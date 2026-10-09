package `in`.sahay.spike

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Base64
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
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
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlin.concurrent.thread

/**
 * N-02 spike. Two phones: one taps Advertise, the other taps Discover. They auto-connect,
 * swap the app "hello" handshake (contract section 5), then Send 50 KB streams a fake
 * envelope. Receiver logs size, sha256 and elapsed time.
 */
class MainActivity : AppCompatActivity() {

    private val serviceId = "in.sahay.nearby"
    private val strategy = Strategy.P2P_CLUSTER
    private val deviceId = UUID.randomUUID().toString()

    private val client by lazy { Nearby.getConnectionsClient(this) }
    private val peers: MutableSet<String> = ConcurrentHashMap.newKeySet()
    private val pending: MutableSet<String> = ConcurrentHashMap.newKeySet()

    private lateinit var statusView: TextView
    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        statusView = findViewById(R.id.status)
        logView = findViewById(R.id.log)
        scroll = findViewById(R.id.scroll)

        findViewById<Button>(R.id.btnAdvertise).setOnClickListener { withPerms { startAdvertising() } }
        findViewById<Button>(R.id.btnDiscover).setOnClickListener { withPerms { startDiscovery() } }
        findViewById<Button>(R.id.btnSend).setOnClickListener { sendEnvelope() }
        findViewById<Button>(R.id.btnStop).setOnClickListener { stopAll() }

        log("device ${deviceId.take(8)} sdk ${Build.VERSION.SDK_INT} ${Build.MODEL}")
    }

    override fun onDestroy() {
        stopAll()
        super.onDestroy()
    }

    // ---- permissions ----------------------------------------------------

    private fun requiredPerms(): Array<String> {
        val p = mutableListOf<String>()
        // Location is required for discovery on every version (verified: Android 16 fails without it)
        p += Manifest.permission.ACCESS_FINE_LOCATION
        p += Manifest.permission.ACCESS_COARSE_LOCATION
        if (Build.VERSION.SDK_INT >= 31) {
            p += Manifest.permission.BLUETOOTH_ADVERTISE
            p += Manifest.permission.BLUETOOTH_CONNECT
            p += Manifest.permission.BLUETOOTH_SCAN
        }
        if (Build.VERSION.SDK_INT >= 33) p += Manifest.permission.NEARBY_WIFI_DEVICES
        return p.toTypedArray()
    }

    private var afterPerms: (() -> Unit)? = null

    private fun withPerms(action: () -> Unit) {
        val missing = requiredPerms().filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (missing.isEmpty()) {
            action()
        } else {
            afterPerms = action
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 42)
        }
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code != 42) return
        val denied = perms.filterIndexed { i, _ -> results[i] != PackageManager.PERMISSION_GRANTED }
        if (denied.isEmpty()) {
            afterPerms?.invoke()
        } else {
            log("DENIED: ${denied.joinToString { it.substringAfterLast('.') }}")
        }
        afterPerms = null
    }

    // ---- nearby ---------------------------------------------------------

    private fun startAdvertising() {
        val opts = AdvertisingOptions.Builder().setStrategy(strategy).build()
        client.startAdvertising("sahay-${deviceId.take(6)}", serviceId, connCallbacks, opts)
            .addOnSuccessListener { setStatus("advertising"); log("advertising started") }
            .addOnFailureListener { log("advertise FAIL: ${it.message}") }
    }

    private fun startDiscovery() {
        val opts = DiscoveryOptions.Builder().setStrategy(strategy).build()
        client.startDiscovery(serviceId, discovery, opts)
            .addOnSuccessListener { setStatus("discovering"); log("discovery started") }
            .addOnFailureListener { log("discover FAIL: ${it.message}") }
    }

    private fun stopAll() {
        client.stopAdvertising()
        client.stopDiscovery()
        client.stopAllEndpoints()
        peers.clear()
        pending.clear()
        setStatus("idle")
    }

    private val discovery = object : EndpointDiscoveryCallback() {
        override fun onEndpointFound(id: String, info: DiscoveredEndpointInfo) {
            log("found $id (${info.endpointName})")
            client.requestConnection("sahay-${deviceId.take(6)}", id, connCallbacks)
                .addOnFailureListener { log("requestConnection FAIL: ${it.message}") }
        }

        override fun onEndpointLost(id: String) = log("lost $id")
    }

    private val connCallbacks = object : ConnectionLifecycleCallback() {
        override fun onConnectionInitiated(id: String, info: ConnectionInfo) {
            log("initiated $id (${info.endpointName}), auto-accept")
            client.acceptConnection(id, payloads)
        }

        override fun onConnectionResult(id: String, result: ConnectionResolution) {
            if (result.status.statusCode == ConnectionsStatusCodes.STATUS_OK) {
                log("connected $id, sending hello")
                pending += id
                sendJson(
                    id,
                    JSONObject()
                        .put("t", "hello").put("app", "sahay").put("v", 1)
                        .put("device_id", deviceId).put("carrying", JSONArray())
                )
            } else {
                log("connect result $id: ${result.status.statusCode} ${result.status.statusMessage}")
            }
        }

        override fun onDisconnected(id: String) {
            peers -= id
            pending -= id
            log("disconnected $id")
            setStatus("peers=${peers.size}")
        }
    }

    // ---- payloads -------------------------------------------------------

    private val streamStart = ConcurrentHashMap<Long, Long>()

    private val payloads = object : PayloadCallback() {
        override fun onPayloadReceived(id: String, payload: Payload) {
            when (payload.type) {
                Payload.Type.BYTES -> handleBytes(id, payload.asBytes()!!)
                Payload.Type.STREAM -> {
                    streamStart[payload.id] = System.currentTimeMillis()
                    val input = payload.asStream()!!.asInputStream()
                    thread(name = "recv-${payload.id}") {
                        val md = MessageDigest.getInstance("SHA-256")
                        val buf = ByteArray(8192)
                        var total = 0L
                        try {
                            while (true) {
                                val n = input.read(buf)
                                if (n < 0) break
                                md.update(buf, 0, n)
                                total += n
                            }
                        } catch (e: Exception) {
                            log("stream read error: ${e.message}")
                        }
                        val ms = System.currentTimeMillis() - (streamStart[payload.id] ?: 0L)
                        log("RECV stream from $id: $total bytes, sha256=${hex(md.digest()).take(16)}, $ms ms")
                    }
                }
                else -> log("unhandled payload type ${payload.type}")
            }
        }

        override fun onPayloadTransferUpdate(id: String, u: PayloadTransferUpdate) {
            if (u.status == PayloadTransferUpdate.Status.FAILURE) log("transfer FAIL ${u.payloadId}")
        }
    }

    private fun handleBytes(id: String, bytes: ByteArray) {
        val j = try {
            JSONObject(String(bytes, Charsets.UTF_8))
        } catch (e: Exception) {
            log("bad json from $id")
            return
        }
        when (j.optString("t")) {
            "hello" -> {
                if (j.optString("app") != "sahay") {
                    log("non-sahay peer $id, disconnect")
                    client.disconnectFromEndpoint(id)
                } else {
                    pending -= id
                    peers += id
                    log("HANDSHAKE ok with $id (device ${j.optString("device_id").take(8)})")
                    setStatus("peers=${peers.size}")
                }
            }
            else -> log("msg ${j.optString("t")} from $id")
        }
    }

    private fun sendJson(id: String, j: JSONObject) {
        client.sendPayload(id, Payload.fromBytes(j.toString().toByteArray(Charsets.UTF_8)))
    }

    /** Fake ~50 KB envelope as a stream (BYTES payloads cap at 32 KB). */
    private fun sendEnvelope() {
        if (peers.isEmpty()) {
            log("no handshaken peers")
            return
        }
        val audio = ByteArray(37 * 1024).also { java.util.Random(7).nextBytes(it) }
        val env = JSONObject()
            .put("t", "envelope")
            .put(
                "envelope",
                JSONObject()
                    .put("report_id", UUID.randomUUID().toString())
                    .put("ttl", 2).put("hops", 0)
                    .put("ciphertext", Base64.encodeToString(audio, Base64.NO_WRAP))
            )
        val bytes = env.toString().toByteArray(Charsets.UTF_8)
        val sha = hex(MessageDigest.getInstance("SHA-256").digest(bytes)).take(16)
        for (id in peers) {
            client.sendPayload(id, Payload.fromStream(ByteArrayInputStream(bytes)))
            log("SEND stream to $id: ${bytes.size} bytes, sha256=$sha")
        }
    }

    // ---- ui helpers -----------------------------------------------------

    private fun hex(b: ByteArray) = b.joinToString("") { "%02x".format(it) }

    private fun setStatus(s: String) = runOnUiThread { statusView.text = s }

    private fun log(s: String) {
        android.util.Log.i("SahaySpike", s)
        runOnUiThread {
            logView.append("$s\n")
            scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) }
        }
    }
}
