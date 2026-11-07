package com.arttestillit.calendaralarm

import android.app.Activity
import android.os.Bundle
import android.view.WindowManager
import android.widget.Button
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/** ロック画面の上にも表示される鳴動画面。音は通知側で鳴っている。 */
class AlarmActivity : Activity() {
    private var info: AlarmInfo? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setShowWhenLocked(true)
        setTurnScreenOn(true)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        setContentView(R.layout.activity_alarm)
        bind()
        findViewById<Button>(R.id.btnStop).setOnClickListener {
            info?.let { AlarmNotifier.stop(this, it) }
            finish()
        }
        findViewById<Button>(R.id.btnSnooze).setOnClickListener {
            info?.let { AlarmNotifier.snooze(this, it) }
            finish()
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        bind()
    }

    private fun bind() {
        val i = AlarmInfo.from(intent) ?: run { finish(); return }
        info = i
        findViewById<TextView>(R.id.alarmClock).text =
            SimpleDateFormat("HH:mm", Locale.JAPAN).format(Date())
        findViewById<TextView>(R.id.alarmTitle).text = i.title
        findViewById<TextView>(R.id.alarmDetail).text = AlarmNotifier.detailText(i)
        findViewById<Button>(R.id.btnSnooze).text =
            "${getString(R.string.snooze)}（${Prefs(this).snoozeMinutes}分）"
    }
}
