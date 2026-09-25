$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path $PSScriptRoot -Parent
$publishDir = Join-Path $repoRoot 'artifacts\exe'

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
    }
    finally {
        Pop-Location
    }

    dotnet publish server\TorrentFlow.Api -c Release -r win-x64 --self-contained true `
        -p:PublishSingleFile=true `
        -p:IncludeNativeLibrariesForSelfExtract=true `
        -p:EnableCompressionInSingleFile=true `
        -p:DebugType=None `
        -p:DebugSymbols=false `
        -o $publishDir

    Get-ChildItem $publishDir -File | Where-Object Name -ne 'TorrentFlow.exe' | Remove-Item -Force
}
finally {
    Pop-Location
}
