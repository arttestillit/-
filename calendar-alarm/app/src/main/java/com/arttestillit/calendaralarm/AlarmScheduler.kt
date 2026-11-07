package com.arttestillit.calendaralarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build

/** 鳴らすアラーム1件分の情報。Intent の extras で受け渡す。 */
data class AlarmInfo(val id: String, val title: String, val eventBegin: Long, val location: String?) {
    val notificationId: Int get() = id.hashCode()

    fun putInto(intent: Intent): Intent = intent
        .putExtra(EXTRA_ID, id)
        .putExtra(EXTRA_TITLE, title)
        .putExtra(EXTRA_BEGIN, eventBegin)
        .putExtra(EXTRA_LOCATION, location)

    companion object {
        private const val EXTRA_ID = "alarm_id"
        private const val EXTRA_TITLE = "title"
        private const val EXTRA_BEGIN = "event_begin"
        private const val EXTRA_LOCATION = "location"

        fun from(intent: Intent): AlarmInfo? {
            val id = intent.getStringExtra(EXTRA_ID) ?: return null
            return AlarmInfo(
                id = id,
                title = intent.getStringExtra(EXTRA_TITLE).orEmpty(),
                eventBegin = intent.getLongExtra(EXTRA_BEGIN, 0L),
                location = intent.getStringExtra(EXTRA_LOCATION),
            )
        }
    }
}

data class SyncResult(
    val candidates: List<Candidate>,
    val plan: List<PlannedAlarm>,
    val hasCalendarPermission: Boolean,
    val canScheduleExact: Boolean,
)

object AlarmScheduler {
    const val LOOKAHEAD_MS = 48 * 60 * 60 * 1000L
    const val ACTION_FIRE = "com.arttestillit.calendaralarm.action.FIRE"

    /** カレンダーを読み直し、セット済みアラームとの差分を反映する。 */
    @Synchronized
    fun sync(context: Context): SyncResult {
        val ctx = context.applicationContext
        val prefs = Prefs(ctx)
        val repo = CalendarRepository(ctx)
        val now = System.currentTimeMillis()
        prefs.pruneSkipped(now)
        val settings = prefs.settings()

        val events = repo.events(now, now + LOOKAHEAD_MS + settings.leadMinutes * 60_000L)
        val candidates = AlarmPlanner.candidates(events, settings, now, horizon = now + LOOKAHEAD_MS)
        val plan = AlarmPlanner.plan(candidates, settings.enabled)

        val wanted = plan.map { it.id }.toSet()
        (prefs.scheduledIds - wanted).forEach { cancel(ctx, it) }

        val canExact = canScheduleExact(ctx)
        val scheduled = if (canExact) {
            plan.filter { schedule(ctx, AlarmInfo(it.id, it.title, it.eventBegin, it.location), it.triggerAt) }
                .map { it.id }.toSet()
        } else {
            emptySet()
        }
        prefs.scheduledIds = scheduled
        return SyncResult(candidates, plan, repo.hasPermission(), canExact)
    }

    fun canScheduleExact(context: Context): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
        return context.getSystemService(AlarmManager::class.java).canScheduleExactAlarms()
    }

    /**
     * setAlarmClock で登録する。Doze 中でも正確に鳴り、ステータスバーにアラームアイコンも出る。
     * 同じIDで再登録すると上書きされる。
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
