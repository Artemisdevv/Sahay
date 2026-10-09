package sahay.relay.demo

import android.os.Bundle
import android.util.Base64
import android.widget.Button
import android.widget.ScrollView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import sahay.relay.EnvelopeCheck
import sahay.relay.FileStore
import sahay.relay.RelayEngine
import sahay.relay.RelayListener
import sahay.relay.android.Mode
import sahay.relay.android.NearbyTransport
import java.io.File
import java.util.UUID

/**
 * N-03 demo: two phones, no server. Phone A "New report" -> relays over Nearby -> Phone B shows it and,
 * with "Simulate upload + receipt", sends a receipt and status back so Phone A shows them.
 */
class MainActivity : AppCompatActivity(), RelayListener {
    private lateinit var status: TextView
    private lateinit var logView: TextView
    private lateinit var scroll: ScrollView
    private lateinit var transport: NearbyTransport
    private lateinit var engine: RelayEngine
    private lateinit var deviceId: String

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        status = findViewById(R.id.status); logView = findViewById(R.id.log); scroll = findViewById(R.id.scroll)

        val prefs = getSharedPreferences("relay-demo", MODE_PRIVATE)
        deviceId = prefs.getString("device_id", null) ?: UUID.randomUUID().toString().take(8).also { prefs.edit().putString("device_id", it).apply() }

        transport = NearbyTransport(this, deviceId, ::log)
        engine = RelayEngine(deviceId, transport, FileStore(File(filesDir, "relay")), this)
        transport.engine = engine
        log("device $deviceId, carrying ${engine.carryingCount()}, pending ${engine.pendingForUpload().size}")

        findViewById<Button>(R.id.btnStart).setOnClickListener { start() }
        findViewById<Button>(R.id.btnStop).setOnClickListener { transport.stop(); setStatus("stopped") }
        findViewById<Button>(R.id.btnSmall).setOnClickListener { newReport(2) }
        findViewById<Button>(R.id.btnBig).setOnClickListener { newReport(150) }
        findViewById<Button>(R.id.btnUpload).setOnClickListener { simulateUpload() }
    }

    override fun onDestroy() {
        transport.stop()
        super.onDestroy()
    }

    private fun start() {
        val missing = transport.missingPermissions()
        if (missing.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, missing.toTypedArray(), 7)
            return
        }
        transport.start(Mode.BOTH)
        setStatus("relay on, peers=0")
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, results: IntArray) {
        super.onRequestPermissionsResult(code, perms, results)
        if (code != 7) return
        if (results.all { it == 0 }) start() else log("permissions denied: ${perms.filterIndexed { i, _ -> results[i] != 0 }.joinToString { it.substringAfterLast('.') }}")
    }

    private fun newReport(kb: Int) {
        val id = "rep-" + UUID.randomUUID().toString().take(8)
        val ct = Base64.encodeToString(ByteArray(kb * 1024).also { java.util.Random(1).nextBytes(it) }, Base64.NO_WRAP)
        val env = buildJsonObject {
            put("envelope_version", 1); put("report_id", id); put("device_id", deviceId)
            put("created_at", "2026-10-09T10:15:00Z"); put("ttl", 5); put("key_id", "k1")
            put("ciphertext", ct)
            put("signature", Base64.encodeToString(ByteArray(64) { 7 }, Base64.NO_WRAP))
        }
        engine.enqueueOwn(env)
        log("NEW own report $id (${kb} KB), peers=${engine.connectedPeerCount()}")
    }

    /** Pretend this phone has internet: "upload" everything it carries for others and send receipt + status back. */
    private fun simulateUpload() {
        val carried = engine.pendingForUpload().filter { it["device_id"]?.jsonPrimitive?.content != deviceId }
        if (carried.isEmpty()) { log("nothing carried for others"); return }
        for (env in carried) {
            val id = EnvelopeCheck.reportId(env)
            val receipt = buildJsonObject {
                put("server_time", "2026-10-09T10:15:02Z")
                put("signature", Base64.encodeToString(ByteArray(64) { 9 }, Base64.NO_WRAP))
            }
            engine.relayReceipt(id, receipt)
            engine.relayStatus(id, "dispatched", "Help dispatched, ETA 6 min")
            log("UPLOADED $id -> receipt+status sent back")
        }
        refresh()
    }

    private fun refresh() = setStatus("peers=${engine.connectedPeerCount()} carrying=${engine.carryingCount()} pending=${engine.pendingForUpload().size}")

    // ---- RelayListener ---------------------------------------------------------------------------
    override fun onPeerConnected(deviceId: String) { log("PEER UP $deviceId"); refresh() }
    override fun onPeerLost(deviceId: String) { log("PEER LOST $deviceId"); refresh() }
    override fun onEnvelopeReceived(envelope: JsonObject, fromPeer: String) {
        val bytes = envelope["ciphertext"]?.jsonPrimitive?.content?.length ?: 0
        log("RECEIVED ${EnvelopeCheck.reportId(envelope)} from $fromPeer hops=${EnvelopeCheck.hops(envelope)} ct=${bytes * 3 / 4 / 1024} KB")
        refresh()
    }
    override fun onReceipt(reportId: String, receipt: JsonObject) { log("RECEIPT for $reportId (delivered)"); refresh() }
    override fun onStatus(reportId: String, status: String, message: String) { log("STATUS $reportId $status: $message") }

    private fun setStatus(s: String) = runOnUiThread { status.text = s }
    private fun log(s: String) {
        android.util.Log.i("SahayRelay", s)
        runOnUiThread { logView.append(s + "\n"); scroll.post { scroll.fullScroll(ScrollView.FOCUS_DOWN) } }
    }
}
