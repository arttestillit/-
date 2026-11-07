package com.arttestillit.calendaralarm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class AlarmPlannerTest {
    private val min = 60_000L
    private val now = 1_000_000_000_000L

    private fun ev(id: Long, beginMin: Long, title: String = "予定$id", cal: Long = 1, allDay: Boolean = false,
                   declined: Boolean = false, canceled: Boolean = false) =
        CalendarEvent(id, title, now + beginMin * min, now + (beginMin + 60) * min, allDay, cal,
            declined = declined, canceled = canceled)

    @Test
    fun alarmRingsLeadMinutesBeforeEvent() {
        val c = AlarmPlanner.candidates(listOf(ev(1, 120)), AlarmSettings(leadMinutes = 30), now)
        assertEquals(now + 90 * min, c.single().triggerAt)
    }

    @Test
    fun skipsAllDayCanceledDeclinedAndExcludedCalendars() {
        val events = listOf(
            ev(1, 120, allDay = true), ev(2, 120, canceled = true), ev(3, 120, declined = true),
            ev(4, 120, cal = 9), ev(5, 120),
        )
        val c = AlarmPlanner.candidates(events, AlarmSettings(excludedCalendarIds = setOf(9L)), now)
        assertEquals(listOf(5L), c.map { it.event.eventId })
    }

    @Test
    fun declinedIncludedWhenOptionOff() {
        val c = AlarmPlanner.candidates(listOf(ev(3, 120, declined = true)), AlarmSettings(skipDeclined = false), now)
        assertEquals(1, c.size)
    }

    @Test
    fun dropsAlarmsWhoseTimeHasPassedOrBeyondHorizon() {
        val events = listOf(ev(1, 10), ev(2, 31), ev(3, 600))
        val c = AlarmPlanner.candidates(events, AlarmSettings(leadMinutes = 30), now, horizon = now + 120 * min)
        assertEquals(listOf(2L), c.map { it.event.eventId })
    }

    @Test
    fun skippedEventsAreListedButNotPlanned() {
        val e = ev(1, 120)
        val settings = AlarmSettings(skippedEventKeys = setOf(e.key))
        val c = AlarmPlanner.candidates(listOf(e, ev(2, 180)), settings, now)
        assertTrue(c.first().skipped)
        assertEquals(listOf(2L), AlarmPlanner.plan(c, true).flatMap { a -> a.events.map { it.eventId } })
    }

    @Test
    fun eventsAtSameTimeShareOneAlarm() {
        val c = AlarmPlanner.candidates(listOf(ev(1, 120, "会議"), ev(2, 120, "会議"), ev(3, 120, "電話")),
            AlarmSettings(), now)
        val plan = AlarmPlanner.plan(c, true)
        assertEquals(1, plan.size)
        assertEquals("会議 / 電話", plan.single().title)
    }

    @Test
    fun recurringInstancesAreDistinct() {
        val c = AlarmPlanner.candidates(listOf(ev(1, 120), ev(1, 120 + 24 * 60)), AlarmSettings(), now)
        assertEquals(2, AlarmPlanner.plan(c, true).size)
    }

    @Test
    fun disabledPlansNothing() {
        val c = AlarmPlanner.candidates(listOf(ev(1, 120)), AlarmSettings(), now)
        assertTrue(AlarmPlanner.plan(c, false).isEmpty())
    }
}
