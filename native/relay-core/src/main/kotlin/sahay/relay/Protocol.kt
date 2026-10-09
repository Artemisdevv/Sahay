package sahay.relay

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

/** Wire messages between phones (api-contract.md section 5). One UTF-8 JSON object per message. */
sealed class Msg {
    data class Hello(val deviceId: String, val carrying: List<String>, val app: String = APP, val v: Int = VERSION) : Msg()
    data class Envelope(val envelope: JsonObject) : Msg()
    data class Ack(val reportId: String) : Msg()
    data class Receipt(val reportId: String, val receipt: JsonObject) : Msg()
    data class Status(val reportId: String, val status: String, val message: String, val signature: String = "") : Msg()

    companion object {
        const val APP = "sahay"
        const val VERSION = 1
    }
}

object Codec {
    /** Reject anything bigger than this before parsing: 200 KB audio, base64, JSON overhead, with headroom. */
    const val MAX_MESSAGE_BYTES = 700 * 1024

    private val json = Json { ignoreUnknownKeys = true }

    fun encode(msg: Msg): ByteArray {
        val obj = when (msg) {
            is Msg.Hello -> buildJsonObject {
                put("t", "hello"); put("app", msg.app); put("v", msg.v); put("device_id", msg.deviceId)
                put("carrying", JsonArray(msg.carrying.map { JsonPrimitive(it) }))
            }
            is Msg.Envelope -> buildJsonObject { put("t", "envelope"); put("envelope", msg.envelope) }
            is Msg.Ack -> buildJsonObject { put("t", "ack"); put("report_id", msg.reportId) }
            is Msg.Receipt -> buildJsonObject { put("t", "receipt"); put("report_id", msg.reportId); put("receipt", msg.receipt) }
            is Msg.Status -> buildJsonObject {
                put("t", "status"); put("report_id", msg.reportId); put("status", msg.status); put("message", msg.message)
                put("signature", msg.signature)
            }
        }
        return obj.toString().toByteArray(Charsets.UTF_8)
    }

    /** Returns null for anything that is not a well-formed Sahay message (unknown types are ignored, not fatal). */
    fun decode(bytes: ByteArray): Msg? {
        if (bytes.isEmpty() || bytes.size > MAX_MESSAGE_BYTES) return null
        return try {
            val o = json.parseToJsonElement(String(bytes, Charsets.UTF_8)).jsonObject
            when (o.str("t")) {
                "hello" -> Msg.Hello(
                    deviceId = o.str("device_id") ?: return null,
                    carrying = (o["carrying"] as? JsonArray)?.mapNotNull { (it as? JsonPrimitive)?.contentOrNull } ?: emptyList(),
                    app = o.str("app") ?: return null,
                    v = o["v"]?.jsonPrimitive?.intOrNull ?: return null,
                )
                "envelope" -> Msg.Envelope(o["envelope"] as? JsonObject ?: return null)
                "ack" -> Msg.Ack(o.str("report_id") ?: return null)
                "receipt" -> Msg.Receipt(o.str("report_id") ?: return null, o["receipt"] as? JsonObject ?: return null)
                "status" -> Msg.Status(o.str("report_id") ?: return null, o.str("status") ?: return null, o.str("message") ?: "", o.str("signature") ?: "")
                else -> null
            }
        } catch (e: Exception) {
            null
        }
    }

    private fun JsonObject.str(k: String): String? = (this[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
}

/** Cheap structural check a relay can do without any key (full signature check happens at the server). */
object EnvelopeCheck {
    /** Returns null when acceptable, else a short reason. */
    fun problem(env: JsonObject): String? {
        fun s(k: String) = (env[k] as? JsonPrimitive)?.takeIf { it.isString }?.content
        if (num(env["envelope_version"]) != 1) return "envelope_version"
        for (k in listOf("report_id", "device_id", "created_at")) if (s(k).isNullOrEmpty()) return k
        if (s("report_id")!!.length > MAX_ID_LENGTH) return "report_id"
        val ct = s("ciphertext")?.takeIf { it.isNotEmpty() } ?: return "ciphertext"
        val sig = s("signature")?.takeIf { it.isNotEmpty() } ?: return "signature"
        val ttl = num(env["ttl"]) ?: return "ttl"
        if (ttl < 0 || ttl > MAX_TTL) return "ttl"
        val hops = if (env.containsKey("hops")) num(env["hops"]) ?: return "hops" else 0
        if (hops < 0) return "hops"
        if (Base64Check.decodedLength(ct) == null) return "base64"
        return if (Base64Check.decodedLength(sig) != 64) "signature length" else null
    }

    /** Integer fields must be real JSON numbers: the library would happily coerce the string "5". */
    private fun num(e: JsonElement?): Int? = (e as? JsonPrimitive)?.takeIf { !it.isString }?.intOrNull

    const val MAX_TTL = 10
    const val MAX_ID_LENGTH = 128
    fun reportId(env: JsonObject): String = env["report_id"]!!.jsonPrimitive.content
    fun ttl(env: JsonObject): Int = num(env["ttl"])!!
    fun hops(env: JsonObject): Int = num(env["hops"]) ?: 0

    fun withHops(env: JsonObject, hops: Int): JsonObject =
        JsonObject(env.toMutableMap().apply { put("hops", JsonPrimitive(hops)) })
}

/** Strict standard base64 (padded) length check with no java.util.Base64, which is missing below Android 8. */
object Base64Check {
    fun decodedLength(s: String): Int? {
        if (s.isEmpty() || s.length % 4 != 0) return null
        var pad = 0
        for ((i, c) in s.withIndex()) {
            val ok = c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9' || c == '+' || c == '/'
            if (c == '=' && i >= s.length - 2) { pad++; continue }
            if (!ok || pad > 0) return null
        }
        return s.length / 4 * 3 - pad
    }
}
