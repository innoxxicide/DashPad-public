package com.dashpad

import android.content.Context
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.media.AudioManager
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.net.wifi.WifiManager
import android.content.res.ColorStateList
import android.text.TextUtils
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.SeekBar
import android.widget.TextView
import java.net.Inet4Address

/** What the ⚙ panel can ask the activity to do. */
interface PanelActions {
    fun brightnessNow(): Int
    fun isNight(): Boolean
    fun previewBrightness(pct: Int)
    fun saveBrightness(pct: Int, night: Boolean)
    fun openWifi()
    fun openDashboardSettings()
    fun reloadPage()
    fun restartApp()
    fun rebootTablet()
    fun openService()
    fun statusLine(): String
    fun closePanel()
    fun brightnessCapped(): Boolean
    fun reloadProgress()
    fun isOwner(): Boolean
}

/** Native control panel opened by the ⚙ button: Wi-Fi, brightness, volume, actions. Swiss style like the dashboard. */
class ControlPanel(private val ctx: Context, private val actions: PanelActions) {
    companion object {
        const val BG = 0xFF17181B.toInt()
        const val INK = 0xFFEDEDEA.toInt()
        const val INK2 = 0xFFB9BAB6.toInt()
        const val MUTED = 0xFF8E8F94.toInt()
        const val FAINT = 0xFF6E6F74.toInt()
        const val RULE = 0xFF2B2C30.toInt()
        const val ACCENT = 0xFFFF6B2C.toInt()
        private const val TAG = "DashPad"
        private const val AUTO_CLOSE_MS = 120_000L
    }

    /** dispatchTouchEvent runs before the children, so a slider drag restarts the wait too;
     *  a dialog is its own window, so the wait pauses while this window has no focus. */
    private inner class AutoCloseRoot : FrameLayout(ctx) {
        private val fire = Runnable { Log.i(TAG, "panel auto-close"); actions.closePanel() }
        private fun restart() { removeCallbacks(fire); postDelayed(fire, AUTO_CLOSE_MS) }
        override fun onAttachedToWindow() { super.onAttachedToWindow(); restart() }
        override fun onDetachedFromWindow() { removeCallbacks(fire); super.onDetachedFromWindow() }
        override fun dispatchTouchEvent(ev: MotionEvent): Boolean { restart(); return super.dispatchTouchEvent(ev) }
        override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
            super.onWindowFocusChanged(hasWindowFocus)
            if (hasWindowFocus) restart() else removeCallbacks(fire)
        }
    }

    private val d = ctx.resources.displayMetrics.density
    private fun dp(v: Int) = (v * d).toInt()
    private val light = Typeface.create("sans-serif-light", Typeface.NORMAL)
    private val medium = Typeface.create("sans-serif-medium", Typeface.NORMAL)
    private val audio = ctx.getSystemService(AudioManager::class.java)

    private lateinit var wifiName: TextView
    private lateinit var wifiDetail: TextView
    private lateinit var brightLabel: TextView
    private lateinit var brightValue: TextView
    private lateinit var brightBar: SeekBar
    private lateinit var volumeBar: SeekBar
    private lateinit var status: TextView
    private lateinit var fresh: TextView
    private var shownNight = false

    val view: View = build()

    init {
        fresh.text = "Дані: перевірка…"
    }

    fun showFreshness(text: String) {
        fresh.text = text
    }

    private fun label(text: String) = TextView(ctx).apply {
        this.text = text.uppercase()
        textSize = 11f
        letterSpacing = 0.18f
        typeface = medium
        setTextColor(MUTED)
    }

    private fun rule() = View(ctx).apply {
        setBackgroundColor(RULE)
        layoutParams = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 1).apply { topMargin = dp(12); bottomMargin = dp(10) }
    }

    private fun action(text: String, accent: Boolean = false, onClick: () -> Unit) = TextView(ctx).apply {
        this.text = text
        textSize = 17f
        typeface = light
        setTextColor(if (accent) ACCENT else INK)
        minHeight = dp(48)
        gravity = Gravity.CENTER_VERTICAL
        isClickable = true
        isFocusable = true
        setOnClickListener { onClick() }
    }

    private fun bar(max: Int) = SeekBar(ctx).apply {
        this.max = max
        progressTintList = ColorStateList.valueOf(ACCENT)
        thumbTintList = ColorStateList.valueOf(INK)
        progressBackgroundTintList = ColorStateList.valueOf(FAINT)
        minHeight = dp(48) // ProgressBar.onMeasure ignores View.minimumHeight (measured 18 dp)
    }

    private fun build(): View {
        val scrim = AutoCloseRoot().apply {
            background = ColorDrawable(0x99000000.toInt())
            isClickable = true
            setOnClickListener { actions.closePanel() }
        }
        val col = LinearLayout(ctx).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(28), dp(24), dp(28), dp(24))
        }
        val scroll = ScrollView(ctx).apply {
            setBackgroundColor(BG)
            isClickable = true // taps on the panel do not close it
            addView(col)
        }
        scrim.addView(scroll, FrameLayout.LayoutParams(dp(380), ViewGroup.LayoutParams.MATCH_PARENT, Gravity.END))

        val head = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL; gravity = Gravity.CENTER_VERTICAL }
        head.addView(TextView(ctx).apply {
            text = "Керування"
            textSize = 30f
            typeface = light
            setTextColor(INK)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        head.addView(action("Закрити", accent = true) { actions.closePanel() })
        col.addView(head)
        col.addView(rule())

        col.addView(label("Wi-Fi"))
        wifiName = TextView(ctx).apply { textSize = 19f; typeface = light; setTextColor(INK); setPadding(0, dp(6), 0, 0) }
        wifiDetail = TextView(ctx).apply { textSize = 13f; setTextColor(INK2) }
        col.addView(wifiName)
        col.addView(wifiDetail)
        col.addView(action("Змінити мережу →", accent = true) { actions.openWifi() })
        col.addView(rule())

        val bRow = LinearLayout(ctx).apply { orientation = LinearLayout.HORIZONTAL }
        brightLabel = label("Яскравість")
        brightValue = TextView(ctx).apply { textSize = 13f; setTextColor(INK2) }
        bRow.addView(brightLabel, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        bRow.addView(brightValue)
        col.addView(bRow)
        brightBar = bar(100).apply {
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) {
                    val v = p.coerceAtLeast(1)
                    brightValue.text = "$v%"
                    if (fromUser) actions.previewBrightness(v)
                }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {
                    if (s.isEnabled) actions.saveBrightness(s.progress.coerceAtLeast(1), shownNight)
                }
            })
        }
        col.addView(brightBar)

        col.addView(label("Гучність").apply { setPadding(0, dp(10), 0, 0) })
        volumeBar = bar(audio.getStreamMaxVolume(AudioManager.STREAM_MUSIC)).apply {
            setOnSeekBarChangeListener(object : SeekBar.OnSeekBarChangeListener {
                override fun onProgressChanged(s: SeekBar, p: Int, fromUser: Boolean) {
                    if (fromUser) audio.setStreamVolume(AudioManager.STREAM_MUSIC, p, 0)
                }
                override fun onStartTrackingTouch(s: SeekBar) {}
                override fun onStopTrackingTouch(s: SeekBar) {}
            })
        }
        col.addView(volumeBar)
        col.addView(rule())

        col.addView(action("Налаштування дашборда") { actions.openDashboardSettings() })
        col.addView(action("Оновити сторінку") { actions.reloadPage() })
        col.addView(action("Оновити «Ход работ»") { actions.reloadProgress() })
        col.addView(action("Перезапустити застосунок") { actions.restartApp() })
        col.addView(if (actions.isOwner()) action("Перезавантажити планшет") { actions.rebootTablet() }
            else action("Перезавантажити планшет — лише в режимі кіоску") {}.apply { isEnabled = false; setTextColor(FAINT) })
        col.addView(rule())

        status = TextView(ctx).apply { textSize = 12f; setTextColor(INK2); maxLines = 1; ellipsize = TextUtils.TruncateAt.END }
        col.addView(status)
        fresh = TextView(ctx).apply { textSize = 12f; setTextColor(INK2) }
        col.addView(fresh)
        col.addView(action("Сервіс…") { actions.openService() }.apply { setTextColor(MUTED); textSize = 15f })
        return scrim
    }

    fun refresh() {
        refreshWifi()
        refreshBrightness()
        volumeBar.progress = audio.getStreamVolume(AudioManager.STREAM_MUSIC)
        status.text = actions.statusLine()
    }

    @Suppress("DEPRECATION")
    private fun refreshWifi() {
        val wm =ctx.applicationContext.getSystemService(WifiManager::class.java)
        val cm = ctx.getSystemService(ConnectivityManager::class.java)
        val info = runCatching { wm.connectionInfo }.getOrNull()
        val ssid = info?.ssid?.trim('"')?.takeIf { it.isNotBlank() && it != "<unknown ssid>" }
        val ip = runCatching {
            cm.getLinkProperties(cm.activeNetwork)?.linkAddresses?.map { it.address }?.firstOrNull { it is Inet4Address }?.hostAddress
        }.getOrNull()
        val onWifi = runCatching {
            cm.getNetworkCapabilities(cm.activeNetwork)?.hasTransport(NetworkCapabilities.TRANSPORT_WIFI) == true
        }.getOrDefault(false)
        wifiName.text = when {
            !wm.isWifiEnabled -> "Wi-Fi вимкнено"
            ssid != null -> ssid
            onWifi -> "Wi-Fi під'єднано"
            else -> "Немає з'єднання"
        }
        val signal = info?.rssi?.let { if (it < -100 || it > 0) null else WifiManager.calculateSignalLevel(it, 101) }
        wifiDetail.text = listOfNotNull(signal?.let { "сигнал $it%" }, ip?.let { "IP $it" }).joinToString(" · ").ifEmpty { "—" }
    }

    private fun refreshBrightness() {
        val capped = actions.brightnessCapped()
        shownNight = actions.isNight()
        brightLabel.text = when {
            capped -> "Яскравість · на батареї"
            shownNight -> "Яскравість · ніч"
            else -> "Яскравість · день"
        }.uppercase()
        val now = actions.brightnessNow()
        val b = if (capped) minOf(Power.ON_BATTERY_MAX_PCT, now) else now
        brightBar.progress = b
        brightBar.isEnabled = !capped
        brightBar.alpha = if (capped) 0.4f else 1f
        brightValue.text = "$b%"
    }
}
