package com.arttestillit.calendaralarm

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
) {
    /** 繰り返し予定でも1回ごとに一意になるキー。 */
    val key: String get() = "$eventId:$begin"
}

data class AlarmSettings(
    val enabled: Boolean = true,
    val leadMinutes: Int = 30,
    val skipDeclined: Boolean = true,
    val excludedCalendarIds: Set<Long> = emptySet(),
    val skippedEventKeys: Set<String> = emptySet(),
)

/** アラーム対象になりうる予定と、その鳴動時刻。skipped はユーザーが個別にオフにしたもの。 */
data class Candidate(val event: CalendarEvent, val triggerAt: Long, val skipped: Boolean)

/** 実際にセットするアラーム。同じ時刻に鳴る予定は1つにまとめる。 */
data class PlannedAlarm(val id: String, val triggerAt: Long, val events: List<CalendarEvent>) {
    val title: String
        get() = events.map { it.title.ifBlank { UNTITLED } }.distinct().joinToString(" / ")
    val eventBegin: Long get() = events.minOf { it.begin }
    val location: String? get() = events.firstNotNullOfOrNull { it.location?.takeIf(String::isNotBlank) }

    companion object {
        const val UNTITLED = "(無題の予定)"
    }
}

object AlarmPlanner {
    private const val MINUTE = 60_000L

    fun candidates(
        events: List<CalendarEvent>,
        settings: AlarmSettings,
        now: Long,
        horizon: Long = Long.MAX_VALUE,
    ): List<Candidate> = events.asSequence()
        .filter { !it.allDay && !it.canceled }
        .filter { !(settings.skipDeclined && it.declined) }
        .filter { it.calendarId !in settings.excludedCalendarIds }
        .distinctBy { it.key }
        .map { Candidate(it, it.begin - settings.leadMinutes * MINUTE, it.key in settings.skippedEventKeys) }
        .filter { it.triggerAt > now && it.triggerAt <= horizon }
        .sortedWith(compareBy<Candidate>({ it.triggerAt }, { it.event.title }))
        .toList()

    fun plan(candidates: List<Candidate>, enabled: Boolean): List<PlannedAlarm> {
        if (!enabled) return emptyList()
        return candidates.filter { !it.skipped }
            .groupBy { it.triggerAt }
            .map { (triggerAt, group) -> PlannedAlarm("t$triggerAt", triggerAt, group.map { it.event }) }
            .sortedBy { it.triggerAt }
    }
}
