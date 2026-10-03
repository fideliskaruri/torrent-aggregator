param([string]$DataDirectory = 'D:\code\memtest\canon-data\converted')
$ErrorActionPreference = 'Stop'
$proof = $PSScriptRoot
$info = [System.Diagnostics.ProcessStartInfo]::new('dotnet')
$info.UseShellExecute = $false
$info.ArgumentList.Add('D:\code\memtest\bin-canon\TorrentFlow.dll')
foreach ($arg in @('--urls','http://127.0.0.1:3961','--TorrentFlow:DataDirectory',
    $DataDirectory,'--TorrentFlow:Scheduler:Disabled','true',
    '--background','--no-browser')) { $info.ArgumentList.Add($arg) }
$info.Environment['TMDB_API_KEY'] = (Get-Content 'C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key' -Raw).Trim()
$info.Environment['ASPNETCORE_ENVIRONMENT'] = 'Development'
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
$process = [System.Diagnostics.Process]::Start($info)
Set-Content "$proof\server.pid" $process.Id
$stdout = [System.IO.FileStream]::new("$proof\server.log", 'Create', 'Write', 'ReadWrite')
$stderr = [System.IO.FileStream]::new("$proof\server.err", 'Create', 'Write', 'ReadWrite')
$outCopy = $process.StandardOutput.BaseStream.CopyToAsync($stdout)
$errCopy = $process.StandardError.BaseStream.CopyToAsync($stderr)
$process.WaitForExit()
$outCopy.GetAwaiter().GetResult()
$errCopy.GetAwaiter().GetResult()
$stdout.Dispose()
$stderr.Dispose()
