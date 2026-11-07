package com.arttestillit.calendaralarm

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

object AlarmNotifier {
    private const val CHANNEL_ID = "calendar_alarm"
    private const val AUTO_STOP_MS = 10 * 60 * 1000L
    const val ACTION_STOP = "com.arttestillit.calendaralarm.action.STOP"
    const val ACTION_SNOOZE = "com.arttestillit.calendaralarm.action.SNOOZE"

    fun ensureChannel(context: Context) {
        val nm = context.getSystemService(NotificationManager::class.java)
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return
        val sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
            ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)
        val channel = NotificationChannel(
            CHANNEL_ID, context.getString(R.string.channel_name), NotificationManager.IMPORTANCE_HIGH,
        ).apply {
            description = context.getString(R.string.channel_desc)
            setSound(
                sound,
                AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build(),
            )
            enableVibration(true)
            vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
            lockscreenVisibility = Notification.VISIBILITY_PUBLIC
            setBypassDnd(true)
        }
        nm.createNotificationChannel(channel)
    }

    /** 全画面アラーム付き通知を出す。音は FLAG_INSISTENT で停止されるまで繰り返す。 */
    fun show(context: Context, info: AlarmInfo) {
        ensureChannel(context)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            return
        }
        val nid = info.notificationId
        val fullScreen = PendingIntent.getActivity(
            context, nid,
            info.putInto(Intent(context, AlarmActivity::class.java))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NO_USER_ACTION),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val snoozeMin = Prefs(context).snoozeMinutes
        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_alarm)
            .setContentTitle(info.title)
            .setContentText(info.detail)
            .setStyle(NotificationCompat.BigTextStyle().bigText(info.detail))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_MAX)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setFullScreenIntent(fullScreen, true)
            .setContentIntent(fullScreen)
            .setOngoing(true)
            .setAutoCancel(false)
            .setTimeoutAfter(AUTO_STOP_MS)
            .addAction(0, context.getString(R.string.stop), actionIntent(context, ACTION_STOP, info))
            .addAction(
                0, "${context.getString(R.string.snooze)}（${snoozeMin}分）",
                actionIntent(context, ACTION_SNOOZE, info),
            )
            .build()
        notification.flags = notification.flags or Notification.FLAG_INSISTENT
        NotificationManagerCompat.from(context).notify(nid, notification)
    }

    fun stop(context: Context, info: AlarmInfo) {
        NotificationManagerCompat.from(context).cancel(info.notificationId)
    }

    fun snooze(context: Context, info: AlarmInfo) {
        stop(context, info)
        val snoozeId = if (info.id.startsWith("snooze:")) info.id else "snooze:${info.id}"
        val at = System.currentTimeMillis() + Prefs(context).snoozeMinutes * 60_000L
        AlarmScheduler.schedule(context, info.copy(id = snoozeId), at)
    }

    private fun actionIntent(context: Context, action: String, info: AlarmInfo): PendingIntent =
        PendingIntent.getBroadcast(
            context, info.notificationId,
            info.putInto(Intent(context, AlarmReceiver::class.java).setAction(action)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
}
