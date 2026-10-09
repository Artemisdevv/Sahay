package sahay.nearby

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Keeps the Sahay process alive while the Nearby relay runs, so a phone in a pocket (screen off) still
 * advertises, discovers and forwards. The relay itself lives in [SahayNearbyPlugin]; this service only holds
 * the foreground priority, the persistent notification and a partial wake lock.
 *
 * Service type is `connectedDevice` (Android 14+): it covers Bluetooth/Wi-Fi Direct peers and is allowed because
 * the app holds BLUETOOTH_* / NEARBY_WIFI_DEVICES runtime permissions before the plugin starts it.
 * The notification has a Stop action that also stops the relay (through [onStopRequested]).
 */
class RelayForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_STOP) {
            onStopRequested?.invoke()
            stopSelf()
            return START_NOT_STICKY
        }
        ensureChannel()
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= 29) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        if (wakeLock == null) {
            val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "sahay:relay").apply {
                setReferenceCounted(false)
                acquire(WAKE_LOCK_MAX_MS)   // bounded so a bug cannot drain the battery forever; start() renews it
            }
        } else {
            wakeLock?.acquire(WAKE_LOCK_MAX_MS)
        }
        return START_NOT_STICKY   // the plugin owns the relay state; if the process dies the app restarts it from the UI
    }

    override fun onDestroy() {
        wakeLock?.let { if (it.isHeld) it.release() }
        wakeLock = null
        super.onDestroy()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < 26) return
        val manager = getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Sahay relay", NotificationManager.IMPORTANCE_LOW).apply {
                    description = "Shown while this phone helps carry nearby emergency reports"
                    setShowBadge(false)
                },
            )
        }
    }

    private fun buildNotification(): Notification {
        val open = packageManager.getLaunchIntentForPackage(packageName)
        val openIntent = PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        val stop = Intent(this, RelayForegroundService::class.java).setAction(ACTION_STOP)
        val stopIntent = PendingIntent.getService(this, 1, stop, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("Sahay relay is on")
            .setContentText("Helping nearby phones get emergency reports through")
            .setContentIntent(openIntent)
            .addAction(0, "Stop", stopIntent)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build()
    }

    companion object {
        const val CHANNEL_ID = "sahay_relay"
        const val NOTIFICATION_ID = 4101
        const val ACTION_STOP = "in.sahay.app.RELAY_STOP"
        private const val WAKE_LOCK_MAX_MS = 6 * 60 * 60 * 1000L

        /** Set by the plugin: called when the user taps Stop in the notification. */
        @Volatile
        var onStopRequested: (() -> Unit)? = null

        /** Must be called while the app is visible (Android 12+ blocks starting foreground services from the background). */
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, RelayForegroundService::class.java))
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, RelayForegroundService::class.java))
        }
    }
}
