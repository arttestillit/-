package com.arttestillit.calendaralarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId
import java.time.ZoneOffset

/** 会話で出た実際の1週間（2026/11/8〜）を使ったテスト。 */
class AlarmPlannerTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private val day = 24 * 60 * 60 * 1000L

    private fun at(m: Int, d: Int, h: Int, min: Int = 0) =
        LocalDateTime.of(2026, m, d, h, min).atZone(zone).toInstant().toEpochMilli()

    private fun hm(millis: Long) = java.time.Instant.ofEpochMilli(millis).atZone(zone).toLocalTime().toString()

    private fun ev(id: Long, begin: Long, title: String, location: String? = null, cal: Long = 1) =
        CalendarEvent(id, title, begin, begin + 3_600_000, false, cal, location)

    private val settings = AlarmSettings(
        arriveEarlyMinutes = 10,
        alarmOffsets = listOf(50, 40),
        places = Prefs.DEFAULT_PLACES,
        timetable = Prefs.DEFAULT_TIMETABLE,
    )
    private val now = at(11, 8, 4, 3) // スクショの時刻

    private fun outings(events: List<CalendarEvent>, s: AlarmSettings = settings, n: Long = now) =
        AlarmPlanner.outings(events, s, n, zone, n + 7 * day)

    @Test
    fun famimaAt12_departs1140_alarmsAt1050And1100() {
        val o = outings(listOf(ev(1, at(11, 8, 12), "1217ファミマ"))).single { it.event.eventId == 1L }
        assertEquals("ファミマ", o.place?.keyword)
        assertEquals("11:40", hm(o.departure))
        assertEquals(listOf("10:50", "11:00"), o.alarms.map { hm(it.at) })
    }

    @Test
    fun timetableClassesMatchTheConversation() {
        val o = outings(emptyList()).filter { it.fromTimetable }
        val byDay = o.associate { java.time.Instant.ofEpochMilli(it.event.begin).atZone(zone).toLocalDate().dayOfMonth to it }
        assertEquals(listOf("07:00", "07:10"), byDay.getValue(10).alarms.map { hm(it.at) }) // 火 1限
        assertEquals(listOf("07:00", "07:10"), byDay.getValue(11).alarms.map { hm(it.at) }) // 水 1限
        assertEquals(listOf("10:55", "11:05"), byDay.getValue(12).alarms.map { hm(it.at) }) // 木 3限
        assertEquals(listOf("12:40", "12:50"), byDay.getValue(13).alarms.map { hm(it.at) }) // 金 4限
    }

    @Test
    fun secondOutingOfDayIsMuted() {
        // 11/12 は 3限のあと16時ファミマへ直行
        val o = outings(listOf(ev(2, at(11, 12, 16), "1217ファミマ")))
        val famima = o.single { it.event.eventId == 2L }
        assertEquals(MuteReason.NOT_FIRST_OF_DAY, famima.muted)
        val plan = AlarmPlanner.plan(o, true)
        assertTrue(plan.none { a -> a.items.any { it.first.event.eventId == 2L } })
    }

    @Test
    fun skippingFirstMakesNextOneFirst() {
        val cls = outings(emptyList()).first { it.fromTimetable && hm(it.event.begin) == "12:55" }
        val s = settings.copy(skippedEventKeys = setOf(cls.event.key)) // 休講
        val famima = outings(listOf(ev(2, at(11, 12, 16), "1217ファミマ")), s).single { it.event.eventId == 2L }
        assertNull(famima.muted)
        assertEquals("15:40", hm(famima.departure))
    }

    @Test
    fun alreadyOutTodayMeansNoAlarmForLaterEvent() {
        val n = at(11, 8, 13)
        val o = outings(listOf(ev(1, at(11, 8, 12), "1217ファミマ"), ev(2, at(11, 8, 18), "夕飯")), n = n)
        assertEquals(MuteReason.NOT_FIRST_OF_DAY, o.single { it.event.eventId == 2L }.muted)
    }

    @Test
    fun firstOnlyCanBeTurnedOff() {
        val o = outings(listOf(ev(2, at(11, 12, 16), "1217ファミマ")), settings.copy(firstOutingOnly = false))
        assertNull(o.single { it.event.eventId == 2L }.muted)
    }

    @Test
    fun unknownPlaceUsesDefaultTravel() {
        val o = outings(listOf(ev(3, at(11, 9, 20), "飲み会"))).single { it.event.eventId == 3L }
        assertNull(o.place)
        assertEquals("19:20", hm(o.departure)) // 20:00 - 10分 - 既定30分
    }

    @Test
    fun placeMatchesLocationAndPrefersLongestKeyword() {
        val s = settings.copy(places = listOf(Place("駅", 5), Place("新宿駅", 40)))
        val o = outings(listOf(ev(4, at(11, 9, 18), "待ち合わせ", location = "新宿駅東口")), s)
            .single { it.event.eventId == 4L }
        assertEquals(40, o.travelMinutes)
    }

    @Test
    fun holidaySkipsTimetable() {
        val utcMidnight = LocalDateTime.of(2026, 11, 10, 0, 0).toInstant(ZoneOffset.UTC).toEpochMilli()
        val holiday = CalendarEvent(99, "祝日", utcMidnight, utcMidnight + day, true, 5, holiday = true)
        val o = outings(listOf(holiday))
        assertTrue(o.none { it.fromTimetable && hm(it.event.begin) == "09:00" && it.event.begin < at(11, 11, 0) })
        assertTrue(o.any { it.fromTimetable && it.event.begin == at(11, 11, 9) })
    }

    @Test
    fun alarmsBeyondTwentyFourHoursAreScheduled() {
        val plan = AlarmPlanner.plan(outings(emptyList()), true)
        assertTrue(plan.any { it.triggerAt > now + 3 * day })
    }

    @Test
    fun sameTimeAlarmsAreMergedAndPastOnesDropped() {
        val s = settings.copy(firstOutingOnly = false, timetableEnabled = false)
        val o = outings(listOf(ev(1, at(11, 9, 14), "1217ファミマ"), ev(2, at(11, 9, 14), "シフト ファミマ")), s)
        assertEquals(2, AlarmPlanner.plan(o, true).size)
        val late = outings(listOf(ev(1, at(11, 8, 4, 45), "1217ファミマ")), s).single()
        assertTrue(late.alarms.isEmpty()) // 出発 4:25 の50分前・40分前はもう過ぎている
    }

    @Test
    fun disabledPlansNothing() {
        assertTrue(AlarmPlanner.plan(outings(emptyList()), false).isEmpty())
    }
}
