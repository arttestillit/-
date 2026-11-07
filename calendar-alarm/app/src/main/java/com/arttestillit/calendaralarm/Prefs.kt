package com.arttestillit.calendaralarm

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class Prefs(context: Context) {
    private val sp = context.applicationContext.getSharedPreferences("settings", Context.MODE_PRIVATE)

    var enabled: Boolean
        get() = sp.getBoolean(KEY_ENABLED, true)
        set(v) = sp.edit().putBoolean(KEY_ENABLED, v).apply()

    var arriveEarlyMinutes: Int
        get() = sp.getInt(KEY_ARRIVE_EARLY, 10)
        set(v) = sp.edit().putInt(KEY_ARRIVE_EARLY, v).apply()

    var alarmOffsets: List<Int>
        get() = parseOffsets(sp.getString(KEY_OFFSETS, null) ?: "50,40").ifEmpty { listOf(50, 40) }
        set(v) = sp.edit().putString(KEY_OFFSETS, v.joinToString(",")).apply()

    var defaultTravelMinutes: Int
        get() = sp.getInt(KEY_DEFAULT_TRAVEL, 30)
        set(v) = sp.edit().putInt(KEY_DEFAULT_TRAVEL, v).apply()

    var firstOutingOnly: Boolean
        get() = sp.getBoolean(KEY_FIRST_ONLY, true)
        set(v) = sp.edit().putBoolean(KEY_FIRST_ONLY, v).apply()

    var snoozeMinutes: Int
        get() = sp.getInt(KEY_SNOOZE, 5)
        set(v) = sp.edit().putInt(KEY_SNOOZE, v).apply()

    var skipDeclined: Boolean
        get() = sp.getBoolean(KEY_SKIP_DECLINED, true)
        set(v) = sp.edit().putBoolean(KEY_SKIP_DECLINED, v).apply()

    var timetableEnabled: Boolean
        get() = sp.getBoolean(KEY_TIMETABLE_ENABLED, true)
        set(v) = sp.edit().putBoolean(KEY_TIMETABLE_ENABLED, v).apply()

    var skipTimetableOnHolidays: Boolean
        get() = sp.getBoolean(KEY_TIMETABLE_HOLIDAYS, true)
        set(v) = sp.edit().putBoolean(KEY_TIMETABLE_HOLIDAYS, v).apply()

    var places: List<Place>
        get() = sp.getString(KEY_PLACES, null)?.let(::decodePlaces) ?: DEFAULT_PLACES
        set(v) = sp.edit().putString(KEY_PLACES, encodePlaces(v)).apply()

    var timetable: List<TimetableEntry>
        get() = sp.getString(KEY_TIMETABLE, null)?.let(::decodeTimetable) ?: DEFAULT_TIMETABLE
        set(v) = sp.edit().putString(KEY_TIMETABLE, encodeTimetable(v)).apply()

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
        arriveEarlyMinutes = arriveEarlyMinutes,
        alarmOffsets = alarmOffsets,
        defaultTravelMinutes = defaultTravelMinutes,
        firstOutingOnly = firstOutingOnly,
        skipDeclined = skipDeclined,
        excludedCalendarIds = excludedCalendarIds,
        skippedEventKeys = skippedEventKeys,
        places = places,
        timetableEnabled = timetableEnabled,
        timetable = timetable,
        skipTimetableOnHolidays = skipTimetableOnHolidays,
    )

    /** 終わった予定のスキップ設定は不要なので掃除する。キーは "id@begin"。 */
    fun pruneSkipped(now: Long) {
        val kept = skippedEventKeys.filter { key ->
            key.substringAfterLast('@').toLongOrNull()?.let { it > now } ?: false
        }.toSet()
        if (kept.size != skippedEventKeys.size) skippedEventKeys = kept
    }

    // getStringSet が返す Set は変更してはいけないのでコピーする
    private fun strings(key: String): Set<String> = sp.getStringSet(key, null)?.toSet() ?: emptySet()

    companion object {
        private const val KEY_ENABLED = "enabled"
        private const val KEY_ARRIVE_EARLY = "arrive_early_minutes"
        private const val KEY_OFFSETS = "alarm_offsets"
        private const val KEY_DEFAULT_TRAVEL = "default_travel_minutes"
        private const val KEY_FIRST_ONLY = "first_outing_only"
        private const val KEY_SNOOZE = "snooze_minutes"
        private const val KEY_SKIP_DECLINED = "skip_declined"
        private const val KEY_TIMETABLE_ENABLED = "timetable_enabled"
        private const val KEY_TIMETABLE_HOLIDAYS = "timetable_skip_holidays"
        private const val KEY_PLACES = "places"
        private const val KEY_TIMETABLE = "timetable"
        private const val KEY_EXCLUDED_CALENDARS = "excluded_calendars"
        private const val KEY_SKIPPED = "skipped_events"
        private const val KEY_SCHEDULED = "scheduled_ids"

        // 初回起動時の値。後から画面で編集できる。
        val DEFAULT_PLACES = listOf(Place("ファミマ", 10), Place("大学", 60))
        val DEFAULT_TIMETABLE = listOf(
            TimetableEntry(2, 9 * 60, "1限", "大学"),
            TimetableEntry(3, 9 * 60, "1限", "大学"),
            TimetableEntry(4, 12 * 60 + 55, "3限", "大学"),
            TimetableEntry(5, 14 * 60 + 40, "4限", "大学"),
        )

        /** "50, 40" → [50, 40]。数字以外や重複は無視する。 */
        fun parseOffsets(text: String): List<Int> =
            text.split(',', '、', ' ', '，').mapNotNull { it.trim().toIntOrNull() }
                .filter { it in 0..600 }.distinct().sortedDescending()

        private fun encodePlaces(list: List<Place>) = JSONArray().apply {
            list.forEach { put(JSONObject().put("k", it.keyword).put("m", it.travelMinutes)) }
        }.toString()

        private fun decodePlaces(json: String): List<Place> = runCatching {
            val a = JSONArray(json)
            List(a.length()) { a.getJSONObject(it).let { o -> Place(o.getString("k"), o.getInt("m")) } }
        }.getOrDefault(DEFAULT_PLACES)

        private fun encodeTimetable(list: List<TimetableEntry>) = JSONArray().apply {
            list.forEach {
                put(JSONObject().put("d", it.dayOfWeek).put("t", it.startMinute).put("n", it.name).put("p", it.place))
            }
        }.toString()

        private fun decodeTimetable(json: String): List<TimetableEntry> = runCatching {
            val a = JSONArray(json)
            List(a.length()) {
                a.getJSONObject(it).let { o ->
                    TimetableEntry(o.getInt("d"), o.getInt("t"), o.getString("n"), o.getString("p"))
                }
            }
        }.getOrDefault(DEFAULT_TIMETABLE)
    }
}
