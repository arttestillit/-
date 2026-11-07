package com.arttestillit.calendaralarm

import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZoneOffset

/** カレンダーの1回分の予定（繰り返し予定は1回ごとに別インスタンス）。 */
data class CalendarEvent(
    val eventId: Long,
    val title: String,
    val begin: Long,
    val end: Long,
    val allDay: Boolean,
    val calendarId: Long,
    val location: String? = null,
    val declined: Boolean = false,
    val canceled: Boolean = false,
    /** 祝日カレンダーの終日予定。 */
    val holiday: Boolean = false,
) {
    /** 繰り返し予定でも1回ごとに一意になるキー。 */
    val key: String get() = "$eventId@$begin"
}

/** 予定のタイトルか場所に [keyword] を含むとき、家から [travelMinutes] 分かかる場所とみなす。 */
data class Place(val keyword: String, val travelMinutes: Int)

/** カレンダーに入っていない授業など、毎週決まった予定。dayOfWeek は 1=月 … 7=日。 */
data class TimetableEntry(val dayOfWeek: Int, val startMinute: Int, val name: String, val place: String) {
    val stableId: Long
        get() = -(("$dayOfWeek|$startMinute|$name".hashCode().toLong() and 0x7fffffffL) + 1)
}

data class AlarmSettings(
    val enabled: Boolean = true,
    /** 集合時刻の何分前に着くか。 */
    val arriveEarlyMinutes: Int = 10,
    /** 出発時刻の何分前に鳴らすか（複数）。 */
    val alarmOffsets: List<Int> = listOf(50, 40),
    /** 場所が登録されていない予定の移動時間。 */
    val defaultTravelMinutes: Int = 30,
    /** その日最初の外出だけ鳴らす（予定から予定へ直行する前提）。 */
    val firstOutingOnly: Boolean = true,
    val skipDeclined: Boolean = true,
    val excludedCalendarIds: Set<Long> = emptySet(),
    val skippedEventKeys: Set<String> = emptySet(),
    val places: List<Place> = emptyList(),
    val timetableEnabled: Boolean = true,
    val timetable: List<TimetableEntry> = emptyList(),
    val skipTimetableOnHolidays: Boolean = true,
)

enum class MuteReason { SKIPPED, NOT_FIRST_OF_DAY }

data class AlarmTime(val offsetMinutes: Int, val at: Long)

/** 予定1件分の「家を出る」計算結果。 */
data class Outing(
    val event: CalendarEvent,
    /** 一致した登録場所。null なら未登録（既定の移動時間で計算）。 */
    val place: Place?,
    val travelMinutes: Int,
    val departure: Long,
    /** これから鳴る時刻（過ぎたものは含まない）。 */
    val alarms: List<AlarmTime>,
    val muted: MuteReason?,
) {
    val active: Boolean get() = muted == null
    val title: String get() = event.title.ifBlank { AlarmPlanner.UNTITLED }
    val fromTimetable: Boolean get() = event.calendarId == AlarmPlanner.TIMETABLE_CALENDAR_ID
}

/** 実際にセットするアラーム。同じ時刻に鳴るものは1つにまとめる。 */
data class PlannedAlarm(val id: String, val triggerAt: Long, val items: List<Pair<Outing, Int>>)

object AlarmPlanner {
    const val TIMETABLE_CALENDAR_ID = -1L
    const val UNTITLED = "(無題の予定)"
    private const val MIN = 60_000L

    fun matchPlace(event: CalendarEvent, places: List<Place>): Place? {
        val text = event.title + "\n" + event.location.orEmpty()
        return places
            .filter { it.keyword.isNotBlank() && text.contains(it.keyword.trim(), ignoreCase = true) }
            .maxByOrNull { it.keyword.trim().length }
    }

    fun timetableEvents(
        entries: List<TimetableEntry>,
        from: LocalDate,
        to: LocalDate,
        zone: ZoneId,
        holidays: Set<LocalDate>,
    ): List<CalendarEvent> {
        val result = mutableListOf<CalendarEvent>()
        var date = from
        while (!date.isAfter(to)) {
            if (date !in holidays) {
                entries.filter { it.dayOfWeek == date.dayOfWeek.value }.forEach { e ->
                    val begin = date.atStartOfDay(zone).plusMinutes(e.startMinute.toLong()).toInstant().toEpochMilli()
                    result += CalendarEvent(
                        eventId = e.stableId, title = e.name, begin = begin, end = begin + 90 * MIN,
                        allDay = false, calendarId = TIMETABLE_CALENDAR_ID, location = e.place,
                    )
                }
            }
            date = date.plusDays(1)
        }
        return result
    }

    /**
     * 予定ごとに出発時刻とアラーム時刻を計算する。
     * [events] には「今日の0時」以降の予定を渡すこと（今日すでに出かけたかの判定に使う）。
     */
    fun outings(
        events: List<CalendarEvent>,
        settings: AlarmSettings,
        now: Long,
        zone: ZoneId,
        horizon: Long,
    ): List<Outing> {
        val today = localDate(now, zone)
        val holidays = events.filter { it.holiday }
            .map { Instant.ofEpochMilli(it.begin).atZone(ZoneOffset.UTC).toLocalDate() }.toSet()
        val timetable = if (settings.timetableEnabled) {
            timetableEvents(
                settings.timetable, today, localDate(horizon, zone).plusDays(1), zone,
                if (settings.skipTimetableOnHolidays) holidays else emptySet(),
            )
        } else {
            emptyList()
        }
        val offsets = settings.alarmOffsets.filter { it >= 0 }.distinct().ifEmpty { listOf(0) }

        val all = (events + timetable).asSequence()
            .filter { !it.allDay && !it.canceled }
            .filter { !(settings.skipDeclined && it.declined) }
            .filter { it.calendarId !in settings.excludedCalendarIds }
            .distinctBy { it.key }
            .map { e ->
                val place = matchPlace(e, settings.places)
                val travel = place?.travelMinutes ?: settings.defaultTravelMinutes
                val departure = e.begin - (settings.arriveEarlyMinutes + travel) * MIN
                Outing(
                    event = e, place = place, travelMinutes = travel, departure = departure,
                    alarms = offsets.map { AlarmTime(it, departure - it * MIN) }.sortedBy { it.at },
                    muted = if (e.key in settings.skippedEventKeys) MuteReason.SKIPPED else null,
                )
            }.toList()

        val withFirstOfDay = all.groupBy { localDate(it.event.begin, zone) }.values.flatMap { day ->
            val sorted = day.sortedBy { it.event.begin }
            val first = sorted.firstOrNull { it.muted == null }
            sorted.map {
                if (settings.firstOutingOnly && it.muted == null && it !== first) {
                    it.copy(muted = MuteReason.NOT_FIRST_OF_DAY)
                } else {
                    it
                }
            }
        }

        return withFirstOfDay
            .filter { it.event.begin > now && (it.alarms.firstOrNull()?.at ?: it.departure) <= horizon }
            .map { o -> o.copy(alarms = o.alarms.filter { it.at > now && it.at <= horizon }) }
            .sortedWith(compareBy<Outing>({ it.event.begin }, { it.title }))
    }

    fun plan(outings: List<Outing>, enabled: Boolean): List<PlannedAlarm> {
        if (!enabled) return emptyList()
        return outings.filter { it.active }
            .flatMap { o -> o.alarms.map { Triple(it.at, o, it.offsetMinutes) } }
            .groupBy { it.first }
            .map { (at, group) -> PlannedAlarm("t$at", at, group.map { it.second to it.third }) }
            .sortedBy { it.triggerAt }
    }

    private fun localDate(millis: Long, zone: ZoneId): LocalDate =
        Instant.ofEpochMilli(millis).atZone(zone).toLocalDate()
}
