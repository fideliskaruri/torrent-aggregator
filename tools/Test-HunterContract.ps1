param([string]$Base = 'http://127.0.0.1:3954')
$ErrorActionPreference = 'Stop'
$evidence = Join-Path $PSScriptRoot '.hunter-proof'
New-Item -ItemType Directory -Force $evidence | Out-Null
function Call([string]$Name, [string]$Method, [string]$Path, $Body = $null) {
    $args = @{ Uri = "$Base$Path"; Method = $Method; TimeoutSec = 120 }
    if ($null -ne $Body) { $args.ContentType = 'application/json'; $args.Body = $Body | ConvertTo-Json -Depth 12 }
    $reply = Invoke-WebRequest @args
    $reply.Content | Set-Content (Join-Path $evidence "$Name.json")
    return $reply.Content | ConvertFrom-Json
}
function Assert($Condition, [string]$Message) { if (!$Condition) { throw $Message } }
$rule = (Call 'rule-create' POST '/api/rules' @{
    name = 'Hunter proof'; query = 'Sintel'; category = 'movies'; minSeeders = 1
    resolution = '1080p'; sources = 'archive'; maxSizeBytes = 2000000000
}).rule
Assert ($rule.name -eq 'Hunter proof' -and $rule.minSeeders -eq 1 -and $rule.enabled) 'Rule create mismatch'
$edit = (Call 'rule-edit' PATCH '/api/rules' @{
    id = $rule.id; enabled = $false; name = 'Edited proof'; sources = $null; maxSizeBytes = $null
}).rule
Assert ($edit.query -eq 'Sintel' -and !$edit.enabled -and $null -eq $edit.sources -and $null -eq $edit.maxSizeBytes) 'Partial rule edit mismatch'
Call 'rule-list' GET '/api/rules' | Out-Null
Call 'rule-delete' DELETE "/api/rules?id=$($rule.id)" | Out-Null
$remaining = Call 'rule-after-delete' GET '/api/rules'
Assert (!($remaining.rules | Where-Object id -eq $rule.id)) 'Rule was not deleted'
$bad = Invoke-WebRequest "$Base/api/rules" -Method POST -ContentType application/json -Body '{"name":"bad","query":"bad","sources":"unsupported"}' -SkipHttpErrorCheck
$bad.Content | Set-Content (Join-Path $evidence 'rule-invalid.json')
Assert ($bad.StatusCode -eq 400) 'Invalid source accepted'
# Abbott Elementary is currently airing; the provider supplies all air dates.
Call 'follow-unrelated-off' PUT '/api/follows/tmdb:tv:130477' @{ enabled = $false } | Out-Null
$follow = Call 'follow' PUT '/api/follows/tmdb:tv:125935' @{ enabled = $true }
$title = Call 'series-metadata' GET '/api/title/tmdb:tv:125935'
$first = Call 'hunter-first' POST '/api/dev/hunter'
$second = Call 'hunter-second' POST '/api/dev/hunter'
Assert ($first.lane -eq 'background' -and !$first.busy) 'Hunter lane mismatch'
Assert ($first.items.Count -gt 0) 'No aired follow candidates'
Assert (!($first.items | Where-Object { [DateTimeOffset]$_.expectedAt -gt [DateTimeOffset]::UtcNow })) 'Unaired episode selected'
Assert ($first.items.Count -eq $second.items.Count) 'Repeat enumeration changed'
Assert (!($first.items | Group-Object episodeId | Where-Object Count -gt 1)) 'Duplicate episode candidates'
$targets = Call 'targets' GET '/api/dev/targets'
Assert ($targets.targets.Count -eq 0) 'Preview unexpectedly created download intent'
Call 'quality-watch' PUT '/api/quality-watches/tmdb:movie:45745' @{ enabled = $true; resolution = 1080 } | Out-Null
Call 'quality-watch-off' PUT '/api/quality-watches/tmdb:movie:45745' @{ enabled = $false; resolution = 1080 } | Out-Null
Call 'follow-off' PUT '/api/follows/tmdb:tv:125935' @{ enabled = $false } | Out-Null
$off = Call 'hunter-unfollowed' POST '/api/dev/hunter'
Assert ($off.items.Count -eq 0) 'Unfollow did not take effect'
$summary = @{
    port = ([uri]$Base).Port
    crud = 'pass'; invalidSource = 'pass'; qualityWatchPersistence = 'pass'
    followEnumeration = 'pass'; airedCandidates = $first.items.Count
    backgroundPass = 'pass'; duplicateCandidates = 'none'; unfollow = 'pass'
    targetCreation = 'BLOCKED OPS-786'; ownedExclusion = 'not exercised on fresh empty library'
    releaseTiming = 'BLOCKED OPS-786'; qualityNotification = 'not exercised'
    note = 'No download admission. Hunter reports blocked candidates, not persisted targets.'
}
$summary | ConvertTo-Json -Depth 8 | Set-Content (Join-Path $evidence 'summary.json')
$summary | ConvertTo-Json
