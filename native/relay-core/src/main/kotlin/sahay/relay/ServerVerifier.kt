package sahay.relay

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.bouncycastle.crypto.params.Ed25519PublicKeyParameters
import org.bouncycastle.crypto.signers.Ed25519Signer
import org.bouncycastle.util.encoders.Base64

/**
 * Verifies what the server signs for the back channel (api-contract.md sections 1 and 5), so a nearby phone
 * cannot forge "delivered" or a fake status. Plug [receipt] and [status] into [RelayEngine] as its verifiers.
 *
 * - Receipt: Ed25519 over UTF-8 `report_id|server_time`.
 * - Status:  Ed25519 over UTF-8 `report_id|status|message|updated_at`.
 *
 * [serverVerifyKeyB64] is `ed25519_public_key` from `GET /config/server-key`.
 */
class ServerVerifier(serverVerifyKeyB64: String) {
    private val key: Ed25519PublicKeyParameters? =
        try { Ed25519PublicKeyParameters(Base64.decode(serverVerifyKeyB64), 0) } catch (e: Exception) { null }

    fun receipt(reportId: String, receipt: JsonObject): Boolean {
        val serverTime = (receipt["server_time"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
        val sig = (receipt["signature"] as? JsonPrimitive)?.takeIf { it.isString }?.content ?: return false
        return verify("$reportId|$serverTime", sig)
    }

    fun status(m: Msg.Status): Boolean {
        if (m.signature.isEmpty() || m.updatedAt.isEmpty()) return false   // unsigned statuses are never trusted
        return verify("${m.reportId}|${m.status}|${m.message}|${m.updatedAt}", m.signature)
    }

    private fun verify(signingInput: String, signatureB64: String): Boolean {
        val k = key ?: return false
        return try {
            val sig = Base64.decode(signatureB64)
            if (sig.size != 64) return false
            val verifier = Ed25519Signer()
            verifier.init(false, k)
            val msg = signingInput.toByteArray(Charsets.UTF_8)
            verifier.update(msg, 0, msg.size)
            verifier.verifySignature(sig)
        } catch (e: Exception) {
            false
        }
    }
}
