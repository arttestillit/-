package com.arttestillit.calendaralarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class TransitTest {
    private val zone = ZoneId.of("Asia/Tokyo")
    private fun at(d: Int, h: Int, m: Int = 0) =
        LocalDateTime.of(2026, 11, d, h, m).atZone(zone).toInstant().toEpochMilli()
    private fun hm(millis: Long) = java.time.Instant.ofEpochMilli(millis).atZone(zone).toLocalTime().toString()

    // NAVITIME route_transit の応答（必要な部分だけ）
    private fun route(from: String, to: String, time: Int) =
        """{"summary":{"move":{"from_time":"2026-11-09T$from:00+09:00","to_time":"2026-11-09T$to:00+09:00","time":$time,"transit_count":1}},"sections":[]}"""

    @Test
    fun picksLatestDepartureThatArrivesInTime() {
        val json = """{"items":[${route("17:58", "18:40", 42)},${route("18:05", "18:49", 44)},${route("18:12", "18:55", 43)}]}"""
        val r = TransitParser.parse(json, at(9, 18, 50))!!
        assertEquals("18:05", hm(r.departure))
        assertEquals(44, r.minutes)
    }

    @Test
    fun noItemsMeansNoRoute() {
        assertNull(TransitParser.parse("""{"items":[]}""", at(9, 18, 50)))
        assertNull(TransitParser.parse("""{"count":{}}""", at(9, 18, 50)))
    }

    @Test
    fun fallsBackToMinutesWhenTimesMissing() {
        val r = TransitParser.parse("""{"items":[{"summary":{"move":{"time":35}}}]}""", at(9, 18, 50))!!
        assertEquals("18:15", hm(r.departure))
    }

    @Test
    fun transitRouteSetsDepartureForUnregisteredPlace() {
        val e = CalendarEvent(7, "ゼミ飲み", at(9, 19), at(9, 21), false, 1, location = "渋谷駅")
        val now = at(8, 4)
        val s = AlarmSettings(places = Prefs.DEFAULT_PLACES, timetableEnabled = false)
        val transit = mapOf(e.key to TransitRoute(at(9, 18, 5), 44))
        val o = AlarmPlanner.outings(listOf(e), s, now, zone, now + 7 * 86_400_000L, transit).single()
        assertEquals(TravelSource.TRANSIT, o.source)
        assertEquals("18:05", hm(o.departure))
        assertEquals(listOf("17:15", "17:25"), o.alarms.map { hm(it.at) })
    }

    @Test
    fun registeredPlaceWinsOverTransit() {
        val e = CalendarEvent(8, "1217ファミマ", at(9, 14), at(9, 18), false, 1, location = "ファミリーマート〇〇店")
        val now = at(8, 4)
        val s = AlarmSettings(places = Prefs.DEFAULT_PLACES, timetableEnabled = false)
        val o = AlarmPlanner.outings(listOf(e), s, now, zone, now + 7 * 86_400_000L,
            mapOf(e.key to TransitRoute(at(9, 12), 100))).single()
        assertEquals(TravelSource.PLACE, o.source)
        assertEquals("13:40", hm(o.departure))
    }
}
