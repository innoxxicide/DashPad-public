package com.dashpad

import android.content.Context
import android.net.Uri
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.util.Calendar
import java.util.TimeZone

/** Screen settings mirrored from the Worker (`/api/settings` → display). */
data class DisplaySettings(
    val day: Int = 70,
    val night: Int = 10,
    val nightFrom: String = "23:00",
    val nightTo: String = "07:00",
    val batteryOffPct: Int = 30,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("dayBrightness", day).put("nightBrightness", night)
        .put("nightFrom", nightFrom).put("nightTo", nightTo)
        .put("batteryScreenOffPct", batteryOffPct)

    private fun minutes(hhmm: String): Int {
        val p = hhmm.split(":")
        return (p.getOrNull(0)?.toIntOrNull() ?: 0) * 60 + (p.getOrNull(1)?.toIntOrNull() ?: 0)
    }

    fun isNight(): Boolean {
        val c = Calendar.getInstance(TimeZone.getTimeZone("Europe/Kyiv"))
        val now = c.get(Calendar.HOUR_OF_DAY) * 60 + c.get(Calendar.MINUTE)
        val from = minutes(nightFrom)
        val to = minutes(nightTo)
        return if (from <= to) now in from until to else now >= from || now < to
    }

    companion object {
        fun from(j: JSONObject?): DisplaySettings {
            if (j == null) return DisplaySettings()
            val d = DisplaySettings()
            return DisplaySettings(
                day = j.optInt("dayBrightness", d.day),
                night = j.optInt("nightBrightness", d.night),
                nightFrom = j.optString("nightFrom", d.nightFrom),
                nightTo = j.optString("nightTo", d.nightTo),
                batteryOffPct = j.optInt("batteryScreenOffPct", d.batteryOffPct),
            )
        }
    }
}

/** Local settings. The dashboard URL (with the device key) and the PIN are set at provisioning:
 *  `adb shell am start -n com.dashpad/.MainActivity --es url "https://…/?k=…" --es pin 1234`. */
class Prefs(ctx: Context) {
    private val p = ctx.getSharedPreferences("dashpad", Context.MODE_PRIVATE)

    var url: String?
        get() = p.getString("url", null)
        set(v) = p.edit().putString("url", v).apply()

    var pin: String
        get() = p.getString("pin", "0000") ?: "0000"
        set(v) = p.edit().putString("pin", v).apply()

    var keepAdbWifi: Boolean
        get() = p.getBoolean("keepAdbWifi", false)
        set(v) = p.edit().putBoolean("keepAdbWifi", v).apply()

    var display: DisplaySettings
        get() = DisplaySettings.from(p.getString("display", null)?.let { runCatching { JSONObject(it) }.getOrNull() })
        set(v) = p.edit().putString("display", v.toJson().toString()).apply()
}

/** Minimal client for the Worker API, derived from the dashboard URL. Call off the main thread. */
object Remote {
    private fun parts(url: String): Pair<String, String>? {
        val u = Uri.parse(url)
        val key = u.getQueryParameter("k") ?: return null
        return "${u.scheme}://${u.authority}" to key
    }

    private fun call(url: String, path: String, method: String = "GET", body: String? = null): JSONObject? {
        val (base, key) = parts(url) ?: return null
        val c = URL(base + path).openConnection() as HttpURLConnection
        return try {
            c.requestMethod = method
            c.connectTimeout = 10_000
            c.readTimeout = 15_000
            c.setRequestProperty("Authorization", "Bearer $key")
            c.setRequestProperty("User-Agent", "DashPadAndroid/${BuildConfig.VERSION_NAME}")
            if (body != null) {
                c.doOutput = true
                c.setRequestProperty("Content-Type", "application/json; charset=utf-8")
                c.outputStream.use { it.write(body.toByteArray()) }
            }
            if (c.responseCode !in 200..299) null else JSONObject(c.inputStream.bufferedReader().readText())
        } catch (_: Exception) {
            null
        } finally {
            c.disconnect()
        }
    }

    fun settings(url: String): JSONObject? = call(url, "/api/settings")

    fun putBrightness(url: String, key: String, pct: Int): DisplaySettings? =
        call(url, "/api/settings", "PUT", JSONObject().put("display", JSONObject().put(key, pct)).toString())
            ?.optJSONObject("display")?.let { DisplaySettings.from(it) }

    fun health(url: String): JSONObject? = call(url, "/api/health")

    fun host(url: String?): String? = url?.let { Uri.parse(it).host }
}

/** The ⚙ panel's data-age line; feed-key prefixes come from the Worker (`alerts:active`, `dtek-fact:`/`svitlo:`, `weather:`). */
fun freshnessText(health: JSONObject?): String {
    if (health != null && !health.has("feeds")) return "Дані: ключ не прийнято"
    val feeds = health?.optJSONArray("feeds") ?: return "Дані: немає зв'язку з сервером"
    val rows = (0 until feeds.length()).mapNotNull { feeds.optJSONObject(it) }
    fun age(vararg prefixes: String): Long? = rows
        .filter { f -> prefixes.any { f.optString("key").startsWith(it) } }
        .mapNotNull { f -> f.optLong("ageSec", -1).takeIf { it >= 0 } }
        .minOrNull()
    val ages = listOf(
        "тривоги" to age("alerts:active"),
        "світло" to age("dtek-fact:", "svitlo:"),
        "погода" to age("weather:"),
        "Ход работ" to health.optLong("publisherHeartbeatAgeSec", -1).takeIf { it >= 0 },
    )
    val text = ages.map { (name, s) -> s?.let { "$name ${ageText(it)}" } ?: "$name —" }.joinToString(" · ")
    return "Дані: $text"
}

private fun ageText(s: Long): String = when {
    s < 60 -> "$s с"
    s < 3600 -> "${s / 60} хв"
    else -> "${s / 3600} год"
}
