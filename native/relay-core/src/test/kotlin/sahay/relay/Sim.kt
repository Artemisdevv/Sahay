package sahay.relay

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.Base64

/** In-memory "radio": phones can be linked and unlinked, messages are queued and pumped deterministically. */
class Net {
    val nodes = mutableMapOf<String, Node>()
    private val links = mutableSetOf<Pair<String, String>>()
    private val queue = ArrayDeque<() -> Unit>()
    /** Directed links ("from" to "to") whose sends report failure, to simulate a transport that drops sends. */
    val failing = mutableSetOf<Pair<String, String>>()
    val wire = mutableListOf<Triple<String, String, Msg?>>()   // from, to, decoded message

    fun node(id: String, store: RelayStore = InMemoryStore(), clock: () -> Long = { 1_000L },
             verifier: (String, JsonObject) -> Boolean = { _, _ -> true }, statusVerifier: (Msg.Status) -> Boolean = { true }) =
        Node(id, this, store, clock, verifier, statusVerifier).also { nodes[id] = it }

    private fun key(a: String, b: String) = if (a < b) a to b else b to a

    fun link(a: String, b: String) {
        links += key(a, b)
        queue += { nodes[a]!!.engine.onConnected("to-$b") }
        queue += { nodes[b]!!.engine.onConnected("to-$a") }
    }

    fun unlink(a: String, b: String) {
        if (!links.remove(key(a, b))) return
        queue += { nodes[a]!!.engine.onDisconnected("to-$b") }
        queue += { nodes[b]!!.engine.onDisconnected("to-$a") }
    }

    fun linked(a: String, b: String) = key(a, b) in links

    internal fun deliver(from: String, endpoint: String, bytes: ByteArray) {
        val to = endpoint.removePrefix("to-")
        wire += Triple(from, to, Codec.decode(bytes))
        if (!linked(from, to)) return
        queue += { nodes[to]!!.engine.onBytes("to-$from", bytes) }
    }

    fun pump(limit: Int = 10_000) {
        var n = 0
        while (queue.isNotEmpty()) {
            queue.removeFirst().invoke()
            check(++n < limit) { "message storm: protocol did not terminate" }
        }
    }

    fun sent(from: String, to: String, type: Class<out Msg>) = wire.count { it.first == from && it.second == to && type.isInstance(it.third) }
}

class Node(val id: String, private val net: Net, store: RelayStore, clock: () -> Long,
           verifier: (String, JsonObject) -> Boolean, statusVerifier: (Msg.Status) -> Boolean) :
    Transport, RelayListener {
    val received = mutableListOf<Pair<JsonObject, String>>()
    val receipts = mutableListOf<Pair<String, JsonObject>>()
    val statuses = mutableListOf<Triple<String, String, String>>()
    val peersUp = mutableListOf<String>()
    val peersDown = mutableListOf<String>()
    val engine = RelayEngine(id, this, store, this, clock, receiptVerifier = verifier, statusVerifier = statusVerifier)

    override fun send(endpointId: String, bytes: ByteArray, onFailure: () -> Unit) {
        if (id to endpointId.removePrefix("to-") in net.failing) onFailure() else net.deliver(id, endpointId, bytes)
    }
    override fun disconnect(endpointId: String) = net.unlink(id, endpointId.removePrefix("to-"))

    override fun onPeerConnected(deviceId: String) { peersUp += deviceId }
    override fun onPeerLost(deviceId: String) { peersDown += deviceId }
    override fun onEnvelopeReceived(envelope: JsonObject, fromPeer: String) { received += envelope to fromPeer }
    override fun onReceipt(reportId: String, receipt: JsonObject) { receipts += reportId to receipt }
    override fun onStatus(reportId: String, status: String, message: String) { statuses += Triple(reportId, status, message) }
}

private val b64 = Base64.getEncoder()

fun envelope(reportId: String, ttl: Int = 5, hops: Int? = null, deviceId: String = "dev-origin"): JsonObject = buildJsonObject {
    put("envelope_version", 1)
    put("report_id", reportId)
    put("device_id", deviceId)
    put("created_at", "2026-10-09T10:15:00Z")
    put("ttl", ttl)
    if (hops != null) put("hops", hops)
    put("key_id", "k1")
    put("ciphertext", b64.encodeToString(ByteArray(40) { it.toByte() }))
    put("signature", b64.encodeToString(ByteArray(64) { 7 }))
}

fun receipt(reportId: String): JsonObject = buildJsonObject {
    put("server_time", "2026-10-09T10:15:02Z"); put("signature", b64.encodeToString(ByteArray(64) { 9 }))
}

fun JsonObject.with(key: String, v: String): JsonObject = JsonObject(toMutableMap().apply { put(key, JsonPrimitive(v)) })
fun JsonObject.without(key: String): JsonObject = JsonObject(toMutableMap().apply { remove(key) })
