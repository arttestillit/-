package com.arttestillit.calendaralarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val info = AlarmInfo.from(intent) ?: return
        when (intent.action) {
            AlarmScheduler.ACTION_FIRE -> {
                val prefs = Prefs(context)
                prefs.scheduledIds = prefs.scheduledIds - info.id
                AlarmNotifier.show(context, info)
            }
            AlarmNotifier.ACTION_STOP -> AlarmNotifier.stop(context, info)
            AlarmNotifier.ACTION_SNOOZE -> AlarmNotifier.snooze(context, info)
        }
    }
}
