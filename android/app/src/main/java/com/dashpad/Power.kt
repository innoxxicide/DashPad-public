package com.dashpad

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import android.os.Handler
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.view.WindowManager

/** Power state and its rules: dim after unplug, keep-screen-on only above the battery threshold, wake on replug.
 *  `onChange(edge)` gets true on power connected, false on power lost, null on a level change or the dim timer. */
class Power(private val activity: Activity, private val onChange: (Boolean?) -> Unit) {
    companion object {
        private const val TAG = "DashPad"
        private const val DIM_AFTER_UNPLUG_MS = 60_000L
        const val ON_BATTERY_MAX_PCT = 4
    }

    var charging = true
        private set
    var level = 100
        private set
    private var unpluggedAt = 0L
    private var wasLow = false
    private val handler = Handler(Looper.getMainLooper())

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                Intent.ACTION_BATTERY_CHANGED -> {
                    val raw = intent.getIntExtra(BatteryManager.EXTRA_LEVEL, -1)
                    val scale = intent.getIntExtra(BatteryManager.EXTRA_SCALE, 100)
                    val pct = if (raw >= 0 && scale > 0) raw * 100 / scale else level
                    val plugged = intent.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) != 0
                    val levelChanged = pct != level
                    level = pct
                    if (plugged != charging) powerEdge(plugged) else if (levelChanged) onChange(null)
                }
                Intent.ACTION_POWER_CONNECTED -> if (!charging) powerEdge(true)
                Intent.ACTION_POWER_DISCONNECTED -> if (charging) powerEdge(false)
            }
        }
    }

    fun register() {
        activity.registerReceiver(receiver, IntentFilter().apply {
            addAction(Intent.ACTION_BATTERY_CHANGED)
            addAction(Intent.ACTION_POWER_CONNECTED)
            addAction(Intent.ACTION_POWER_DISCONNECTED)
        })
    }

    fun unregister() {
        handler.removeCallbacksAndMessages(null)
        runCatching { activity.unregisterReceiver(receiver) }
    }

    fun dimmed(now: Long): Boolean = !charging && unpluggedAt > 0 && now - unpluggedAt > DIM_AFTER_UNPLUG_MS

    fun low(offPct: Int): Boolean = !charging && level <= offPct

    /** State-derived: the flag is cleared on every call below the threshold, so a manual wake times out again. */
    fun applyScreenPolicy(offPct: Int) {
        val isLow = low(offPct)
        keepScreenOn(!isLow)
        if (isLow && !wasLow) {
            val locked = Kiosk.screenOff(activity)
            val timeout = Settings.System.getInt(activity.contentResolver, Settings.System.SCREEN_OFF_TIMEOUT, -1)
            Log.i(TAG, "battery $level% ≤ $offPct%: keepScreenOn=false lockNow=$locked timeoutMs=$timeout")
        }
        wasLow = isLow
    }

    private fun powerEdge(plugged: Boolean) {
        charging = plugged
        Log.i(TAG, "power ${if (plugged) "connected" else "lost"}, battery $level%")
        if (plugged) {
            unpluggedAt = 0
            keepScreenOn(true)
            wake()
        } else {
            unpluggedAt = System.currentTimeMillis()
            handler.postDelayed({ onChange(null) }, DIM_AFTER_UNPLUG_MS + 1_000)
        }
        onChange(plugged)
    }

    private fun keepScreenOn(on: Boolean) {
        val flag = WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON
        if ((activity.window.attributes.flags and flag != 0) == on) return
        if (on) activity.window.addFlags(flag) else activity.window.clearFlags(flag)
    }

    @Suppress("DEPRECATION")
    private fun wake() {
        val pm = activity.getSystemService(PowerManager::class.java)
        runCatching {
            pm.newWakeLock(PowerManager.SCREEN_BRIGHT_WAKE_LOCK or PowerManager.ACQUIRE_CAUSES_WAKEUP, "dashpad:wake").acquire(10_000)
        }
        runCatching {
            activity.startActivity(Kiosk.startIntent(activity).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_REORDER_TO_FRONT))
        }
        handler.postDelayed({ Log.i(TAG, "wake: interactive=${pm.isInteractive}") }, 3_000)
    }
}
