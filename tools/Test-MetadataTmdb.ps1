#requires -Version 7.5
param(
    [string] $BaseUrl = 'http://127.0.0.1:3940',
    [string] $EvidenceDirectory = "$PSScriptRoot\.metadata-proof\authenticated",
    [ValidateSet('Authenticated', 'Keyless')] [string] $Mode = 'Authenticated',
    [switch] $UseExistingResults
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$health = Invoke-RestMethod "$BaseUrl/health"
if (!$health.ok) { throw 'Diagnostic server is not healthy.' }
if ($Mode -eq 'Keyless') {
    $query = @{ identity = @{ provider = 'tmdb'; externalId = '60797'; providerKind = 'tv' }; kind = 'Series' }
    $missing = Invoke-RestMethod "$BaseUrl/resolve" -Method Post -ContentType 'application/json' `
        -Body ($query | ConvertTo-Json) -TimeoutSec 180
    if ($missing.work -or $missing.failure.code -ne 'unconfigured' -or
        $missing.failure.message -notmatch 'TMDB key') { throw 'Missing key must return an honest unconfigured failure.' }
    $fallback = Invoke-RestMethod "$BaseUrl/resolve" -Method Post -ContentType 'application/json' `
        -Body '{"title":"Scorpion","year":2014,"kind":"Series"}' -TimeoutSec 180
    if (!$fallback.work -or $fallback.work.work.kind -ne 'Series' -or
        $fallback.work.work.ratingSource -eq 'tmdb') { throw 'Keyless catalog fallback failed.' }
    $after = Invoke-RestMethod "$BaseUrl/health"
    if (!$after.ok -or $after.pid -ne $health.pid) { throw 'Keyless host crashed or restarted.' }
    @{ healthy = $true; failure = $missing.failure; fallback = $fallback.work.work.workKey } |
        ConvertTo-Json -Depth 10 | Set-Content (Join-Path $EvidenceDirectory 'keyless.json')
    Write-Output 'Keyless: healthy; TMDB unconfigured with actionable reason; Scorpion fallback resolved; same PID.'
    return
}
if (!$UseExistingResults) {
    & "$PSScriptRoot\Test-MetadataContract.ps1" -BaseUrl $BaseUrl -EvidenceDirectory $EvidenceDirectory | Out-Null
}
$cases = @(Get-Content (Join-Path $EvidenceDirectory 'results.json') -Raw | ConvertFrom-Json)
if ($cases.Count -ne 9) { throw 'Expected all nine benchmark titles.' }
$table = foreach ($case in $cases) {
    $result = Get-Content (Join-Path $EvidenceDirectory "$($case.title).json") -Raw | ConvertFrom-Json -DateKind String
    $kind = if ($case.kind -eq 'Film') { 'movie' } else { 'tv' }
    $id = ($result.work.links | Where-Object provider -eq 'tmdb' | Select-Object -First 1).externalId
    $response = (Invoke-WebRequest "$BaseUrl/proof/tmdb/$kind/$id").Content | ConvertFrom-Json -DateKind String
    $proof = @($response | ForEach-Object { $_ })
    $proof | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $EvidenceDirectory "$($case.title)-tmdb.json")
    $detail = @($proof | Where-Object { $_.path.StartsWith("/$kind/$id`?") })
    if ($detail.Count -ne 1 -or !$detail[0].complete -or $detail[0].payload.id.ToString() -ne $id -or
        $result.work.work.ratingSource -ne 'tmdb') { throw "$($case.title): no successful applied TMDB detail response." }
    if ($case.kind -eq 'Series' -and !($proof | Where-Object { $_.path.StartsWith("/tv/$id/season/") })) {
        throw "$($case.title): TMDB season responses missing."
    }
    if ($case.kind -eq 'Film') {
        $dates = @($detail[0].payload.release_dates.results | ForEach-Object { $_.release_dates })
        foreach ($field in @(@{ name = 'digitalAt'; type = 4 }, @{ name = 'physicalAt'; type = 5 })) {
            $expected = @($dates | Where-Object type -eq $field.type |
                ForEach-Object { [DateTimeOffset]::Parse($_.release_date) } | Sort-Object) | Select-Object -First 1
            $actual = $result.work.work.($field.name)
            if (!$expected) {
                if ($actual) { throw "$($case.title): invented $($field.name) without provider evidence." }
            } elseif (!$actual -or [DateTimeOffset]::Parse($actual) -ne $expected) {
                throw "$($case.title): $($field.name) differs from earliest TMDB type $($field.type)."
            }
        }
    }
    if ($case.title -eq 'Frieren') {
        $season = $result.work.seasons | Where-Object number -eq 2
        $episodes = @($result.work.episodes | Where-Object seasonId -eq $season.id)
        if ($episodes.Count -ne 10) { throw 'Frieren S2 must have ten known episodes.' }
        $providerEpisodes = @($proof | Where-Object { $_.path.StartsWith("/tv/$id/season/1?") } |
            ForEach-Object { $_.payload.episodes })
        $providerSeason2 = @($proof | Where-Object { $_.path.StartsWith("/tv/$id/season/2?") } |
            ForEach-Object { $_.payload.episodes })
        foreach ($episode in $episodes) {
            $provider = if ($providerSeason2.Count) {
                $providerSeason2 | Where-Object episode_number -eq $episode.number
            } else {
                $providerEpisodes | Where-Object episode_number -eq (28 + $episode.number)
            }
            if (!$provider.air_date -or !$episode.airAt -or $episode.absoluteNumber -ne (28 + $episode.number) -or
                [DateTimeOffset]::Parse($episode.airAt).UtcDateTime.ToString('yyyy-MM-dd') -ne $provider.air_date) {
                throw "Frieren S2E$($episode.number): air date or absolute number differs from TMDB listing."
            }
        }
    }
    [pscustomobject]@{
        title = $case.title; tmdb = $id; applied = $true; fetchedAt = $detail[0].fetchedAt
        digital = $result.work.work.digitalAt; physical = $result.work.work.physicalAt
        coldMs = $case.coldMs; warmMs = $case.warmMs
    }
}
$table | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $EvidenceDirectory 'tmdb-verification.json')
$table | Format-Table title, tmdb, applied, digital, physical, coldMs, warmMs
