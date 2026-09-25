# Runs the .NET version. Pass a different address with: .\run.ps1 --urls http://127.0.0.1:3001
$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    $urls = if ($args.Count -gt 0) { $args } else { @('--urls', 'http://127.0.0.1:3000') }
    Write-Host "TorrentFlow: $($urls[-1]) (first run builds the web UI)"
    dotnet run -c Release --project server\TorrentFlow.Api -- @urls
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
