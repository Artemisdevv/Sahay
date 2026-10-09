package sahay.relay

import kotlinx.serialization.json.JsonObject

/** Platform I/O. endpointId is the transport's ephemeral id (Nearby endpoint id), not the device id. */
interface Transport {
    /** [onFailure] must be called (from any thread) if the bytes did not reach the peer, so the engine can retry later. */
    fun send(endpointId: String, bytes: ByteArray, onFailure: () -> Unit = {})
    fun disconnect(endpointId: String)
}

/** Callbacks to the web layer. Keep implementations quick and non-blocking. */
interface RelayListener {
    fun onPeerConnected(deviceId: String) {}
    fun onPeerLost(deviceId: String) {}
    /** A report from someone else arrived. If this phone is online the web layer uploads it via POST /reports. */
    fun onEnvelopeReceived(envelope: JsonObject, fromPeer: String) {}
    /** Our own report got a server receipt back through a relay. */
    fun onReceipt(reportId: String, receipt: JsonObject) {}
    fun onStatus(reportId: String, status: String, message: String) {}
}

class RelayConfig(
    val maxRecords: Int = 200,
    val maxRelayAgeMs: Long = 24L * 3600_000,
    val maxOriginAgeMs: Long = 7L * 24 * 3600_000,
)

/**
 * Store-and-forward relay (contract section 5).
 *
 * Rules enforced here:
 *  1. The first message from a peer must be a valid Sahay hello; anything else disconnects it.
 *  2. Envelopes get a cheap structural check (no keys needed); malformed ones disconnect the sender.
 *  3. Dedupe by report_id. A duplicate is acked but never re-emitted or re-forwarded, so loops end.
 *  4. Forward only while hops < ttl; hops is incremented by each relay (the origin sends hops as created).
 *  5. Never send a report back to a peer it came from, or to one that already carries it.
 *  6. The relay never opens ciphertext. `ttl` and `hops` are unsigned, everything else is untouched.
 *  7. Receipts and statuses travel back along the path the envelope came in on, and are held until that
 *     peer is reachable again.
 *
 * Thread-safe; callbacks run on the calling thread.
 */
class RelayEngine(
    private val deviceId: String,
    private val transport: Transport,
    private val store: RelayStore,
    private val listener: RelayListener,
    private val now: () -> Long = System::currentTimeMillis,
    private val config: RelayConfig = RelayConfig(),
    /** Verifies a server receipt (Ed25519 over report_id|server_time). Required: stops a nearby peer forging "delivered". */
    private val receiptVerifier: (reportId: String, receipt: JsonObject) -> Boolean,
    /** Verifies a server-signed status. Required: stops a nearby peer feeding the reporter a fake status. */
    private val statusVerifier: (Msg.Status) -> Boolean,
) {
    private class Peer(val endpointId: String) {
        var deviceId: String? = null
        val has = mutableSetOf<String>()
        val ready get() = deviceId != null
    }

    private val records = LinkedHashMap<String, Record>()
    private val peers = LinkedHashMap<String, Peer>()

    init { store.loadAll().forEach { records[it.reportId] = it } }

    // ---- transport events -----------------------------------------------------------------

    @Synchronized
    fun onConnected(endpointId: String) {
        peers[endpointId] = Peer(endpointId)
        transport.send(endpointId, Codec.encode(Msg.Hello(deviceId, carryingIds())))
    }

    @Synchronized
    fun onDisconnected(endpointId: String) {
        val p = peers.remove(endpointId) ?: return
        p.deviceId?.let { listener.onPeerLost(it) }
    }

    @Synchronized
    fun onBytes(endpointId: String, bytes: ByteArray) {
        val peer = peers[endpointId] ?: return
        val msg = Codec.decode(bytes)
        if (msg == null) {
            if (!peer.ready) drop(peer)   // garbage before hello: not one of ours
            return                         // unknown message types from a newer peer are ignored
        }
        if (!peer.ready && msg !is Msg.Hello) return drop(peer)
        when (msg) {
            is Msg.Hello -> onHello(peer, msg)
            is Msg.Envelope -> onEnvelope(peer, msg.envelope)
            is Msg.Ack -> peer.has += msg.reportId
            is Msg.Receipt -> onReceipt(peer, msg)
            is Msg.Status -> onStatus(peer, msg)
        }
    }

    private fun drop(peer: Peer) {
        peers.remove(peer.endpointId)
        transport.disconnect(peer.endpointId)
        peer.deviceId?.let { listener.onPeerLost(it) }
    }

    private fun onHello(peer: Peer, h: Msg.Hello) {
        if (h.app != Msg.APP || h.v != Msg.VERSION || h.deviceId.isEmpty() || h.deviceId == deviceId) return drop(peer)
        if (peer.ready) return  // repeated hello: ignore
        peer.deviceId = h.deviceId
        peer.has += h.carrying
        listener.onPeerConnected(h.deviceId)
        purgeExpired()
        pushTo(peer)
        flushBackChannel(peer)
    }

    private fun onEnvelope(peer: Peer, env: JsonObject) {
        if (EnvelopeCheck.problem(env) != null) return drop(peer)
        val id = EnvelopeCheck.reportId(env)
        val from = peer.deviceId!!
        peer.has += id
        val existing = records[id]
        if (existing != null) {            // duplicate: remember the extra path, ack, stop
            if (existing.sources.add(from)) store.save(existing)
            transport.send(peer.endpointId, Codec.encode(Msg.Ack(id)))
            flushBackChannel(peer)
            return
        }
        purgeExpired()
        if (!makeRoom()) return            // full of our own undelivered reports: cannot carry more
        val rec = Record(id, env, origin = false, sources = mutableSetOf(from), receivedAt = now())
        records[id] = rec
        store.save(rec)
        transport.send(peer.endpointId, Codec.encode(Msg.Ack(id)))
        listener.onEnvelopeReceived(env, from)
        peers.values.filter { it.ready && it !== peer }.forEach { pushOne(it, rec) }
    }

    private fun onReceipt(peer: Peer, m: Msg.Receipt) {
        val rec = records[m.reportId] ?: return
        if (rec.receipt != null) return
        if (!receiptVerifier(m.reportId, m.receipt)) return drop(peer)
        rec.receipt = m.receipt
        rec.delivered = true
        store.save(rec)
        if (rec.origin) listener.onReceipt(rec.reportId, m.receipt)
        peers.values.filter { it.ready }.forEach { flushBackChannel(it) }
    }

    private fun onStatus(peer: Peer, m: Msg.Status) {
        val rec = records[m.reportId] ?: return
        val old = rec.status
        if (old?.status == m.status && old.message == m.message) return
        // A signed status carries updated_at: never let an older one replace a newer one (replay).
        if (old != null && old.updatedAt.isNotEmpty() && m.updatedAt.isNotEmpty() && m.updatedAt <= old.updatedAt) return
        if (!statusVerifier(m)) return drop(peer)
        rec.status = m
        rec.statusSentTo.clear()
        store.save(rec)
        if (rec.origin) listener.onStatus(rec.reportId, m.status, m.message)
        peers.values.filter { it.ready }.forEach { flushBackChannel(it) }
    }

    // ---- API for the web layer / plugin ---------------------------------------------------------

    /** Our own new report: carry it and hand it to any peer now, others as they appear. */
    @Synchronized
    fun enqueueOwn(envelope: JsonObject) {
        EnvelopeCheck.problem(envelope)?.let { throw IllegalArgumentException("bad envelope: $it") }
        val id = EnvelopeCheck.reportId(envelope)
        if (records.containsKey(id)) return
        makeRoom()
        val rec = Record(id, envelope, origin = true, receivedAt = now())
        records[id] = rec
        store.save(rec)
        peers.values.filter { it.ready }.forEach { pushOne(it, rec) }
    }

    /** The web layer confirmed delivery (uploaded or verified receipt): stop carrying and advertising it. */
    @Synchronized
    fun markDelivered(reportId: String) {
        val rec = records[reportId] ?: return
        rec.delivered = true
        store.save(rec)
    }

    /** After uploading someone else's report, return the server receipt along the path it came in on. */
    @Synchronized
    fun relayReceipt(reportId: String, receipt: JsonObject) {
        val rec = records[reportId] ?: return
        if (rec.receipt == null) rec.receipt = receipt
        rec.delivered = true
        store.save(rec)
        peers.values.filter { it.ready }.forEach { flushBackChannel(it) }
    }

    @Synchronized
    fun relayStatus(reportId: String, status: String, message: String, signature: String = "", updatedAt: String = "") {
        val rec = records[reportId] ?: return
        rec.status = Msg.Status(reportId, status, message, signature, updatedAt)
        rec.statusSentTo.clear()
        store.save(rec)
        peers.values.filter { it.ready }.forEach { flushBackChannel(it) }
    }

    /** Everything not yet confirmed delivered (own and others'), for the web layer to upload when online. */
    @Synchronized
    fun pendingForUpload(): List<JsonObject> = records.values.filter { !it.delivered }.map { it.envelope }

    /** Reports we carry for other people. The UI shows only this count, never contents. */
    @Synchronized
    fun carryingCount(): Int = records.values.count { !it.origin && !it.delivered }

    @Synchronized
    fun connectedPeerCount(): Int = peers.values.count { it.ready }

    @Synchronized
    fun purgeExpired() {
        val t = now()
        val dead = records.values.filter {
            val age = t - it.receivedAt
            if (it.origin) age > config.maxOriginAgeMs else age > config.maxRelayAgeMs
        }
        dead.forEach { records.remove(it.reportId); store.delete(it.reportId) }
    }

    // ---- internals ------------------------------------------------------------------------------

    private fun carryingIds() = records.values.filter { !it.delivered }.map { it.reportId }

    private fun canForward(r: Record) = !r.delivered && EnvelopeCheck.hops(r.envelope) < EnvelopeCheck.ttl(r.envelope)

    private fun pushTo(peer: Peer) = records.values.toList().forEach { pushOne(peer, it) }

    private fun pushOne(peer: Peer, r: Record) {
        val pid = peer.deviceId ?: return
        if (!canForward(r) || r.reportId in peer.has || pid in r.sources) return
        val hops = EnvelopeCheck.hops(r.envelope)
        val out = if (r.origin) r.envelope else EnvelopeCheck.withHops(r.envelope, hops + 1)
        peer.has += r.reportId
        transport.send(peer.endpointId, Codec.encode(Msg.Envelope(out))) { onSendFailed { peer.has -= r.reportId } }
    }

    /** Send held receipts/statuses to a peer if it is on the path back for that report. */
    private fun flushBackChannel(peer: Peer) {
        val pid = peer.deviceId ?: return
        for (r in records.values) {
            if (pid !in r.sources) continue
            val receipt = r.receipt
            if (receipt != null && r.receiptSentTo.add(pid)) {
                store.save(r)
                transport.send(peer.endpointId, Codec.encode(Msg.Receipt(r.reportId, receipt))) {
                    onSendFailed { if (r.receiptSentTo.remove(pid)) store.save(r) }
                }
            }
            val st = r.status
            if (st != null && r.statusSentTo.add(pid)) {
                store.save(r)
                transport.send(peer.endpointId, Codec.encode(st)) {
                    onSendFailed { if (r.status === st && r.statusSentTo.remove(pid)) store.save(r) }
                }
            }
        }
    }

    /** Transport failure callbacks may arrive on any thread; take the engine lock, then roll back the "sent" marker. */
    private fun onSendFailed(rollback: () -> Unit) = synchronized(this) { rollback() }

    /** Ensure space for one more record: evict delivered first, then oldest relayed. False if only own reports remain. */
    private fun makeRoom(): Boolean {
        while (records.size >= config.maxRecords) {
            val victim = records.values.filter { it.delivered }.minByOrNull { it.receivedAt }
                ?: records.values.filter { !it.origin }.minByOrNull { it.receivedAt }
                ?: return false
            records.remove(victim.reportId)
            store.delete(victim.reportId)
        }
        return true
    }
}
