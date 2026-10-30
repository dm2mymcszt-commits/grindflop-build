<#
.SYNOPSIS
    Registers GrindFlop's AppUserModelID so Windows toasts show the app's own
    name and icon instead of "Windows PowerShell".

.DESCRIPTION
    The app now writes this registration itself every time it starts (see
    src-tauri/src/toast_identity.rs), so nobody has to run this script for
    notifications to work. It stays for taking the registration away again
    (-Unregister) and for trying another name or icon by hand.

    A Windows toast carries no app identity of its own — it carries an
    AppUserModelID (AUMID), and the shell looks that AUMID up to decide which
    name and icon to paint on the notification.

    Installed builds get their AUMID registered by the NSIS/MSI installer, via a
    Start Menu shortcut stamped with System.AppUserModel.ID. A build run straight
    out of src-tauri\target\release has no such shortcut, so upstream's
    notification plugin declines to set an AUMID at all (an unresolvable one makes
    Windows drop the toast silently) and the underlying crate falls back to its
    default: PowerShell's AUMID. Hence "Windows PowerShell" on every toast.

    src-tauri\notification-patched\src\desktop.rs is patched to always set our own
    AUMID. This script supplies the other half — the registration that makes that
    AUMID resolve — by writing the documented shell keys under
    HKCU:\Software\Classes\AppUserModelId\<aumid>.

    Run once per machine. Per-user (HKCU), so no admin rights needed. Toasts sent
    before this is run will not appear at all, since Windows cannot resolve the ID.

.PARAMETER Aumid
    The AppUserModelID to register. Must match "identifier" in
    src-tauri\tauri.conf.json, which is what the plugin stamps on the toast.

.PARAMETER DisplayName
    The name shown on the toast and in Settings > Notifications.

.PARAMETER IconPath
    Image the toast displays as the app icon. PNG is the safest choice; the shell
    is inconsistent about .ico here.

.PARAMETER Unregister
    Remove the registration instead of creating it.

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\register-toast-aumid.ps1

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts\register-toast-aumid.ps1 -Unregister
#>
[CmdletBinding()]
param(
    [string]$Aumid = 'dev.estopia.free-grind',
    [string]$DisplayName = 'GrindFlop',
    [string]$IconPath,
    [switch]$Unregister
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$key = "HKCU:\Software\Classes\AppUserModelId\$Aumid"

if ($Unregister) {
    if (Test-Path $key) {
        Remove-Item -Path $key -Recurse -Force
        Write-Host "Unregistered AUMID '$Aumid'."
    } else {
        Write-Host "AUMID '$Aumid' was not registered; nothing to do."
    }
    Write-Host 'Restart GrindFlop for the change to take effect.'
    return
}

if (-not $IconPath) {
    $IconPath = Join-Path $repoRoot 'src-tauri\icons\128x128.png'
}

# The shell reads this path at notification time, not now, so it has to be
# absolute and has to survive past this script.
$IconPath = [System.IO.Path]::GetFullPath($IconPath)
if (-not (Test-Path -LiteralPath $IconPath)) {
    throw "Icon not found: $IconPath"
}

if (-not (Test-Path $key)) {
    New-Item -Path $key -Force | Out-Null
}

New-ItemProperty -Path $key -Name 'DisplayName'     -Value $DisplayName -PropertyType String -Force | Out-Null
New-ItemProperty -Path $key -Name 'IconUri'         -Value $IconPath    -PropertyType String -Force | Out-Null
# Without this the app never appears under Settings > System > Notifications,
# which is also where per-app toast settings live.
New-ItemProperty -Path $key -Name 'ShowInSettings'  -Value 1            -PropertyType DWord  -Force | Out-Null

Write-Host "Registered AUMID '$Aumid'"
Write-Host "  DisplayName : $DisplayName"
Write-Host "  IconUri     : $IconPath"
Write-Host ''
Write-Host 'Rebuild and restart GrindFlop, then trigger an auto-block to check the toast.'
