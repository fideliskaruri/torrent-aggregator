param(
    # Stamped into the exe and the installer, e.g. 1.2.3 or 1.2.3+abc1234 (a leading v is dropped).
    [string]$Version = '',
    # Also compile installer\windows\TorrentFlow.iss with Inno Setup (iscc).
    [switch]$Installer
)

$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$publishDir = Join-Path $repoRoot 'artifacts\exe'
$Version = $Version.TrimStart('v', 'V')

Push-Location $repoRoot
try {
    if (Test-Path $publishDir) {
        Remove-Item $publishDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $publishDir | Out-Null

    Push-Location (Join-Path $repoRoot 'web')
    try {
        pnpm install --frozen-lockfile
        pnpm build
        if ($LASTEXITCODE -ne 0) { throw "web build failed." }
    }
    finally {
        Pop-Location
    }

    $versionArgs = @()
    if ($Version) {
        # MSBuild's Version must be SemVer without build metadata; the +<sha> part becomes SourceRevisionId, which
        # the SDK appends to the informational (product) version: 1.2.3+abc1234.
        $core, $metadata = $Version -split '\+', 2
        $versionArgs = @("-p:Version=$core")
        if ($metadata) { $versionArgs += "-p:SourceRevisionId=$metadata" }
    }

    dotnet publish server\TorrentFlow.Api -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=false `
        -p:DebugType=None `
        -p:DebugSymbols=false `
        -p:SkipWebBuild=true `
        @versionArgs `
        -o $publishDir
    if ($LASTEXITCODE -ne 0) { throw "dotnet publish failed." }

    Get-ChildItem $publishDir -File | Where-Object Name -ne 'TorrentFlow.exe' | Remove-Item -Force

    if ($Installer) {
        $iscc = (Get-Command iscc -ErrorAction SilentlyContinue).Source
        if (-not $iscc) {
            $iscc = @(
                "$env:LOCALAPPDATA\Programs\Inno Setup 6\ISCC.exe",
                "${env:ProgramFiles(x86)}\Inno Setup 6\ISCC.exe",
                "$env:ProgramFiles\Inno Setup 6\ISCC.exe"
            ) | Where-Object { Test-Path $_ } | Select-Object -First 1
        }
        if (-not $iscc) { throw "Inno Setup (iscc) not found. Install it with: winget install JRSoftware.InnoSetup" }

        $installerVersion = if ($Version) { $Version } else { '0.0.0' }
        & $iscc "/DAppVersion=$installerVersion" "/DSourceExe=$publishDir\TorrentFlow.exe" "/O$publishDir" `
            (Join-Path $repoRoot 'installer\windows\TorrentFlow.iss')
        if ($LASTEXITCODE -ne 0) { throw "installer build failed." }
    }
}
finally {
    Pop-Location
}
