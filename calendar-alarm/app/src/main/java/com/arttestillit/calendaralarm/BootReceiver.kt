package com.arttestillit.calendaralarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** 再起動・アップデート・時刻変更のあと、アラームを登録し直す。 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action !in HANDLED_ACTIONS) return
        val pending = goAsync()
        val app = context.applicationContext
        Thread {
            try {
                SyncJobs.schedule(app)
                AlarmScheduler.sync(app)
            } finally {
                pending.finish()
            }
        }.start()
    }

    private companion object {
        val HANDLED_ACTIONS = setOf(
            Intent.ACTION_BOOT_COMPLETED,
            Intent.ACTION_MY_PACKAGE_REPLACED,
            Intent.ACTION_TIME_CHANGED,
            Intent.ACTION_TIMEZONE_CHANGED,
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED",
        )
    }
}
