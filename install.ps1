<#
.SYNOPSIS
    Builds TorrentFlow from this checkout and installs (or updates) the Windows desktop app in one step.

.DESCRIPTION
    Checks prerequisites, builds the web UI + single-file exe + per-user installer, detects an existing install and
    asks before installing or updating, stops a running TorrentFlow gracefully, installs silently and relaunches it
    in the tray. If you have been using .\run.ps1, it offers to move that library (server\TorrentFlow.Api\data, or <repo>\data) into the installed
    app. Nothing is deleted: the old folder is renamed to data.migrated-<timestamp>.

.EXAMPLE
    .\install.ps1
.EXAMPLE
    .\install.ps1 -Yes      # accept every default without prompting
#>
[CmdletBinding()]
param(
    # Answer every prompt with its default (install/update: yes; move a run.ps1 library: yes; keep the installed library).
    [switch]$Yes,
    # Install folder. Defaults to the existing install's folder, else %LOCALAPPDATA%\Programs\TorrentFlow.
    [string]$InstallDir = '',
    # The installed app's data folder. Defaults to TorrentFlow__DataDirectory, else %LOCALAPPDATA%\TorrentFlow.
    [string]$DataDir = '',
    # The run.ps1 library to offer to move. Defaults to the newer of server\TorrentFlow.Api\data and <repo>\data.
    [string]$LegacyDataDir = '',
    # Version to stamp. Defaults to <latest v* tag or 0.0.0>+<git short sha>.
    [string]$Version = '',
    # Reuse artifacts\exe from a previous build instead of building again.
    [switch]$SkipBuild,
    # Copy the exe and create the Start-menu shortcut instead of using Inno Setup.
    [switch]$NoInnoSetup
)

$ErrorActionPreference = 'Stop'
$AppId = '{6F1B9E2A-4C57-4E8B-9D3A-7A2C5B1E0F42}'
$UninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\${AppId}_is1"
$RepoRoot = $PSScriptRoot
$ArtifactDir = Join-Path $RepoRoot 'artifacts\exe'
$BuiltExe = Join-Path $ArtifactDir 'TorrentFlow.exe'

function Write-Step([string]$Text) { Write-Host "==> $Text" -ForegroundColor Cyan }

# install.cmd double-clicked from Explorer opens a console that would vanish with the result; keep it open.
$PauseAtEnd = $false
if ($env:TORRENTFLOW_INSTALL_CMD -eq '1') {
    try {
        $cmdPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $PID").ParentProcessId
        $launcherPid = (Get-CimInstance Win32_Process -Filter "ProcessId = $cmdPid").ParentProcessId
        $PauseAtEnd = (Get-Process -Id $launcherPid -ErrorAction Stop).ProcessName -eq 'explorer'
    }
    catch { }
}

function Exit-Install([int]$Code) {
    if ($PauseAtEnd) { Write-Host 'Press Enter to close.' -NoNewline; [void](Read-Host) }
    exit $Code
}

trap {
    Write-Host "Install failed: $($_.Exception.Message)" -ForegroundColor Red
    Exit-Install 1
}

function Confirm-Choice([string]$Question) {
    if ($Yes) { Write-Host "$Question [Y/n] y (-Yes)"; return $true }
    while ($true) {
        Write-Host "$Question [Y/n] " -NoNewline
        $answer = "$(Read-Host)".Trim().ToLowerInvariant()
        if ($answer -in @('', 'y', 'yes')) { return $true }
        if ($answer -in @('n', 'no')) { return $false }
    }
}

function Stop-Fail([string]$Text) {
    Write-Host $Text -ForegroundColor Red
    Exit-Install 1
}

function Find-Iscc {
    $cmd = Get-Command iscc -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $candidates = @(
        (Join-Path $env:LOCALAPPDATA 'Programs\Inno Setup 6\ISCC.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Inno Setup 6\ISCC.exe'),
        (Join-Path $env:ProgramFiles 'Inno Setup 6\ISCC.exe'))
    return $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

function Get-BuildVersion {
    # Windows PowerShell turns a native command's stderr into a terminating error under 'Stop'.
    $ErrorActionPreference = 'Continue'
    if ($Version) { return $Version.TrimStart('v', 'V') }
    $base = '0.0.0'
    $git = Get-Command git -ErrorAction SilentlyContinue
    if (-not $git) { return $base }
    $tag = (& git -C $RepoRoot describe --tags --abbrev=0 --match 'v[0-9]*' 2>$null)
    if ($LASTEXITCODE -eq 0 -and $tag) { $base = "$tag".Trim().TrimStart('v', 'V') }
    $sha = (& git -C $RepoRoot rev-parse --short=7 HEAD 2>$null)
    if ($LASTEXITCODE -ne 0 -or -not $sha) { return $base }
    $dirty = (& git -C $RepoRoot status --porcelain --untracked-files=no 2>$null)
    $suffix = if ($dirty) { '.dirty' } else { '' }
    return "$base+$("$sha".Trim())$suffix"
}

function Get-ListenUrl {
    $urls = $env:ASPNETCORE_URLS
    if ($urls) { return ($urls -split ';')[0].Trim().TrimEnd('/') }
    return 'http://127.0.0.1:3000'
}

# Graceful first: taskkill without /F posts WM_CLOSE (the tray app shuts down cleanly, like its Quit item);
# a console dev server (run.ps1) ignores that, so it is force-stopped after the wait. SQLite's WAL keeps committed
# data safe either way.
function Stop-Processes([object[]]$Processes, [string]$What, [int]$TimeoutSeconds = 20) {
    $Processes = @($Processes | Where-Object { $_ })
    if ($Processes.Count -eq 0) { return }
    $ErrorActionPreference = 'Continue'
    Write-Step "Stopping $What (PID $(($Processes | ForEach-Object Id) -join ', '))"
    foreach ($p in $Processes) { & taskkill.exe /PID $p.Id 2>$null | Out-Null }
    $Processes | Wait-Process -Timeout $TimeoutSeconds -ErrorAction SilentlyContinue
    $left = @($Processes | Where-Object { -not $_.HasExited })
    if ($left.Count -gt 0) {
        Write-Host "    still running after ${TimeoutSeconds}s; stopping it."
        $left | Stop-Process -Force -ErrorAction SilentlyContinue
        $left | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
    }
}

function Get-InstalledAppProcesses([string]$Dir) {
    $exe = Join-Path $Dir 'TorrentFlow.exe'
    @(Get-Process -Name TorrentFlow -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path -ieq $exe) })
}

# run.ps1 = `dotnet run`, whose server is the TorrentFlow.exe apphost under server\TorrentFlow.Api\bin (dotnet run
# exits by itself once that stops).
function Get-DevServerProcesses {
    $root = Join-Path $RepoRoot 'server'
    @(Get-Process -Name TorrentFlow -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and $_.Path.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase) })
}

function Get-LibrarySummary([string]$Dir) {
    $db = Get-Item (Join-Path $Dir 'torrentflow.db') -ErrorAction SilentlyContinue
    $files = @(Get-ChildItem $Dir -Recurse -File -ErrorAction SilentlyContinue)
    $size = ($files | Measure-Object Length -Sum).Sum
    $last = ($files | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    "{0}  ({1} files, {2:N0} MB, last changed {3:yyyy-MM-dd HH:mm})" -f $Dir, $files.Count, ($size / 1MB), $(if ($last) { $last } else { $db.LastWriteTime })
}

function Invoke-Exe([string]$Exe, [string[]]$Arguments) {
    $out = [IO.Path]::GetTempFileName()
    try {
        # Double trailing backslashes so a path such as D:\ doesn't escape the closing quote.
        $quoted = $Arguments | ForEach-Object { '"' + (($_ -replace '"', '\"') -replace '(\\+)$', '$1$1') + '"' }
        $p = Start-Process -FilePath $Exe -ArgumentList $quoted -Wait -PassThru -NoNewWindow -RedirectStandardOutput $out
        Get-Content $out | ForEach-Object { Write-Host "    $_" }
        return $p.ExitCode
    }
    finally { Remove-Item $out -Force -ErrorAction SilentlyContinue }
}

function Test-Health([string]$Url, [int]$Seconds) {
    $deadline = (Get-Date).AddSeconds($Seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $r = Invoke-RestMethod -Uri "$Url/api/health" -TimeoutSec 3 -ErrorAction Stop
            if ($r.live -eq $true) { return $true }
        }
        catch { }
        Start-Sleep -Milliseconds 500
    }
    return $false
}

# --- 1. Prerequisites -------------------------------------------------------------------------------------------
Write-Step 'Checking prerequisites'
if (-not $SkipBuild) {
    $sdks = @()
    if (Get-Command dotnet -ErrorAction SilentlyContinue) { $sdks = @(& { $ErrorActionPreference = 'Continue'; dotnet --list-sdks 2>$null }) }
    if (-not ($sdks | Where-Object { $_ -match '^10\.' })) { Stop-Fail 'Missing the .NET 10 SDK. Install it with: winget install Microsoft.DotNet.SDK.10' }
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Stop-Fail 'Missing Node.js. Install it with: winget install OpenJS.NodeJS.LTS' }
    if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { Stop-Fail 'Missing pnpm. Install it with: npm install -g pnpm' }
}

$useInno = -not $NoInnoSetup
if ($useInno -and -not (Find-Iscc)) {
    Write-Step 'Inno Setup not found; installing it for this user (winget JRSoftware.InnoSetup)'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        & winget install --id JRSoftware.InnoSetup --exact --scope user --silent --accept-package-agreements --accept-source-agreements --disable-interactivity | Out-Host
    }
    if (-not (Find-Iscc)) {
        Write-Host '    Inno Setup could not be installed; TorrentFlow will be installed by copying files instead.' -ForegroundColor Yellow
        $useInno = $false
    }
}

# --- 2. Build ---------------------------------------------------------------------------------------------------
if ($SkipBuild) {
    if (-not (Test-Path $BuiltExe)) { Stop-Fail "No previous build at $BuiltExe. Run without -SkipBuild." }
    $newVersion = (Get-Item $BuiltExe).VersionInfo.ProductVersion
}
else {
    $newVersion = Get-BuildVersion
    Write-Step "Building TorrentFlow $newVersion (web UI, exe$(if ($useInno) { ', installer' }))"
    & (Join-Path $RepoRoot 'scripts\publish-exe.ps1') -Version $newVersion -Installer:$useInno
}
$setupExe = $null
if ($useInno) {
    # Only the installer built from this exe; an older setup in artifacts\exe would install a different version.
    $setupExe = Get-Item (Join-Path $ArtifactDir "TorrentFlow-Setup-$newVersion.exe") -ErrorAction SilentlyContinue
    if (-not $setupExe) {
        Write-Host "    No installer for $newVersion was found; installing by copying files instead." -ForegroundColor Yellow
        $useInno = $false
    }
}

# --- 3. Existing install ----------------------------------------------------------------------------------------
$installed = Get-ItemProperty $UninstallKey -ErrorAction SilentlyContinue
$installedDir = $null
$installedVersion = $null
if ($installed -and $installed.InstallLocation) {
    $installedDir = $installed.InstallLocation.TrimEnd('\')
    $installedVersion = $installed.DisplayVersion
}
if (-not $InstallDir) { $InstallDir = if ($installedDir) { $installedDir } else { Join-Path $env:LOCALAPPDATA 'Programs\TorrentFlow' } }
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
if (-not $installedDir -or ($installedDir -ine $InstallDir)) {
    $exeInDir = Join-Path $InstallDir 'TorrentFlow.exe'
    if (Test-Path $exeInDir) {
        $installedDir = $InstallDir
        $installedVersion = (Get-Item $exeInDir).VersionInfo.ProductVersion
    }
    elseif ($installedDir -ine $InstallDir) { $installedDir = $null }
}

if ($installedDir) {
    $ok = Confirm-Choice "TorrentFlow $installedVersion is installed at $installedDir. Update to ${newVersion}?"
}
else {
    $ok = Confirm-Choice "Install TorrentFlow ${newVersion}?"
}
if (-not $ok) { Write-Host 'Nothing was changed.'; Exit-Install 0 }

# --- 4. Library to adopt ----------------------------------------------------------------------------------------
if (-not $DataDir) {
    $DataDir = if ($env:TorrentFlow__DataDirectory) { $env:TorrentFlow__DataDirectory }
               else { Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'TorrentFlow' }
}
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')
if (-not $LegacyDataDir) {
    # dotnet run (run.ps1) uses its content root, the project folder: server\TorrentFlow.Api\data. <repo>\data is
    # checked too (older layouts, the published exe run with a portable marker from the repo root).
    $candidates = @((Join-Path $RepoRoot 'server\TorrentFlow.Api\data'), (Join-Path $RepoRoot 'data')) |
        Where-Object { Test-Path (Join-Path $_ 'torrentflow.db') } |
        Sort-Object { (Get-Item (Join-Path $_ 'torrentflow.db')).LastWriteTime } -Descending
    $LegacyDataDir = if ($candidates) { @($candidates)[0] } else { Join-Path $RepoRoot 'server\TorrentFlow.Api\data' }
    if (@($candidates).Count -gt 1) { Write-Host "    Also found an older library at $(@($candidates)[1]); it is left as it is." }
}
$LegacyDataDir = [IO.Path]::GetFullPath($LegacyDataDir).TrimEnd('\')

$adopt = $null
$legacyDb = Join-Path $LegacyDataDir 'torrentflow.db'
$targetDb = Join-Path $DataDir 'torrentflow.db'
if (($LegacyDataDir -ine $DataDir) -and (Test-Path $legacyDb)) {
    if (-not (Test-Path $targetDb)) {
        if (Confirm-Choice "Move your existing library from $LegacyDataDir into the installed app?") { $adopt = 'move' }
    }
    else {
        Write-Host 'Two TorrentFlow libraries exist:'
        Write-Host "    [I] installed app: $(Get-LibrarySummary $DataDir)"
        Write-Host "    [R] run.ps1:       $(Get-LibrarySummary $LegacyDataDir)"
        Write-Host '    Nothing is overwritten: keeping [R] renames the installed library to a .replaced-<time> backup; keeping [I] leaves both as they are.'
        $keep = 'i'
        if ($Yes) { Write-Host 'Keep which library? [I/r] i (-Yes)' }
        else {
            do { Write-Host 'Keep which library? [I/r] ' -NoNewline; $keep = "$(Read-Host)".Trim().ToLowerInvariant(); if (-not $keep) { $keep = 'i' } }
            while ($keep -notin @('i', 'r'))
        }
        if ($keep -eq 'r') { $adopt = 'replace' }
        else { Write-Host "    Keeping the installed library; $LegacyDataDir is left as it is." }
    }
}

# --- 5. Stop, adopt, install ------------------------------------------------------------------------------------
Stop-Processes (Get-InstalledAppProcesses $InstallDir) 'the running TorrentFlow'

if ($adopt) {
    Stop-Processes (Get-DevServerProcesses) 'the run.ps1 dev server that uses the old library' 10
    Write-Step "Moving the library from $LegacyDataDir to $DataDir"
    $adoptArgs = @('--adopt-data', $LegacyDataDir, $DataDir)
    if ($adopt -eq 'replace') { $adoptArgs += '--replace-existing' }
    $code = Invoke-Exe $BuiltExe $adoptArgs
    if ($code -ne 0) {
        Write-Host "    The library was not moved (see above); both libraries are as they were. Continuing with the install." -ForegroundColor Yellow
    }
}

if ($useInno) {
    Write-Step "Running $($setupExe.Name) silently"
    $setupArgs = @('/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', "/DIR=`"$InstallDir`"")
    $p = Start-Process -FilePath $setupExe.FullName -ArgumentList $setupArgs -Wait -PassThru
    if ($p.ExitCode -ne 0) { Stop-Fail "The installer failed (exit code $($p.ExitCode))." }
}
else {
    Write-Step "Copying TorrentFlow.exe to $InstallDir"
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
    Copy-Item $BuiltExe (Join-Path $InstallDir 'TorrentFlow.exe') -Force
    $programs = [Environment]::GetFolderPath('Programs')
    $shell = New-Object -ComObject WScript.Shell
    $link = $shell.CreateShortcut((Join-Path $programs 'TorrentFlow.lnk'))
    $link.TargetPath = Join-Path $InstallDir 'TorrentFlow.exe'
    $link.WorkingDirectory = $InstallDir
    $link.IconLocation = "$(Join-Path $InstallDir 'TorrentFlow.exe'),0"
    $link.Save()
    Write-Host "    Start-menu shortcut created. To remove this install later, delete $InstallDir and that shortcut."
}

# --- 6. Relaunch ------------------------------------------------------------------------------------------------
$url = Get-ListenUrl
$port = ([Uri]$url).Port
$owner = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1
if ($owner) {
    $holder = Get-Process -Id $owner.OwningProcess -ErrorAction SilentlyContinue
    $dev = @(Get-DevServerProcesses | Where-Object { $_.Id -eq $owner.OwningProcess })
    $isTorrentFlow = $dev.Count -gt 0 -or ($holder -and $holder.ProcessName -eq 'TorrentFlow')
    $holderText = if ($dev.Count -gt 0) { 'the run.ps1 dev server' } elseif ($holder -and $holder.Path) { "TorrentFlow from $($holder.Path)" } else { "PID $($owner.OwningProcess)" }
    if ($isTorrentFlow -and (Confirm-Choice "$holderText is using port $port. Stop it so the installed app can start?")) {
        if ($dev.Count -gt 0) { Stop-Processes (Get-DevServerProcesses) 'the run.ps1 dev server' 10 }
        else { Stop-Processes @($holder) $holderText }
    }
    else {
        Write-Host "TorrentFlow $newVersion installed, but port $port is in use by $holderText. Close it, then start TorrentFlow from the Start menu." -ForegroundColor Yellow
                Exit-Install 0
    }
}

Start-Process -FilePath (Join-Path $InstallDir 'TorrentFlow.exe') -ArgumentList '--background' -WorkingDirectory $InstallDir
if (Test-Health $url 60) {
    Write-Host "TorrentFlow $newVersion installed. Open: $url (tray icon running)" -ForegroundColor Green
}
else {
    Write-Host "TorrentFlow $newVersion installed, but it did not answer on $url within 60s. Start it from the Start menu; errors are shown in a message box." -ForegroundColor Yellow
        Exit-Install 1
}
    Exit-Install 0
