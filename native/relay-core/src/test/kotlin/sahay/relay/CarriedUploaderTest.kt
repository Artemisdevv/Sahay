package sahay.relay

import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class CarriedUploaderTest {
    /** B carries what A sent (A -> B), so B has two carried reports and one of its own. */
    private fun carrier(): Triple<Net, Node, Node> {
        val net = Net()
        val a = net.node("A")
        val b = net.node("B")
        a.engine.enqueueOwn(envelope("r1"))
        a.engine.enqueueOwn(envelope("r2"))
        b.engine.enqueueOwn(envelope("mine"))
        net.link("A", "B"); net.pump()
        return Triple(net, a, b)
    }

    private class FakeHttp(val answer: (String) -> HttpResult) : UploadHttp {
        val posted = mutableListOf<String>()
        override fun post(envelopeJson: String, token: String): HttpResult {
            posted += EnvelopeCheck.reportId(kotlinx.serialization.json.Json.parseToJsonElement(envelopeJson) as JsonObject)
            return answer(envelopeJson)
        }
    }

    private fun ok(id: String) = HttpResult(202, """{"report_id":"$id","status":"received","receipt":{"server_time":"2026-10-09T10:15:02Z","signature":"c2ln"}}""")

    @Test fun `uploads only what it carries for others, returns receipts and stops carrying`() {
        val (net, a, b) = carrier()
        assertEquals(2, b.engine.carryingCount())
        val http = FakeHttp { env -> ok(EnvelopeCheck.reportId(kotlinx.serialization.json.Json.parseToJsonElement(env) as JsonObject)) }
        val summary = CarriedUploader(b.engine, http, { "jwt" }, { true }).attempt()
        assertEquals(CarriedUploader.Summary(delivered = 2), summary)
        assertEquals(setOf("r1", "r2"), http.posted.toSet())  // never "mine": that stays with the app's own queue
        assertEquals(0, b.engine.carryingCount())
        net.pump()
        assertEquals(setOf("r1", "r2"), a.receipts.map { it.first }.toSet())  // receipts travel back to the sender
        assertTrue(b.engine.pendingForUpload().any { EnvelopeCheck.reportId(it) == "mine" })
    }

    @Test fun `does nothing and makes no request while offline or without a token`() {
        val (_, _, b) = carrier()
        val http = FakeHttp { error("must not be called") }
        assertEquals("offline", CarriedUploader(b.engine, http, { "jwt" }, { false }).attempt().skipped)
        assertEquals("no token", CarriedUploader(b.engine, http, { null }, { true }).attempt().skipped)
        assertTrue(http.posted.isEmpty())
        assertEquals(2, b.engine.carryingCount())
    }

    @Test fun `a rejected report is dropped but the rest still go`() {
        val (_, _, b) = carrier()
        val http = FakeHttp { env ->
            val id = EnvelopeCheck.reportId(kotlinx.serialization.json.Json.parseToJsonElement(env) as JsonObject)
            if (id == "r1") HttpResult(422, """{"error":{"code":"invalid_signature"}}""") else ok(id)
        }
        val summary = CarriedUploader(b.engine, http, { "jwt" }, { true }).attempt()
        assertEquals(1, summary.delivered); assertEquals(1, summary.dropped)
        assertEquals(0, b.engine.carryingCount())
    }

    @Test fun `a stale token stops the round and keeps everything`() {
        val (_, _, b) = carrier()
        val http = FakeHttp { HttpResult(401, "{}") }
        val summary = CarriedUploader(b.engine, http, { "old" }, { true }).attempt()
        assertEquals("token rejected", summary.skipped); assertEquals(2, summary.waiting)
        assertEquals(1, http.posted.size)  // did not keep trying with a token the server rejects
        assertEquals(2, b.engine.carryingCount())
    }

    @Test fun `server errors and no answer stop the round and keep the reports for the next try`() {
        for (status in listOf(0, 429, 500, 503)) {
            val (_, _, b) = carrier()
            val http = FakeHttp { HttpResult(status) }
            val summary = CarriedUploader(b.engine, http, { "jwt" }, { true }).attempt()
            assertEquals(2, summary.waiting, "status $status"); assertEquals(1, http.posted.size, "status $status")
            assertEquals(2, b.engine.carryingCount(), "status $status")
        }
    }

    @Test fun `a second round after recovery delivers what was kept, and a delivered report is not sent twice`() {
        val (_, _, b) = carrier()
        var down = true
        val http = FakeHttp { env -> if (down) HttpResult(0) else ok(EnvelopeCheck.reportId(kotlinx.serialization.json.Json.parseToJsonElement(env) as JsonObject)) }
        val uploader = CarriedUploader(b.engine, http, { "jwt" }, { true })
        uploader.attempt()
        down = false
        assertEquals(2, uploader.attempt().delivered)
        assertEquals(0, uploader.attempt().delivered)  // nothing left, nothing posted
        assertEquals(3, http.posted.size)
    }

    @Test fun `a success without a readable receipt still stops carrying`() {
        val (_, _, b) = carrier()
        val http = FakeHttp { HttpResult(200, "not json") }
        assertEquals(2, CarriedUploader(b.engine, http, { "jwt" }, { true }).attempt().delivered)
        assertEquals(0, b.engine.carryingCount())
    }
}
