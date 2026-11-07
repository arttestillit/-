package com.arttestillit.calendaralarm

import android.content.Context

class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, true)
        set(v) = sp.edit().putBoolean(KEY_ENABLED, v).apply()

    var leadMinutes: Int
        get() = sp.getInt(KEY_LEAD, 30)
        set(v) = sp.edit().putInt(KEY_LEAD, v).apply()

    var snoozeMinutes: Int
        get() = sp.getInt(KEY_SNOOZE, 5)
        set(v) = sp.edit().putInt(KEY_SNOOZE, v).apply()

    var skipDeclined: Boolean
        get() = sp.getBoolean(KEY_SKIP_DECLINED, true)
        set(v) = sp.edit().putBoolean(KEY_SKIP_DECLINED, v).apply()

    var excludedCalendarIds: Set<Long>
        get() = strings(KEY_EXCLUDED_CALENDARS).mapNotNull(String::toLongOrNull).toSet()
        set(v) = sp.edit().putStringSet(KEY_EXCLUDED_CALENDARS, v.map(Long::toString).toSet()).apply()

    var skippedEventKeys: Set<String>
        get() = strings(KEY_SKIPPED)
        set(v) = sp.edit().putStringSet(KEY_SKIPPED, v).apply()

    /** AlarmManager に登録済みのアラームID（後で取り消すために保持）。 */
    var scheduledIds: Set<String>
        get() = strings(KEY_SCHEDULED)
        set(v) = sp.edit().putStringSet(KEY_SCHEDULED, v).apply()

    fun settings() = AlarmSettings(
        enabled = enabled,
        leadMinutes = leadMinutes,
        skipDeclined = skipDeclined,
        excludedCalendarIds = excludedCalendarIds,
        skippedEventKeys = skippedEventKeys,
    )

    /** 開始済みの予定のスキップ設定は不要なので掃除する。キーは "eventId:begin"。 */
    fun pruneSkipped(now: Long) {
        val kept = skippedEventKeys.filter { key ->
            key.substringAfter(':').toLongOrNull()?.let { it > now } ?: false
        }.toSet()
        if (kept.size != skippedEventKeys.size) skippedEventKeys = kept
    }

    // getStringSet が返す Set は変更してはいけないのでコピーする
    private fun strings(key: String): Set<String> = sp.getStringSet(key, null)?.toSet() ?: emptySet()

    private companion object {
        const val KEY_ENABLED = "enabled"
        const val KEY_LEAD = "lead_minutes"
        const val KEY_SNOOZE = "snooze_minutes"
        const val KEY_SKIP_DECLINED = "skip_declined"
        const val KEY_EXCLUDED_CALENDARS = "excluded_calendars"
        const val KEY_SKIPPED = "skipped_events"
        const val KEY_SCHEDULED = "scheduled_ids"
    }
}
