$ErrorActionPreference = 'Stop'
Push-Location $PSScriptRoot
try {
    Write-Host 'TorrentFlow: http://127.0.0.1:5106 (available after the first build)'
    dotnet run -c Release --project server\TorrentFlow.Api -- --urls http://127.0.0.1:5106
    exit $LASTEXITCODE
}
finally {
    Pop-Location
}
