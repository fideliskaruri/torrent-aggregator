# Runs the .NET version. Pass a different address with: .\run.ps1 --urls http://127.0.0.1:3001
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $urls = if ($args.Count -gt 0) { $args } else { @('--urls', 'http://127.0.0.1:3000') }
    # dotnet run's content root is the project folder, so the library lives in server\TorrentFlow.Api\data.
    $dataDir = if ($env:TorrentFlow__DataDirectory) { $env:TorrentFlow__DataDirectory } else { Join-Path $PSScriptRoot 'server\TorrentFlow.Api\data' }
    Write-Host "Dev mode: data in $dataDir. To install the app run .\install.ps1"
    Write-Host "TorrentFlow: $($urls[-1]) (first run builds the web UI)"
    dotnet run -c Release --project server\TorrentFlow.Api -- @urls
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
