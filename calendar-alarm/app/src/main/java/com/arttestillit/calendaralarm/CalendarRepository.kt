package com.arttestillit.calendaralarm

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.provider.CalendarContract
import android.provider.CalendarContract.Calendars as c
import android.provider.CalendarContract.Instances as i

data class CalendarInfo(val id: Long, val name: String, val account: String, val color: Int)

class CalendarRepository(context: Context) {
    private val ctx = context.applicationContext

    fun hasPermission(): Boolean =
        ctx.checkSelfPermission(Manifest.permission.READ_CALENDAR) == PackageManager.PERMISSION_GRANTED

    fun calendars(): List<CalendarInfo> {
        if (!hasPermission()) return emptyList()
        val projection = arrayOf(c._ID, c.CALENDAR_DISPLAY_NAME, c.ACCOUNT_NAME, c.CALENDAR_COLOR)
        val result = mutableListOf<CalendarInfo>()
        ctx.contentResolver.query(
            c.CONTENT_URI, projection, "${c.VISIBLE} = 1", null,
            "${c.ACCOUNT_NAME} ASC, ${c.CALENDAR_DISPLAY_NAME} ASC",
        )?.use { cur ->
            while (cur.moveToNext()) {
                result += CalendarInfo(
                    id = cur.getLong(0),
                    name = cur.getString(1).orEmpty(),
                    account = cur.getString(2).orEmpty(),
                    color = cur.getInt(3),
                )
            }
        }
        return result
    }

    /** [from, to] に重なる予定インスタンス（繰り返し展開済み）を返す。 */
    fun events(from: Long, to: Long): List<CalendarEvent> {
        if (!hasPermission()) return emptyList()
        val uri = i.CONTENT_URI.buildUpon().also {
            ContentUris.appendId(it, from)
            ContentUris.appendId(it, to)
        }.build()
        val projection = arrayOf(
            i.EVENT_ID, i.TITLE, i.BEGIN, i.END, i.ALL_DAY, i.CALENDAR_ID,
            i.EVENT_LOCATION, i.SELF_ATTENDEE_STATUS, i.STATUS,
        )
        val result = mutableListOf<CalendarEvent>()
        ctx.contentResolver.query(uri, projection, "${i.VISIBLE} = 1", null, "${i.BEGIN} ASC")?.use { cur ->
            while (cur.moveToNext()) {
                result += CalendarEvent(
                    eventId = cur.getLong(0),
                    title = cur.getString(1).orEmpty(),
                    begin = cur.getLong(2),
                    end = cur.getLong(3),
                    allDay = cur.getInt(4) != 0,
                    calendarId = cur.getLong(5),
                    location = cur.getString(6),
                    declined = !cur.isNull(7) &&
                        cur.getInt(7) == CalendarContract.Attendees.ATTENDEE_STATUS_DECLINED,
                    canceled = !cur.isNull(8) &&
                        cur.getInt(8) == CalendarContract.Events.STATUS_CANCELED,
                )
            }
        }
        return result
    }
}
