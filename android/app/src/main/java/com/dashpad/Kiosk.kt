package com.dashpad

import android.Manifest
import android.app.Activity
import android.app.ActivityManager
import android.app.admin.DeviceAdminReceiver
import android.app.admin.DevicePolicyManager
import android.content.BroadcastReceiver
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.BatteryManager
import android.os.Build
import android.os.UserManager
import android.provider.Settings
import android.util.Log

/** Device admin component; becomes the Device Owner via
 *  `adb shell dpm set-device-owner com.dashpad/.AdminReceiver` (no accounts, one user).
 *  The component name is the Device Owner identity: never rename or move this class once DO is set. */
class AdminReceiver : DeviceAdminReceiver()

/** Keeps wireless adb on; the boot/update start works only as Device Owner or default HOME (else Android blocks it silently). */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (Prefs(context).keepAdbWifi) AdbWifi.set(context, true)
        if (intent.action == Intent.ACTION_BOOT_COMPLETED || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            runCatching {
                context.startActivity(Kiosk.startIntent(context).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
            }
        }
    }
}

/** Wireless debugging toggle (needs `pm grant com.dashpad android.permission.WRITE_SECURE_SETTINGS`). */
object AdbWifi {
    fun isOn(ctx: Context) = Settings.Global.getInt(ctx.contentResolver, "adb_wifi_enabled", 0) == 1
    fun set(ctx: Context, on: Boolean): Boolean = runCatching {
        Settings.Global.putInt(ctx.contentResolver, "adb_wifi_enabled", if (on) 1 else 0)
    }.getOrDefault(false)
}

/** Device Owner kiosk policies. Everything is a no-op when the app is not the Device Owner. */
object Kiosk {
    private const val TAG = "DashPadKiosk"

    fun admin(ctx: Context) = ComponentName(ctx, AdminReceiver::class.java)
    private fun dpm(ctx: Context) = ctx.getSystemService(DevicePolicyManager::class.java)
    fun isOwner(ctx: Context) = dpm(ctx).isDeviceOwnerApp(ctx.packageName)
    fun isLocked(ctx: Context) =
        ctx.getSystemService(ActivityManager::class.java).lockTaskModeState != ActivityManager.LOCK_TASK_MODE_NONE

    /** While DashPad is HOME (owner, or the only launcher left after an undo) its record sits in the home task:
     *  only a HOME launch reuses it, an explicit start opens a second instance. */
    fun startIntent(ctx: Context): Intent =
        if (isOwner(ctx) || isResolvedHome(ctx)) Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME).setPackage(ctx.packageName)
        else Intent(ctx, MainActivity::class.java)

    private fun isResolvedHome(ctx: Context): Boolean {
        val home = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_HOME)
        val pm = ctx.packageManager
        val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            pm.resolveActivity(home, PackageManager.ResolveInfoFlags.of(PackageManager.MATCH_DEFAULT_ONLY.toLong()))
        } else {
            @Suppress("DEPRECATION") pm.resolveActivity(home, PackageManager.MATCH_DEFAULT_ONLY)
        }
        return info?.activityInfo?.packageName == ctx.packageName
    }

    fun apply(activity: Activity) {
        if (!isOwner(activity)) return
        val d = dpm(activity)
        val a = admin(activity)
        val pkg = activity.packageName
        val home = IntentFilter(Intent.ACTION_MAIN).apply {
            addCategory(Intent.CATEGORY_HOME)
            addCategory(Intent.CATEGORY_DEFAULT)
        }
        val plugged = BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or BatteryManager.BATTERY_PLUGGED_WIRELESS
        val policies: List<Pair<String, () -> Any?>> = listOf(
            // Settings stays allowed: the ⚙ Wi-Fi panel runs inside the lock task. Factory reset stays available
            // (developer, 2026-11-23); clearing it also lifts the restriction an earlier build set.
            "lockTaskPackages" to { d.setLockTaskPackages(a, arrayOf(pkg, "com.android.settings")) },
            "lockTaskFeatures" to { d.setLockTaskFeatures(a, DevicePolicyManager.LOCK_TASK_FEATURE_GLOBAL_ACTIONS) },
            "persistentHome" to { d.addPersistentPreferredActivity(a, home, ComponentName(activity, MainActivity::class.java)) },
            "keyguardDisabled" to { d.setKeyguardDisabled(a, true) },
            "statusBarDisabled" to { d.setStatusBarDisabled(a, true) },
            "stayOn" to { d.setGlobalSetting(a, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, plugged.toString()) },
            "screenTimeout" to { d.setSystemSetting(a, Settings.System.SCREEN_OFF_TIMEOUT, (30 * 60 * 1000).toString()) },
            "noSafeBoot" to { d.addUserRestriction(a, UserManager.DISALLOW_SAFE_BOOT) },
            "factoryResetAllowed" to { d.clearUserRestriction(a, UserManager.DISALLOW_FACTORY_RESET) },
            "location" to { d.setLocationEnabled(a, true) },
            "fineLocation" to { d.setPermissionGrantState(a, pkg, Manifest.permission.ACCESS_FINE_LOCATION, DevicePolicyManager.PERMISSION_GRANT_STATE_GRANTED) },
        )
        val failed = policies.filterNot { (name, call) -> applied(name, call) }.map { it.first }
        Log.i(TAG, "apply ok=${policies.size - failed.size} failed=$failed")
    }

    /** A policy fails when it throws or returns `false`; one failure never skips the others. */
    private fun applied(name: String, call: () -> Any?): Boolean {
        val result = runCatching(call)
        val ok = result.isSuccess && result.getOrNull() != false
        if (!ok) Log.w(TAG, "apply $name ${if (result.isSuccess) "returned false" else "threw"}", result.exceptionOrNull())
        return ok
    }

    private fun permitted(ctx: Context) = dpm(ctx).isLockTaskPermitted(ctx.packageName)

    /** Never calls startLockTask unpermitted: Android would fall back to the screen-pinning prompt. */
    fun enterLockTask(activity: Activity) {
        if (!isOwner(activity)) return
        if (!permitted(activity)) apply(activity)
        val state = activity.getSystemService(ActivityManager::class.java).lockTaskModeState
        if (state != ActivityManager.LOCK_TASK_MODE_LOCKED && permitted(activity)) {
            runCatching { activity.startLockTask() }.onFailure { Log.w(TAG, "startLockTask", it) }
        }
    }

    fun leaveLockTask(activity: Activity) {
        if (isLocked(activity)) runCatching { activity.stopLockTask() }
    }

    fun reboot(ctx: Context): Boolean = isOwner(ctx) && runCatching { dpm(ctx).reboot(admin(ctx)) }.isSuccess

    fun screenOff(ctx: Context): Boolean {
        val d = dpm(ctx)
        return d.isAdminActive(admin(ctx)) && runCatching { d.lockNow() }.isSuccess
    }

    /** Undo everything and give up Device Owner (maintenance; the tablet becomes an ordinary one). */
    @Suppress("DEPRECATION")
    fun removeOwner(ctx: Context): Boolean {
        if (!isOwner(ctx)) return false
        val d = dpm(ctx)
        val a = admin(ctx)
        return runCatching {
            d.clearPackagePersistentPreferredActivities(a, ctx.packageName)
            d.setLockTaskPackages(a, emptyArray())
            d.setKeyguardDisabled(a, false)
            d.setStatusBarDisabled(a, false)
            d.clearUserRestriction(a, UserManager.DISALLOW_SAFE_BOOT)
            d.clearUserRestriction(a, UserManager.DISALLOW_FACTORY_RESET)
            d.clearDeviceOwnerApp(ctx.packageName)
        }.isSuccess
    }
}
