package sahay.relay

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.Json

/** Result of one POST. `status == 0` means the request never got an answer (no connection, timeout). */
class HttpResult(val status: Int, val body: String = "")

fun interface UploadHttp {
    /** POST the sealed envelope to `/reports` with the device token. Must not throw: report failures as status 0. */
    fun post(envelopeJson: String, token: String): HttpResult
}

/**
 * Uploads the reports this phone is *carrying for other people* straight from the native layer.
 *
 * Why it exists: the web layer does the uploading while the app is open, but with the screen off the WebView is
 * throttled and neither the relay event nor the 30 s timer reliably runs (seen on a Moto G96). The relay and its
 * foreground service keep running, so this runs there. It only touches reports carried for others; a phone's own
 * reports stay with the app's queue (the server is idempotent, so a double upload is harmless).
 *
 * Rules, per envelope (contract 2.2):
 *  200/202  delivered: hand the server receipt to the engine (it travels back along the path) and stop carrying
 *  400/409/413/422  the server will never accept it: stop carrying
 *  401  the token is stale: stop this round, keep everything, the app refreshes the token when it opens
 *  429, 5xx, no answer  try again later: stop this round so we do not hammer a struggling server
 */
class CarriedUploader(
    private val engine: RelayEngine,
    private val http: UploadHttp,
    private val token: () -> String?,
    private val online: () -> Boolean,
) {
    data class Summary(
        val delivered: Int = 0,
        val dropped: Int = 0,
        val waiting: Int = 0,
        val skipped: String? = null,
    )

    private val permanent = setOf(400, 409, 413, 422)

    fun attempt(): Summary {
        val carried = engine.pendingCarried()
        if (carried.isEmpty()) return Summary()
        if (!online()) return Summary(waiting = carried.size, skipped = "offline")
        val jwt = token() ?: return Summary(waiting = carried.size, skipped = "no token")
        var delivered = 0
        var dropped = 0
        for ((index, envelope) in carried.withIndex()) {
            val reportId = EnvelopeCheck.reportId(envelope)
            val result = http.post(envelope.toString(), jwt)
            when {
                result.status == 200 || result.status == 202 -> {
                    receiptOf(result.body)?.let { engine.relayReceipt(reportId, it) }
                    engine.markDelivered(reportId)
                    delivered++
                }
                result.status in permanent -> {
                    engine.markDelivered(reportId)
                    dropped++
                }
                result.status == 401 -> return Summary(delivered, dropped, carried.size - index, "token rejected")
                else -> return Summary(delivered, dropped, carried.size - index, "server busy or unreachable (${result.status})")
            }
        }
        return Summary(delivered, dropped)
    }

    private fun receiptOf(body: String): JsonObject? = try {
        Json.parseToJsonElement(body).jsonObject["receipt"]?.jsonObject
    } catch (e: Exception) {
        null
    }
}
