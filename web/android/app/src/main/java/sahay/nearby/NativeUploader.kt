package sahay.nearby

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.util.Base64
import android.util.Log
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import sahay.relay.CarriedUploader
import sahay.relay.HttpResult
import sahay.relay.RelayEngine
import sahay.relay.UploadHttp
import sahay.securestore.SecureVault
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Android side of [CarriedUploader]: uploads the reports this phone carries for others from the relay's foreground
 * service, so a phone with its screen off (WebView asleep) still delivers them.
 *
 * Triggers: a sealed report just arrived over Nearby, the internet came back, and a 30 s timer. Config: the API
 * base URL (passed by the web layer when it starts the relay) and the device bearer token (read from the Keystore
 * vault, written there by the web layer). The token lives 12 h and is refreshed by the web layer whenever the app
 * is opened; if it has expired the uploader waits quietly and the app takes over when it is opened.
 */
class NativeUploader(context: Context, private val engine: () -> RelayEngine?) {
    private val app = context.applicationContext
    private val vault = SecureVault(app)
    private val prefs = app.getSharedPreferences("sahay_relay_cfg", Context.MODE_PRIVATE)
    private val pool: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor { r ->
        Thread(r, "sahay-native-upload").apply { isDaemon = true }
    }
    private val connectivity = app.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
    private val queued = AtomicBoolean(false)
    private var timer: ScheduledFuture<*>? = null
    private var callback: ConnectivityManager.NetworkCallback? = null

    @Synchronized
    fun configure(apiBase: String?) {
        if (!apiBase.isNullOrBlank()) prefs.edit().putString(KEY_API, apiBase.trim().trimEnd('/')).apply()
        if (timer == null) {
            timer = pool.scheduleWithFixedDelay({ run() }, 15, 30, TimeUnit.SECONDS)
            val cb = object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = kick()
            }
            try {
                connectivity.registerDefaultNetworkCallback(cb)
                callback = cb
            } catch (e: Exception) {
                Log.w(TAG, "no network callback: ${e.javaClass.simpleName}")
            }
        }
    }

    /** Try soon (coalesced): a report just arrived or the network came back. */
    fun kick() {
        if (queued.compareAndSet(false, true)) pool.schedule({ queued.set(false); run() }, 1, TimeUnit.SECONDS)
    }

    @Synchronized
    fun stop() {
        timer?.cancel(false)
        timer = null
        callback?.let { runCatching { connectivity.unregisterNetworkCallback(it) } }
        callback = null
    }

    private fun run() {
        val eng = engine() ?: return
        val base = prefs.getString(KEY_API, null) ?: return
        try {
            val summary = CarriedUploader(eng, http(base), ::token, ::online).attempt()
            if (summary.delivered + summary.dropped > 0 || summary.skipped == "token rejected") {
                Log.i(TAG, "carried reports: $summary")
            }
        } catch (e: Exception) {
            Log.w(TAG, "upload round failed: ${e.javaClass.simpleName}")
        }
    }

    /** The bearer token, unless it is missing or about to expire (the server would answer 401 anyway). */
    private fun token(): String? {
        val jwt = vault.get(TOKEN_KEY) ?: return null
        val exp = try {
            val payload = String(Base64.decode(jwt.split('.')[1], Base64.URL_SAFE or Base64.NO_PADDING), Charsets.UTF_8)
            Json.parseToJsonElement(payload).jsonObject["exp"]?.jsonPrimitive?.longOrNull
        } catch (e: Exception) {
            null
        }
        return if (exp != null && exp - System.currentTimeMillis() / 1000 > 30) jwt else null
    }

    private fun online(): Boolean {
        val caps = connectivity.getNetworkCapabilities(connectivity.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    private fun http(apiBase: String) = UploadHttp { envelopeJson, jwt ->
        var conn: HttpURLConnection? = null
        try {
            conn = (URL("$apiBase/reports").openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 10_000
                readTimeout = 20_000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Authorization", "Bearer $jwt")
                setRequestProperty("ngrok-skip-browser-warning", "1")  // ngrok's free tier answers browsers with an HTML page
            }
            conn.outputStream.use { it.write(envelopeJson.toByteArray(Charsets.UTF_8)) }
            val status = conn.responseCode
            val stream = if (status in 200..399) conn.inputStream else conn.errorStream
            HttpResult(status, stream?.use { String(it.readBytes().take(MAX_BODY).toByteArray(), Charsets.UTF_8) } ?: "")
        } catch (e: Exception) {
            HttpResult(0)
        } finally {
            conn?.disconnect()
        }
    }

    private companion object {
        const val TAG = "SahayNativeUpload"
        const val KEY_API = "api_base"
        const val TOKEN_KEY = "device.token"  // the web layer's name for it (web/src/lib/device-identity.ts)
        const val MAX_BODY = 64 * 1024
    }
}
