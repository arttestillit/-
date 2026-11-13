package app.nighthike

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
import android.provider.Settings
import android.webkit.JavascriptInterface
import android.webkit.JsResult
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var web: WebView
    private val reqCode = 1

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        web = WebView(this)
        setContentView(web)
        with(web.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = true
            allowUniversalAccessFromFileURLs = true
        }
        web.webViewClient = WebViewClient()
        // confirm()/alert() を WebView で表示する(既定では何も出ず、キャンセル扱いになるため)
        web.webChromeClient = object : WebChromeClient() {
            override fun onJsConfirm(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setNegativeButton("キャンセル") { _, _ -> result?.cancel() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }
            override fun onJsAlert(view: WebView?, url: String?, message: String?, result: JsResult?): Boolean {
                AlertDialog.Builder(this@MainActivity).setMessage(message)
                    .setPositiveButton("OK") { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.confirm() }
                    .show()
                return true
            }
        }
        web.addJavascriptInterface(Bridge(), "Android")
        web.loadUrl("file:///android_asset/index.html")
    }

    override fun onBackPressed() {
        moveTaskToBack(true)   // 戻るボタンでアプリを終了させない(記録は継続)
    }

    private fun ensurePermissionsThenStart() {
        val need = mutableListOf(
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.ACCESS_COARSE_LOCATION
        )
        if (Build.VERSION.SDK_INT >= 33) need.add(Manifest.permission.POST_NOTIFICATIONS)
        val missing = need.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isEmpty()) startTracking()
        else requestPermissions(missing.toTypedArray(), reqCode)
    }

    override fun onRequestPermissionsResult(code: Int, perms: Array<out String>, res: IntArray) {
        super.onRequestPermissionsResult(code, perms, res)
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED) {
            startTracking()
        } else {
            Toast.makeText(this, "位置情報の許可が必要です", Toast.LENGTH_LONG).show()
        }
    }

    private fun startTracking() {
        val i = Intent(this, TrackService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(i) else startService(i)
        // 画面消灯中も止められないよう、電池の最適化から除外してもらう(初回のみ)
        val prefs = getSharedPreferences("app", MODE_PRIVATE)
        val pm = getSystemService(POWER_SERVICE) as PowerManager
        if (!prefs.getBoolean("askedBattery", false) && !pm.isIgnoringBatteryOptimizations(packageName)) {
            prefs.edit().putBoolean("askedBattery", true).apply()
            try {
                startActivity(
                    Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:$packageName"))
                )
            } catch (e: Exception) {}
        }
    }

    inner class Bridge {
        @JavascriptInterface fun start() { runOnUiThread { ensurePermissionsThenStart() } }
        @JavascriptInterface fun stop() { runOnUiThread { stopService(Intent(this@MainActivity, TrackService::class.java)) } }
        @JavascriptInterface fun isTracking(): Boolean = TrackService.running
        @JavascriptInterface fun getTrack(): String = TrackService.readTrackJson(this@MainActivity)
        @JavascriptInterface fun clearTrack() { TrackService.clearTrack(this@MainActivity) }
        @JavascriptInterface fun share(text: String) {
            runOnUiThread {
                val send = Intent(Intent.ACTION_SEND).apply {
                    type = "text/plain"
                    putExtra(Intent.EXTRA_TEXT, text)
                }
                startActivity(Intent.createChooser(send, "ログを共有"))
            }
        }
    }
}
