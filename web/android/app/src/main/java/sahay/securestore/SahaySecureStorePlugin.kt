package sahay.securestore

import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * Capacitor plugin `SahaySecureStore`: a thin adapter over [SecureVault] (the Keystore-backed encryption lives
 * there so the native uploader can read the bearer token too). Not a general key/value store: keep it to secrets.
 */
@CapacitorPlugin(name = "SahaySecureStore")
class SahaySecureStorePlugin : Plugin() {
    private val vault by lazy { SecureVault(context) }

    @PluginMethod
    fun set(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key.isNullOrEmpty() || value == null) return call.reject("key and value are required")
        try {
            vault.set(key, value)
            call.resolve()
        } catch (e: Exception) {
            call.reject("could not store value: ${e.javaClass.simpleName}")
        }
    }

    @PluginMethod
    fun get(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        call.resolve(JSObject().put("value", vault.get(key)))
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val key = call.getString("key") ?: return call.reject("key is required")
        vault.remove(key)
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        vault.clear()
        call.resolve()
    }

    /** `hardwareBacked` is true when the key sits in a TEE or StrongBox, not just in software. */
    @PluginMethod
    fun info(call: PluginCall) {
        call.resolve(JSObject().put("hardwareBacked", vault.hardwareBacked()).put("native", true))
    }
}
