package sahay.relay

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.io.File
import kotlin.test.Test
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Checks the verifier against the frozen contract vector (signed by the real backend code). */
class ServerVerifierTest {
    private val vector: JsonObject = Json.parseToJsonElement(
        File("../../contract/crypto-test-vector.json").readText(Charsets.UTF_8),
    ).jsonObject
    private val verifier = ServerVerifier(vector["server"]!!.jsonObject["verify_key"]!!.jsonPrimitive.content)
    private val receipt = vector["receipt"]!!.jsonObject
    private val status = vector["status"]!!.jsonObject

    private fun s(o: JsonObject, k: String) = o[k]!!.jsonPrimitive.content

    private fun realStatus() = Msg.Status(
        s(status, "report_id"), s(status, "status"), s(status, "message"), s(status, "signature"), s(status, "updated_at"),
    )

    private fun realReceipt() = buildJsonObject {
        put("server_time", s(receipt, "server_time")); put("signature", s(receipt, "signature"))
    }

    @Test fun `genuine receipt verifies`() {
        assertTrue(verifier.receipt(s(receipt, "report_id"), realReceipt()))
    }

    @Test fun `receipt for another report, altered time or bad signature is rejected`() {
        val good = realReceipt()
        assertFalse(verifier.receipt("22222222-2222-4222-8222-222222222222", good))
        assertFalse(verifier.receipt(s(receipt, "report_id"),
            JsonObject(good.toMutableMap().apply { put("server_time", JsonPrimitive("2026-10-09T10:15:03Z")) })))
        assertFalse(verifier.receipt(s(receipt, "report_id"),
            JsonObject(good.toMutableMap().apply { put("signature", JsonPrimitive("AAAA")) })))
        assertFalse(verifier.receipt(s(receipt, "report_id"), buildJsonObject { put("server_time", "x") }))
    }

    @Test fun `genuine status verifies, any change or missing signature is rejected`() {
        val st = realStatus()
        assertTrue(verifier.status(st))
        assertFalse(verifier.status(st.copy(status = "resolved")))
        assertFalse(verifier.status(st.copy(message = "Help dispatched, ETA 1 min")))
        assertFalse(verifier.status(st.copy(updatedAt = "2026-10-09T10:21:00Z")))
        assertFalse(verifier.status(st.copy(signature = "")))
        assertFalse(verifier.status(st.copy(updatedAt = "")))
    }

    @Test fun `a malformed or wrong server key never verifies anything`() {
        assertFalse(ServerVerifier("not base64!!").status(realStatus()))
        assertFalse(ServerVerifier("AAAA").status(realStatus()))
        val other = ServerVerifier(vector["device"]!!.jsonObject["public_key"]!!.jsonPrimitive.content)
        assertFalse(other.status(realStatus()))
    }
}
