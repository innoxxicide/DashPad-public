package com.dashpad

import android.Manifest
import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.text.InputType
import android.util.Log
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.window.OnBackInvokedDispatcher
import android.webkit.JavascriptInterface
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageButton
import android.widget.TextView
import android.widget.Toast
import org.json.JSONObject
import java.util.concurrent.Executors

/** One full-screen WebView with the dashboard (both halves come from the Worker), the ⚙ control panel,
 *  the brightness schedule, power-loss handling and, as the Device Owner, a lock-task kiosk that is also HOME. */
class MainActivity : Activity(), PanelActions {
    companion object {
        private const val TAG = "DashPad"
        private const val TICK_MS = 30_000L
        private const val SETTINGS_EVERY_MS = 5 * 60_000L
        private const val HEARTBEAT_EVERY_MS = 2 * 60_000L
        private const val RELOAD_AFTER_POWER_MS = 30_000L
        private const val BRIEF_IDLE_MS = 300_000L
    }

    private lateinit var prefs: Prefs
    private lateinit var root: FrameLayout
    private var web: WebView? = null
    private var hint: TextView? = null
    private var panel: ControlPanel? = null
    private val main = Handler(Looper.getMainLooper())
    private val io = Executors.newSingleThreadExecutor()

    private var display = DisplaySettings()
    private var previewPct: Int? = null
    private lateinit var power: Power
    private var lastSettings = 0L
    private var settingsShown = false
    private var lastHeartbeat = 0L
    private var heartbeatToken = 0
    private lateinit var briefButton: TextView
    private var briefOpen = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (savedInstanceState == null) takeExtras(intent) // recreate() and process restore replay the launch intent
        display = prefs.display
        power = Power(this, ::powerChanged)

        root = FrameLayout(this).apply { setBackgroundColor(0xFF111214.toInt()) }
        setContentView(root)
        createWebView()
        root.addView(gearButton(), FrameLayout.LayoutParams(dp(48), dp(48), Gravity.TOP or Gravity.END).apply { topMargin = dp(4); rightMargin = dp(4) })
        briefButton = briefButton()
        root.addView(briefButton, FrameLayout.LayoutParams(dp(64), dp(48), Gravity.TOP or Gravity.END).apply { topMargin = dp(4); rightMargin = dp(60) })

        power.register()
        power.applyScreenPolicy(display.batteryOffPct)
        getSystemService(ConnectivityManager::class.java).registerDefaultNetworkCallback(netCallback)
        if (Build.VERSION.SDK_INT >= 33) onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) { onBack() }

        Kiosk.apply(this)
        if (prefs.keepAdbWifi) AdbWifi.set(this, true)
        loadDashboard()
        main.post(tick)
    }

    private fun gearButton() = ImageButton(this).apply {
        setImageResource(R.drawable.ic_gear)
        background = null
        alpha = 0.45f
        contentDescription = "Керування"
        scaleType = android.widget.ImageView.ScaleType.FIT_CENTER
        val p = dp(11)
        setPadding(p, p, p, p)
        setOnClickListener { openPanel() }
    }

    private fun briefButton() = TextView(this).apply {
        text = "Brief"
        textSize = 18f
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
        setTextColor(ControlPanel.INK)
        alpha = 0.45f
        gravity = Gravity.CENTER
        background = null
        contentDescription = "Бриф"
        setOnClickListener { web?.evaluateJavascript("location.hash = '#brief'", null) }
    }

    private val briefIdle = Runnable { web?.evaluateJavascript("if(location.hash==='#brief')location.hash=''", null) }

    private fun armBriefIdle() {
        main.removeCallbacks(briefIdle)
        main.postDelayed(briefIdle, BRIEF_IDLE_MS)
    }

    // Touches inside the sandboxed brief frame reach only this level, never the page.
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        if (briefOpen) armBriefIdle()
        return super.dispatchTouchEvent(ev)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (takeExtras(intent)) loadDashboard()
    }

    override fun onResume() {
        super.onResume()
        Kiosk.enterLockTask(this)
        hideSystemBars()
        applyBrightness()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (!hasFocus) return
        hideSystemBars()
        panel?.let { p -> p.refresh(); freshness { if (panel === p) p.showFreshness(it) } }
    }

    @Deprecated("Activity back handling")
    override fun onBackPressed() = onBack() // API 31–32; 33+ uses the OnBackInvokedCallback

    /** Back never leaves the app: it closes the panel, else leaves #settings or #brief (the re-read follows the navigation). */
    private fun onBack() {
        if (panel != null) closePanel()
        else web?.evaluateJavascript("if(location.hash)location.hash=''", null)
    }

    override fun onDestroy() {
        main.removeCallbacksAndMessages(null)
        power.unregister()
        runCatching { getSystemService(ConnectivityManager::class.java).unregisterNetworkCallback(netCallback) }
        web?.let { root.removeView(it); it.destroy() }
        io.shutdownNow()
        super.onDestroy()
    }

    /** Provisioning extras url (with ?k=) and pin: url only for the provisioned host, pin only with it. True when the URL changed. */
    private fun takeExtras(i: Intent?): Boolean {
        i ?: return false
        if ((i.flags and Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return false // Recents replays the base intent
        val url = i.getStringExtra("url")
        val pin = i.getStringExtra("pin")
        if (url == null && pin == null) return false
        i.removeExtra("url")
        i.removeExtra("pin")
        val current = prefs.url
        val refused = when {
            url == null -> "pin without url"
            !url.startsWith("https://") -> "not https"
            current != null && Remote.host(url) != Remote.host(current) -> "host"
            else -> null
        }
        val pinRefused = when {
            pin != null && pin.length < 4 -> "too short"
            pin != null && pin.any { it !in '0'..'9' } -> "not digits"
            else -> null
        }
        Log.i(TAG, when {
            refused != null -> "extras refused: $refused"
            pinRefused != null -> "extras accepted; pin refused: $pinRefused"
            else -> "extras accepted"
        })
        if (refused != null || url == null) return false
        if (pinRefused == null) pin?.let { prefs.pin = it }
        prefs.url = url
        return url != current
    }

    private fun createWebView() {
        WebView.setWebContentsDebuggingEnabled(true) // remote inspection over adb only
        val w = WebView(this)
        w.setBackgroundColor(0xFF111214.toInt())
        w.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = true
        }
        w.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val allowed = request.url.host == Remote.host(prefs.url) || request.url.scheme == "about"
                if (!allowed) Log.i(TAG, "blocked navigation to ${request.url.host}")
                return !allowed
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    Log.w(TAG, "main frame error ${error.errorCode} ${error.description}")
                    main.removeCallbacks(retryLoad)
                    main.postDelayed(retryLoad, 30_000)
                }
            }

            override fun onPageFinished(view: WebView, url: String) = pushBattery()

            // Same-document hash changes reach this callback too: the page's «← До дашборда» link has no other signal.
            override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
                val hash = url.substringAfter('#', "")
                val now = hash == "settings"
                if (settingsShown && !now) refreshSettings()
                settingsShown = now
                briefOpen = hash == "brief"
                briefButton.visibility = if (briefOpen) View.GONE else View.VISIBLE
                if (briefOpen) armBriefIdle() else main.removeCallbacks(briefIdle)
            }

            override fun onRenderProcessGone(view: WebView, detail: RenderProcessGoneDetail): Boolean {
                Log.e(TAG, "renderer gone, crashed=${detail.didCrash()}")
                recreateWebView()
                return true
            }
        }
        w.addJavascriptInterface(Bridge(), "DashPadNative")
        root.addView(w, 0, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        web = w
    }

    private fun recreateWebView() {
        heartbeatToken++
        web?.let { root.removeView(it); it.destroy() }
        web = null
        createWebView()
        loadDashboard()
    }

    private val retryLoad = Runnable { loadDashboard() }

    private fun loadDashboard() {
        val url = prefs.url
        if (url == null) {
            showHint("DashPad не налаштовано.\nadb shell am start -n com.dashpad/.MainActivity --es url \"https://…/?k=…\" --es pin 1234")
            return
        }
        hint?.let { root.removeView(it) }
        hint = null
        web?.loadUrl(url)
    }

    private fun showHint(text: String) {
        if (hint == null) {
            hint = TextView(this).apply {
                setTextColor(Color.LTGRAY)
                textSize = 18f
                gravity = Gravity.CENTER
                setPadding(dp(40), dp(40), dp(40), dp(40))
            }
            root.addView(hint, 1, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        }
        hint?.text = text
    }

    /** Exposed to the page as window.DashPadNative; the host guard covers top-level navigations only (the right-half iframe relies on target=_blank for external links). */
    inner class Bridge {
        @JavascriptInterface
        fun battery(): String =
            JSONObject().put("level", power.level).put("charging", power.charging).put("offAt", display.batteryOffPct).toString()

        @JavascriptInterface
        fun version(): String = BuildConfig.VERSION_NAME
    }

    private fun pushBattery() {
        web?.evaluateJavascript("window.dispatchEvent(new Event('dashpad:battery'))", null)
    }

    private val tick = object : Runnable {
        override fun run() {
            val now = System.currentTimeMillis()
            applyBrightness()
            power.applyScreenPolicy(display.batteryOffPct)
            if (now - lastSettings > SETTINGS_EVERY_MS) refreshSettings()
            if (now - lastHeartbeat > HEARTBEAT_EVERY_MS) heartbeat()
            main.postDelayed(this, TICK_MS)
        }
    }

    private fun refreshSettings() {
        val url = prefs.url ?: return
        lastSettings = System.currentTimeMillis()
        io.execute {
            val j = Remote.settings(url) ?: return@execute
            val d = DisplaySettings.from(j.optJSONObject("display"))
            main.post { setDisplay(d) }
        }
    }

    /** If the page stops answering (renderer hung), rebuild the WebView. */
    private fun heartbeat() {
        val w = web ?: return
        lastHeartbeat = System.currentTimeMillis()
        val token = ++heartbeatToken
        var answered = false
        w.evaluateJavascript("document.readyState") { answered = true }
        main.postDelayed({
            if (!answered && token == heartbeatToken) {
                Log.e(TAG, "page did not answer the heartbeat; recreating WebView")
                recreateWebView()
            }
        }, 15_000)
    }

    private val netCallback = object : ConnectivityManager.NetworkCallback() {
        override fun onAvailable(network: Network) {
            main.post { if (web?.url == null || web?.url == "about:blank") loadDashboard() }
        }
    }

    override fun isNight(): Boolean = display.isNight()

    override fun brightnessNow(): Int = if (isNight()) display.night else display.day

    private fun applyBrightness() {
        var pct = previewPct ?: brightnessNow()
        if (brightnessCapped()) pct = minOf(pct, Power.ON_BATTERY_MAX_PCT)
        val lp = window.attributes
        val v = (pct / 100f).coerceIn(0.01f, 1f)
        if (lp.screenBrightness != v) {
            lp.screenBrightness = v
            window.attributes = lp
        }
    }

    override fun previewBrightness(pct: Int) {
        previewPct = pct
        applyBrightness()
    }

    override fun brightnessCapped(): Boolean = power.dimmed(System.currentTimeMillis())

    override fun saveBrightness(pct: Int, night: Boolean) {
        previewPct = null
        val key = if (night) "nightBrightness" else "dayBrightness"
        setDisplay(if (night) display.copy(night = pct) else display.copy(day = pct))
        val url = prefs.url ?: return
        io.execute {
            val merged = Remote.putBrightness(url, key, pct)
            Log.i(TAG, "brightness save $key=$pct ok=${merged != null}")
            main.post { if (merged != null) setDisplay(merged) else toast("Не вдалося зберегти яскравість") }
        }
    }

    private fun setDisplay(d: DisplaySettings) {
        display = d
        prefs.display = d
        applyBrightness()
    }

    private val reloadAfterPower = Runnable {
        Log.i(TAG, "power held ${RELOAD_AFTER_POWER_MS / 1000} s: reload")
        web?.reload()
    }

    /** Wake and brightness follow at once; the reload waits until power has held, so a flapping outage reloads once. */
    private fun powerChanged(plugEdge: Boolean?) {
        if (plugEdge != null) main.removeCallbacks(reloadAfterPower)
        if (plugEdge == true) main.postDelayed(reloadAfterPower, RELOAD_AFTER_POWER_MS)
        power.applyScreenPolicy(display.batteryOffPct)
        applyBrightness()
        pushBattery()
        panel?.refresh()
    }

    private fun openPanel() {
        if (panel != null) return
        val p = ControlPanel(this, this)
        panel = p
        root.addView(p.view, FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        p.refresh()
        freshness { if (panel === p) p.showFreshness(it) }
    }

    override fun closePanel() {
        panel?.let { root.removeView(it.view) }
        panel = null
        previewPct = null
        applyBrightness()
    }

    override fun openWifi() {
        closePanel()
        runCatching { startActivity(Intent(Settings.Panel.ACTION_WIFI)) }
            .onFailure { runCatching { startActivity(Intent(Settings.ACTION_WIFI_SETTINGS)) } }
    }

    override fun openDashboardSettings() {
        closePanel()
        web?.evaluateJavascript("location.hash = '#settings'", null)
    }

    override fun reloadPage() {
        closePanel()
        loadDashboard()
    }

    override fun reloadProgress() {
        closePanel()
        web?.evaluateJavascript("(function(){var f=document.querySelector('iframe.right');if(!f)return 0;f.src=f.getAttribute('src');return 1})()") {
            Log.i(TAG, "progress reload $it")
            if (it != "1") toast("«Ход работ» зараз не показано")
        }
    }

    private fun freshness(cb: (String) -> Unit) {
        val url = prefs.url ?: return cb(freshnessText(null))
        io.execute { freshnessText(Remote.health(url)).let { main.post { cb(it) } } }
    }

    override fun restartApp() {
        closePanel()
        recreate()
    }

    override fun isOwner(): Boolean = Kiosk.isOwner(this)

    private fun canAdbWifi(): Boolean = checkSelfPermission(Manifest.permission.WRITE_SECURE_SETTINGS) == PackageManager.PERMISSION_GRANTED

    override fun rebootTablet() {
        if (!isOwner()) return
        confirm("Перезавантажити планшет? Екран згасне на час перезавантаження.") {
            if (!Kiosk.reboot(this)) toast("Перезавантаження доступне лише в режимі кіоску (Device Owner)")
        }
    }

    override fun statusLine(): String {
        val source = if (power.charging) "від мережі" else "на батареї"
        val mode = if (isOwner()) "кіоск" else "без кіоску"
        return "DashPad ${BuildConfig.VERSION_NAME} · $mode · заряд ${power.level}% · $source"
    }

    override fun openService() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_CLASS_NUMBER or InputType.TYPE_NUMBER_VARIATION_PASSWORD
            hint = "PIN"
        }
        dialog()
            .setTitle("Сервіс")
            .setView(input)
            .setPositiveButton("Далі") { _, _ ->
                if (input.text.toString() == prefs.pin) serviceMenu() else toast("Неправильний PIN")
            }
            .setNegativeButton("Скасувати", null)
            .show()
    }

    private fun serviceMenu() {
        val owner = isOwner()
        val adbOn = AdbWifi.isOn(this)
        val items = listOfNotNull(
            if (owner) "Вийти з режиму кіоску й відкрити налаштування Android" else "Відкрити налаштування Android",
            when {
                !canAdbWifi() -> "Налагодження через Wi-Fi — немає дозволу"
                adbOn -> "Вимкнути налагодження через Wi-Fi"
                else -> "Увімкнути налагодження через Wi-Fi (діятиме й після перезавантаження)"
            },
            if (owner) "Зняти режим кіоску (Device Owner)" else null,
        ).toTypedArray()
        dialog()
            .setTitle("Сервіс")
            .setItems(items) { _, which ->
                when (which) {
                    0 -> {
                        closePanel()
                        Kiosk.leaveLockTask(this)
                        // Own task: the large-screen Settings homepage restarts itself as a task root, which pulls DashPad back into lock task.
                        startActivity(Intent(Settings.ACTION_SETTINGS).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
                    }
                    1 -> setAdbWifi(!adbOn)
                    2 -> confirm("Зняти режим кіоску? DashPad залишиться встановленим, але планшет стане звичайним.") {
                        Kiosk.leaveLockTask(this)
                        toast(if (Kiosk.removeOwner(this)) "Режим кіоску знято" else "Не вдалося зняти режим кіоску")
                    }
                }
            }
            .setNegativeButton("Закрити", null)
            .show()
    }

    private fun setAdbWifi(on: Boolean) {
        if (!canAdbWifi() || !AdbWifi.set(this, on)) return toast("Немає дозволу WRITE_SECURE_SETTINGS")
        prefs.keepAdbWifi = on
        toast(if (on) "Налагодження через Wi-Fi увімкнено" else "Налагодження через Wi-Fi вимкнено")
    }

    private fun dialog() = AlertDialog.Builder(this, android.R.style.Theme_DeviceDefault_Dialog_Alert)

    private fun confirm(text: String, ok: () -> Unit) {
        dialog()
            .setMessage(text)
            .setPositiveButton("Так") { _, _ -> ok() }
            .setNegativeButton("Ні", null)
            .show()
    }

    private fun toast(text: String) = Toast.makeText(this, text, Toast.LENGTH_LONG).show()

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun hideSystemBars() {
        window.insetsController?.let {
            it.hide(WindowInsets.Type.systemBars())
            it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }
}
