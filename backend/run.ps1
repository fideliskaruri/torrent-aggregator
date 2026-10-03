param(
    [string] $DataDirectory = 'D:\code\memtest\rebuild-dev\data'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location $root
try {
    dotnet build backend\TorrentFlow.Backend.slnx --nologo
    if ($LASTEXITCODE -ne 0) { throw 'Backend build failed.' }
    if (-not (Test-Path web\dist\index.html)) {
        Push-Location web
        try {
            pnpm build
            if ($LASTEXITCODE -ne 0) { throw 'Web build failed.' }
        }
        finally { Pop-Location }
    }
    dotnet backend\src\Api\bin\Debug\net10.0\TorrentFlow.dll `
        --urls http://127.0.0.1:3940 `
        --TorrentFlow:DataDirectory $DataDirectory `
        --TorrentFlow:Scheduler:Disabled true `
        --background --no-browser
    if ($LASTEXITCODE -ne 0) { throw 'The rebuild server stopped with an error. Inspect the scratch data directory logs.' }
}
finally { Pop-Location }
