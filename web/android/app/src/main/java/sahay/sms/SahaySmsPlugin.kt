package sahay.sms

import android.Manifest
import android.app.Activity
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.telephony.SmsManager
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import java.util.concurrent.atomic.AtomicInteger

/**
 * Capacitor plugin `SahaySms` (api-contract.md section 6): the last-resort leg of the delivery ladder.
 *
 * - `send` sends one text silently with SmsManager. Needs the SEND_SMS runtime permission, asked on first use.
 * - `openDialer` opens the dialer with the number prefilled (ACTION_DIAL). The app never places a call itself
 *   (no ACTION_CALL), and the demo never dials 112.
 *
 * `send` resolves `sent: true` only when the radio reports the message as sent, not merely queued.
 */
@CapacitorPlugin(
    name = "SahaySms",
    permissions = [Permission(alias = "sms", strings = [Manifest.permission.SEND_SMS])],
)
class SahaySmsPlugin : Plugin() {
    private val requestIds = AtomicInteger(0)

    @PluginMethod
    fun send(call: PluginCall) {
        val to = call.getString("to")
        val body = call.getString("body")
        if (to.isNullOrBlank() || body.isNullOrEmpty()) return call.reject("to and body are required")
        if (!to.matches(Regex("^[+]?[0-9]{3,15}$"))) return call.reject("to must be a phone number")
        if (body.length > 480) return call.reject("body is too long for an SMS")
        if (getPermissionState("sms") != PermissionState.GRANTED) {
            requestPermissionForAlias("sms", call, "smsPermissionResult")
            return
        }
        dispatch(call, to, body)
    }

    @PermissionCallback
    private fun smsPermissionResult(call: PluginCall) {
        if (getPermissionState("sms") != PermissionState.GRANTED) return call.reject("SMS permission was not granted")
        val to = call.getString("to") ?: return call.reject("to is required")
        val body = call.getString("body") ?: return call.reject("body is required")
        dispatch(call, to, body)
    }

    @PluginMethod
    fun canSend(call: PluginCall) {
        val telephony = context.packageManager.hasSystemFeature(android.content.pm.PackageManager.FEATURE_TELEPHONY)
        call.resolve(JSObject().put("available", telephony).put("granted", getPermissionState("sms") == PermissionState.GRANTED))
    }

    @PluginMethod
    fun openDialer(call: PluginCall) {
        val number = call.getString("number")
        if (number.isNullOrBlank() || !number.matches(Regex("^[+]?[0-9*#]{2,20}$"))) return call.reject("number is invalid")
        try {
            val intent = Intent(Intent.ACTION_DIAL, Uri.parse("tel:$number")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            context.startActivity(intent)
            call.resolve()
        } catch (e: Exception) {
            call.reject("could not open the dialer")
        }
    }

    private fun dispatch(call: PluginCall, to: String, body: String) {
        val ctx = context.applicationContext
        val action = "sahay.sms.SENT.${requestIds.incrementAndGet()}"
        val main = Handler(Looper.getMainLooper())
        var done = false
        lateinit var receiver: BroadcastReceiver
        fun finish(sent: Boolean) {
            if (done) return
            done = true
            try { ctx.unregisterReceiver(receiver) } catch (_: IllegalArgumentException) {}
            call.resolve(JSObject().put("sent", sent))
        }
        receiver = object : BroadcastReceiver() {
            override fun onReceive(c: Context?, intent: Intent?) { finish(resultCode == Activity.RESULT_OK) }
        }
        val flags = PendingIntent.FLAG_ONE_SHOT or (if (Build.VERSION.SDK_INT >= 23) PendingIntent.FLAG_IMMUTABLE else 0)
        val sentIntent = PendingIntent.getBroadcast(ctx, requestIds.get(), Intent(action).setPackage(ctx.packageName), flags)
        try {
            val filter = IntentFilter(action)
            if (Build.VERSION.SDK_INT >= 33) ctx.registerReceiver(receiver, filter, Context.RECEIVER_NOT_EXPORTED)
            else ctx.registerReceiver(receiver, filter)
            val sms: SmsManager = if (Build.VERSION.SDK_INT >= 31) ctx.getSystemService(SmsManager::class.java) else @Suppress("DEPRECATION") SmsManager.getDefault()
            sms.sendTextMessage(to, null, body, sentIntent, null)
            main.postDelayed({ finish(false) }, 30_000)  // no radio answer: report "not sent" so the ladder can try again
        } catch (e: Exception) {
            finish(false)
        }
    }
}
