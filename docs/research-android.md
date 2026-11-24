# DashPad: Android research for the Galaxy Tab A7 10.4" (2020) wall dashboard

- **Date:** 2026-11-19
- **Device:** Samsung Galaxy Tab A7 10.4 (2020): SM-T500 (Wi-Fi, codename `gta4lwifi`), SM-T505/T507 (LTE, `gta4l`). Qualcomm SM6115 (Snapdragon 662), 3 GB RAM, 32 GB storage, TFT LCD 2000x1200, 7040 mAh battery.
- **Our actual device (read via adb on 2026-11-19):** **SM-T505** (LTE, `gta4l`, CSC AUT), build `T505XXS7CXB1`, Android 12 / One UI 4.1, security patch **2024-01-01**, bootloader locked, Knox warranty bit 0, WebView 157.0.8103.50, 2.7 GB RAM visible, display 1200x2000 @ 240 dpi. Where this file cites SM-T500 build numbers (e.g. T500XXS8CXG3), the T505 equivalents differ — check Settings → Software update before the wipe. LineageOS device for us is `gta4l`, not `gta4lwifi`.
- **Goal:** wipe the tablet, replace One UI Home with our Kotlin app (two side-by-side WebViews: our dashboard on the left, claude.ai with a persistent login on the right), keep the screen on 24/7, and start straight into the dashboard after boot.

Confidence labels used below:
- **[confirmed]**: backed by an official or primary source (linked).
- **[community]**: reported by community or third-party sources. Probably right, but not official.
- **[uncertain]**: not verified. Check it on the real device before relying on it.
- **[suggestion]**: my design recommendation, not a sourced fact.

---

## 0. TL;DR and recommended approach

**Recommended path: keep the stock firmware, debloat it, and run our own app as Device Owner.**

1. Reset the tablet from Settings (remove the Google and Samsung accounts first). In the setup wizard, skip every account and set **no** screen lock.
2. Turn on USB debugging. Debloat with `pm uninstall -k --user 0` for apps that are safe to remove, and `pm disable-user` for the borderline ones. Never touch the "never remove" list in section 2.
3. Install the DashPad APK, then run `adb shell dpm set-device-owner <pkg>/.AdminReceiver`.
4. On first start, the app sets its own policies: it allowlists itself for lock task mode and starts lock task, makes itself the persistent HOME activity, disables the keyguard, sets `STAY_ON_WHILE_PLUGGED_IN`, sets the screen timeout and update policy, and adds user restrictions.
5. Keep the screen on with layered settings: `FLAG_KEEP_SCREEN_ON`, stay-on-while-plugged, a long timeout, and Samsung's screensaver, adaptive brightness and auto-restart turned off. Do night dimming with the window brightness override.
6. **Power outages:** the most reliable fix is to **never let the battery drain fully**. When mains power drops, the app turns the screen off and wakes it again when power returns. A 5 V mini-UPS helps further. If true auto-boot from 0% is required, the only non-root way on stock firmware is the **Samsung Knox** "Force Auto Start Up" API (`SystemManager.setForceAutoStartUpState`). It needs the free KPE Premium licence key, or Fully Kiosk PLUS, which already exposes it.
7. **Battery:** turn on "Protect battery" (85% cap) in the UI if it is there, or apply the Knox tablet policy. A battery-level-driven smart plug (charge between 40% and 80%) is a vendor-independent alternative.
8. **claude.ai login:** use "Continue with email". Opening the emailed link on a phone or PC shows a **code**, which you type on the tablet. Google sign-in **will not work** inside a WebView (`disallowed_useragent`).
9. **WebView updates:** the OS is end-of-life, but WebView still updates on Android 12 (157.x builds for Android 10+ exist as of Nov 2026). There are three ways to update it: keep the Play Store with a dedicated Google account, sideload updates with `adb install -r`, or have the Device Owner app install them silently from our own server.

**Plan B: LineageOS 24.0 (Android 17).** It is now **official** for both `gta4lwifi` and `gta4l`. It gives monthly security patches and a WebView that updates with the OS, but it permanently trips Knox and loses the Knox auto-boot and charge-limit options. Section 8 covers it.

**Fully Kiosk Browser** is cheap (EUR 8.90 / USD 10.99 one-time per device) and capable, but it has **no split view**. A wrapper page that puts claude.ai in an iframe is very likely blocked by claude.ai's framing policy. A custom app is clearly the better fit (section 4).

---

## 1. Firmware, Android version and WebView

### 1.1 Final firmware [confirmed]
| Item | Value |
|---|---|
| Final major OS | **Android 12 / One UI 4.1** (the second and final OS upgrade; [PhoneArena](https://www.phonearena.com/news/samsung-galaxy-tab-a7-official-android-12-update-rollout_id140758), [AndroidHeadlines](https://www.androidheadlines.com/2022/06/galaxy-tab-a7-10-4-2020-android-12-one-ui.html)) |
| Latest SM-T500 build | **T500XXS8CXG3**, Android 12, released 2024-07-29, **security patch level 2024-06-01** ([Samsung update notes SM-T500](https://doc.samsungmobile.com/SM-T500/014718200929/wel.html)) |
| Earlier June-2024 build | T500XXS8CXG1 / T505XXS8CXG1 ([SamMobile](https://www.sammobile.com/news/galaxy-tab-a7-2020-june-2024-security-update/)) |
| End of support | Removed from Samsung's update list in Oct 2024 ([9to5Google](https://9to5google.com/2024/10/08/no-more-updates-for-galaxy-z-fold-2-tab-a7/), [SammyFans](https://sammyfans.com/2024/10/08/samsung-galaxy-m51-and-tab-a7-end-their-software-update-support/amp)). endoflife.date lists security support ending 2024-08 ([endoflife.date](https://endoflife.date/samsung-galaxy-tab)). |

**Implication:** the OS has had no security patches for about 2.5 years. The browser engine (WebView) is the biggest attack surface, and it is updated separately from the OS (see below). Treat the tablet as an untrusted IoT device. Put it on an isolated VLAN or SSID if possible, and lock both WebViews to an allowlist of URLs. **[suggestion]**

### 1.2 Android System WebView on Android 12
- On Samsung Android 12 the WebView provider is the standalone `com.google.android.webview` package. It ships preinstalled and is updated through Google Play. **[community]** Check on the device with `adb shell dumpsys webviewupdate`. **[uncertain until checked]**
- **WebView still supports Android 12 as of Nov 2026.** APKMirror lists Android System WebView **157.0.8103.52** (2026-11-19) with an **"Android 10+"** variant (plus "12L+" variants) ([APKMirror](https://www.apkmirror.com/apk/google-inc/android-system-webview/)). Chrome's minimum has been Android 10 since Chrome 139, which dropped Android 8 and 9 in Aug 2025 ([9to5Google](https://9to5google.com/2025/06/26/google-chrome-android-versions-no-longer-supported-2025/)). I found no announcement of Android 10/11/12 being dropped. **[confirmed for now; the future cutoff date is unknown]**
- Updates to a system package must be signed with the same certificate, so Android rejects a WebView "update" signed by anyone else. This makes sideloading fairly safe as long as installs succeed only with Google's signature. **[community / Android platform behaviour]**

### 1.3 How WebView gets updated if we drop Google Play or a Google account
The Play Store does not update apps without a signed-in Google account. Google Play system updates (Mainline) do not cover WebView. **[community]** The options:

| Option | How | Pros | Cons |
|---|---|---|---|
| A. Keep Play Store and add a dedicated Google account **after** `set-device-owner` | Device owner only requires zero accounts at provisioning time ([bayton.org](https://bayton.org/android/android-enterprise-faq/can-i-set-device-owner-without-factory-reset/)). Add an account later and let Play auto-update WebView. | Automatic, signed updates | Needs a Google account and GMS running in the background. **[uncertain]** Play behaviour on a device managed by a custom DPC; test it. |
| B. Sideload with adb | `adb install -r <webview>.apk`. Use the arm64 "Android 10+" variant from a trusted mirror, and check the signer with `apksigner verify --print-certs`. | No Google account | Manual. APKMirror is third-party, though Android enforces the signature match. |
| C. Self-update from the Device Owner app | The app downloads a WebView APK we host and installs it silently with `PackageInstaller`. Device owners can install without user interaction ([Android dedicated-devices cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook)). | Fully remote and automatic | We have to fetch and host the APK ourselves. |
| D. Bundle our own engine (GeckoView) | Ship the browser engine inside our APK | Not tied to the system WebView | Bigger APK, different engine. **[uncertain]** whether Cloudflare and claude.ai behave the same. |
| E. LineageOS | WebView is built and updated with each OS build | Monthly updates with the OS | Requires the custom ROM (section 8) |

**Recommendation [suggestion]:** A is the least effort, so prototype it. If Play misbehaves under Device Owner, use C, which also gives us the self-update channel for DashPad itself (section 9).

---

## 2. Wipe and debloat without root

### 2.1 The wipe
1. Remove the Google account and the Samsung account (Find My Mobile / Reactivation Lock) **before** resetting. This avoids FRP and reactivation-lock prompts. **[community]**
2. Go to Settings > General management > Reset > Factory data reset. You can also use recovery (power off, then hold Volume Up + Power with USB connected, per the [LineageOS device data](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_data/devices/gta4lwifi.yml)), but a recovery reset with an account still present triggers FRP.
3. In the setup wizard: connect Wi-Fi (optional), **skip Google sign-in, skip Samsung account**, decline extras, and set the **screen lock to None**.
   - Do not set a PIN or password. With a secure lock, the device stays on the lock screen after every reboot because credential-encrypted storage is still locked, so our HOME app and WebView data are unavailable until someone unlocks it. `setKeyguardDisabled()` also does nothing while a PIN, password or pattern is set ([DevicePolicyManager reference](https://developer.android.com/reference/android/app/admin/DevicePolicyManager)). **[confirmed]**
4. Developer options: Settings > About tablet > Software information, tap **Build number** 7 times, then turn on **USB debugging**.

### 2.2 Can system apps be fully removed without root? **No.** [confirmed]
- System APKs live on the read-only, verified `/system` (or `/product`) partitions. UAD-ng's FAQ states that deleting system packages without root is "actually not possible". The tool uninstalls packages **for user 0** and clears their `/data` copies and updates ([UAD-ng FAQ](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation/wiki/FAQ)).
- `pm uninstall -k --user 0 <pkg>` hides the app for the user and removes its data and updates. No `/system` space is freed. **A factory reset restores everything** ("A factory reset will restore all the debloated packages!", same FAQ).
- To restore a package: `adb shell cmd package install-existing --user 0 <pkg>`. For a disabled one: `adb shell pm enable <pkg>`. **[confirmed, UAD-ng FAQ]**
- UAD-ng advises **disabling rather than uninstalling** anything above the "Recommended" level. It also warns that even "Recommended" is not a guarantee. **[confirmed]**
- Truly removing system apps requires an unlocked bootloader plus root or a custom ROM, which trips Knox permanently (section 8).

### 2.3 Packages that must NEVER be removed (UAD-ng "Unsafe", or known to bootloop or lock you out)
From the current UAD-ng list (`uad_lists.json` on main, fetched 2026-11-19, [repo](https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation)):

| Package | Why |
|---|---|
| `com.android.systemui` | Everything that isn't an app. Unsafe. |
| `com.android.settings`, `com.samsung.android.SettingsReceiver` | Settings and Samsung's Settings overlay. Unsafe. |
| `com.android.providers.settings`, `com.android.providers.telephony`, `com.android.providers.downloads` | Core content providers. Unsafe. (`providers.media` and `providers.contacts` are Expert: keep them.) |
| **`com.samsung.android.kgclient`** | **Removing it locks you out** with a full-screen "Device Services was uninstalled in an unauthorised manner" overlay that persists until a factory reset. |
| `com.google.android.ext.services`, `com.google.android.ext.shared`, `com.google.android.modulemetadata`, `com.google.android.permissioncontroller`, `com.google.android.packageinstaller`, `com.google.android.networkstack` | Mainline and framework modules. Unsafe. **We need `packageinstaller` for self-updates.** |
| `com.samsung.android.networkstack`, `com.samsung.android.wifi.resources` (and the other `wifi.*.resources`), `com.samsung.android.ConnectivityOverlay` | Wi-Fi stops working |
| `com.samsung.android.mtp`, `com.samsung.android.storage.watchstoragemanager` | Unsafe ("DO NOT REMOVE THIS") |
| `com.samsung.knox.keychain`, `com.samsung.ucs.agent.boot`, `com.samsung.android.sm.policy` | Knox and boot components. Unsafe. |
| `com.samsung.android.timezone.*` | One of these bootloops a Galaxy A50 |
| `com.samsung.android.app.soundpicker`, `com.samsung.android.clipboarduiservice`, `com.samsung.android.applock`, `com.samsung.android.incallui` | Unsafe |

Also keep these for **our** use case:

| Package | UAD level | Why we keep it |
|---|---|---|
| `com.google.android.webview` | Expert | Our app *is* two WebViews |
| `com.samsung.android.honeyboard` (Samsung Keyboard) | Expert | Keep at least one keyboard with direct-boot support, or you can get stuck at boot. We also need it to type the claude.ai login. |
| `com.samsung.android.lool` (Device care) | Advanced | Removing it "may remove the option to manage Power Saving, Fast Charging & **Battery Protection**". We want Protect battery. |
| `com.sec.android.app.SecSetupWizard`, `com.google.android.setupwizard` | Advanced | No benefit to removing them, and they return after a reset anyway. Removing a setup wizard before `user_setup_complete=1` can leave Home and quick settings broken. **[community]** |
| `com.samsung.klmsagent`, `com.samsung.android.knox.kpecore` | Advanced / Recommended | Needed for **Knox licence activation** if we use Knox auto-boot or Fully's Knox features (section 7) |
| `com.sec.android.app.launcher` (One UI Home) | Expert | Disabling it "breaks the multitasking navigation button". In lock task mode we don't need it, but keep it installed, ideally enabled, as the fallback HOME until DashPad is proven stable. **[suggestion]** |
| `com.android.vending`, `com.google.android.gms`, `com.google.android.gsf` | Expert | Keep them if using WebView option A. UAD notes that removing GMS "can boot-loop some devices". Disable rather than uninstall if they are not used. |
| `com.wssyncmldm`, `com.sec.android.soagent` (OTA) | Expert | The device is end-of-life, so **disabling** them to stop update nags is reasonable. Don't uninstall. |
| `com.android.phone`, `com.samsung.android.app.telephonyui` | Expert | Breaks Samsung's update screen. Keep them on the LTE model. |
| `com.samsung.accessibility` | Expert | "Can cause a bootloop if you set a lock code" |

### 2.4 Usually safe to uninstall for user 0 (UAD-ng "Recommended")
Run `adb shell pm list packages -s` first and only act on packages that are present. A missing package just makes the command fail harmlessly.

- **Bixby and assistants:** `com.samsung.android.bixby.agent`, `com.samsung.android.bixby.wakeup`, `com.samsung.android.bixby.service`, `com.samsung.systemui.bixby2`, `com.samsung.android.app.settings.bixby`, `com.samsung.android.bixbyvision.framework`, `com.samsung.android.visionintelligence`, `com.samsung.android.svoiceime`, `com.samsung.android.app.spage`, `com.samsung.android.app.reminder`
- **Games and kids:** `com.samsung.android.game.gamehome`, `com.samsung.android.game.gametools`, `com.samsung.android.game.gos`, `com.samsung.android.kidsinstaller`, `com.sec.android.app.kidshome`
- **Connectivity extras:** `com.samsung.android.oneconnect`, `com.samsung.android.beaconmanager`, `com.samsung.android.easysetup`, `com.samsung.android.service.stplatform`, `com.samsung.android.mateagent`, `com.samsung.android.app.watchmanagerstub`, `com.samsung.android.allshare.service.mediashare`, `com.samsung.android.app.sharelive`, `com.samsung.android.app.simplesharing`, `com.samsung.android.mdx`, `com.microsoft.appmanager`
- **Accounts, cloud and payments:** `com.samsung.android.scloud`, `com.samsung.android.fmm`, `com.samsung.android.samsungpass`, `com.samsung.android.authfw`, `com.samsung.android.spay` (if present), `com.sec.android.app.billing`, `com.samsung.android.coldwalletservice`, `com.samsung.android.privateshare`, `com.samsung.android.dkey`, `com.samsung.android.digitalkey`
- **Edge panels and suggestions:** `com.samsung.android.app.cocktailbarservice`, `com.samsung.android.app.appsedge`, `com.samsung.android.app.taskedge`, `com.samsung.android.app.clipboardedge`, `com.samsung.android.service.peoplestripe`, `com.samsung.android.smartsuggestions`, `com.samsung.android.app.tips`
- **Telemetry:** `com.samsung.android.rubin.app`, `com.samsung.android.svcagent`, `com.samsung.android.dsms`, `com.samsung.android.providers.context`, `com.samsung.android.ipsgeofence`, `com.samsung.android.knox.analytics.uploader`
- **Consumer apps:** `com.samsung.android.app.notes`, `com.samsung.android.email.provider`, `com.sec.android.app.sbrowser`, `com.sec.android.app.voicenote`, `com.sec.android.easyMover`, `com.samsung.android.smartswitchassistant`, `com.samsung.android.voc`, `com.samsung.android.da.daagent` (Dual Messenger), `com.samsung.android.app.omcagent`, `com.samsung.android.app.updatecenter`, `com.sec.android.app.chromecustomizations`
- **Camera extras:** `com.samsung.android.aremoji`, `com.samsung.android.stickercenter`, `com.samsung.android.emojiupdater`, `com.samsung.android.app.camera.sticker.facearavatar.preload`
- **Third-party:** `com.facebook.katana`, `com.facebook.appmanager`, `com.facebook.services`, `com.facebook.system`, `com.netflix.mediaclient`, `com.netflix.partner.activation`, `com.microsoft.skydrive`, `com.microsoft.office.officehubrow`, `com.linkedin.android`, `com.spotify.music`
- **Google apps:** `com.google.android.youtube`, `com.google.android.apps.youtube.music`, `com.google.android.gm`, `com.google.android.apps.maps`, `com.google.android.apps.docs`, `com.google.android.videos`, `com.google.android.apps.photos`, `com.google.android.apps.tachyon`, `com.google.android.gms.location.history`, `com.google.ar.core`, `com.google.android.apps.restore`, `com.google.android.feedback`, `com.google.android.onetimeinitializer`
- **Secure Folder / Knox containers:** `com.samsung.android.knox.containercore` and `com.samsung.android.knox.containeragent` are "Recommended". Secure Folder isn't supported in Device Owner mode anyway ([Samsung KBA on Dual Messenger](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/kba-360041579894/)).

Example script (PowerShell or bash, run from the PC):
```sh
for p in com.samsung.android.bixby.agent com.samsung.android.app.tips com.facebook.katana ; do
  adb shell pm uninstall -k --user 0 $p
done
# Borderline: disable instead (reversible with `pm enable`)
adb shell pm disable-user --user 0 com.wssyncmldm
adb shell pm disable-user --user 0 com.sec.android.soagent
```
**Process:** debloat in small batches and reboot after each one. If something breaks, roll back with `cmd package install-existing`. **[suggestion]** The UAD-ng GUI can also be used. It is a third-party tool, so the user decides whether to install it.

---

## 3. Device Owner kiosk

### 3.1 Requirements for `dpm set-device-owner` [confirmed / community]
- The admin APK must be installed and contain a `DeviceAdminReceiver` (with the `BIND_DEVICE_ADMIN` permission and `@xml/device_admin`).
- **No accounts on the device** ([Android cookbook, development setup](https://developer.android.com/work/dpc/dedicated-devices/cookbook)). bayton.org adds "no Google accounts **or secondary users**" ([bayton.org](https://bayton.org/android/android-enterprise-faq/can-i-set-device-owner-without-factory-reset/)). Samsung accounts count too.
- Typical errors: "Not allowed to set the device owner because there are already some accounts on the device" and "...already several users on the device". On Samsung, **Secure Folder (user 150) and Dual Messenger (user 95)** create extra users or profiles, so don't set them up. **[community]**
- Checks before running it:
  ```sh
  adb shell pm list users          # expect only: UserInfo{0:Owner...}
  adb shell dumpsys account        # expect: Accounts: 0
  adb shell dpm set-device-owner com.dashpad/.AdminReceiver
  adb shell dumpsys device_policy | findstr /i "owner"   # (PowerShell) confirm
  ```
- The adb method is officially a "development and testing tool". QR-code provisioning is the production route, but for a single device adb is fine ([bayton.org](https://bayton.org/android/android-enterprise-faq/can-i-set-device-owner-without-factory-reset/), [cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook)).
- Samsung's Dual Messenger is **not supported in Device Owner or Profile Owner mode** ([Samsung Knox KBA](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/kba-360041579894/)). That doesn't matter for us. **[confirmed]**

### 3.2 Policies to set from the app (Kotlin)
All of the following is documented in [Lock task mode](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode), the [dedicated-devices cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook), [system updates](https://developer.android.com/work/dpc/system-updates) and the [DevicePolicyManager reference](https://developer.android.com/reference/android/app/admin/DevicePolicyManager). **[confirmed]**

```kotlin
fun applyKioskPolicies(ctx: Context) {
    val dpm = ctx.getSystemService(DevicePolicyManager::class.java)
    val admin = ComponentName(ctx, AdminReceiver::class.java)
    if (!dpm.isDeviceOwnerApp(ctx.packageName)) return

    // 1. Lock task allowlist + which system UI stays visible (API 28+)
    dpm.setLockTaskPackages(admin, arrayOf(ctx.packageName))
    dpm.setLockTaskFeatures(admin, DevicePolicyManager.LOCK_TASK_FEATURE_NONE)
    //  ^ NONE hides home/recents/notifications/status info and the power menu.
    //    Use LOCK_TASK_FEATURE_GLOBAL_ACTIONS if you still want the long-press power menu.

    // 2. Be the persistent HOME (survives reboots; no chooser)
    val home = IntentFilter(Intent.ACTION_MAIN).apply {
        addCategory(Intent.CATEGORY_HOME); addCategory(Intent.CATEGORY_DEFAULT)
    }
    dpm.addPersistentPreferredActivity(admin, home, ComponentName(ctx, KioskActivity::class.java))

    // 3. No lock screen (no effect if a PIN/pattern/password exists)
    dpm.setKeyguardDisabled(admin, true)
    // setStatusBarDisabled() has NO effect while in lock task mode; it only matters outside it.
    dpm.setStatusBarDisabled(admin, true)

    // 4. Screen on while powered (must not use setMaximumTimeToLock at the same time)
    val plugged = BatteryManager.BATTERY_PLUGGED_AC or BatteryManager.BATTERY_PLUGGED_USB or
                  BatteryManager.BATTERY_PLUGGED_WIRELESS            // = 7
    dpm.setGlobalSetting(admin, Settings.Global.STAY_ON_WHILE_PLUGGED_IN, plugged.toString())
    dpm.setSystemSetting(admin, Settings.System.SCREEN_OFF_TIMEOUT, (24 * 3600 * 1000).toString())
    dpm.setSystemSetting(admin, Settings.System.SCREEN_BRIGHTNESS_MODE,
        Settings.System.SCREEN_BRIGHTNESS_MODE_MANUAL.toString())

    // 5. OTA: postpone (30 days max per update) or windowed; freeze periods max 90 days, 60-day gap
    dpm.setSystemUpdatePolicy(admin, SystemUpdatePolicy.createPostponeInstallPolicy())

    // 6. Restrictions
    listOf(UserManager.DISALLOW_SAFE_BOOT,              // safe mode would bypass our HOME
           UserManager.DISALLOW_SYSTEM_ERROR_DIALOGS,   // auto-restart crashed apps silently
           UserManager.DISALLOW_ADD_USER)
        .forEach { dpm.addUserRestriction(admin, it) }
    // Do NOT add DISALLOW_DEBUGGING_FEATURES (we need adb). DISALLOW_FACTORY_RESET is optional.
}
```
In `KioskActivity`:
```kotlin
override fun onCreate(b: Bundle?) { super.onCreate(b); window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON) }
override fun onResume() { super.onResume(); if (dpm.isLockTaskPermitted(packageName)) startLockTask() }
```
Manifest: the HOME/DEFAULT intent filter, `android:launchMode="singleTask"` (the cookbook uses `singleInstance`), `android:lockTaskMode="if_whitelisted"` so the system enters lock task mode automatically, and `android:excludeFromRecents="true"`.

**Activity type and `singleTask` (measured on the tablet 2026-11-23).** A HOME-category start without a component lands in the HOME-type task. An explicit-component start (`am start -n`, or `Intent(ctx, MainActivity::class.java)` from the app) lands in a standard-type task. `singleTask` does not reuse a task of the other type, so the second start creates a second `MainActivity`. Under Device Owner, start DashPad only by the HOME form, or force-stop it first.

Notes:
- `setGlobalSetting` now only allows `ADB_ENABLED`, `USB_MASS_STORAGE_ENABLED`, `STAY_ON_WHILE_PLUGGED_IN` (only if `setMaximumTimeToLock` is not used) and `WIFI_DEVICE_OWNER_CONFIGS_LOCKDOWN`. `setSystemSetting` allows only `SCREEN_BRIGHTNESS`, `SCREEN_BRIGHTNESS_MODE` and `SCREEN_OFF_TIMEOUT` ([DPM reference](https://developer.android.com/reference/android/app/admin/DevicePolicyManager)). **[confirmed]**
- Lock task mode hides the status bar contents, hides the Home and Overview buttons, stops other apps from launching activities, and disables the lock screen ([Lock task mode](https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode)). Adding `DISALLOW_CREATE_WINDOWS` in `onLockTaskModeEntering` also blocks toasts and overlays from other apps.
- **SystemUpdatePolicy:** a postponed update is deferred **30 days once**, then the user is prompted. OEMs may exempt security updates. Freeze periods are at most 90 days with a mandatory 60-day gap ([system updates](https://developer.android.com/work/dpc/system-updates)). The device is end-of-life, so Samsung is unlikely to ship more OTAs. Disabling `com.wssyncmldm` and `com.sec.android.soagent` is the practical belt-and-braces step. **[suggestion]**
- **Samsung quirks:** I found no reports that Samsung ignores the AOSP lock task or HOME APIs. Samsung's Device care **Auto restart** ("Restart when needed" and "Restart on schedule") stays active on One UI 4.1 ([Samsung support](https://www.samsung.com/in/support/mobile-devices/how-to-automatically-optimise-your-galaxy-device/)). Turn both off in the UI, and make sure the app copes with reboots anyway (it does, because it is the HOME activity). **[community]**

### 3.3 Removing Device Owner later (maintenance)
| Method | Notes |
|---|---|
| In-app maintenance mode **[suggestion]** | A hidden, PIN-protected gesture calls `stopLockTask()`, `dpm.clearPackagePersistentPreferredActivities(admin, pkg)` and, if needed, `dpm.clearDeviceOwnerApp(pkg)`. That last call is deprecated since API 26 and documented as "intended for testing only", but it still lets the DO drop itself. |
| `adb shell dpm remove-active-admin com.dashpad/.AdminReceiver` | Works **only if the APK declares `android:testOnly="true"`** and was installed with `adb install -t`. Otherwise it throws a SecurityException ([AOSP Dpm.java](https://code.yawk.at/android/android-9.0.0_r35/com/android/commands/dpm/Dpm.java), [FreeKiosk docs](https://raw.githubusercontent.com/RushB-fr/freekiosk/main/docs/adb-configuration.md)). The flag is captured at the first activation: `setActiveAdmin` keeps an existing admin's `testOnlyAdmin` and reads the package flag only for a new admin; a later update does not change it ([AOSP DevicePolicyManagerService](https://github.com/aosp-mirror/platform_frameworks_base/blob/main/services/devicepolicy/java/com/android/server/devicepolicy/DevicePolicyManagerService.java)). So install the testOnly APK before `set-device-owner`, while `com.dashpad` is not an active admin. **[confirmed in AOSP source; DashPad: `testOnlyAdmin=true` measured on the tablet 2026-11-23]** **[uncertain]** whether a testOnly APK can also self-update through PackageInstaller; DashPad drops the flag before the Phase 7 self-update. |
| `adb shell am task lock stop` | Does **not** end the Device Owner lock: the state stayed `LOCKED` (measured on the tablet 2026-11-23). Not a way out. |
| adb-only maintenance receiver **[suggestion, uncertain]** | An exported `BroadcastReceiver` protected by a permission that the `shell` user holds but normal apps cannot get (for example `android.permission.DUMP`). From the PC: `adb shell am broadcast -n com.dashpad/.MaintenanceReceiver -a com.dashpad.EXIT_KIOSK`. Verify that shell holds the permission on the device. |
| Factory reset from recovery | The last resort. It wipes everything. |

On owner removal the system clears the owner's user restrictions (`removePoliciesForAdmin` in `clearDeviceOwnerLocked`, AOSP DevicePolicyManagerService) and drops the `POLICY_FIXED` flag of granted permissions. It does not reset `setLockScreenDisabled`: after `dpm remove-active-admin` run `adb shell locksettings set-disabled false`. **[confirmed in AOSP source; not measured on the tablet]**

---

## 4. Fully Kiosk Browser vs. a custom app

| | Fully Kiosk Browser (PLUS) | Custom DashPad app |
|---|---|---|
| Price | **EUR 8.90 / USD 10.99 per device, one-time**, plus optional Fully Cloud at up to EUR 1.18 per device per month ([Fully FAQ](https://www.fully-kiosk.com/docs/en/faq/difference)) | Development time |
| Device Owner | Yes: QR provisioning (needs a factory reset) or ADB provisioning code (no reset) ([provisioning](https://www.fully-kiosk.com/docs/en/management/device-provisioning)). DO features include lock task, disabling the status bar and keyguard, blocking safe mode, update policy, silent APK install and a daily reboot ([DO settings](https://www.fully-kiosk.com/docs/en/configuration/device-owner)). There is an experimental "Remove Device Owner". | Everything in section 3 |
| Scheduled screen on/off | Yes (PLUS): sleep/wake schedule, wake on power connect, sleep on power disconnect ([power settings](https://www.fully-kiosk.com/docs/en/configuration/power)) | We build it (simple: `lockNow()`, wake locks, brightness) |
| Remote admin | LAN web admin on port 2323, REST API, screenshots, Fully Cloud ([remote admin](https://www.fully-kiosk.com/docs/en/configuration/remote-administration)) | adb, scrcpy and our own endpoint |
| Samsung Knox | PLUS includes **"Force Auto Start"** (auto-boot on power, Qualcomm/LSI on Android 12 or lower), disabling power off, OTA, etc. It needs internet for Knox licence activation and a one-time on-device acceptance of the Knox agreement ([Knox settings](https://www.fully-kiosk.com/docs/en/configuration/knox)). | Must integrate the Knox SDK ourselves (section 7) |
| **Two WebViews side by side** | **No.** It only has tabs, switched by swiping ([tabs FAQ](https://www.fully-kiosk.com/docs/en/faq/tabs)). An HTML wrapper with two iframes would need claude.ai to allow framing. claude.ai served `X-Frame-Options: SAMEORIGIN` on the Cloudflare response we saw, and app pages almost certainly forbid third-party framing. **[uncertain, very likely blocked]** Third-party cookie partitioning inside iframes would also hurt the login. | Native split layout, a shared cookie store, full control over login handling and reloads |
| Engine | System WebView, so the same WebView update and Google-login limits apply | Same (unless GeckoView) |
| Openness | Closed source | Ours |

**Verdict [suggestion]:** a custom app is clearly better for the split view and persistent-login requirements. Fully's main advantage is its ready-made Knox "Force Auto Start". If we don't want to integrate the Knox SDK ourselves, one option is to buy one PLUS licence and test whether Fully, installed as a Knox-capable admin, can set Force Auto Start while DashPad is Device Owner. **[uncertain, untested; Knox policies may be tied to the admin that set them]** FreeKiosk is an open-source kiosk alternative ([docs](https://raw.githubusercontent.com/RushB-fr/freekiosk/main/docs/adb-configuration.md)), but it doesn't solve the split view either.

---

## 5. Keeping the screen on 24/7

Use several layers, because Samsung has several things that can turn the screen off or dim it:

| Layer | Command or API | Source / confidence |
|---|---|---|
| Window flag | `window.addFlags(FLAG_KEEP_SCREEN_ON)`: keeps the screen on and bright while our activity is visible | [cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook) [confirmed] |
| Stay awake while plugged in | `adb shell settings put global stay_on_while_plugged_in 7` (AC 1 + USB 2 + wireless 4), or the DPM `setGlobalSetting` call from section 3 | [cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook) [confirmed] |
| Screen timeout | `adb shell settings put system screen_off_timeout 86400000` (24 h; `2147483647` is also used), or DPM `setSystemSetting(SCREEN_OFF_TIMEOUT)` | [DPM ref](https://developer.android.com/reference/android/app/admin/DevicePolicyManager) [confirmed for DPM] |
| No lock screen | `adb shell locksettings set-disabled true` ("Lock screen disabled set to true"). This only switches between Swipe and None, and does nothing if a secure lock exists. DPM `setKeyguardDisabled(true)` is the equivalent. | [Esper](https://www.esper.io/blog/how-to-disable-the-lock-screen-on-android), [AOSP LockSettingsCmd](https://code.yawk.at/android/android-9.0.0_r35/com/android/commands/locksettings/LockSettingsCmd.java) [confirmed] |
| Adaptive brightness off | `adb shell settings put system screen_brightness_mode 0`, or DPM `setSystemSetting` | AOSP key [confirmed] |
| Screensaver / daydream off | `adb shell settings put secure screensaver_enabled 0`, `... screensaver_activate_on_dock 0`, `... screensaver_activate_on_sleep 0` | AOSP keys. [community] for the Samsung effect ([Datalogic thread](https://discussion.datalogic.com/t/how-to-allow-memor-11s-screen-in-kiosk-mode-to-turn-off-when-charging-in-a-dock/2596)) |
| Power saving off | `adb shell settings put global low_power 0`, and keep Samsung Power saving off in the UI | AOSP key. **[uncertain]** whether Samsung has its own extra key |
| Samsung "Keep screen on while viewing" (Smart Stay) | Turn it **off** in Settings > Advanced features > Motions and gestures. It uses the front camera and is unreliable. The adb key is possibly `intelligent_sleep_mode`. | **[uncertain]** key. UAD links it to `com.samsung.android.smartface`. |
| Device care Auto restart | Turn off both "Restart when needed" and "Restart on schedule" (UI only; no documented adb key) | [Samsung support](https://www.samsung.com/in/support/mobile-devices/how-to-automatically-optimise-your-galaxy-device/) [confirmed UI] |
| Sleeping apps | Battery > Background usage limits: turn off "Put unused apps to sleep", add DashPad to "Never sleeping apps", turn off Adaptive battery | [Samsung](https://www.samsung.com/us/support/answer/ANS00088422/), [dontkillmyapp](https://dontkillmyapp.com/samsung) [community] |
| Doze / standby exemptions | `adb shell dumpsys deviceidle whitelist +com.dashpad`; `adb shell cmd appops set com.dashpad RUN_ANY_IN_BACKGROUND allow`; `adb shell am set-standby-bucket com.dashpad active` | Standard AOSP shell commands. Active device admins are normally placed in the EXEMPTED standby bucket. **[uncertain on Samsung]** Doze only applies with the screen off anyway. |

**Finding Samsung-only keys [suggestion]:** run `adb shell settings list global > a.txt` (and the same for `system` and `secure`), flip the toggle in the UI, dump again and diff. This works for Protect battery, Smart Stay, power saving and Auto restart.

**Night dimming [suggestion]:**
```kotlin
fun setDim(level: Float?) = window.attributes.let {   // level 0.0..1.0, null = follow system
    it.screenBrightness = level ?: WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
    window.attributes = it
}
// e.g. 23:00-07:00 -> setDim(0.02f); day -> setDim(null) or 0.6f
```
Some panels turn the backlight fully off at 0.0, so use a small positive minimum such as 0.01 to 0.02. The DO can also set the system-wide `SCREEN_BRIGHTNESS` (0 to 255) through `setSystemSetting`. To turn the screen fully off at night, call `dpm.lockNow()`. With the keyguard disabled it just blanks the screen. Wake it with a wake lock that uses `ACQUIRE_CAUSES_WAKEUP`, or with an activity using `setTurnScreenOn(true)`. The Tab A7 has an LCD, so there is no OLED burn-in risk. Dimming mainly saves backlight and heat.

---

## 6. Battery health when plugged in 24/7

- **Risk:** lithium cells kept at 100% and warm age fast and can **swell**. Swollen batteries in always-on wall tablets are a recurring report in home-automation communities ([openHAB "Bloated battery, fire hazard"](https://community.openhab.org/t/bloated-battery-in-tablet-fire-hazard/145821), [Lava blog](https://lavalink.com/lavablog/articles/is-your-tablets-battery-bloating-4-tips-to-avoid-this-issue/)). Allow ventilation behind the wall mount, avoid sun and heat, and check monthly for the screen lifting. **[community]**
- **Samsung "Protect battery" (85% cap):** introduced with One UI 4.0, at Settings > Battery and device care > Battery > More battery settings > Protect battery ([SamMobile guide](https://www.sammobile.com/news/protect-galaxy-smartphone-battery-for-longer-lifespan-guide/), [Samsung](https://www.samsung.com/in/support/mobile-devices/battery-protection-feature-in-samsung-galaxy-phones)). Tab A7 Lite users report finding the toggle there. **[uncertain]** whether it appears on the SM-T500 with One UI 4.1, so check it on the device. Some tablets show "100%" while actually stopped at 85%.
- **adb key:** `adb shell settings put global protect_battery 1` is used in automation tutorials for One UI 4/5 ([SOTI thread](https://pulse.soti.net/community/thread/61cdf6a2-37fe-40e9-8d6f-164453fe68b0), automation guides). **[uncertain]**: verify it with the settings-diff method in section 5. One UI 6.1+ uses a different "Battery protection" mode, which doesn't apply here.
- **Knox route (tablets only) [confirmed]:** the Knox policy "Extend battery life by limiting the maximum charge" (Knox Configure), or "Enable battery protection setting" (Knox Service Plugin), caps charging at **85%** on **tablets only** and needs **Knox 3.4.1+** ([KBA-77](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/kba-77-how-to-limit-battery-charging-on-samsung-knox-device/)). It lowers the charge voltage from 4.4 V to 4.2 V, and the indicator may show 100% ([KBA-322](https://docs.samsungknox.com/admin/knox-configure/kbas/kba-322-device-shows-battery-life-100/)). This needs an EMM that can push KSP, or Knox Configure. **[uncertain]** whether our own DPC can push the KSP managed configuration with `setApplicationRestrictions`. Newer KSP charging-threshold options need Android 15+ or Knox 3.14+, so they don't apply here.
- **Vendor-independent alternative [suggestion]:** a smart plug driven by battery level. DashPad reports its battery percentage (HTTP or MQTT to Home Assistant or similar), and an automation turns the plug **on at 40% and off at 80%**. A fixed timer schedule is less precise, because with the screen on the tablet drains at a few percent per hour. Either way, set `stay_on_while_plugged_in` to 7 and rely on `FLAG_KEEP_SCREEN_ON`, so the screen also stays on while the plug is off.
- The Knox "No Battery Mode" is only for Tab Active models ([KBA-489](https://docs.samsungknox.com/admin/knox-manage/kbas/kba-489-enable-no-battery-mode/)), so it doesn't apply.

---

## 7. Auto power-on after a power outage

### 7.1 The problem
If the battery runs to 0%, the tablet shuts down. When power returns, Samsung boots into the **LPM charging animation** instead of Android. Without help, someone has to hold the power button. **[community]** ([Samsung community](https://eu.community.samsung.com/t5/tablets/galaxy-tab-a-10-1-2019-auto-start-on-plugging-into-charger/td-p/1745983))

### 7.2 Options
| Option | Root? | Status |
|---|---|---|
| **Knox SDK `SystemManager.setForceAutoStartUpState(ON)`** | No | **[confirmed]** "the device boots fully when power is applied to the USB connector, instead of stopping at the battery charging UI". Since Knox 2.6; permission `com.samsung.android.knox.permission.KNOX_CUSTOM_SYSTEM`. On **Android 12 and lower it works only on Qualcomm and LSI chipsets**; the Tab A7's SM6115 is Qualcomm. Returns `ERROR_NOT_SUPPORTED` on unsupported devices ([SystemManager reference](https://docs.samsungknox.com/devref/knox-sdk/reference/com/samsung/android/knox/custom/SystemManager.html), [Knox KBA](https://docs.samsungknox.com/dev/knox-sdk/kbas/how-to-power-the-device-on-or-off-when-connected-or-disconnected-from-a-power-source/)). The permission sits in the Premium/Customization tier ([licence permissions](https://docs.samsungknox.com/dev/knox-sdk/introduction/license-permissions/)). The **KPE Premium licence is free**, but each key expires 2 years after activation ([KPE licences](https://docs.samsungknox.com/admin/knox-platform-for-enterprise/before-you-begin/knox-platform-for-enterprise-licenses/), [get a licence](https://docs.samsungknox.com/dev/knox-sdk/get-started/get-a-license/)). Activation needs internet. |
| Knox Service Plugin policy "Set Power ON when connected to power source" | No | **[confirmed]** Needs Knox Manage (or another EMM) plus a KPE Premium or Knox Suite licence. On Android 12 and lower, Qualcomm and LSI only ([KBA-474](https://docs.samsungknox.com/admin/knox-manage/kbas/kba-474-automatically-start-a-device-with-knox-service-plugin/)). |
| Fully Kiosk PLUS → Knox "Force Auto Start" | No | **[confirmed feature]** ([Fully Knox settings](https://www.fully-kiosk.com/docs/en/configuration/knox)). It is the same API wrapped for you. |
| Magisk module `magisk-autoboot`, or editing Samsung's `lpm` / `playlpm` binary or init `on charger` | **Yes** (unlocked bootloader, Knox trip) | **[community]** ([magisk-autoboot](https://awesome.ecosyste.ms/projects/github.com%2Fanasfanani%2Fmagisk-autoboot), [Instructables](https://instructables.com/AutoBoot-Android-When-Charger-Connected)). It is device-specific, wrong permissions can send the device into recovery, and I found no confirmed recipe for the Tab A7. |
| LineageOS | Needs a custom ROM | **[uncertain]** I found no setting for this. You would need root and the autoboot module. |

**Known Knox caveat:** with a **deeply drained battery**, auto-power-on can **boot-loop** if the device draws more power while booting than it charges. Samsung's KBA only suggests a service centre ([Knox Configure KBA](https://docs.samsungknox.com/admin/knox-configure/kbas/kba-360047678173/)). Another reason not to let the battery reach 0%.

### 7.3 Practical workaround (recommended, no Knox needed) [suggestion]
1. **Don't let the battery reach 0%.** DashPad registers `ACTION_POWER_DISCONNECTED` and `ACTION_POWER_CONNECTED` dynamically (these implicit broadcasts can't be registered in the manifest since Android 8, but our activity is always running).
   - On power loss: after about 1 minute, dim to the minimum. After about 5 minutes, or below roughly 60%, call `dpm.lockNow()` to turn the screen off. An idle 7040 mAh tablet with the screen off and Wi-Fi on typically lasts **days**, which covers Ukrainian scheduled blackouts of several hours. **[uncertain: measure the actual drain]**
   - On power restore: turn the screen on (wake lock with `ACQUIRE_CAUSES_WAKEUP`, or `setTurnScreenOn(true)`), restore brightness, and reload both WebViews.
   - Optionally, below about 10%, show a "charge me" banner or send a notification.
2. **A 5 V mini-UPS** of the kind used for routers, or a power bank that supports true pass-through. The Tab A7 charges at up to 15 W, so the UPS must provide 2 A or more at 5 V.
3. If true unattended recovery from 0% is still required: integrate the Knox SDK (free KPE Premium key, renewed every 2 years) and call `setForceAutoStartUpState(ON)` once. Or use Fully PLUS for that single feature. Test it: drain to 0%, then plug in.

---

## 8. Optional "truly clean" path: LineageOS

### 8.1 Current status [confirmed]
- **The device is officially supported by LineageOS**, so unofficial builds are no longer needed. Device data from the LineageOS wiki source:
  - `gta4lwifi` (SM-T500): current branch **24.0**, supported versions 20 through 24.0, maintainer **chrmhoffmann**, kernel 4.19 ([gta4lwifi.yml](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_data/devices/gta4lwifi.yml))
  - `gta4l` (SM-T505/T505C/T505N/T507): same branches and maintainer, with an IMS quirk ([gta4l.yml](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_data/devices/gta4l.yml))
  - Device tree on the `lineage-24.0` branch: [android_device_samsung_gta4l-common](https://github.com/LineageOS/android_device_samsung_gta4l-common)
- **LineageOS 24.0 is based on Android 17.** It was announced on 2026-10-11/12, with rollout per device "over the coming weeks". Devices on kernels 4.4 and 4.9 stay on 22.2, but the Tab A7 uses 4.19, so it is eligible ([9to5Google](https://9to5google.com/2026/10/12/lineageos-24-launches-based-on-android-17-with-app-redesigns-and-simple-flash-tool/), [CyberInsider](https://cyberinsider.com/lineageos-24-lands-with-android-17-and-upgrade-limits-for-older-devices/)). **[uncertain]** whether 24.0 builds for gta4lwifi are already on download.lineageos.org; the site blocked automated access. If not, 23.2 (Android 16) is available.
- The **"Linux4"** builds the user remembers: Linux4 maintains the Tab **S6 Lite** (`gta4xl` and related). The Tab A7's official maintainer is chrmhoffmann. The earlier unofficial Tab A7 XDA threads (LineageOS 18.1 and 19.1 with TWRP) are retired or obsolete ([XDA 19.1 thread](https://forum.xda-developers.com/t/rom-sm-t500-samsung-galaxy-tab-a7-10-4-2020-lineageos-19-1-and-twrp-3-6-1.4421365/post-87540029)). The iodéOS and /e/OS forks also exist ([iodé](https://community.iode.tech/t/unofficial-build-samsung-galaxy-tab-a7-10-4-2020-sm-t505-gta4l-und-sm-t500-gta4lwifi/2689), [/e/OS gta4lwifi](https://wiki.e.foundation/devices/gta4lwifi)).

### 8.2 Requirements and procedure (summary) [confirmed: LineageOS wiki templates]
- **Stock Android 12 firmware must be installed first** (`before_install: needs_specific_android_fw, version 12`). Our tablet is already on the final Android 12 build.
- Turn on **OEM unlocking** in Developer options. Then, in Download mode (power off, hold Volume Down + Volume Up, connect USB), unlock the bootloader. This **wipes data** and **permanently trips the Knox e-fuse (0x1)**. **[community]** for the Knox detail ([TheCustomDroid](https://www.thecustomdroid.com/samsung-galaxy-bootloader-unlock-guide)).
- The wiki now uses **samloader-rs** (instead of Odin/Heimdall) to flash **Lineage Recovery**. Boot into recovery immediately afterwards, or stock overwrites it ([install template](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_includes/templates/recovery_install_samloader_rs.md)). Then Format data, `adb -d sideload lineage-*.zip`, and optionally GApps before the first boot ([device_install template](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_includes/templates/device_install.md)). LineageOS 24 also added optional in-browser WebUSB tools, including Samsung Odin ([9to5Google](https://9to5google.com/2026/10/12/lineageos-24-launches-based-on-android-17-with-app-redesigns-and-simple-flash-tool/)).
- Firmware updates later: flash `AP_*.tar.md5` from the maintainer's GitHub releases with `samloader flash` ([firmware_update_samsung_gta4lwifi](https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_includes/templates/device_specific/firmware_update_samsung_gta4lwifi.md)).

### 8.3 Pros and cons
| Pros | Cons and risks |
|---|---|
| Android 17, **monthly security patches** (stock stopped at 2024-06) | **Knox is tripped permanently.** Samsung Pay, Pass and Secure Folder die, and Knox APIs are unavailable, so **no Knox auto-boot and no Knox 85% cap** |
| No Samsung bloat at all, so no debloat step is needed | Charging control (charge limit) exists in LineageOS 20+ only where the device's health HAL supports it. **[uncertain]** for gta4l. |
| Bundled WebView updated with each OS build, with no Google account needed | Auto-boot on charger probably needs root (Magisk) **[uncertain]** |
| Device Owner, lock task and the other AOSP DPM APIs work the same | More setup effort, a small brick risk, and a bootloader-unlocked warning on every boot **[uncertain how long it shows]** |
| Weekly or monthly OTA through Updater | Upgrades need maintenance attention; an OTA can change behaviour |

**Recommendation [suggestion]:** start with **stock plus debloat**. The two hardest requirements, **auto-boot after an outage** and the **85% charge cap**, are only cleanly solvable on stock through Knox. Move to LineageOS if: (a) WebView or Play updates prove unworkable, (b) the security posture of an Android 12 device frozen at 2024-06 holding a logged-in claude.ai session becomes a concern, or (c) Samsung services keep interfering. If you go with LineageOS, use the UPS and no-full-drain approach from section 7.3 for outages.

---

## 9. Remote maintenance

### 9.1 adb over Wi-Fi
- **Android 11+ wireless debugging** (applies to Android 12): Developer options > Wireless debugging > "Pair device with pairing code", then on the PC run `adb pair IP:PAIRPORT`, enter the code, and `adb connect IP:PORT`. **Pairing only has to happen once**; the device stays paired until you forget it. "Always allow on this network" makes the network trusted ([Android adb docs](https://developer.android.com/tools/adb)). **[confirmed]**
- **Reboots:** users report that the **Wireless debugging toggle switches off after a reboot**, and the port is random ([GrapheneOS forum](https://discuss.grapheneos.org/d/9054-developer-options-wireless-debugging-resetting-itself-on-reboot)). **[community]** ADB Wi-Fi 2.0, with automatic reconnection, only arrives in Android 17 ([adb docs](https://developer.android.com/tools/adb)).
- **Workarounds:**
  - Grant DashPad `WRITE_SECURE_SETTINGS` once: `adb shell pm grant com.dashpad android.permission.WRITE_SECURE_SETTINGS`. At boot the app writes `Settings.Global "adb_wifi_enabled" = 1`. This is the technique used by [adb-auto-enable](https://github.com/mouldybread/adb-auto-enable) and [KeepADB](https://f-droid.org/packages/de.hohnepeople.keepadb/). The PC's adb then finds the paired device through mDNS (`adb mdns services`). **[community; verify on the device]**
  - `adb tcpip 5555` gives a fixed port (handy over VPN), but **it is lost on reboot** because `service.adb.tcp.port` is not persistent. `persist.adb.tcp.port` needs root ([knightli](https://knightli.com/en/2020/12/28/adb-tcpip-persistent/)). adb-auto-enable re-issues `tcpip:5555` to the local adbd after boot (tested on Android 14+). **[community]**
- **Security:** network adb means full device control. Use it only on the LAN or a VPN (for example WireGuard or Tailscale into the home network), never expose port 5555 to the internet, and consider turning it off when not in use. **[suggestion]**

### 9.2 Remote screen
- **scrcpy** (latest v5.x per [GitHub](https://github.com/Genymobile/scrcpy)) works over adb TCP. `scrcpy --tcpip=IP:5555` connects to a listening device. Without an argument it switches a USB-connected device to TCP/IP mode ([connection docs](https://github.com/Genymobile/scrcpy/blob/master/doc/connection.md)). Useful options include `--no-audio` and `-m1024`. **[confirmed]**

### 9.3 Updating DashPad later
- **adb:** `adb install -r -t dashpad.apk`. Keep the same signing key and an increasing `versionCode`. The Device Owner status, the persistent HOME preference and the lock task allowlist survive an update because the component names are unchanged. **[confirmed behaviour for same-package updates; uncertain only for edge cases]**
- **Self-update [confirmed API]:** as Device Owner, DashPad can download an APK over HTTPS from our server, check its hash and signature, and install it silently through a `PackageInstaller` session. Device owners receive no `STATUS_PENDING_USER_ACTION` ([cookbook](https://developer.android.com/work/dpc/dedicated-devices/cookbook)). Handle `ACTION_MY_PACKAGE_REPLACED` to relaunch, though as HOME it relaunches anyway. The same channel can deliver WebView updates (section 1.3, option C).

---

## 10. Logging in to claude.ai inside an Android WebView

- **Google sign-in is blocked in an embedded WebView. [confirmed]** Since 2021-09-30, Google OAuth refuses requests from embedded webviews, including `android.webkit.WebView`, with **`Error 403: disallowed_useragent`**. Google recommends Custom Tabs or the default browser instead ([Google Developers Blog](https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html)). Spoofing the user agent conflicts with Google's policy and is fragile, so don't. A Custom Tab login doesn't help either, because Custom Tabs use Chrome's cookie jar, not our WebView's.
- **Use the email login. [confirmed]** On claude.ai, enter the email address and click "Continue with email" to get a login link. **If the link is opened on a different device, it shows a verification code to enter on the original device** ([Claude Help Center](https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account)). The flow: request the link in the tablet WebView, open the email on a phone or PC, and type the code into the tablet.
  - Accounts created with Google: the help article implies the emailed link works for the same address (after unlinking Google you "use only the emailed login link"). **[uncertain]** whether it works without unlinking; test it.
  - Community reports mention emails delayed by 2 to 5 minutes and occasional magic-link errors ([claudeissues](https://claudeissues.com/issue/82049-claude-ai-sign-in-magic-link-emails-delayed-2-5-minutes-since-mid-july-2026)). **[community]**
  - **Session lifetime is undocumented. [uncertain]** DashPad should detect a redirect to `/login`, show a "re-login needed" state, and optionally send a notification.
- **Cloudflare:** claude.ai is behind Cloudflare. Our `curl` returned `server: cloudflare` and `cf-mitigated: challenge`. Cloudflare's requirements for challenges in WebViews ([Turnstile mobile implementation](https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/), [challenge troubleshooting](https://developers.cloudflare.com/turnstile/troubleshooting/challenge-solve-issues/)): **[confirmed]**
  - `javaScriptEnabled = true` and `domStorageEnabled = true` (both required)
  - `CookieManager.setAcceptCookie(true)` and `setAcceptThirdPartyCookies(webView, true)`
  - don't block `challenges.cloudflare.com`, and allow `about:blank` and `about:srcdoc`
  - **don't change the User-Agent during a session** (keep the default)
  - treat DNS failures for `*.challenges.cloudflare.com` subdomains as non-fatal
- **WebView setup sketch [suggestion]:**
  ```kotlin
  CookieManager.getInstance().apply { setAcceptCookie(true); setAcceptThirdPartyCookies(claudeView, true) }
  claudeView.settings.apply { javaScriptEnabled = true; domStorageEnabled = true; databaseEnabled = true }
  // never touch userAgentString
  // onPause()/periodically: CookieManager.getInstance().flush()  -> persist the session cookie
  // WebViewClient.onRenderProcessGone(): destroy + recreate the WebView (3 GB RAM device, claude.ai is heavy)
  // shouldOverrideUrlLoading(): allowlist claude.ai, anthropic.com, challenges.cloudflare.com, our dashboard host
  ```
  Both WebViews share one cookie store by default, which is fine. `androidx.webkit` Profiles can isolate them if needed. **[uncertain]** whether claude.ai shows any "unsupported browser" notice in WebView. None is known, but test it.

---

## 11. Provisioning runbook (consolidated) [suggestion]

1. On the PC: install Android SDK Platform-Tools (the user's decision; not done yet).
2. On the tablet: remove the accounts, then reset from Settings.
3. Setup wizard: no Google account, no Samsung account, **screen lock None**. Note the build with `adb shell getprop ro.build.display.id` (expect T500XXS8CXG3).
4. Turn on Developer options and USB debugging, then accept the PC's RSA key.
5. Checks: `adb shell pm list users`, `adb shell dumpsys account`, `adb shell dumpsys webviewupdate` (WebView version).
6. In the UI: turn on Protect battery (if present) and turn off Auto restart, sleeping apps, Adaptive battery, Smart Stay, adaptive brightness and power saving.
7. Debloat in batches, rebooting between them (section 2).
8. `adb install -r -t dashpad.apk`, then `adb shell dpm set-device-owner com.dashpad/.AdminReceiver`.
9. Apply the settings (section 5) plus `adb shell pm grant com.dashpad android.permission.WRITE_SECURE_SETTINGS` for the adb-wifi auto-enable.
10. Launch DashPad in its HOME form: force-stop it, then `adb shell am start -a android.intent.action.MAIN -c android.intent.category.HOME com.dashpad`. `scripts\provision.ps1 -SetDeviceOwner` does steps 8 and 10 together. Under Device Owner, an explicit-component start (`am start -n`) or a launcher-icon start opens a second copy (section 3.2). DashPad applies its policies, enters lock task mode and becomes HOME.
11. Log in to claude.ai with the email code flow.
12. Tests: reboot, pull the power and plug it back in, let the battery drop low, check behaviour overnight, check the WebView renderer crash recovery, and confirm adb reconnects over Wi-Fi after a reboot.
13. Optional: Knox SDK integration for Force Auto Start and the battery cap, then a drain-to-0% test.

## 12. Open questions to verify on the device
- Is "Protect battery" present on SM-T500 One UI 4.1, and which settings key does it flip (`protect_battery`)?
- Does the Play Store behave normally with a Google account added after a custom DO is provisioned?
- Does `settings put global adb_wifi_enabled 1` from an app with WRITE_SECURE_SETTINGS re-enable wireless debugging at boot on One UI 4.1? Does the network stay trusted?
- Does `setForceAutoStartUpState(ON)` return SUCCESS on SM-T500 with a free KPE Premium key? Does it survive reboots and work from 0%?
- How fast does the battery drain with the screen off, Wi-Fi on and the app idle (for the outage plan)?
- How long does the claude.ai session cookie last in the WebView?
- Is LineageOS 24.0 actually being built for gta4lwifi yet?

## 13. Sources
Official or primary:
- Samsung SM-T500 update notes: https://doc.samsungmobile.com/SM-T500/014718200929/wel.html
- Android lock task mode: https://developer.android.com/work/dpc/dedicated-devices/lock-task-mode
- Android dedicated-devices cookbook: https://developer.android.com/work/dpc/dedicated-devices/cookbook
- Android system updates (DPC): https://developer.android.com/work/dpc/system-updates
- DevicePolicyManager reference: https://developer.android.com/reference/android/app/admin/DevicePolicyManager
- adb docs (wireless debugging): https://developer.android.com/tools/adb
- Google OAuth embedded-webview block: https://developers.googleblog.com/2021/06/upcoming-security-changes-to-googles-oauth-2.0-authorization-endpoint.html
- Claude login help: https://support.claude.com/en/articles/13189465-log-in-to-your-claude-account
- Cloudflare Turnstile mobile/WebView: https://developers.cloudflare.com/turnstile/get-started/mobile-implementation/ and https://developers.cloudflare.com/turnstile/troubleshooting/challenge-solve-issues/
- Knox SDK SystemManager: https://docs.samsungknox.com/devref/knox-sdk/reference/com/samsung/android/knox/custom/SystemManager.html
- Knox SDK auto power on/off KBA: https://docs.samsungknox.com/dev/knox-sdk/kbas/how-to-power-the-device-on-or-off-when-connected-or-disconnected-from-a-power-source/
- Knox KSP auto-start KBA-474: https://docs.samsungknox.com/admin/knox-manage/kbas/kba-474-automatically-start-a-device-with-knox-service-plugin/
- Knox Configure power-loop KBA: https://docs.samsungknox.com/admin/knox-configure/kbas/kba-360047678173/
- Knox battery limit KBA-77: https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/kba-77-how-to-limit-battery-charging-on-samsung-knox-device/ and KBA-322: https://docs.samsungknox.com/admin/knox-configure/kbas/kba-322-device-shows-battery-life-100/
- KPE licences: https://docs.samsungknox.com/admin/knox-platform-for-enterprise/before-you-begin/knox-platform-for-enterprise-licenses/
- Knox Dual Messenger in DO mode: https://docs.samsungknox.com/admin/knox-platform-for-enterprise/kbas/kba-360041579894/
- Samsung Auto optimisation/Auto restart: https://www.samsung.com/in/support/mobile-devices/how-to-automatically-optimise-your-galaxy-device/
- LineageOS wiki device data: https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_data/devices/gta4lwifi.yml, https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_data/devices/gta4l.yml
- LineageOS install templates: https://raw.githubusercontent.com/LineageOS/lineage_wiki/main/_includes/templates/recovery_install_samloader_rs.md
- Fully Kiosk docs: https://www.fully-kiosk.com/docs/en/faq/difference, /configuration/device-owner, /configuration/power, /configuration/knox, /configuration/remote-administration, /faq/tabs, /management/device-provisioning
- UAD-ng list and FAQ: https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation (resources/assets/uad_lists.json), https://github.com/Universal-Debloater-Alliance/universal-android-debloater-next-generation/wiki/FAQ
- scrcpy: https://github.com/Genymobile/scrcpy, https://github.com/Genymobile/scrcpy/blob/master/doc/connection.md

News and community (lower confidence):
- 9to5Google (Tab A7 end of updates): https://9to5google.com/2024/10/08/no-more-updates-for-galaxy-z-fold-2-tab-a7/
- SamMobile (June 2024 patch): https://www.sammobile.com/news/galaxy-tab-a7-2020-june-2024-security-update/
- endoflife.date: https://endoflife.date/samsung-galaxy-tab
- 9to5Google (LineageOS 24): https://9to5google.com/2026/10/12/lineageos-24-launches-based-on-android-17-with-app-redesigns-and-simple-flash-tool/
- 9to5Google (Chrome min Android 10): https://9to5google.com/2025/06/26/google-chrome-android-versions-no-longer-supported-2025/
- APKMirror WebView listing: https://www.apkmirror.com/apk/google-inc/android-system-webview/
- bayton.org on adb device owner: https://bayton.org/android/android-enterprise-faq/can-i-set-device-owner-without-factory-reset/
- Esper (locksettings): https://www.esper.io/blog/how-to-disable-the-lock-screen-on-android
- adb-auto-enable: https://github.com/mouldybread/adb-auto-enable ; KeepADB: https://f-droid.org/packages/de.hohnepeople.keepadb/
- GrapheneOS forum (wireless debugging off after reboot): https://discuss.grapheneos.org/d/9054-developer-options-wireless-debugging-resetting-itself-on-reboot
- openHAB swollen tablet battery: https://community.openhab.org/t/bloated-battery-in-tablet-fire-hazard/145821
- dontkillmyapp Samsung: https://dontkillmyapp.com/samsung
- FreeKiosk adb guide: https://raw.githubusercontent.com/RushB-fr/freekiosk/main/docs/adb-configuration.md
- magisk-autoboot: https://awesome.ecosyste.ms/projects/github.com%2Fanasfanani%2Fmagisk-autoboot ; Instructables autoboot: https://instructables.com/AutoBoot-Android-When-Charger-Connected

## 14. Android 17 platform facts, measured on the tablet (2026-11-22)

Setup: LineageOS 24.0 (Android 17), DashPad 0.2.0 with `targetSdk 36`, a normal install (no Device Owner, no device admin). Power changes were simulated with `adb shell dumpsys battery unplug`, `set level` and `reset`. Screen state was read with `adb shell dumpsys power`.

| # | Platform fact | Source | Reading on the tablet |
|---|---|---|---|
| V1 | Target 36 on Android 16+: "`onBackPressed` is not called and `KeyEvent.KEYCODE_BACK` is not dispatched anymore". Register an `OnBackInvokedCallback` in `onCreate`. | [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16) [confirmed] | `input keyevent KEYCODE_BACK` reaches the DashPad callback. Panel open → the panel closes. Panel closed → DashPad stays the top resumed activity. |
| V2 | `ACQUIRE_CAUSES_WAKEUP` is deprecated since API 33: "This flag will require TURN_SCREEN_ON in future releases." | [PowerManager](https://developer.android.com/reference/android/os/PowerManager) [confirmed] | `appops get com.dashpad TURN_SCREEN_ON`: before the run "No operations. Default mode: default"; after it "TURN_SCREEN_ON: default; rejectTime=…". At the moment of that rejection `PowerManagerService` logs "Allowing device wake-up without android.permission.TURN_SCREEN_ON for com.dashpad". So on this build the op records a rejection but does not enforce it, and the `dashpad:wake` `ACQUIRE_CAUSES_WAKEUP` wake lock wakes the screen. A replug after a 30 min sleep (`Dozing`): `power connected` → `wake: interactive=true` 3 s later → DashPad top resumed; the op logged a rejection 4.7 s before the read. |
| V3 | A start from the background needs an exception; the first one is "The app has a visible window". A blocked start logs "Background activity launch blocked!". Consequence for a normal install: the `BootReceiver` start after a boot or an APK update is blocked silently; the wall shows the LineageOS launcher (after a boot also the lock screen) until someone taps DashPad. Only a Device Owner or the default HOME app starts there (Phase 5). | [Background activity starts](https://developer.android.com/guide/components/activities/background-starts) [confirmed]; AOSP `BackgroundActivityStartController` [confirmed]. The boot/update start is from these sources, not measured | On both replugs from `Dozing`, the backup `startActivity` in `Power.wake()` logs `Background activity launch blocked!` and `(BAL_BLOCK)`, `callingUidProcState: TOP_SLEEPING`. DashPad was the top resumed activity anyway. The call stays as a harmless backup (decision 2026-11-22). |
| V4 | `DevicePolicyManager.lockNow()`: "The calling device admin must have requested USES_POLICY_FORCE_LOCK … if it has not, a security exception will be thrown." | [DevicePolicyManager](https://developer.android.com/reference/android/app/admin/DevicePolicyManager) [confirmed]; [AOSP commit on the `lockNow` permission](https://gitlab.e.foundation/e/os/android_frameworks_base/-/commit/931043d12e587a67059b8ebd7b33050c14dfe440) [community] | No admin: `Kiosk.screenOff()` returns false, the log says `lockNow=false`. With an active admin (provisioning step P1): not measured. |
| V5 | `dumpsys battery unplug` sets the chargers offline and stops real updates until `reset`. The plug change sends `ACTION_POWER_DISCONNECTED`; `reset` sends `ACTION_POWER_CONNECTED`. | [AOSP `BatteryService.java`](https://raw.githubusercontent.com/aosp-mirror/platform_frameworks_base/main/services/core/java/com/android/server/BatteryService.java) [confirmed] | Both broadcasts reach the DashPad dynamic receiver (`power lost`, `power connected` log lines), also in a series of 4 changes in 4 s. A test must always end with `dumpsys battery reset`. |
| V6 | Target 36 on sw ≥ 600 dp: the platform ignores `screenOrientation`, `sensorLandscape` included. Opt-out: `android.window.PROPERTY_COMPAT_ALLOW_RESTRICTED_RESIZABILITY` (ignored when targeting 37). | [Android 16 behavior changes](https://developer.android.com/about/versions/16/behavior-changes-16) [confirmed] | sw = 800 dp, so the rule applies. `dumpsys window`: `mCurrentRotation=ROTATION_90` (landscape), `mUserRotationMode=USER_ROTATION_FREE`. DashPad sets no opt-out. |
| V7 | LineageOS «Wake on plug» is the `LineageSettings.Global` key `wake_when_plugged_or_unplugged`; its default comes from `config_unplugTurnsOnScreen`. No official LineageOS doc found. | [lineage-sdk commit (mirror)](https://gitlab.e.foundation/e/os/android_lineage-sdk/-/commit/318e3c941b51dd2c5f71ee01e915a127ec54d5f6) [community] | `content query --uri content://lineagesettings/global --where "name='wake_when_plugged_or_unplugged'"` returns no row, so the default applies (its value is not read). The screen woke on replug with no change to this setting. |

**Screen-off below the battery threshold, normal mode.** DashPad clears `FLAG_KEEP_SCREEN_ON`; the system timeout then turns the screen off. On this tablet `mScreenOffTimeoutSetting=1800000` (30 min). Measured at level 25 % with the threshold at 30 %:
- the line `SCREEN_BRIGHT_WAKE_LOCK 'WindowManager/displayId:0' … ws=WorkSource{… com.dashpad}` disappears from `dumpsys power`;
- it stays absent after `input keyevent KEYCODE_WAKEUP`;
- positive control: the same line is present while unplugged above the threshold;
- with no touch after the unplug, `mWakefulness` stayed `Awake` at every minute poll for 29 min and read `Dozing` 30 min after the unplug. The timeout counts from the unplug event: the unplug counts as user activity. The level was already below the threshold at the unplug, so this measures the timeout, not a real outage. In a real outage the level crosses the threshold hours after the unplug, when the timeout has usually elapsed (no touch in the last 30 min); the screen then turns off at about the crossing [inferred, not measured].

**Lock screen under DashPad.** After any screen-off, the Android swipe lock screen (no PIN set) sits under DashPad; DashPad shows over it. «Змінити мережу» (the system Wi-Fi panel) then shows the lock screen; one swipe dismisses it. Fix without code: set the Android screen lock to "None"; a Device Owner disables it with `setKeyguardDisabled` (Phase 5).

**Screen rotation under the kiosk (measured on the tablet 2026-11-23, lying flat).** The display ignores `sensorLandscape` (V6, Android 16+): it has `ignoreOrientationRequest=true`, so the rotation follows the sensor. Upright, either mount side should give landscape [inferred from the AOSP sensor rotation path, not measured: confirm by standing the tablet upright]. Lying flat, the display keeps the last rotation; after a boot that is `ROTATION_0` (portrait). `wm set-ignore-orientation-request false` does not survive a reboot on this LineageOS 24 build, so it is no fix. A Device Owner cannot set the rotation: `setSystemSetting` allows only the brightness and screen-timeout keys [confirmed, [DevicePolicyManager](https://developer.android.com/reference/android/app/admin/DevicePolicyManager)]. Decision (2026-11-23): keep the system auto-rotation.
