$ErrorActionPreference = 'Stop'
$proof = $PSScriptRoot
$environment = @{
    ASPNETCORE_ENVIRONMENT = 'Development'
    TorrentFlow__DataDirectory = 'D:\code\memtest\data-wupg'
    TorrentFlow__Scheduler__Disabled = 'true'
    TorrentFlow__WebRoot = 'D:\code\platformApps-worktrees\rebuild\web\dist'
    TMDB_API_KEY = (Get-Content 'C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key' -Raw).Trim()
}
$process = Start-Process 'D:\code\memtest\bin-wupg\TorrentFlow.exe' -PassThru `
    -WorkingDirectory 'D:\code\memtest\bin-wupg' `
    -ArgumentList '--background', '--no-browser', '--urls', 'http://127.0.0.1:3967' `
    -Environment $environment -RedirectStandardOutput "$proof\server.log" -RedirectStandardError "$proof\server.err"
$process.Id | Set-Content "$proof\server.pid"
for ($i = 0; $i -lt 30; $i++) {
    try {
        $health = Invoke-RestMethod 'http://127.0.0.1:3967/api/health'
        if ($health.ready) {
            $health | ConvertTo-Json -Depth 8 | Set-Content "$proof\health.json"
            return
        }
    } catch { Start-Sleep -Milliseconds 500 }
}
throw 'The isolated server did not become ready.'

