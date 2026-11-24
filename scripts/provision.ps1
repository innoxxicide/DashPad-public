<#
.SYNOPSIS
  Provision the DashPad wall tablet as a Device Owner kiosk over adb (USB).

.DESCRIPTION
  Steps, each one: read -> act only if needed -> read back -> OK / SKIP / FAIL.
    0  exactly one adb device
    1  read-only pre-checks (the whole of -PreCheckOnly)
    2  install the debug APK with -r -t and check the TEST_ONLY flag, only when
       com.dashpad is missing, -SetDeviceOwner needs TEST_ONLY, or -Install is given
    3  adb keys never expire (adb_allowed_connection_time = 0)
    4  P2 fine location + location on, P3 TURN_SCREEN_ON, P4 WRITE_SECURE_SETTINGS
    5  -Configure: P0 dashboard URL (from publisher.json) and the service PIN
    6  -SetDeviceOwner: dpm set-device-owner after a typed confirmation, then wake,
       force-stop and a HOME start (one MainActivity, in the home task)
    7  verify (whenever DashPad is the device owner), one MainActivity record in a home task included
    8  -DisableLauncher3: only after the verify passed

  Every install needs -t: the debug APK is testOnly.
  Keep %USERPROFILE%\.android\debug.keystore backed up outside git: the Device
  Owner app can only be updated with an APK signed by that key.

  Undo: docs/setup-ru.md, section 10 (leaving the kiosk).
  This script never runs them.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -PreCheckOnly
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -Install
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -Configure
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -Configure -Pin <digits>
  Test PINs only: the value lands in the PowerShell history. Omit -Pin for the hidden prompt.
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -SetDeviceOwner -ConfirmDeviceOwner com.dashpad/.AdminReceiver
.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts\provision.ps1 -DisableLauncher3
#>
[CmdletBinding()]
param(
    [switch]$PreCheckOnly,
    [switch]$Install,
    [switch]$Configure,
    [string]$Pin,
    [switch]$SetDeviceOwner,
    [string]$ConfirmDeviceOwner,
    [switch]$DisableLauncher3,
    [string]$Apk
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

$Pkg = 'com.dashpad'
$Admin = 'com.dashpad/.AdminReceiver'
$HomeActivity = 'com.dashpad/.MainActivity'
$Launcher3 = 'com.android.launcher3'
if (-not $Apk) { $Apk = Join-Path $PSScriptRoot '..\android\app\build\outputs\apk\debug\app-debug.apk' }

function Fail([string]$msg) {
    Write-Host "FAIL: $msg"
    exit 1
}

function Get-LastLine([string]$text) {
    $lines = @($text -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($lines.Count -eq 0) { return '' }
    return $lines[-1]
}

function Find-Adb {
    $cmd = Get-Command adb -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
    $candidates = @(
        "$env:LOCALAPPDATA\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe",
        "$env:LOCALAPPDATA\Android\Sdk\platform-tools\adb.exe")
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    Fail 'adb not found on PATH, in WinGet platform-tools or in the Android SDK'
}

function Invoke-Adb([string[]]$a, [string]$stdin) {
    # Local Continue: under Stop, native stderr merged by 2>&1 becomes a terminating error.
    $ErrorActionPreference = 'Continue'
    if ($stdin) { $lines = @($stdin | & $script:AdbExe @a 2>&1 | ForEach-Object { "$_" }) }
    else { $lines = @(& $script:AdbExe @a 2>&1 | ForEach-Object { "$_" }) }
    $code = $LASTEXITCODE
    return [pscustomobject]@{ Text = ($lines -join "`n"); Code = $code }
}

function Read-Adb([string]$what, [string[]]$a) {
    $r = Invoke-Adb $a
    if ($r.Code -ne 0) { Fail "$what (adb exit $($r.Code)): $(Get-LastLine $r.Text)" }
    return $r.Text
}

function Assert-Arguments {
    if ($PreCheckOnly -and ($Install -or $Configure -or $SetDeviceOwner -or $DisableLauncher3)) { Fail '-PreCheckOnly cannot be combined with other switches' }
    if ($SetDeviceOwner -and $DisableLauncher3) { Fail '-SetDeviceOwner and -DisableLauncher3 refused in one run: the developer decided (2026-11-23) to disable launcher3 only after a reboot showed the dashboard by itself' }
    if ($Pin -and -not $Configure) { Fail '-Pin needs -Configure' }
    if ($ConfirmDeviceOwner -and -not $SetDeviceOwner) { Fail '-ConfirmDeviceOwner needs -SetDeviceOwner' }
}

function Assert-OneDevice {
    $t = Read-Adb 'adb devices' @('devices')
    $n = [regex]::Matches($t, '(?m)^\S+\s+device\s*$').Count
    if ($n -ne 1) { Fail "adb devices lists $n ready devices; exactly 1 is needed" }
    Write-Host '0 adb: OK (1 device)'
}

function Get-Owner {
    # AOSP prints "no owners" or one "User N: admin=<component>,DeviceOwner|ProfileOwner" line per owner.
    $t = Read-Adb 'dpm list-owners' @('shell', 'dpm', 'list-owners')
    $owner = Get-Match $t '(?m)^\s*User\s+\d+:\s*admin=([^,\s]+)[^\r\n]*DeviceOwner'
    if ($owner) { return $owner }
    if ($t -match '(?m)^\s*(no owners|User\s+\d+:\s*admin=)') { return '' }
    Fail "dpm list-owners: unreadable answer: $(Get-LastLine $t)"
}

function Get-AdminState {
    $t = Read-Adb 'dumpsys device_policy' @('shell', 'dumpsys', 'device_policy')
    if ($t -notmatch 'Enabled Device Admins') { return @{ Active = $false; TestOnly = ''; Unreadable = $true } }
    $m = [regex]::Match($t, '(?m)^\s*' + [regex]::Escape($Admin) + ':\s*$')
    if (-not $m.Success) { return @{ Active = $false; TestOnly = ''; Unreadable = $false } }
    return @{ Active = $true; TestOnly = Get-Match ($t.Substring($m.Index + $m.Length)) 'testOnlyAdmin=(\w+)'; Unreadable = $false }
}

function Get-Match([string]$text, [string]$pattern) {
    $m = [regex]::Match($text, $pattern)
    if ($m.Success) { return $m.Groups[1].Value.Trim() }
    return ''
}

function Get-PackageState {
    $t = Read-Adb 'dumpsys package' @('shell', 'dumpsys', 'package', $Pkg)
    return @{
        VersionCode    = Get-Match $t 'versionCode=(\d+)'
        VersionName    = Get-Match $t 'versionName=(\S+)'
        TestOnly       = (Get-Match $t '(?m)^\s*flags=\[([^\]]*)\]') -match '\bTEST_ONLY\b'
        LastUpdate     = Get-Match $t 'lastUpdateTime=([^\r\n]+)'
        FineLocation   = $t -match 'ACCESS_FINE_LOCATION: granted=true'
        SecureSettings = $t -match 'WRITE_SECURE_SETTINGS: granted=true'
    }
}

function Get-HomeActivity {
    $a = @('shell', 'cmd', 'package', 'resolve-activity', '--brief', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME')
    return Get-LastLine (Read-Adb 'resolve HOME' $a)
}

function Get-LockState {
    return Get-Match (Read-Adb 'dumpsys activity' @('shell', 'dumpsys', 'activity', 'activities')) 'mLockTaskModeState=(\w+)'
}

function Get-DeviceState {
    $acc = Read-Adb 'dumpsys account' @('shell', 'dumpsys', 'account')
    $n = 0
    foreach ($m in [regex]::Matches($acc, 'Accounts:\s*(\d+)')) { $n += [int]$m.Groups[1].Value }
    $pk = Read-Adb 'pm list packages' @('shell', 'pm', 'list', 'packages', $Pkg)
    return @{
        Users    = [regex]::Matches((Read-Adb 'pm list users' @('shell', 'pm', 'list', 'users')), 'UserInfo\{').Count
        Accounts = $n
        Owner    = Get-Owner
        Admin    = Get-AdminState
        Package  = Get-PackageState
        Spike    = $pk -match '(?m)^package:com\.dashpad\.spike\s*$'
        Home     = Get-HomeActivity
        AdbTime  = (Read-Adb 'settings get' @('shell', 'settings', 'get', 'global', 'adb_allowed_connection_time')).Trim()
        Lock     = Get-LockState
    }
}

function Get-OwnerBlockers($s) {
    $b = @()
    if ($s.Owner -and $s.Owner -ne $Admin) { $b += "another device owner: $($s.Owner)" }
    if ($s.Users -ne 1) { $b += "$($s.Users) users (needs 1)" }
    if ($s.Accounts -ne 0) { $b += "$($s.Accounts) accounts (needs 0)" }
    if ($s.Admin.Unreadable) { $b += 'device_policy dump unreadable' }
    if (-not $s.Package.TestOnly) { $b += 'installed com.dashpad lacks TEST_ONLY (the install step adds it)' }
    # testOnlyAdmin is captured at the first activation and kept by later updates (AOSP setActiveAdmin).
    if ($s.Admin.Active -and $s.Owner -ne $Admin) { $b += 'com.dashpad is already an active admin: its testOnlyAdmin flag would never change' }
    return ,$b
}

function Show-PreChecks($s) {
    $model = (Read-Adb 'getprop' @('shell', 'getprop', 'ro.product.model')).Trim()
    $release = (Read-Adb 'getprop' @('shell', 'getprop', 'ro.build.version.release')).Trim()
    $p = $s.Package
    $owner = if ($s.Owner) { $s.Owner } else { 'none' }
    $adminText = if ($s.Admin.Active) { "yes (testOnlyAdmin=$($s.Admin.TestOnly))" } else { 'no' }
    $spike = if ($s.Spike) { 'present' } else { 'ABSENT' }
    Write-Host "1 device: $model, Android $release"
    Write-Host "1 users: $($s.Users); accounts: $($s.Accounts); device owner: $owner"
    Write-Host "1 com.dashpad active admin: $adminText"
    Write-Host "1 com.dashpad: versionCode $($p.VersionCode) ($($p.VersionName)), TEST_ONLY $($p.TestOnly), lastUpdateTime $($p.LastUpdate)"
    Write-Host "1 com.dashpad.spike: $spike"
    Write-Host "1 HOME: $($s.Home)"
    Write-Host "1 adb_allowed_connection_time: $($s.AdbTime)"
    Write-Host "1 lock task: $($s.Lock)"
    $b = Get-OwnerBlockers $s
    if ($s.Owner -eq $Admin) { Write-Host '1 set-device-owner: already done' }
    elseif ($b.Count -eq 0) { Write-Host '1 set-device-owner: READY' }
    else { Write-Host "1 set-device-owner: BLOCKED ($($b -join '; '))" }
}

function Get-InstallReason($s) {
    if ($Install) { return '-Install given' }
    if (-not $s.Package.VersionCode) { return 'com.dashpad is missing' }
    if ($SetDeviceOwner -and $s.Owner -ne $Admin -and -not $s.Package.TestOnly) { return '-SetDeviceOwner needs TEST_ONLY' }
    return ''
}

function Install-Apk {
    if (-not (Test-Path -LiteralPath $Apk -PathType Leaf)) { Fail "APK not found: $Apk" }
    $r = Invoke-Adb @('install', '-r', '-t', $Apk)
    if ($r.Code -ne 0 -or $r.Text -notmatch '(?m)^Success') { Fail "adb install -r -t: $(Get-LastLine $r.Text)" }
    $p = Get-PackageState
    if (-not $p.TestOnly) { Fail 'the installed APK lacks the TEST_ONLY flag: install the debug build' }
    Write-Host "2 install: OK (versionCode $($p.VersionCode), TEST_ONLY)"
}

function Set-Step([string]$name, [scriptblock]$isDone, [string[]]$act) {
    if (& $isDone) { Write-Host "${name}: SKIP (already)"; return }
    Read-Adb $name $act | Out-Null
    if (-not (& $isDone)) { Fail "$name did not read back" }
    Write-Host "${name}: OK"
}

function Set-DevicePrerequisites {
    Set-Step '3 adb key never expires' { (Read-Adb 'settings get' @('shell', 'settings', 'get', 'global', 'adb_allowed_connection_time')).Trim() -eq '0' } @('shell', 'settings', 'put', 'global', 'adb_allowed_connection_time', '0')
    Set-Step '4 P2 fine location grant' { (Get-PackageState).FineLocation } @('shell', 'pm', 'grant', $Pkg, 'android.permission.ACCESS_FINE_LOCATION')
    Set-Step '4 P2 location on' { (Read-Adb 'location' @('shell', 'cmd', 'location', 'is-location-enabled')).Trim() -eq 'true' } @('shell', 'cmd', 'location', 'set-location-enabled', 'true')
    Set-Step '4 P3 TURN_SCREEN_ON allow' { (Read-Adb 'appops get' @('shell', 'appops', 'get', $Pkg, 'TURN_SCREEN_ON')) -match 'TURN_SCREEN_ON: allow' } @('shell', 'appops', 'set', $Pkg, 'TURN_SCREEN_ON', 'allow')
    Set-Step '4 P4 WRITE_SECURE_SETTINGS grant' { (Get-PackageState).SecureSettings } @('shell', 'pm', 'grant', $Pkg, 'android.permission.WRITE_SECURE_SETTINGS')
}

function Get-DashboardUrl {
    $f = Join-Path $env:USERPROFILE '.dashpad\publisher.json'
    if (-not (Test-Path -LiteralPath $f)) { Fail 'missing %USERPROFILE%\.dashpad\publisher.json' }
    try { $j = Get-Content -LiteralPath $f -Raw -Encoding UTF8 | ConvertFrom-Json } catch { Fail 'publisher.json is not valid JSON' }
    $url = ''
    $key = ''
    if ($j.PSObject.Properties['url']) { $url = ([string]$j.url).TrimEnd('/') }
    if ($j.PSObject.Properties['readKey']) { $key = [string]$j.readKey }
    if ($url -notmatch '^https://[A-Za-z0-9.-]+(:[0-9]+)?(/[A-Za-z0-9._~/-]*)?$') { Fail 'publisher.json field url is missing or not a plain https URL' }
    if ($key -notmatch '^[A-Za-z0-9._~-]+$') { Fail 'publisher.json field readKey is missing or has characters unsafe for adb shell' }
    return "$url/?k=$key"
}

function Get-ServicePin {
    $p = $Pin
    if (-not $p) {
        $sec = Read-Host -AsSecureString 'Service PIN (4+ digits, not shown)'
        $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)
        try { $p = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }
    }
    if ($p -notmatch '^[0-9]{4,}$') { Fail 'the PIN must be at least 4 digits' }
    return $p
}

function Wait-ExtrasLog([string]$since) {
    for ($i = 0; $i -lt 10; $i++) {
        Start-Sleep -Seconds 1
        $t = (Invoke-Adb @('logcat', '-d', '-t', "$since.0", '-s', 'DashPad:I')).Text
        $m = [regex]::Matches($t, 'extras (accepted|refused)[^\r\n]*')
        if ($m.Count -gt 0) { return $m[$m.Count - 1].Value.Trim() }
    }
    return 'no extras line within 10 s; read adb logcat -d -s DashPad:I'
}

function Test-HomeForm {
    return ((Get-Owner) -eq $Admin) -or ((Get-HomeActivity) -like "$Pkg/*")
}

function Get-StartCommand([string]$extras) {
    # While DashPad is HOME its record sits in the home task; an explicit component would add a second instance.
    $parts = @('am', 'start')
    $homeForm = Test-HomeForm
    if ($homeForm) { $parts += @('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.HOME') } else { $parts += @('-n', $HomeActivity) }
    if ($extras) { $parts += $extras }
    if ($homeForm) { $parts += $Pkg }
    return $parts -join ' '
}

function Invoke-Configure {
    $url = Get-DashboardUrl
    $pin = Get-ServicePin
    $since = (Read-Adb 'device time' @('shell', 'date', '+%s')).Trim()
    Invoke-WakeScreen
    if (Test-HomeForm) { Stop-StrayInstance | Out-Null }
    # Via stdin: adbd logs a shell argument line to logcat, which would expose the key and PIN.
    # Single quotes keep ? and & literal; the trailing # swallows the CR PowerShell appends.
    $r = Invoke-Adb @('shell') "$(Get-StartCommand "--es url '$url' --es pin $pin"); exit #"
    if ($r.Code -ne 0 -or $r.Text -match 'Error') { Fail "P0 am start failed (adb exit $($r.Code); output withheld: it may carry the URL)" }
    Write-Host '5 P0 sent'
    $result = Wait-ExtrasLog $since
    if ($result -ne 'extras accepted') { Fail "P0: $result" }
    Write-Host "5 P0 app log: $result"
}

function Invoke-WakeScreen {
    Read-Adb 'wake' @('shell', 'input', 'keyevent', 'KEYCODE_WAKEUP') | Out-Null
    Read-Adb 'dismiss keyguard' @('shell', 'wm', 'dismiss-keyguard') | Out-Null
}

function Get-Instances {
    $t = Read-Adb 'dumpsys activity' @('shell', 'dumpsys', 'activity', 'activities')
    $types = @{}
    foreach ($m in [regex]::Matches($t, 'Task\{[0-9a-f]+ #(\d+) type=(\w+)')) { $types[$m.Groups[1].Value] = $m.Groups[2].Value }
    if ($types.Count -eq 0) { Fail 'dumpsys activity: no Task lines to read the MainActivity tasks from' }
    $tasks = @{}
    foreach ($m in [regex]::Matches($t, 'ActivityRecord\{([0-9a-f]+) u0 com\.dashpad/\.MainActivity(?: t(\d+))?')) {
        if (-not $tasks.ContainsKey($m.Groups[1].Value) -or $m.Groups[2].Success) { $tasks[$m.Groups[1].Value] = $m.Groups[2].Value }
    }
    $inHome = @($tasks.Values | Where-Object { $_ -and $types[$_] -eq 'home' }).Count
    return @{ Count = $tasks.Count; Home = $inHome }
}

function Stop-StrayInstance {
    # A record outside the home task (pre-owner, or an explicit start) would stay beside the HOME start's one.
    $i = Get-Instances
    if ($i.Count -gt $i.Home -or $i.Count -gt 1) { Read-Adb 'force-stop' @('shell', 'am', 'force-stop', $Pkg) | Out-Null }
    return $i
}

function Show-DashPad {
    Invoke-WakeScreen
    $i = Stop-StrayInstance
    Read-Adb 'am start' (@('shell') + ((Get-StartCommand '') -split ' ')) | Out-Null
    return $i
}

function Invoke-SetDeviceOwner {
    $s = Get-DeviceState
    if ($s.Owner -eq $Admin) {
        $i = Show-DashPad
        Write-Host "6 device owner: SKIP (already $Admin; MainActivity records before: $($i.Count), in a home task: $($i.Home))"
        return
    }
    $b = Get-OwnerBlockers $s
    if ($b.Count -gt 0) { Fail "set-device-owner refused: $($b -join '; ')" }
    $c = $ConfirmDeviceOwner
    if (-not $c) { $c = Read-Host "Type $Admin to confirm dpm set-device-owner" }
    if ($c -cne $Admin) { Fail 'the confirmation did not match; nothing changed' }
    $r = Invoke-Adb @('shell', 'dpm', 'set-device-owner', $Admin)
    if ($r.Code -ne 0 -or $r.Text -notmatch 'Success') { Fail "dpm set-device-owner: $(Get-LastLine $r.Text)" }
    Show-DashPad | Out-Null
    Write-Host '6 device owner: OK'
    Write-Host "6 undo (not run): adb shell dpm remove-active-admin $Admin"
}

function Wait-Locked {
    for ($i = 0; $i -lt 15; $i++) {
        $l = Get-LockState
        if ($l -eq 'LOCKED') { return $l }
        Start-Sleep -Seconds 1
    }
    return $l
}

function Wait-SingleInstance {
    # After an install the replaced task's finishing record stays listed for about 2 s.
    $reads = 0
    do {
        if ($reads -gt 0) { Start-Sleep -Seconds 1 }
        $i = Get-Instances
        $reads++
    } while (-not ($i.Count -eq 1 -and $i.Home -eq 1) -and $reads -lt 11)
    return @{ Count = $i.Count; Home = $i.Home; Reads = $reads }
}

function Test-Kiosk {
    $w = Wait-SingleInstance
    $checks = [ordered]@{
        "one MainActivity record, in a home task (count $($w.Count), in home $($w.Home), reads $($w.Reads))" = ($w.Count -eq 1 -and $w.Home -eq 1)
        'owner is com.dashpad'   = ((Get-Owner) -eq $Admin)
        'testOnlyAdmin=true'     = ((Get-AdminState).TestOnly -eq 'true')
        'HOME is DashPad'        = ((Get-HomeActivity) -eq $HomeActivity)
        'lock task LOCKED'       = ((Wait-Locked) -eq 'LOCKED')
    }
    $failed = @($checks.Keys | Where-Object { -not $checks[$_] })
    foreach ($k in $checks.Keys) { if ($checks[$k]) { Write-Host "7 verify ${k}: PASS" } else { Write-Host "7 verify ${k}: FAIL" } }
    if ($failed.Count -gt 0) { Fail "verify: $($failed -join '; ')" }
}

function Test-Launcher3Disabled {
    return (Read-Adb 'pm list packages -d' @('shell', 'pm', 'list', 'packages', '-d')) -match ('(?m)^package:' + [regex]::Escape($Launcher3) + '\s*$')
}

function Disable-Launcher3 {
    if (Test-Launcher3Disabled) { Write-Host '8 launcher3: SKIP (already disabled)'; return }
    if ((Get-HomeActivity) -ne $HomeActivity) { Fail "HOME is not DashPad; $Launcher3 stays enabled" }
    Read-Adb 'pm disable-user' @('shell', 'pm', 'disable-user', '--user', '0', $Launcher3) | Out-Null
    if (-not (Test-Launcher3Disabled)) { Fail "$Launcher3 is not in pm list packages -d" }
    if ((Get-HomeActivity) -ne $HomeActivity) { Fail 'HOME is no longer DashPad after the disable' }
    Write-Host '8 launcher3: OK (disabled; HOME is still DashPad)'
    Write-Host "8 undo (not run): adb shell pm enable $Launcher3"
}

Assert-Arguments
$script:AdbExe = Find-Adb
Assert-OneDevice
$state = Get-DeviceState
Show-PreChecks $state
if ($PreCheckOnly) { Write-Host 'pre-check only: nothing changed'; exit 0 }

$reason = Get-InstallReason $state
if ($reason) { Write-Host "2 install: $reason"; Install-Apk }
else { Write-Host "2 install: SKIP (installed versionCode $($state.Package.VersionCode); -Install reinstalls)" }
Set-DevicePrerequisites
if ($Configure) { Invoke-Configure }
if ($SetDeviceOwner) { Invoke-SetDeviceOwner }
$isOwner = (Get-Owner) -eq $Admin
if ($isOwner) { Test-Kiosk } else { Write-Host '7 verify: SKIP (DashPad is not the device owner)' }
if ($DisableLauncher3) {
    if (-not $isOwner) { Fail '-DisableLauncher3 refused: DashPad is not the device owner' }
    Disable-Launcher3
}
Write-Host 'done'
exit 0
