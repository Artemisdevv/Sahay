package sahay.securestore

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

/**
 * Capacitor plugin `SahaySecureStore`: small secrets (the device signing seed, the bearer token) encrypted with
 * an AES-256-GCM key that lives in the Android Keystore and never leaves it. Values are stored as
 * base64(iv | ciphertext+tag) in app-private SharedPreferences; the entry name is bound in as AAD, so an
 * encrypted value cannot be moved to another name. Not a general key/value store: keep it to secrets.
 */
@CapacitorPlugin(name = "SahaySecureStore")
class SahaySecureStorePlugin : Plugin() {
    private val prefs by lazy { context.getSharedPreferences(PREFS, Context.MODE_PRIVATE) }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key.isNullOrEmpty() || value == null) return call.reject("key and value are required")
        try {
            prefs.edit().putString(key, encrypt(key, value)).apply()
            call.resolve()
        } catch (e: Exception) {
            call.reject("could not store value: ${e.javaClass.simpleName}")
        }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        val stored = prefs.getString(key, null)
        val result = JSObject()
        if (stored == null) {
            result.put("value", null as String?)
            return call.resolve(result)
        }
        try {
            result.put("value", decrypt(key, stored))
        } catch (e: Exception) {
            // Keystore key was reset (new lock screen, factory data wipe restore...) or the entry was tampered with.
            Log.w(TAG, "dropping unreadable entry '$key': ${e.javaClass.simpleName}")
            prefs.edit().remove(key).apply()
            result.put("value", null as String?)
        }
        call.resolve(result)
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        prefs.edit().remove(key).apply()
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        prefs.edit().clear().apply()
        call.resolve()
    }

    /** `hardwareBacked` is true when the key sits in a TEE or StrongBox, not just in software. */
    @PluginMethod
    fun info(call: PluginCall) {
        val hardware = try {
            val info = SecretKeyFactory.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
                .getKeySpec(masterKey(), KeyInfo::class.java) as KeyInfo
            info.isInsideSecureHardware
        } catch (e: Exception) {
            false
        }
        call.resolve(JSObject().put("hardwareBacked", hardware).put("native", true))
    }

    // ---- crypto ---------------------------------------------------------------------------------

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

    companion object {
        private const val TAG = "SahaySecureStore"
        private const val PREFS = "sahay_secure"
        private const val KEYSTORE = "AndroidKeyStore"
        private const val ALIAS = "sahay_master_v1"
        private const val TRANSFORM = "AES/GCM/NoPadding"
        private const val IV_BYTES = 12
        private const val TAG_BITS = 128
    }
}
