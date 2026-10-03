$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3967'
function Save($name, $value) {
    $value | ConvertTo-Json -Depth 60 | Set-Content (Join-Path $PSScriptRoot "$name.json")
}
function Check($condition, $message) { if (-not $condition) { throw $message } }
foreach ($root in (Invoke-RestMethod "$base/api/dev/library/roots").roots) {
    Invoke-RestMethod "$base/api/dev/library/roots/$($root.id)" -Method Delete | Out-Null
}
$accepted = Invoke-RestMethod "$base/api/title/tmdb:movie:45745" -Method Post -ContentType application/json -Body '{}'
Save 'real-download-first' $accepted
Check $accepted.ok 'Real Download refused the fresh intent.'
$before = Invoke-RestMethod "$base/api/dev/targets"
Save 'targets-before-filing' $before
$payload = Get-Content (Join-Path $PSScriptRoot 'filing-input.json') -Raw | ConvertFrom-Json
$noRoot = Invoke-RestMethod "$base/api/dev/filing/" -Method Post -ContentType application/json -Body ($payload | ConvertTo-Json -Depth 60)
Save 'no-root-filing' $noRoot
Check ($noRoot.failure.code -eq 'NoDriveSpace') 'Expected real no-root placement refusal.'
$try = Invoke-RestMethod "$base/api/dev/targets/$([uri]::EscapeDataString($before.targets[0].id))/try" -Method Post
Save 'existing-target-try-now' $try
Check $try.accepted 'Try now refused the existing target.'
$root = Invoke-RestMethod "$base/api/dev/library/roots" -Method Post -ContentType application/json -Body '{"path":"D:\\code\\memtest\\library-apiact-final","kinds":[0],"priority":0,"reserveBytes":0,"confirmed":true}'
Save 'root-added' $root
$added = Invoke-RestMethod "$base/api/dev/filing/" -Method Post -ContentType application/json -Body ($payload | ConvertTo-Json -Depth 60)
Save 'filing-after-root' $added
Check $added.accepted 'Corrected root did not admit download.'
$repeat = Invoke-RestMethod "$base/api/dev/filing/" -Method Post -ContentType application/json -Body ($payload | ConvertTo-Json -Depth 60)
Save 'filing-repeat' $repeat
Check ($repeat.accepted -and $repeat.duplicate) 'Repeated filing created another download.'
$old = $payload.placement.targets[0].id
$payload.placement.targets[0].id = 'renamed-proof-target'
$payload.placement.assignment.targetIds[0] = 'renamed-proof-target'
$payload.placement.assignment.files[0].targetId = 'renamed-proof-target'
$repeat = Invoke-RestMethod "$base/api/dev/filing/" -Method Post -ContentType application/json -Body ($payload | ConvertTo-Json -Depth 60)
Save 'filing-renamed-repeat' $repeat
Check ($repeat.accepted -and $repeat.duplicate) 'Renamed repeat created another download.'
Save 'real-download-repeat' (Invoke-RestMethod "$base/api/title/tmdb:movie:45745" -Method Post -ContentType application/json -Body '{}')
Save 'real-try-now' (Invoke-RestMethod "$base/api/wanted/try?workKey=tmdb:movie:45745" -Method Post)
$deadline = (Get-Date).AddMinutes(2)
do {
    $state = Invoke-RestMethod "$base/api/dev/filing/"
    if ($state.media.Count -eq 1) { break }
    Start-Sleep -Milliseconds 500
} while ((Get-Date) -lt $deadline)
Save 'completed-filing' $state
Check ($state.media.Count -eq 1) 'Licensed transfer did not complete.'
$source = 'D:\code\platformApps-worktrees\rebuild\tools\.filing-proof\seed\Sintel\Sintel.mp4'
$sourceHash = (Get-FileHash $source).Hash
$targetHash = (Get-FileHash $state.media[0].path).Hash
Save 'completed-digest' @{present=(Test-Path $state.media[0].path);matches=$sourceHash -eq $targetHash;sha256=$targetHash;bytes=$state.media[0].bytes}
Check ($sourceHash -eq $targetHash) 'Complete transfer digest differs.'
$after = Invoke-RestMethod "$base/api/dev/targets"
Save 'targets-after-repeat' $after
Check ($after.targets.Count -eq 1 -and $after.targets[0].id -eq $before.targets[0].id -and $after.downloads.Count -eq 1) 'Target or Download duplicated.'
Write-Output 'OPS-837 final HTTP assertions passed.'
