package com.arttestillit.calendaralarm

import android.Manifest
import android.app.Activity
import android.app.NotificationManager
import android.app.TimePickerDialog
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
import android.widget.EditText
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
    private lateinit var nextAlarm: TextView
    private lateinit var upcomingList: LinearLayout
    private lateinit var placeList: LinearLayout
    private lateinit var timetableList: LinearLayout
    private lateinit var calendarList: LinearLayout
    private lateinit var editOffsets: EditText
    private lateinit var btnTtTime: Button

    private var ttMinute = 9 * 60
    private val dayNames = listOf("月", "火", "水", "木", "金", "土", "日")
    private val dateFormat = SimpleDateFormat("M/d(E)", Locale.JAPAN)
    private val timeFormat = SimpleDateFormat("HH:mm", Locale.JAPAN)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        permissionBox = findViewById(R.id.permissionBox)
        nextAlarm = findViewById(R.id.nextAlarm)
        upcomingList = findViewById(R.id.upcomingList)
        placeList = findViewById(R.id.placeList)
        timetableList = findViewById(R.id.timetableList)
        calendarList = findViewById(R.id.calendarList)
        editOffsets = findViewById(R.id.editOffsets)
        btnTtTime = findViewById(R.id.btnTtTime)

        AlarmNotifier.ensureChannel(this)
        setupSettings()
        setupPlaces()
        setupTimetable()
        setupTransit()

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

    // ---- 設定 ----

    private fun setupSettings() {
        findViewById<Switch>(R.id.switchEnabled).apply {
            isChecked = prefs.enabled
            setOnCheckedChangeListener { _, v -> prefs.enabled = v; refresh() }
        }
        editOffsets.setText(prefs.alarmOffsets.joinToString(","))
        findViewById<Button>(R.id.btnSaveOffsets).setOnClickListener {
            val offsets = Prefs.parseOffsets(editOffsets.text.toString())
            if (offsets.isEmpty()) {
                Toast.makeText(this, "分を数字で入力してください（例：50,40）", Toast.LENGTH_SHORT).show()
            } else {
                prefs.alarmOffsets = offsets
                editOffsets.setText(offsets.joinToString(","))
                refresh()
                Toast.makeText(this, "出発の ${offsets.joinToString("分前・")}分前 に鳴らします", Toast.LENGTH_SHORT).show()
            }
        }
        setupSpinner(findViewById(R.id.spinnerArriveEarly), listOf(0, 5, 10, 15, 20, 30),
            { prefs.arriveEarlyMinutes }, { if (it == 0) "ちょうどに着く" else "${it}分前" }) {
            prefs.arriveEarlyMinutes = it; refresh()
        }
        setupSpinner(findViewById(R.id.spinnerDefaultTravel), listOf(0, 10, 15, 20, 30, 45, 60, 90, 120),
            { prefs.defaultTravelMinutes }, { "${it}分" }) {
            prefs.defaultTravelMinutes = it; refresh()
        }
        setupSpinner(findViewById(R.id.spinnerSnooze), listOf(1, 3, 5, 10, 15),
            { prefs.snoozeMinutes }, { "${it}分" }) {
            prefs.snoozeMinutes = it
        }
        bindCheck(R.id.checkFirstOnly, { prefs.firstOutingOnly }) { prefs.firstOutingOnly = it }
        bindCheck(R.id.checkSkipDeclined, { prefs.skipDeclined }) { prefs.skipDeclined = it }
        bindCheck(R.id.checkTimetable, { prefs.timetableEnabled }) { prefs.timetableEnabled = it }
        bindCheck(R.id.checkHolidays, { prefs.skipTimetableOnHolidays }) { prefs.skipTimetableOnHolidays = it }
    }

    private fun bindCheck(id: Int, get: () -> Boolean, set: (Boolean) -> Unit) {
        findViewById<CheckBox>(id).apply {
            isChecked = get()
            setOnCheckedChangeListener { _, v -> set(v); refresh() }
        }
    }

    // ---- 場所 ----

    private fun setupPlaces() {
        val keyword = findViewById<EditText>(R.id.editPlaceKeyword)
        val minutes = findViewById<EditText>(R.id.editPlaceMinutes)
        findViewById<Button>(R.id.btnAddPlace).setOnClickListener {
            val k = keyword.text.toString().trim()
            val m = minutes.text.toString().trim().toIntOrNull()
            if (k.isEmpty() || m == null || m !in 0..600) {
                Toast.makeText(this, "場所の言葉と移動時間（分）を入力してください", Toast.LENGTH_SHORT).show()
                return@setOnClickListener
            }
            prefs.places = prefs.places.filterNot { it.keyword == k } + Place(k, m)
            keyword.text.clear(); minutes.text.clear()
            renderPlaces(); refresh()
        }
        renderPlaces()
    }

    private fun renderPlaces() {
        placeList.removeAllViews()
        prefs.places.forEach { p ->
            placeList.addView(removableRow("${p.keyword}　→　移動 ${p.travelMinutes}分") {
                prefs.places = prefs.places - p
                renderPlaces(); refresh()
            })
        }
    }

    // ---- 公共交通機関 ----

    private fun setupTransit() {
        val editHome = findViewById<EditText>(R.id.editHome)
        val editKey = findViewById<EditText>(R.id.editApiKey)
        editHome.setText(prefs.homeLabel)
        editKey.setText(prefs.rapidApiKey)
        findViewById<Button>(R.id.btnSaveHome).setOnClickListener {
            val text = editHome.text.toString().trim()
            if (text.isEmpty()) {
                prefs.home = null; prefs.homeLabel = ""
                renderTransitStatus(); refresh()
                return@setOnClickListener
            }
            Toast.makeText(this, "場所を調べています…", Toast.LENGTH_SHORT).show()
            worker.execute {
                val resolver = TransitResolver(this)
                val pos = resolver.geocode(text)
                val address = pos?.let { resolver.describe(text) }
                runOnUiThread {
                    if (pos == null) {
                        Toast.makeText(this, "場所が見つかりませんでした。住所を詳しく入れてみてください", Toast.LENGTH_LONG).show()
                    } else {
                        prefs.home = pos
                        prefs.homeLabel = text
                        findViewById<TextView>(R.id.homeStatus).text = "→ ${address ?: pos.key}"
                        refresh()
                    }
                    renderTransitStatus()
                }
            }
        }
        findViewById<Button>(R.id.btnSaveApiKey).setOnClickListener {
            prefs.rapidApiKey = editKey.text.toString()
            Toast.makeText(this, "APIキーを保存しました", Toast.LENGTH_SHORT).show()
            renderTransitStatus(); refresh()
        }
        findViewById<Button>(R.id.btnGetApiKey).setOnClickListener {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(TransitResolver.SIGNUP_URL)))
        }
        renderTransitStatus()
    }

    private fun renderTransitStatus() {
        val home = findViewById<TextView>(R.id.homeStatus)
        if (prefs.home == null) home.text = "家が未設定です"
        else if (home.text.isNullOrBlank() || home.text == "家が未設定です") home.text = "→ 設定済み（${prefs.home?.key}）"
        val used = TransitResolver(this).usedThisMonth()
        findViewById<TextView>(R.id.transitStatus).text = when {
            prefs.home == null || prefs.rapidApiKey.isBlank() ->
                "家とAPIキーを設定すると、登録していない場所は電車の所要時間で計算します。"
            else -> "経路検索：今月 $used / ${TransitResolver.MONTHLY_LIMIT} 回（同じ予定は保存した結果を使います）"
        }
    }

    // ---- 時間割 ----

    private fun setupTimetable() {
        val day = findViewById<Spinner>(R.id.spinnerTtDay)
        day.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, dayNames)
        btnTtTime.text = hm(ttMinute)
        btnTtTime.setOnClickListener {
            TimePickerDialog(this, { _, h, m -> ttMinute = h * 60 + m; btnTtTime.text = hm(ttMinute) },
                ttMinute / 60, ttMinute % 60, true).show()
        }
        val name = findViewById<EditText>(R.id.editTtName)
        val place = findViewById<EditText>(R.id.editTtPlace)
        findViewById<Button>(R.id.btnAddTt).setOnClickListener {
            val entry = TimetableEntry(
                dayOfWeek = day.selectedItemPosition + 1,
                startMinute = ttMinute,
                name = name.text.toString().trim().ifEmpty { "授業" },
                place = place.text.toString().trim(),
            )
            prefs.timetable = (prefs.timetable.filterNot { it.dayOfWeek == entry.dayOfWeek && it.startMinute == entry.startMinute } + entry)
                .sortedWith(compareBy({ it.dayOfWeek }, { it.startMinute }))
            name.text.clear()
            renderTimetable(); refresh()
        }
        renderTimetable()
    }

    private fun renderTimetable() {
        timetableList.removeAllViews()
        prefs.timetable.forEach { e ->
            val where = if (e.place.isBlank()) "" else "　@${e.place}"
            timetableList.addView(removableRow("${dayNames[e.dayOfWeek - 1]}　${hm(e.startMinute)}　${e.name}$where") {
                prefs.timetable = prefs.timetable - e
                renderTimetable(); refresh()
            })
        }
    }

    // ---- 同期と描画 ----

    private fun refresh() {
        worker.execute {
            val result = AlarmScheduler.sync(this)
            val calendars = repo.calendars()
            runOnUiThread {
                if (!isFinishing) {
                    render(result, calendars)
                    renderTransitStatus()
                }
            }
        }
    }

    private fun render(result: SyncResult, calendars: List<CalendarInfo>) {
        renderPermissions(result)

        nextAlarm.text = when {
            !prefs.enabled -> "自動アラームはオフです"
            result.plan.isEmpty() -> "セット中のアラームはありません"
            else -> result.plan.first().let { a ->
                "次のアラーム：${dateFormat.format(Date(a.triggerAt))} ${timeFormat.format(Date(a.triggerAt))}" +
                    "（${a.items.first().first.title}）\nこの先1週間で ${result.plan.size} 回セット済み"
            }
        }

        upcomingList.removeAllViews()
        if (result.outings.isEmpty()) upcomingList.addView(hint(getString(R.string.no_events)))
        result.outings.forEach { upcomingList.addView(outingRow(it)) }

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
    }

    private fun outingRow(o: Outing): View {
        val e = o.event
        val box = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(0, dp(6), 0, dp(6))
        }
        val tag = if (o.fromTimetable) "［時間割］" else ""
        val via = when (o.source) {
            TravelSource.PLACE -> "${o.place?.keyword}・移動${o.travelMinutes}分"
            TravelSource.TRANSIT -> "電車など${o.travelMinutes}分・NAVITIME"
            TravelSource.DEFAULT -> "移動${o.travelMinutes}分（仮）"
        }
        val alarms = when {
            o.muted == MuteReason.NOT_FIRST_OF_DAY -> "この日は先に出かけているので鳴らしません"
            o.muted == MuteReason.SKIPPED -> "鳴らしません"
            o.alarms.isEmpty() -> "アラーム時刻は過ぎています"
            else -> "⏰ " + o.alarms.joinToString(" / ") { timeFormat.format(Date(it.at)) }
        }
        box.addView(CheckBox(this).apply {
            text = "${dateFormat.format(Date(e.begin))} ${timeFormat.format(Date(e.begin))}　$tag${o.title}\n" +
                "出発 ${timeFormat.format(Date(o.departure))}（$via）\n$alarms"
            isChecked = o.muted != MuteReason.SKIPPED
            isEnabled = prefs.enabled
            alpha = if (o.active) 1f else 0.55f
            minHeight = dp(48)
            setOnCheckedChangeListener { _, checked ->
                prefs.skippedEventKeys =
                    if (checked) prefs.skippedEventKeys - e.key else prefs.skippedEventKeys + e.key
                refresh()
            }
        })
        if (o.source == TravelSource.DEFAULT && o.active) {
            val location = e.location?.takeIf(String::isNotBlank)
            box.addView(TextView(this).apply {
                text = when {
                    location == null -> "⚠ 予定に場所が入っていません。カレンダーの予定に場所を入れるか、「場所と移動時間」に登録してください"
                    prefs.home == null || prefs.rapidApiKey.isBlank() ->
                        "⚠ 家とAPIキーを設定すると「$location」までの電車の時間で計算します"
                    else -> "⚠ 「$location」までの経路が見つかりませんでした。「場所と移動時間」に登録してください"
                }
                setTextColor(getColor(R.color.warning))
                textSize = 12f
                setPadding(dp(32), 0, 0, 0)
            })
        }
        return box
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

    // ---- 権限 ----

    private fun deniedRuntimePermissions(): List<String> = buildList {
        add(Manifest.permission.READ_CALENDAR)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) add(Manifest.permission.POST_NOTIFICATIONS)
    }.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }

    private fun requestRuntimePermissions() {
        val needed = deniedRuntimePermissions()
        if (needed.isNotEmpty()) requestPermissions(needed.toTypedArray(), 1)
    }

    private fun openAppSettingsOrRequest() {
        if (deniedRuntimePermissions().any { shouldShowRequestPermissionRationale(it) }) {
            requestRuntimePermissions()
        } else {
            // 「今後表示しない」状態ではダイアログが出ないので、アプリ設定を開く
            startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:$packageName")))
        }
    }

    private fun testAlarm() {
        if (!AlarmScheduler.canScheduleExact(this)) {
            Toast.makeText(this, "「アラームとリマインダー」の権限を許可してください", Toast.LENGTH_LONG).show()
            return
        }
        val at = System.currentTimeMillis() + 10_000
        AlarmScheduler.schedule(this, AlarmInfo("test", "テストアラーム", "10秒後に鳴るテストです"), at)
        Toast.makeText(this, "10秒後に鳴ります（画面を消して試せます）", Toast.LENGTH_LONG).show()
    }

    // ---- 部品 ----

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

    private fun removableRow(label: String, onRemove: () -> Unit) = LinearLayout(this).apply {
        orientation = LinearLayout.HORIZONTAL
        addView(TextView(context).apply {
            text = label
            textSize = 15f
            layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                .apply { gravity = android.view.Gravity.CENTER_VERTICAL }
        })
        addView(Button(context, null, android.R.attr.borderlessButtonStyle).apply {
            text = "削除"
            setOnClickListener { onRemove() }
        })
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

    private fun hm(minuteOfDay: Int) = "%d:%02d".format(minuteOfDay / 60, minuteOfDay % 60)

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()
}
