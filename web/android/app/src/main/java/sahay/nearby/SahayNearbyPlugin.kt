package sahay.nearby

import android.Manifest
import android.os.Build
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import sahay.relay.FileStore
import sahay.relay.RelayEngine
import sahay.relay.RelayListener
import sahay.relay.ServerVerifier
import sahay.relay.android.Mode
import sahay.relay.android.NearbyTransport
import java.io.File

/**
 * Capacitor plugin `SahayNearby` (api-contract.md section 5). A thin adapter: all protocol rules live in
 * relay-core (JVM-tested), all radio code in relay-android. This class only translates JS calls and events.
 *
 * Receipts and statuses from nearby phones are applied only if they verify against the server Ed25519 key that
 * the web layer passes to `start` (`ed25519_public_key` from GET /config/server-key).
 */
@CapacitorPlugin(
    name = "SahayNearby",
    permissions = [
        Permission(alias = "location", strings = [Manifest.permission.ACCESS_FINE_LOCATION, Manifest.permission.ACCESS_COARSE_LOCATION]),
        Permission(alias = "bluetooth", strings = [
            Manifest.permission.BLUETOOTH_ADVERTISE, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.BLUETOOTH_SCAN,
        ]),
        Permission(alias = "wifi", strings = [Manifest.permission.NEARBY_WIFI_DEVICES]),
        Permission(alias = "notifications", strings = [Manifest.permission.POST_NOTIFICATIONS]),
    ],
)
class SahayNearbyPlugin : Plugin(), RelayListener {
    // The relay outlives this plugin: with the foreground service running it must keep working after the Activity
    // (and so this plugin instance) is destroyed, e.g. the user presses Back. State lives in [RelaySession].
    private val engine get() = RelaySession.engine
    private val transport get() = RelaySession.transport
    private val startedAs get() = RelaySession.startedAs

    override fun load() {
        RelaySession.sink = this
        RelayForegroundService.onStopRequested = { stopRelay() }
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    @PluginMethod
    fun start(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        val key = call.getString("serverVerifyKey")
        if (deviceId.isNullOrBlank() || key.isNullOrBlank()) {
            return call.reject("deviceId and serverVerifyKey (ed25519_public_key from /config/server-key) are required")
        }
        val missing = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        // Notifications are asked in the same dialog round but never required (see notificationsToAsk).
        val ask = missing + notificationsToAsk()
        if (ask.isNotEmpty()) {
            requestPermissionForAliases(ask.toTypedArray(), call, "permissionsResult")
            return
        }
        startRelay(call)
    }

    @PermissionCallback
    private fun permissionsResult(call: PluginCall) {
        val still = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (still.isEmpty()) startRelay(call) else call.reject("Missing permissions: ${still.joinToString()}")
    }

    private fun startRelay(call: PluginCall) {
        val deviceId = call.getString("deviceId")!!
        val verifier = ServerVerifier(call.getString("serverVerifyKey")!!)
        val mode = when (call.getString("mode", "both")) {
            "advertise" -> Mode.ADVERTISE
            "discover" -> Mode.DISCOVER
            else -> Mode.BOTH
        }
        try {
            synchronized(this) {
                if (engine != null && startedAs == deviceId) {   // already running for this device: just apply the mode
                    transport?.stop()
                    transport?.start(mode)
                    return@synchronized
                }
                transport?.stop()
                val t = NearbyTransport(context.applicationContext, deviceId)
                val e = RelayEngine(
                    deviceId, t, FileStore(File(context.filesDir, "relay")), RelaySession.forwarder,
                    receiptVerifier = verifier::receipt, statusVerifier = verifier::status,
                )
                t.engine = e
                t.start(mode)
                RelaySession.transport = t; RelaySession.engine = e; RelaySession.startedAs = deviceId
            }
            startService()
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "could not start relay")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        stopRelay()
        call.resolve()
    }

    private fun stopRelay() {
        synchronized(RelaySession) { RelaySession.reset() }
        RelayForegroundService.stop(context.applicationContext)
    }

    /** Foreground service keeps the relay alive with the screen off. A refusal (e.g. notifications blocked) must not kill the relay. */
    private fun startService() {
        try {
            RelayForegroundService.start(context.applicationContext)
        } catch (e: Exception) {
            android.util.Log.w("SahayNearby", "foreground service not started: ${e.message}")
        }
    }

    override fun handleOnDestroy() {
        // Do NOT stop the transport: the foreground service exists so the relay keeps running without the UI.
        if (RelaySession.sink === this) RelaySession.sink = null
        super.handleOnDestroy()
    }

    // ---- queue ----------------------------------------------------------------------------------

    @PluginMethod
    fun enqueue(call: PluginCall) = withEngine(call) { e ->
        e.enqueueOwn(json(call.getObject("envelope") ?: return@withEngine call.reject("envelope is required")))
        call.resolve()
    }

    @PluginMethod
    fun markDelivered(call: PluginCall) = withEngine(call) { e ->
        e.markDelivered(call.getString("reportId") ?: return@withEngine call.reject("reportId is required"))
        call.resolve()
    }

    @PluginMethod
    fun relayReceipt(call: PluginCall) = withEngine(call) { e ->
        val id = call.getString("reportId") ?: return@withEngine call.reject("reportId is required")
        e.relayReceipt(id, json(call.getObject("receipt") ?: return@withEngine call.reject("receipt is required")))
        call.resolve()
    }

    @PluginMethod
    fun relayStatus(call: PluginCall) = withEngine(call) { e ->
        val id = call.getString("reportId") ?: return@withEngine call.reject("reportId is required")
        e.relayStatus(
            id, call.getString("status", "") ?: "", call.getString("message", "") ?: "",
            call.getString("signature", "") ?: "", call.getString("updatedAt", "") ?: "",
        )
        call.resolve()
    }

    @PluginMethod
    fun pendingForUpload(call: PluginCall) = withEngine(call) { e ->
        val arr = JSArray()
        e.pendingForUpload().forEach { arr.put(JSObject(it.toString())) }
        call.resolve(JSObject().put("envelopes", arr))
    }

    @PluginMethod
    fun carryingCount(call: PluginCall) = withEngine(call) { e ->
        call.resolve(JSObject().put("count", e.carryingCount()))
    }

    // ---- engine -> JS events --------------------------------------------------------------------

    override fun onPeerConnected(deviceId: String) { notifyListeners("peerConnected", JSObject().put("peerId", deviceId)) }

    override fun onPeerLost(deviceId: String) { notifyListeners("peerLost", JSObject().put("peerId", deviceId)) }

    override fun onEnvelopeReceived(envelope: JsonObject, fromPeer: String) {
        notifyListeners("envelopeReceived", JSObject().put("envelope", JSObject(envelope.toString())).put("fromPeer", fromPeer))
    }

    override fun onReceipt(reportId: String, receipt: JsonObject) {
        notifyListeners("receiptReceived", JSObject().put("reportId", reportId).put("receipt", JSObject(receipt.toString())))
    }

    override fun onStatus(reportId: String, status: String, message: String) {
        notifyListeners("statusReceived", JSObject().put("reportId", reportId).put("status", status).put("message", message))
    }

    // ---- helpers --------------------------------------------------------------------------------

    private fun withEngine(call: PluginCall, block: (RelayEngine) -> Unit) {
        val e = engine ?: return call.reject("relay not started: call start() first")
        try { block(e) } catch (ex: IllegalArgumentException) { call.reject(ex.message ?: "bad request") }
    }

    private fun json(o: JSObject): JsonObject = Json.parseToJsonElement(o.toString()).jsonObject

    /** Which permission groups this Android version needs (location always; Bluetooth 12+; nearby Wi-Fi 13+). */
    private fun requiredAliases(): List<String> = buildList {
        add("location")
        if (Build.VERSION.SDK_INT >= 31) add("bluetooth")
        if (Build.VERSION.SDK_INT >= 33) add("wifi")
    }

    /**
     * Android 13+: the relay notification is hidden until POST_NOTIFICATIONS is granted. The service still runs without it,
     * so it is asked once (state PROMPT) and a denial never blocks start().
     */
    private fun notificationsToAsk(): List<String> {
        if (Build.VERSION.SDK_INT < 33) return emptyList()
        val state = getPermissionState("notifications")
        return if (state == PermissionState.PROMPT || state == PermissionState.PROMPT_WITH_RATIONALE) listOf("notifications") else emptyList()
    }
}

/** Process-wide relay state, shared by the plugin and the foreground service lifetime. */
private object RelaySession {
    @Volatile var engine: RelayEngine? = null
    @Volatile var transport: NearbyTransport? = null
    @Volatile var startedAs: String? = null

    /** Receives engine events; null while no UI is attached (reports stay in the store, see pendingForUpload). */
    @Volatile var sink: RelayListener? = null

    val forwarder = object : RelayListener {
        override fun onPeerConnected(deviceId: String) { sink?.onPeerConnected(deviceId) }
        override fun onPeerLost(deviceId: String) { sink?.onPeerLost(deviceId) }
        override fun onEnvelopeReceived(envelope: JsonObject, fromPeer: String) { sink?.onEnvelopeReceived(envelope, fromPeer) }
        override fun onReceipt(reportId: String, receipt: JsonObject) { sink?.onReceipt(reportId, receipt) }
        override fun onStatus(reportId: String, status: String, message: String) { sink?.onStatus(reportId, status, message) }
    }

    fun reset() {
        transport?.stop(); transport = null; engine = null; startedAs = null
    }
}
