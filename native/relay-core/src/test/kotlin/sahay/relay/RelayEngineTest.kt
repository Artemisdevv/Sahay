package sahay.relay

import kotlinx.serialization.json.JsonPrimitive
import java.io.File
import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

class RelayEngineTest {
    private fun net(vararg ids: String): Pair<Net, List<Node>> {
        val n = Net()
        return n to ids.map { n.node(it) }
    }

    private fun hopsOf(n: Node, id: String) = n.engine.pendingForUpload().first { EnvelopeCheck.reportId(it) == id }.let(EnvelopeCheck::hops)

    // ---- handshake -----------------------------------------------------------------------------

    @Test fun `hello handshake makes both sides ready`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        assertEquals(listOf("B"), a.peersUp); assertEquals(listOf("A"), b.peersUp)
        assertEquals(1, net.sent("A", "B", Msg.Hello::class.java))
    }

    @Test fun `non sahay peer is disconnected`() {
        val (net, ab) = net("A", "B"); val a = ab[0]
        net.link("A", "B"); net.pump()
        a.engine.onDisconnected("to-B"); net.pump()
        a.engine.onConnected("to-X")
        a.engine.onBytes("to-X", Codec.encode(Msg.Hello("evil", emptyList(), app = "other")))
        assertEquals(0, a.engine.connectedPeerCount())
    }

    @Test fun `garbage or non hello first message disconnects`() {
        val (net, ab) = net("A", "B"); val a = ab[0]
        net.link("A", "B"); net.pump(); net.unlink("A", "B"); net.pump()
        net.link("A", "B"); net.pump()  // fresh connection, fully handshaken, then:
        a.engine.onConnected("to-Z")
        a.engine.onBytes("to-Z", "not json".toByteArray())
        a.engine.onBytes("to-Z", Codec.encode(Msg.Ack("x")))   // endpoint already dropped: ignored, no crash
        assertEquals(1, a.engine.connectedPeerCount())
        a.engine.onConnected("to-Y")
        a.engine.onBytes("to-Y", Codec.encode(Msg.Envelope(envelope("r1"))))   // envelope before hello
        assertEquals(1, a.engine.connectedPeerCount())
        assertEquals(0, a.engine.carryingCount())
    }

    @Test fun `wrong version or self device id is rejected`() {
        val (_, ab) = net("A", "B"); val a = ab[0]
        a.engine.onConnected("to-X")
        a.engine.onBytes("to-X", Codec.encode(Msg.Hello("X", emptyList(), v = 2)))
        a.engine.onConnected("to-Y")
        a.engine.onBytes("to-Y", Codec.encode(Msg.Hello("A", emptyList())))
        assertEquals(0, a.engine.connectedPeerCount())
    }

    @Test fun `repeated hello and unknown message types are ignored`() {
        val (net, ab) = net("A", "B"); val a = ab[0]
        net.link("A", "B"); net.pump()
        a.engine.onBytes("to-B", Codec.encode(Msg.Hello("B", emptyList())))
        a.engine.onBytes("to-B", """{"t":"future-thing","x":1}""".toByteArray())
        assertEquals(1, a.engine.connectedPeerCount())
        assertEquals(listOf("B"), a.peersUp)
    }

    // ---- delivery -------------------------------------------------------------------------------

    @Test fun `own report is handed to a peer who emits it for upload and acks`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        assertEquals(1, b.received.size)
        assertEquals("A", b.received[0].second)
        assertEquals(1, b.engine.carryingCount())
        assertEquals(1, net.sent("B", "A", Msg.Ack::class.java))
        assertEquals(0, a.engine.carryingCount())            // own reports are not "carrying for others"
        assertEquals(1, net.sent("A", "B", Msg.Envelope::class.java))   // not re-sent after ack
    }

    @Test fun `receipt travels back to the origin and stops carrying`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        b.engine.relayReceipt("r1", receipt("r1")); net.pump()
        assertEquals(listOf("r1"), a.receipts.map { it.first })
        assertTrue(a.engine.pendingForUpload().isEmpty()); assertTrue(b.engine.pendingForUpload().isEmpty())
        assertEquals(0, b.engine.carryingCount())
    }

    @Test fun `status reaches the origin and updates are delivered once each`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        b.engine.relayStatus("r1", "dispatched", "Help dispatched, ETA 6 min"); net.pump()
        b.engine.relayStatus("r1", "dispatched", "Help dispatched, ETA 6 min"); net.pump()
        b.engine.relayStatus("r1", "en_route", "On the way"); net.pump()
        assertEquals(listOf("dispatched", "en_route"), a.statuses.map { it.second })
    }

    @Test fun `report created offline is carried and delivered when a peer appears later`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        assertTrue(b.received.isEmpty())
        net.link("A", "B"); net.pump()
        assertEquals(listOf("r1"), b.received.map { EnvelopeCheck.reportId(it.first) })
    }

    @Test fun `receipt held until the path back is reachable again`() {
        val (net, abc) = net("A", "B", "C"); val (a, b, c) = abc
        net.link("A", "B"); net.link("B", "C"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        assertEquals(1, c.received.size)
        net.unlink("A", "B"); net.pump()
        c.engine.relayReceipt("r1", receipt("r1")); net.pump()
        assertTrue(a.receipts.isEmpty())                       // B holds it
        net.link("A", "B"); net.pump()
        assertEquals(listOf("r1"), a.receipts.map { it.first })
        assertEquals(0, b.engine.carryingCount())
    }

    // ---- ttl / hops / loops ---------------------------------------------------------------------

    @Test fun `ttl bounds the chain and hops increase per relay`() {
        val (net, nodes) = net("A", "B", "C", "D"); val (a, b, c, d) = nodes
        net.link("A", "B"); net.link("B", "C"); net.link("C", "D"); net.pump()
        a.engine.enqueueOwn(envelope("r1", ttl = 2)); net.pump()
        assertEquals(0, hopsOf(b, "r1")); assertEquals(1, hopsOf(c, "r1")); assertEquals(2, hopsOf(d, "r1"))
        val (net2, n2) = net("A", "B", "C", "D")
        net2.link("A", "B"); net2.link("B", "C"); net2.link("C", "D"); net2.pump()
        n2[0].engine.enqueueOwn(envelope("r2", ttl = 1)); net2.pump()
        assertEquals(1, n2[1].received.size); assertEquals(1, n2[2].received.size); assertEquals(0, n2[3].received.size)
    }

    @Test fun `ttl zero is never forwarded`() {
        val (net, ab) = net("A", "B")
        net.link("A", "B"); net.pump()
        ab[0].engine.enqueueOwn(envelope("r1", ttl = 0)); net.pump()
        assertTrue(ab[1].received.isEmpty())
    }

    @Test fun `fully connected triangle terminates with each report seen once per node`() {
        val (net, abc) = net("A", "B", "C"); val (a, b, c) = abc
        net.link("A", "B"); net.link("B", "C"); net.link("A", "C"); net.pump()
        a.engine.enqueueOwn(envelope("r1", ttl = 9)); net.pump()
        assertEquals(1, b.received.size); assertEquals(1, c.received.size)
        assertTrue(a.received.isEmpty())                      // never echoed back to its origin
        for (n in listOf("A", "B", "C")) for (m in listOf("A", "B", "C")) if (n != m)
            assertTrue(net.sent(n, m, Msg.Envelope::class.java) <= 1, "$n->$m sent duplicates")
    }

    @Test fun `report is never sent back to the peer it came from`() {
        val (net, ab) = net("A", "B")
        net.link("A", "B"); net.pump()
        ab[0].engine.enqueueOwn(envelope("r1")); net.pump()
        assertEquals(0, net.sent("B", "A", Msg.Envelope::class.java))
    }

    @Test fun `hello carrying list suppresses resend`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        net.unlink("A", "B"); net.pump()
        net.link("A", "B"); net.pump()                        // reconnect: B says it already carries r1
        assertEquals(1, net.sent("A", "B", Msg.Envelope::class.java))
        assertEquals(1, b.received.size)
    }

    // ---- dedupe & validation --------------------------------------------------------------------

    @Test fun `duplicate envelope is acked but emitted once`() {
        val (net, ab) = net("A", "B"); val b = ab[1]
        net.link("A", "B"); net.pump()
        val msg = Codec.encode(Msg.Envelope(envelope("r1")))
        b.engine.onBytes("to-A", msg); b.engine.onBytes("to-A", msg); net.pump()
        assertEquals(1, b.received.size)
        assertEquals(2, net.sent("B", "A", Msg.Ack::class.java))
    }

    @Test fun `malformed envelopes are dropped and the sender disconnected`() {
        val good = envelope("r1")
        val bad = listOf(
            good.without("signature"), good.with("signature", "AAAA"), good.with("ciphertext", "***not-base64"),
            good.without("report_id"), good.with("report_id", ""), good.without("ttl"),
            good.with("ttl", "5"), good.with("device_id", ""), good.with("hops", "0"), good.with("envelope_version", "1"),
        )
        for ((i, env) in bad.withIndex()) {
            val (net, ab) = net("A", "B"); val b = ab[1]
            net.link("A", "B"); net.pump()
            b.engine.onBytes("to-A", Codec.encode(Msg.Envelope(env))); net.pump()
            assertTrue(b.received.isEmpty(), "case $i accepted")
            assertEquals(0, b.engine.connectedPeerCount(), "case $i not disconnected")
        }
    }

    @Test fun `negative hops and absurd ttl rejected`() {
        assertNotNull(EnvelopeCheck.problem(envelope("r", ttl = 99)))
        assertNotNull(EnvelopeCheck.problem(envelope("r", hops = -1)))
        assertNull(EnvelopeCheck.problem(envelope("r", ttl = EnvelopeCheck.MAX_TTL, hops = 0)))
    }

    @Test fun `oversize message is ignored by the codec`() {
        assertNull(Codec.decode(ByteArray(Codec.MAX_MESSAGE_BYTES + 1) { 'a'.code.toByte() }))
        assertNull(Codec.decode(ByteArray(0)))
    }

    @Test fun `enqueueOwn rejects a malformed envelope`() {
        val (_, ab) = net("A")
        assertFailsWith<IllegalArgumentException> { ab[0].engine.enqueueOwn(envelope("r1").without("signature")) }
    }

    @Test fun `relay never alters the signed fields`() {
        val (net, abc) = net("A", "B", "C"); val c = abc[2]
        net.link("A", "B"); net.link("B", "C"); net.pump()
        val original = envelope("r1", ttl = 3)
        abc[0].engine.enqueueOwn(original); net.pump()
        val atC = c.received[0].first
        for (k in listOf("report_id", "device_id", "created_at", "ciphertext", "signature", "key_id", "envelope_version"))
            assertEquals(original[k], atC[k], k)
        assertEquals(JsonPrimitive(1), atC["hops"])
    }

    // ---- delivered / receipts -------------------------------------------------------------------

    @Test fun `markDelivered stops carrying and advertising`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        b.engine.markDelivered("r1")
        assertEquals(0, b.engine.carryingCount()); assertTrue(b.engine.pendingForUpload().isEmpty())
        net.unlink("A", "B"); net.pump(); net.link("A", "B"); net.pump()
        val hello = net.wire.last { it.first == "B" && it.third is Msg.Hello }.third as Msg.Hello
        assertTrue(hello.carrying.isEmpty())
    }

    @Test fun `receipt for an unknown report is ignored`() {
        val (net, ab) = net("A", "B"); val a = ab[0]
        net.link("A", "B"); net.pump()
        a.engine.onBytes("to-B", Codec.encode(Msg.Receipt("ghost", receipt("ghost"))))
        a.engine.onBytes("to-B", Codec.encode(Msg.Status("ghost", "x", "y")))
        assertTrue(a.receipts.isEmpty() && a.statuses.isEmpty())
    }

    @Test fun `receipt verifier rejects a forged receipt and drops the peer`() {
        val net = Net()
        val a = net.node("A", verifier = { _, _ -> false }); net.node("B")
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        a.engine.onBytes("to-B", Codec.encode(Msg.Receipt("r1", receipt("r1"))))
        assertTrue(a.receipts.isEmpty()); assertEquals(1, a.engine.pendingForUpload().size)
        assertEquals(0, a.engine.connectedPeerCount())
    }

    @Test fun `duplicate receipt is only delivered once`() {
        val (net, ab) = net("A", "B"); val (a, b) = ab
        net.link("A", "B"); net.pump()
        a.engine.enqueueOwn(envelope("r1")); net.pump()
        val m = Codec.encode(Msg.Receipt("r1", receipt("r1")))
        a.engine.onBytes("to-B", m); a.engine.onBytes("to-B", m)
        assertEquals(1, a.receipts.size)
    }

    // ---- persistence, expiry, capacity ----------------------------------------------------------

    @Test fun `file store survives a restart and keeps receipt routing state`() {
        val dir = Files.createTempDirectory("relay").toFile()
        try {
            val net = Net()
            val a = net.node("A"); val b = net.node("B", FileStore(dir))
            net.link("A", "B"); net.pump()
            a.engine.enqueueOwn(envelope("r1")); net.pump()
            // B "restarts": new engine over the same directory, same device id
            val net2 = Net()
            val a2 = net2.node("A"); val b2 = net2.node("B", FileStore(dir))
            assertEquals(1, b2.engine.carryingCount())
            net2.link("A", "B"); net2.pump()
            b2.engine.relayReceipt("r1", receipt("r1")); net2.pump()
            assertEquals(0, b2.engine.carryingCount())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `file store ignores corrupt files and round trips every field`() {
        val dir = Files.createTempDirectory("relay").toFile()
        try {
            val store = FileStore(dir)
            val r = Record("r-1", envelope("r-1"), origin = false, sources = mutableSetOf("A"), delivered = true,
                receipt = receipt("r-1"), status = Msg.Status("r-1", "dispatched", "ok"), receivedAt = 42,
                receiptSentTo = mutableSetOf("A"), statusSentTo = mutableSetOf("A"))
            store.save(r); store.save(r)                     // overwrite is fine
            File(dir, "junk.json").writeText("{ not json")
            val back = FileStore(dir).loadAll()
            assertEquals(1, back.size); assertEquals(r, back[0])
            store.delete("r-1"); assertTrue(FileStore(dir).loadAll().isEmpty())
        } finally { dir.deleteRecursively() }
    }

    @Test fun `old relayed reports expire but own undelivered reports stay`() {
        var t = 1_000L
        val net = Net()
        val a = net.node("A", clock = { t }); val b = net.node("B", clock = { t })
        net.link("A", "B"); net.pump()
        b.engine.enqueueOwn(envelope("mine")); a.engine.enqueueOwn(envelope("theirs")); net.pump()
        assertEquals(1, b.engine.carryingCount())
        t += 25L * 3600_000
        b.engine.purgeExpired()
        assertEquals(0, b.engine.carryingCount())
        assertEquals(listOf("mine"), b.engine.pendingForUpload().map(EnvelopeCheck::reportId))
        t += 7L * 24 * 3600_000
        b.engine.purgeExpired()
        assertTrue(b.engine.pendingForUpload().isEmpty())
    }

    @Test fun `capacity evicts delivered first then oldest relayed and protects own reports`() {
        var t = 0L
        val net = Net()
        val b = net.node("B", clock = { t++ }, store = InMemoryStore())
        val tiny = RelayEngine("T", object : Transport { override fun send(endpointId: String, bytes: ByteArray) {} override fun disconnect(endpointId: String) {} },
            InMemoryStore(), object : RelayListener {}, { t++ }, RelayConfig(maxRecords = 3))
        tiny.enqueueOwn(envelope("own"))
        tiny.onConnected("to-X"); tiny.onBytes("to-X", Codec.encode(Msg.Hello("X", emptyList())))
        tiny.onBytes("to-X", Codec.encode(Msg.Envelope(envelope("r1"))))
        tiny.onBytes("to-X", Codec.encode(Msg.Envelope(envelope("r2"))))
        tiny.markDelivered("r1")
        tiny.onBytes("to-X", Codec.encode(Msg.Envelope(envelope("r3"))))          // evicts delivered r1
        assertEquals(setOf("own", "r2", "r3"), tiny.pendingForUpload().map(EnvelopeCheck::reportId).toSet())
        tiny.onBytes("to-X", Codec.encode(Msg.Envelope(envelope("r4"))))          // evicts oldest relayed r2
        assertEquals(setOf("own", "r3", "r4"), tiny.pendingForUpload().map(EnvelopeCheck::reportId).toSet())
        assertEquals(b.engine.carryingCount(), 0)
    }

    @Test fun `full of own reports refuses to carry more`() {
        var t = 0L
        val tiny = RelayEngine("T", object : Transport { override fun send(endpointId: String, bytes: ByteArray) {} override fun disconnect(endpointId: String) {} },
            InMemoryStore(), object : RelayListener {}, { t++ }, RelayConfig(maxRecords = 1))
        tiny.enqueueOwn(envelope("own"))
        tiny.onConnected("to-X"); tiny.onBytes("to-X", Codec.encode(Msg.Hello("X", emptyList())))
        tiny.onBytes("to-X", Codec.encode(Msg.Envelope(envelope("r1"))))
        assertEquals(listOf("own"), tiny.pendingForUpload().map(EnvelopeCheck::reportId))
    }

    // ---- codec ---------------------------------------------------------------------------------

    @Test fun `codec round trips every message type`() {
        val msgs = listOf(
            Msg.Hello("dev", listOf("a", "b")), Msg.Envelope(envelope("r1", hops = 2)), Msg.Ack("r1"),
            Msg.Receipt("r1", receipt("r1")), Msg.Status("r1", "dispatched", "Help dispatched, ETA 6 min"),
        )
        for (m in msgs) assertEquals(m, Codec.decode(Codec.encode(m)))
        assertContentEquals("""{"t":"ack","report_id":"r1"}""".toByteArray(), Codec.encode(Msg.Ack("r1")))
    }

    @Test fun `codec rejects structurally wrong messages`() {
        for (s in listOf("[]", "{}", """{"t":"ack"}""", """{"t":"hello","app":"sahay"}""", """{"t":"envelope","envelope":"x"}""",
            """{"t":"receipt","report_id":"r"}""", """{"t":"status","report_id":"r"}""", "\u0000\u0001"))
            assertNull(Codec.decode(s.toByteArray()), s)
    }


    @Test fun `base64 check matches the real decoder`() {
        val enc = java.util.Base64.getEncoder()
        for (n in 0..70) { val s = enc.encodeToString(ByteArray(n) { it.toByte() }); assertEquals(if (n == 0) null else n, Base64Check.decodedLength(s), "len $n") }
        for (bad in listOf("", "abc", "ab=c", "a===", "====", "AA=A", "AAA*", "AA==AAAA", "AAAA ")) assertNull(Base64Check.decodedLength(bad), bad)
    }

    private inline fun <reified T : Throwable> assertFailsWith(block: () -> Unit) {
        try { block() } catch (e: Throwable) { if (e is T) return else throw e }
        throw AssertionError("expected ${T::class.simpleName}")
    }
}
