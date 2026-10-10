package sahay.securestore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Small secrets (the device signing seed, the bearer token) encrypted with an AES-256-GCM key that lives in the
 * Android Keystore and never leaves it. Values are stored as base64(iv | ciphertext+tag) in app-private
 * SharedPreferences; the entry name is bound in as AAD, so an encrypted value cannot be moved to another name.
 *
 * Used by the Capacitor plugin `SahaySecureStore` (for the web layer) and by the native uploader, which has to read
 * the bearer token while the WebView is asleep. Not a general key/value store: keep it to secrets.
 */
class SecureVault(context: Context) {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun set(name: String, value: String) {
        prefs.edit().putString(name, encrypt(name, value)).apply()
    }

    /** The stored value, or null when absent or unreadable (an unreadable entry is dropped). */
    fun get(name: String): String? {
        val stored = prefs.getString(name, null) ?: return null
        return try {
            decrypt(name, stored)
        } catch (e: Exception) {
            // Keystore key was reset (new lock screen, factory data wipe restore...) or the entry was tampered with.
            Log.w(TAG, "dropping unreadable entry '$name': ${e.javaClass.simpleName}")
            prefs.edit().remove(name).apply()
            null
        }
    }

    fun remove(name: String) {
        prefs.edit().remove(name).apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    /** True when the Keystore key sits in a TEE or StrongBox, not just in software. */
    fun hardwareBacked(): Boolean = try {
        val info = SecretKeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
            .getKeySpec(masterKey(), KeyInfo::class.java) as KeyInfo
        info.isInsideSecureHardware
    } catch (e: Exception) {
        false
    }

    private fun masterKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getKey(ALIAS, null) as? SecretKey)?.let { return it }
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setRandomizedEncryptionRequired(true)
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE).apply { init(spec) }.generateKey()
    }

    private fun encrypt(name: String, plain: String): String {
        val cipher = Cipher.getInstance(TRANSFORM).apply { init(Cipher.ENCRYPT_MODE, masterKey()) }
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val body = cipher.doFinal(plain.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(cipher.iv + body, Base64.NO_WRAP)
    }

    private fun decrypt(name: String, stored: String): String {
        val raw = Base64.decode(stored, Base64.NO_WRAP)
        require(raw.size > IV_BYTES) { "entry too short" }
        val cipher = Cipher.getInstance(TRANSFORM)
            .apply { init(Cipher.DECRYPT_MODE, masterKey(), GCMParameterSpec(TAG_BITS, raw, 0, IV_BYTES)) }
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        return String(cipher.doFinal(raw, IV_BYTES, raw.size - IV_BYTES), Charsets.UTF_8)
    }

    private companion object {
        const val TAG = "SecureVault"
        const val PREFS = "sahay_secure"
        const val KEYSTORE = "AndroidKeyStore"
        const val ALIAS = "sahay_master_v1"
        const val TRANSFORM = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        const val TAG_BITS = 128
    }
}
