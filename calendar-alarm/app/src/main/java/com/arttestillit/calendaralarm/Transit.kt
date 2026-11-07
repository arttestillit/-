package com.arttestillit.calendaralarm

import android.content.Context
import android.location.Geocoder
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.OffsetDateTime
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

data class LatLon(val lat: Double, val lon: Double) {
    val key: String get() = "%.5f,%.5f".format(Locale.US, lat, lon)
}

/** NAVITIME ルート検索（トータルナビ）の結果を読む。 */
object TransitParser {
    /**
     * 到着時刻 [goalTime] までに着く経路のうち、いちばん遅く家を出られるものを返す。
     * 経路が無ければ null。
     */
    fun parse(json: String, goalTime: Long): TransitRoute? {
        val items = JSONObject(json).optJSONArray("items") ?: return null
        val routes = (0 until items.length()).mapNotNull { i ->
            val move = items.optJSONObject(i)?.optJSONObject("summary")?.optJSONObject("move") ?: return@mapNotNull null
            val minutes = move.optInt("time", -1)
            val from = parseTime(move.optString("from_time"))
            val to = parseTime(move.optString("to_time"))
            when {
                from != null -> TransitRoute(from, if (minutes >= 0) minutes else ((to ?: goalTime) - from).div(60_000).toInt()) to to
                minutes >= 0 -> TransitRoute(goalTime - minutes * 60_000L, minutes) to goalTime
                else -> null
            }
        }
        val onTime = routes.filter { (_, arrive) -> arrive == null || arrive <= goalTime }.ifEmpty { routes }
        return onTime.maxByOrNull { it.first.departure }?.first
    }

    private fun parseTime(s: String?): Long? =
        s?.takeIf { it.isNotBlank() }?.let { runCatching { OffsetDateTime.parse(it).toInstant().toEpochMilli() }.getOrNull() }
}

/**
 * 登録場所に一致しない予定について、予定の「場所」を地図上の位置に変換し、
 * 家からの公共交通機関の経路を NAVITIME（RapidAPI）で調べる。
 * 結果は保存して使い回し、月の検索回数は [MONTHLY_LIMIT] までに抑える。
 */
class TransitResolver(context: Context) {
    private val ctx = context.applicationContext
    private val cache = ctx.getSharedPreferences("transit_cache", Context.MODE_PRIVATE)

    fun resolve(outings: List<Outing>, prefs: Prefs, now: Long): Map<String, TransitRoute> {
        val home = prefs.home ?: return emptyMap()
        val apiKey = prefs.rapidApiKey.trim()
        val routes = loadRoutes()
        val geocodes = loadGeocodes()
        val result = mutableMapOf<String, TransitRoute>()
        var fetched = 0

        for (o in outings) {
            if (!o.active || o.place != null) continue
            val location = o.event.location?.trim()?.takeIf { it.isNotEmpty() } ?: continue
            val cached = geocodes[location] ?: lookup(location, home)?.also { geocodes[location] = it } ?: continue
            val goal = cached.takeIf { it.isNotEmpty() }?.let(::parseLatLon) ?: continue
            val goalTime = o.event.begin - prefs.arriveEarlyMinutes * 60_000L
            val key = "${home.key}>${goal.key}@$goalTime"

            if (routes.has(key)) {
                routes.getJSONObject(key).toRoute()?.let { result[o.event.key] = it }
                continue
            }
            if (apiKey.isEmpty() || fetched >= MAX_PER_SYNC || !takeBudget()) continue
            fetched++
            val fetchedResult = runCatching { fetch(apiKey, home, goal, goalTime) }.getOrNull() ?: continue
            routes.put(key, fetchedResult.toJson(goalTime))
            fetchedResult.route?.let { result[o.event.key] = it }
        }

        // 終わった予定の経路は消す
        routes.keys().asSequence().toList().forEach { k ->
            if (routes.getJSONObject(k).optLong("g") < now) routes.remove(k)
        }
        cache.edit()
            .putString(KEY_ROUTES, routes.toString())
            .putString(KEY_GEOCODES, JSONObject(geocodes as Map<*, *>).toString())
            .apply()
        return result
    }

    /** 今月の検索回数。 */
    fun usedThisMonth(): Int =
        if (cache.getString(KEY_MONTH, null) == currentMonth()) cache.getInt(KEY_COUNT, 0) else 0

    /** 住所や駅名を位置に変換する（端末の Geocoder を使用、キー不要）。 */
    fun geocode(text: String, near: LatLon? = null): LatLon? =
        lookup(text, near)?.takeIf { it.isNotEmpty() }?.let(::parseLatLon)

    /** "lat,lon"、見つからなければ ""、通信エラーなどで分からなければ null（保存しない）。 */
    private fun lookup(text: String, near: LatLon?): String? {
        if (!Geocoder.isPresent()) return null
        val g = Geocoder(ctx, Locale.JAPAN)
        return runCatching {
            // 家の近く（約100km四方）を優先して探す
            @Suppress("DEPRECATION")
            val nearby = near?.let {
                g.getFromLocationName(text, 1, it.lat - 1.0, it.lon - 1.0, it.lat + 1.0, it.lon + 1.0)
            }
            @Suppress("DEPRECATION")
            val any = if (nearby.isNullOrEmpty()) g.getFromLocationName(text, 1) else nearby
            any?.firstOrNull()?.let { LatLon(it.latitude, it.longitude).key } ?: ""
        }.getOrNull()
    }

    fun describe(text: String): String? = runCatching {
        if (!Geocoder.isPresent()) return null
        @Suppress("DEPRECATION")
        Geocoder(ctx, Locale.JAPAN).getFromLocationName(text, 1)?.firstOrNull()?.getAddressLine(0)
    }.getOrNull()

    private class Fetched(val route: TransitRoute?) {
        fun toJson(goalTime: Long): JSONObject = JSONObject().put("g", goalTime).apply {
            if (route != null) put("d", route.departure).put("m", route.minutes)
        }
    }

    private fun JSONObject.toRoute(): TransitRoute? =
        if (has("d")) TransitRoute(getLong("d"), getInt("m")) else null

    private fun fetch(apiKey: String, home: LatLon, goal: LatLon, goalTime: Long): Fetched? {
        val time = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss")
            .format(Instant.ofEpochMilli(goalTime).atZone(ZoneId.of("Asia/Tokyo")))
        val url = Uri.parse(ENDPOINT).buildUpon()
            .appendQueryParameter("start", "${home.lat},${home.lon}")
            .appendQueryParameter("goal", "${goal.lat},${goal.lon}")
            .appendQueryParameter("goal_time", time)
            .appendQueryParameter("limit", "3")
            .build().toString()
        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 10_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("x-rapidapi-key", apiKey)
            conn.setRequestProperty("x-rapidapi-host", HOST)
            val code = conn.responseCode
            if (code != 200) {
                // キー間違い・回数超過などは保存せず、次回また試す
                return null
            }
            val body = conn.inputStream.bufferedReader().use { it.readText() }
            return Fetched(TransitParser.parse(body, goalTime))
        } finally {
            conn.disconnect()
        }
    }

    private fun takeBudget(): Boolean {
        val month = currentMonth()
        val used = usedThisMonth()
        if (used >= MONTHLY_LIMIT) return false
        cache.edit().putString(KEY_MONTH, month).putInt(KEY_COUNT, used + 1).apply()
        return true
    }

    private fun currentMonth() = java.time.YearMonth.now().toString()

    private fun loadRoutes() = runCatching { JSONObject(cache.getString(KEY_ROUTES, "{}")!!) }.getOrDefault(JSONObject())

    private fun loadGeocodes(): MutableMap<String, String> = runCatching {
        val o = JSONObject(cache.getString(KEY_GEOCODES, "{}")!!)
        o.keys().asSequence().associateWith { o.getString(it) }.toMutableMap()
    }.getOrDefault(mutableMapOf())

    private fun parseLatLon(s: String): LatLon? = s.split(',').takeIf { it.size == 2 }?.let {
        val lat = it[0].toDoubleOrNull() ?: return null
        val lon = it[1].toDoubleOrNull() ?: return null
        LatLon(lat, lon)
    }

    companion object {
        const val MONTHLY_LIMIT = 450 // 無料枠 500回/月 に余裕を残す
        private const val MAX_PER_SYNC = 15
        private const val HOST = "navitime-route-totalnavi.p.rapidapi.com"
        private const val ENDPOINT = "https://$HOST/route_transit"
        const val SIGNUP_URL = "https://rapidapi.com/navitimejapan-navitimejapan/api/navitime-route-totalnavi"
        private const val KEY_ROUTES = "routes"
        private const val KEY_GEOCODES = "geocodes"
        private const val KEY_MONTH = "month"
        private const val KEY_COUNT = "count"
    }
}
