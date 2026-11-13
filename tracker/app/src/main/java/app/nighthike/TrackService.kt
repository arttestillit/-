package app.nighthike

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.location.Location
import android.location.LocationListener
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import java.io.File

/**
 * 画面を消していても動き続ける前景サービス。
 * GPS を 1 分間隔で受け取り、filesDir/track.jsonl に 1 行 1 点で追記する。
 */
class TrackService : Service(), LocationListener {

    companion object {
        @Volatile var running = false
        const val INTERVAL_MS = 60_000L
        private const val CHANNEL = "track"
        private const val NOTIF_ID = 1
        private val lock = Any()

        fun trackFile(c: Context) = File(c.filesDir, "track.jsonl")

        fun readTrackJson(c: Context): String = synchronized(lock) {
            val f = trackFile(c)
            if (!f.exists()) "[]"
            else "[" + f.readLines().filter { it.isNotBlank() }.joinToString(",") + "]"
        }

        fun clearTrack(c: Context) = synchronized(lock) { trackFile(c).delete() }
    }

    private var wakeLock: PowerManager.WakeLock? = null
    private var lastWrite = 0L
    private var count = 0

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (running) return START_STICKY
        running = true
        startInForeground()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nighthike:track").apply {
            setReferenceCounted(false)
            acquire(24 * 60 * 60 * 1000L)
        }
        requestUpdates()
        return START_STICKY
    }

    private fun startInForeground() {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL, "ログ記録", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val open = PendingIntent.getActivity(
            this, 0, Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val b = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
            Notification.Builder(this, CHANNEL) else Notification.Builder(this)
        val n = b.setContentTitle("ナイトハイク記録中")
            .setContentText("1分ごとに位置を記録しています")
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setContentIntent(open)
            .setOngoing(true)
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIF_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIF_ID, n)
        }
    }

    private fun requestUpdates() {
        val lm = getSystemService(Context.LOCATION_SERVICE) as LocationManager
        try {
            lm.removeUpdates(this)
            if (lm.isProviderEnabled(LocationManager.GPS_PROVIDER)) {
                lm.requestLocationUpdates(
                    LocationManager.GPS_PROVIDER, INTERVAL_MS, 0f, this, Looper.getMainLooper()
                )
            }
            // 電波の悪い場所での補助(精度が低いので UI 側で弾かれる)
            if (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER)) {
                lm.requestLocationUpdates(
                    LocationManager.NETWORK_PROVIDER, INTERVAL_MS, 0f, this, Looper.getMainLooper()
                )
            }
        } catch (e: SecurityException) {
            stopSelf()
        }
    }

    override fun onLocationChanged(loc: Location) {
        val now = System.currentTimeMillis()
        if (now - lastWrite < 30_000L) return   // 約1分に1点に揃える
        lastWrite = now
        val line = "{\"t\":$now,\"lat\":${loc.latitude},\"lon\":${loc.longitude}," +
            "\"acc\":${if (loc.hasAccuracy()) loc.accuracy else -1f}," +
            "\"alt\":${if (loc.hasAltitude()) loc.altitude else 0.0}}\n"
        synchronized(lock) { trackFile(this).appendText(line) }
        count++
    }

    @Deprecated("Deprecated in Java")
    override fun onStatusChanged(provider: String?, status: Int, extras: Bundle?) {}
    override fun onProviderEnabled(provider: String) {}
    override fun onProviderDisabled(provider: String) {}

    override fun onDestroy() {
        running = false
        try {
            (getSystemService(Context.LOCATION_SERVICE) as LocationManager).removeUpdates(this)
        } catch (e: SecurityException) {}
        wakeLock?.let { if (it.isHeld) it.release() }
        super.onDestroy()
    }
}
