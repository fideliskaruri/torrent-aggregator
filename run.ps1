# Builds the web app and runs the server on http://127.0.0.1:3968. Pass a different address with: .\run.ps1 --urls http://127.0.0.1:3001
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $urls = if ($args.Count -gt 0) { $args } else { @('--urls', 'http://127.0.0.1:3968') }
    $dataDir = if ($env:TorrentFlow__DataDirectory) { $env:TorrentFlow__DataDirectory } else { Join-Path $PSScriptRoot 'backend\data' }
    $webRoot = Join-Path $PSScriptRoot 'web\dist'
    if (-not (Test-Path (Join-Path $webRoot 'index.html'))) {
        pnpm --dir web install
        pnpm --dir web run build
    }
    Write-Host "TorrentFlow: $($urls[-1]), data in $dataDir"
    dotnet run -c Release --project backend\src\Api -- @urls --TorrentFlow:DataDirectory $dataDir --TorrentFlow:WebRoot $webRoot --no-browser
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
