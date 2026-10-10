package sahay.relay.android

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat
import com.google.android.gms.nearby.Nearby
import com.google.android.gms.nearby.connection.AdvertisingOptions
import com.google.android.gms.nearby.connection.ConnectionInfo
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback
import com.google.android.gms.nearby.connection.ConnectionResolution
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo
import com.google.android.gms.nearby.connection.DiscoveryOptions
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback
import com.google.android.gms.nearby.connection.Payload
import com.google.android.gms.nearby.connection.PayloadCallback
import com.google.android.gms.nearby.connection.PayloadTransferUpdate
import com.google.android.gms.nearby.connection.Strategy
import sahay.relay.Codec
import sahay.relay.RelayEngine
import sahay.relay.Transport
import java.io.ByteArrayInputStream
import java.util.concurrent.Executors

enum class Mode { ADVERTISE, DISCOVER, BOTH }

/**
 * Google Nearby Connections (P2P_CLUSTER) underneath a [RelayEngine].
 *
 * - Endpoint name = our device id, so peers know who they found before connecting.
 * - In BOTH mode only the lexicographically smaller device id calls requestConnection, which avoids the
 *   simultaneous-request collision. In single modes the discoverer always connects.
 * - Auto-accepts every connection; the app-level hello (engine) decides whether the peer is one of ours.
 * - Messages over 32 KB (BYTES payload cap) go as a STREAM, smaller ones as BYTES.
 * - All inbound messages are handled on one serial thread, in the order Nearby reported them, so a slow
 *   stream cannot be overtaken by a later small message from the same peer.
 */
class NearbyTransport(
    private val context: Context,
    private val deviceId: String,
    /**
     * TEST HOOK (chain test): device ids this phone may link with. Empty = everyone, which is the normal case.
     * Lets three phones in one room behave as a chain A - B - C where A and C cannot see each other.
     */
    private val allowedPeers: () -> Set<String> = { emptySet() },
    private val log: (String) -> Unit = { Log.i(TAG, it) },
) : Transport {
    private fun allowed(remoteDeviceId: String) = allowedPeers().let { it.isEmpty() || remoteDeviceId in it }

    lateinit var engine: RelayEngine

    private val client by lazy { Nearby.getConnectionsClient(context) }
    private val inbound = Executors.newSingleThreadExecutor { r -> Thread(r, "sahay-relay-in").apply { isDaemon = true } }
    private var mode = Mode.BOTH
    private val connected = HashSet<String>()
    private val requested = HashSet<String>()

    fun missingPermissions(): List<String> = requiredPermissions().filter {
        ContextCompat.checkSelfPermission(context, it) != PackageManager.PERMISSION_GRANTED
    }

    fun start(mode: Mode) {
        this.mode = mode
        val missing = missingPermissions()
        require(missing.isEmpty()) { "missing permissions: ${missing.joinToString { it.substringAfterLast('.') }}" }
        if (mode != Mode.DISCOVER) {
            client.startAdvertising(deviceId, SERVICE_ID, lifecycle, AdvertisingOptions.Builder().setStrategy(STRATEGY).build())
                .addOnSuccessListener { log("advertising") }
                .addOnFailureListener { log("advertise failed: ${it.message}") }
        }
        if (mode != Mode.ADVERTISE) {
            client.startDiscovery(SERVICE_ID, discovery, DiscoveryOptions.Builder().setStrategy(STRATEGY).build())
                .addOnSuccessListener { log("discovering") }
                .addOnFailureListener { log("discover failed: ${it.message}") }
        }
    }

    fun stop() {
        client.stopAdvertising(); client.stopDiscovery(); client.stopAllEndpoints()
        synchronized(this) { connected.clear(); requested.clear() }
    }

    override fun send(endpointId: String, bytes: ByteArray, onFailure: () -> Unit) {
        val payload = if (bytes.size <= MAX_BYTES_PAYLOAD) Payload.fromBytes(bytes)
        else Payload.fromStream(ByteArrayInputStream(bytes))
        client.sendPayload(endpointId, payload).addOnFailureListener {
            log("send failed to $endpointId: ${it.message}")
            onFailure()
        }
    }

    override fun disconnect(endpointId: String) {
        client.disconnectFromEndpoint(endpointId)
        synchronized(this) { connected.remove(endpointId); requested.remove(endpointId) }
        inbound.execute { engine.onDisconnected(endpointId) }
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(id: String, info: DiscoveredEndpointInfo) {
            if (info.serviceId != SERVICE_ID) return
            val remote = info.endpointName
            if (!allowed(remote)) return
            if (mode == Mode.BOTH && deviceId > remote) return   // the other side initiates
            synchronized(this@NearbyTransport) { if (id in connected || !requested.add(id)) return }
            client.requestConnection(deviceId, id, lifecycle).addOnFailureListener {
                synchronized(this@NearbyTransport) { requested.remove(id) }
                log("requestConnection failed: ${it.message}")
            }
        }

        override fun onEndpointLost(id: String) { synchronized(this@NearbyTransport) { requested.remove(id) } }
    }

    private val lifecycle = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(id: String, info: ConnectionInfo) {
            if (allowed(info.endpointName)) client.acceptConnection(id, payloads)
            else { log("refusing ${info.endpointName} (not on the allow list)"); client.rejectConnection(id) }
        }

        override fun onConnectionResult(id: String, result: ConnectionResolution) {
            if (result.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                synchronized(this@NearbyTransport) { connected += id }
                inbound.execute { engine.onConnected(id) }
            } else {
                synchronized(this@NearbyTransport) { requested.remove(id) }
                log("connection to $id failed: ${result.status.statusCode}")
            }
        }

        override fun onDisconnected(id: String) {
            synchronized(this@NearbyTransport) { connected.remove(id); requested.remove(id) }
            inbound.execute { engine.onDisconnected(id) }
        }
    }

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(id: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> payload.asBytes()?.let { b -> inbound.execute { engine.onBytes(id, b) } }
                Payload.Type.STREAM -> {
                    val input = payload.asStream()?.asInputStream() ?: return
                    inbound.execute {   // serial: blocks later messages from this peer until this one is complete
                        val bytes = readCapped(input)
                        if (bytes == null) { log("oversize stream from $id, disconnecting"); client.disconnectFromEndpoint(id) }
                        else engine.onBytes(id, bytes)
                    }
                }
                else -> Unit
            }
        }

        override fun onPayloadTransferUpdate(id: String, update: PayloadTransferUpdate) {
            if (update.status == PayloadTransferUpdate.Status.FAILURE) log("transfer failed from/to $id")
        }
    }

    private fun readCapped(input: java.io.InputStream): ByteArray? {
        val out = java.io.ByteArrayOutputStream()
        val buf = ByteArray(8192)
        input.use {
            while (true) {
                val n = it.read(buf)
                if (n < 0) break
                out.write(buf, 0, n)
                if (out.size() > Codec.MAX_MESSAGE_BYTES) return null
            }
        }
        return out.toByteArray()
    }

    companion object {
        const val TAG = "SahayRelay"
        const val SERVICE_ID = "in.sahay.nearby"
        /** Nearby's documented cap for a BYTES payload; anything larger must be a stream. */
        private const val MAX_BYTES_PAYLOAD = 32 * 1024
        private val STRATEGY = Strategy.P2P_CLUSTER

        fun requiredPermissions(): List<String> = buildList {
            add(Manifest.permission.ACCESS_FINE_LOCATION)
            add(Manifest.permission.ACCESS_COARSE_LOCATION)
            if (Build.VERSION.SDK_INT >= 31) {
                add(Manifest.permission.BLUETOOTH_ADVERTISE)
                add(Manifest.permission.BLUETOOTH_CONNECT)
                add(Manifest.permission.BLUETOOTH_SCAN)
            }
            if (Build.VERSION.SDK_INT >= 33) add(Manifest.permission.NEARBY_WIFI_DEVICES)
        }
    }
}
