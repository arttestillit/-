package com.arttestillit.calendaralarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import java.text.SimpleDateFormat
import java.time.LocalDate
import java.time.ZoneId
import java.util.Date
import java.util.Locale

/** 鳴らすアラーム1件分の表示内容。Intent の extras で受け渡す。 */
data class AlarmInfo(val id: String, val title: String, val detail: String) {
    val notificationId: Int get() = id.hashCode()

    fun putInto(intent: Intent): Intent = intent
        .putExtra(EXTRA_ID, id)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_DETAIL, detail)

    companion object {
        private const val EXTRA_ID = "alarm_id"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_DETAIL = "detail"

        fun from(intent: Intent): AlarmInfo? {
            val id = intent.getStringExtra(EXTRA_ID) ?: return null
            return AlarmInfo(id, intent.getStringExtra(EXTRA_TITLE).orEmpty(), intent.getStringExtra(EXTRA_DETAIL).orEmpty())
        }

        fun of(alarm: PlannedAlarm): AlarmInfo {
            val hm = SimpleDateFormat("HH:mm", Locale.JAPAN)
            val title = alarm.items.joinToString(" / ") { (o, offset) ->
                if (offset == 0) "出発時刻です（${o.title}）" else "あと${offset}分で出発（${o.title}）"
            }
            val detail = alarm.items.map { it.first }.distinct().joinToString("\n") { o ->
                "出発 ${hm.format(Date(o.departure))} → ${hm.format(Date(o.event.begin))} ${o.title}" +
                    (o.event.location?.takeIf(String::isNotBlank)?.let { "（$it）" } ?: "")
            }
            return AlarmInfo(alarm.id, title, detail)
        }
    }
}

data class SyncResult(
    val outings: List<Outing>,
    val plan: List<PlannedAlarm>,
    val hasCalendarPermission: Boolean,
    val canScheduleExact: Boolean,
)

object AlarmScheduler {
    /** 1週間先までアラームを登録しておく。 */
    const val LOOKAHEAD_MS = 7 * 24 * 60 * 60 * 1000L
    const val ACTION_FIRE = "com.arttestillit.calendaralarm.action.FIRE"

    /** カレンダーと時間割を読み直し、セット済みアラームとの差分を反映する。 */
    @Synchronized
    fun sync(context: Context): SyncResult {
        val ctx = context.applicationContext
        val prefs = Prefs(ctx)
        val repo = CalendarRepository(ctx)
        val now = System.currentTimeMillis()
        val zone = ZoneId.systemDefault()
        prefs.pruneSkipped(now)
        val settings = prefs.settings()

        // 「今日もう出かけたか」を判定するため、今日の0時から読む
        val startOfToday = LocalDate.now(zone).atStartOfDay(zone).toInstant().toEpochMilli()
        val horizon = now + LOOKAHEAD_MS
        val events = repo.events(startOfToday, horizon + 24 * 60 * 60 * 1000L)
        val outings = AlarmPlanner.outings(events, settings, now, zone, horizon)
        val plan = AlarmPlanner.plan(outings, settings.enabled)

        val wanted = plan.map { it.id }.toSet()
        (prefs.scheduledIds - wanted).forEach { cancel(ctx, it) }

        val canExact = canScheduleExact(ctx)
        val scheduled = if (canExact) {
            plan.filter { schedule(ctx, AlarmInfo.of(it), it.triggerAt) }.map { it.id }.toSet()
        } else {
            emptySet()
        }
        prefs.scheduledIds = scheduled
        return SyncResult(outings, plan, repo.hasPermission(), canExact)
    }

    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }

    /**
     * setAlarmClock で登録する。Doze 中でも正確に鳴り、ステータスバーにアラームアイコンも出る。
     * 時計アプリと違い24時間以上先でも登録できる。同じIDで再登録すると上書きされる。
     */
    fun schedule(context: Context, info: AlarmInfo, triggerAt: Long): Boolean {
        val am = context.getSystemService(AlarmManager::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && !am.canScheduleExactAlarms()) return false
        val show = PendingIntent.getActivity(
            context, 0,
            Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            PendingIntent.FLAG_IMMUTABLE,
        )
        val fire = PendingIntent.getBroadcast(
            context, 0, info.putInto(fireIntent(context, info.id)),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        am.setAlarmClock(AlarmManager.AlarmClockInfo(triggerAt, show), fire)
        return true
    }

    fun cancel(context: Context, id: String) {
        val pi = PendingIntent.getBroadcast(
            context, 0, fireIntent(context, id),
            PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE,
        ) ?: return
        context.getSystemService(AlarmManager::class.java).cancel(pi)
        pi.cancel()
    }

    // data URI をIDごとに変えることで、PendingIntent をアラームごとに区別する
    private fun fireIntent(context: Context, id: String) =
        Intent(context, AlarmReceiver::class.java)
            .setAction(ACTION_FIRE)
            .setData(Uri.parse("calalarm://alarm/" + Uri.encode(id)))
}
