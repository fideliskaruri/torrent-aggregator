param([Parameter(Mandatory)][string]$Label)
$psi = [Diagnostics.ProcessStartInfo]::new('dotnet')
$psi.ArgumentList.Add('D:\code\memtest\bin-epid\TorrentFlow.dll')
@('--urls', 'http://127.0.0.1:3967', '--TorrentFlow:DataDirectory',
  'D:\code\memtest\epid-data\converted', '--TorrentFlow:Scheduler:Disabled',
  'false', '--background', '--no-browser') | ForEach-Object { $psi.ArgumentList.Add($_) }
$psi.Environment['TMDB_API_KEY'] = (Get-Content 'C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key' -Raw).Trim()
$psi.Environment['ASPNETCORE_ENVIRONMENT'] = 'Development'
$psi.UseShellExecute = $false
$process = [Diagnostics.Process]::Start($psi)
$process.Id | Set-Content (Join-Path $PSScriptRoot "$Label.pid")
Write-Output "Proof PID $($process.Id)"
