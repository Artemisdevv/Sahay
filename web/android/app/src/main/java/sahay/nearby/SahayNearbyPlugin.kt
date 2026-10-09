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
    ],
)
class SahayNearbyPlugin : Plugin(), RelayListener {
    private var engine: RelayEngine? = null
    private var transport: NearbyTransport? = null
    private var startedAs: String? = null

    // ---- lifecycle ------------------------------------------------------------------------------

    @PluginMethod
    fun start(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        val key = call.getString("serverVerifyKey")
        if (deviceId.isNullOrBlank() || key.isNullOrBlank()) {
            return call.reject("deviceId and serverVerifyKey (ed25519_public_key from /config/server-key) are required")
        }
        val missing = requiredAliases().filter { getPermissionState(it) != PermissionState.GRANTED }
        if (missing.isNotEmpty()) {
            requestPermissionForAliases(missing.toTypedArray(), call, "permissionsResult")
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
                val t = NearbyTransport(context, deviceId)
                val e = RelayEngine(
                    deviceId, t, FileStore(File(context.filesDir, "relay")), this,
                    receiptVerifier = verifier::receipt, statusVerifier = verifier::status,
                )
                t.engine = e
                t.start(mode)
                transport = t; engine = e; startedAs = deviceId
            }
            call.resolve()
        } catch (e: Exception) {
            call.reject(e.message ?: "could not start relay")
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        synchronized(this) { transport?.stop(); transport = null; engine = null; startedAs = null }
        call.resolve()
    }

    override fun handleOnDestroy() {
        transport?.stop()
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
}
