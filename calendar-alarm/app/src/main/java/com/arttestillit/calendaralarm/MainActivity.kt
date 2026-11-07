package com.arttestillit.calendaralarm

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.content.Intent
import android.content.pm.PackageManager
import android.content.res.ColorStateList
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.View
import android.widget.AdapterView
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CheckBox
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.Switch
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.concurrent.Executors

class MainActivity : Activity() {
    private val prefs by lazy { Prefs(this) }
    private val repo by lazy { CalendarRepository(this) }
    private val worker = Executors.newSingleThreadExecutor()

    private lateinit var permissionBox: LinearLayout
    private lateinit var switchEnabled: Switch
    private lateinit var nextAlarm: TextView
    private lateinit var spinnerLead: Spinner
    private lateinit var spinnerSnooze: Spinner
    private lateinit var checkSkipDeclined: CheckBox
    private lateinit var calendarList: LinearLayout
    private lateinit var upcomingList: LinearLayout

    private val leadOptions = listOf(0, 5, 10, 15, 20, 30, 45, 60, 90, 120)
    private val snoozeOptions = listOf(1, 3, 5, 10, 15)
    private val dateFormat = SimpleDateFormat("M/d(E) HH:mm", Locale.JAPAN)
    private val timeFormat = SimpleDateFormat("HH:mm", Locale.JAPAN)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        permissionBox = findViewById(R.id.permissionBox)
        switchEnabled = findViewById(R.id.switchEnabled)
        nextAlarm = findViewById(R.id.nextAlarm)
        spinnerLead = findViewById(R.id.spinnerLead)
        spinnerSnooze = findViewById(R.id.spinnerSnooze)
        checkSkipDeclined = findViewById(R.id.checkSkipDeclined)
        calendarList = findViewById(R.id.calendarList)
        upcomingList = findViewById(R.id.upcomingList)

        AlarmNotifier.ensureChannel(this)

        switchEnabled.isChecked = prefs.enabled
        switchEnabled.setOnCheckedChangeListener { _, checked -> prefs.enabled = checked; refresh() }

        checkSkipDeclined.isChecked = prefs.skipDeclined
        checkSkipDeclined.setOnCheckedChangeListener { _, checked -> prefs.skipDeclined = checked; refresh() }

        setupSpinner(spinnerLead, leadOptions, { prefs.leadMinutes }, { if (it == 0) "開始時刻ちょうど" else "${it}分前" }) {
            prefs.leadMinutes = it
            refresh()
        }
        setupSpinner(spinnerSnooze, snoozeOptions, { prefs.snoozeMinutes }, { "${it}分" }) {
            prefs.snoozeMinutes = it
        }

        findViewById<Button>(R.id.btnSync).setOnClickListener {
            refresh()
            Toast.makeText(this, "カレンダーと同期しました", Toast.LENGTH_SHORT).show()
        }
        findViewById<Button>(R.id.btnTest).setOnClickListener { testAlarm() }

        requestRuntimePermissions()
    }

    override fun onResume() {
        super.onResume()
        SyncJobs.schedule(this)
        refresh()
    }

    override fun onDestroy() {
        worker.shutdown()
        super.onDestroy()
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        refresh()
    }

    private fun deniedRuntimePermissions(): List<String> = buildList {
        add(Manifest.permission.READ_CALENDAR)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

    private fun requestRuntimePermissions() {
        val needed = deniedRuntimePermissions()
        if (needed.isNotEmpty()) requestPermissions(needed.toTypedArray(), 1)
    }

    /** バックグラウンドで同期し、結果で画面を描き直す。 */
    private fun refresh() {
        worker.execute {
            val result = AlarmScheduler.sync(this)
            val calendars = repo.calendars()
            runOnUiThread {
                if (!isFinishing) render(result, calendars)
            }
        }
    }

    private fun render(result: SyncResult, calendars: List<CalendarInfo>) {
        renderPermissions(result)

        nextAlarm.text = when {
            !prefs.enabled -> "自動アラームはオフです"
            result.plan.isEmpty() -> "セット中のアラームはありません"
            else -> result.plan.first().let { "次のアラーム：${dateFormat.format(Date(it.triggerAt))}　${it.title}" } +
                if (result.plan.size > 1) "（ほか${result.plan.size - 1}件）" else ""
        }

        calendarList.removeAllViews()
        if (calendars.isEmpty()) calendarList.addView(hint(getString(R.string.no_calendars)))
        val excluded = prefs.excludedCalendarIds
        calendars.forEach { cal ->
            calendarList.addView(CheckBox(this).apply {
                text = if (cal.account.isNotBlank() && cal.account != cal.name) "${cal.name}\n${cal.account}" else cal.name
                isChecked = cal.id !in excluded
                buttonTintList = ColorStateList.valueOf(cal.color or 0xFF000000.toInt())
                minHeight = dp(48)
                setOnCheckedChangeListener { _, checked ->
                    prefs.excludedCalendarIds =
                        if (checked) prefs.excludedCalendarIds - cal.id else prefs.excludedCalendarIds + cal.id
                    refresh()
                }
            })
        }

        upcomingList.removeAllViews()
        if (result.candidates.isEmpty()) upcomingList.addView(hint(getString(R.string.no_events)))
        result.candidates.forEach { c ->
            val e = c.event
            upcomingList.addView(CheckBox(this).apply {
                text = "${dateFormat.format(Date(c.triggerAt))} に鳴る\n" +
                    "${timeFormat.format(Date(e.begin))}〜 ${e.title.ifBlank { PlannedAlarm.UNTITLED }}"
                isChecked = !c.skipped
                isEnabled = prefs.enabled
                minHeight = dp(48)
                setOnCheckedChangeListener { _, checked ->
                    prefs.skippedEventKeys =
                        if (checked) prefs.skippedEventKeys - e.key else prefs.skippedEventKeys + e.key
                    refresh()
                }
            })
        }
    }

    private fun renderPermissions(result: SyncResult) {
        permissionBox.removeAllViews()
        if (!result.hasCalendarPermission) {
            warning("カレンダーへのアクセスが許可されていません。", "許可する") { openAppSettingsOrRequest() }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            warning("通知が許可されていないため、アラームが鳴りません。", "許可する") { openAppSettingsOrRequest() }
        }
        if (!result.canScheduleExact && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            warning("「アラームとリマインダー」の権限が必要です。", "設定を開く") {
                startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:$packageName")))
            }
        }
        if (Build.VERSION.SDK_INT >= 34 &&
            !getSystemService(NotificationManager::class.java).canUseFullScreenIntent()
        ) {
            warning("ロック中に全画面でアラームを表示するには「全画面通知」の許可が必要です。", "設定を開く") {
                startActivity(Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, Uri.parse("package:$packageName")))
            }
        }
        permissionBox.visibility = if (permissionBox.childCount == 0) View.GONE else View.VISIBLE
    }

    private fun openAppSettingsOrRequest() {
        val denied = deniedRuntimePermissions()
        if (denied.any { shouldShowRequestPermissionRationale(it) }) {
            requestRuntimePermissions()
        } else {
            // 「今後表示しない」状態ではダイアログが出ないので、アプリ設定を開く
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun warning(message: String, button: String, onClick: () -> Unit) {
        permissionBox.addView(TextView(this).apply {
            text = message
            setTextColor(getColor(R.color.warning))
            setPadding(0, dp(8), 0, 0)
        })
        permissionBox.addView(Button(this).apply {
            text = button
            setOnClickListener { onClick() }
        })
    }

    private fun testAlarm() {
        if (!AlarmScheduler.canScheduleExact(this)) {
            Toast.makeText(this, "「アラームとリマインダー」の権限を許可してください", Toast.LENGTH_LONG).show()
            return
        }
        val at = System.currentTimeMillis() + 10_000
        AlarmScheduler.schedule(this, AlarmInfo("test", "テストアラーム", at, null), at)
        Toast.makeText(this, "10秒後に鳴ります（画面を消して試せます）", Toast.LENGTH_LONG).show()
    }

    private fun setupSpinner(
        spinner: Spinner,
        options: List<Int>,
        current: () -> Int,
        label: (Int) -> String,
        onSelected: (Int) -> Unit,
    ) {
        spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, options.map(label))
        spinner.setSelection(options.indexOf(current()).coerceAtLeast(0), false)
        spinner.onItemSelectedListener = object : AdapterView.OnItemSelectedListener {
            override fun onItemSelected(parent: AdapterView<*>?, view: View?, position: Int, id: Long) {
                val value = options[position]
                if (value != current()) onSelected(value)
            }

            override fun onNothingSelected(parent: AdapterView<*>?) = Unit
        }
    }

    private fun hint(text: String) = TextView(this).apply {
        this.text = text
        alpha = 0.7f
        setPadding(0, dp(8), 0, dp(8))
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
