param(
    [string] $BaseUrl = 'http://127.0.0.1:3940',
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\.catalog-proof'),
    [switch] $AfterRestart
)
$ErrorActionPreference = 'Stop'
$checks = [Collections.Generic.List[object]]::new()
function Call([string]$path, [string]$method='GET', $body=$null) {
    $params = @{Uri=$BaseUrl.TrimEnd('/')+$path;Method=$method;SkipHttpErrorCheck=$true;TimeoutSec=120}
    if($null -ne $body) { $params.ContentType='application/json';$params.Body=($body|ConvertTo-Json -Depth 20 -Compress) }
    $r=Invoke-WebRequest @params
    return @{status=[int]$r.StatusCode;body=($r.Content|ConvertFrom-Json -AsHashtable -DateKind String)}
}
function Check([string]$name,[bool]$ok,$evidence) {
    $checks.Add([pscustomobject]@{check=$name;result=$(if($ok){'PASS'}else{'FAIL'});evidence=$evidence})
}
$receipt = Join-Path $OutputDirectory 'watch-restart-receipt.json'
if($AfterRestart) {
    $saved=Get-Content $receipt -Raw|ConvertFrom-Json -AsHashtable
    $items=(Call '/api/watchlist').body.items
    $row=$items|Where-Object id -eq $saved.id
    Check 'WatchItem, Follow and WorkPreference survive restart' ($row.status -eq 'watching' -and $row.monitored -eq $true -and
        $row.fromSeason -eq 2 -and $row.fromEpisode -eq 3 -and $row.preferredResolution -eq 1080) $row
    $r=Call ('/api/watchlist?id='+$saved.id) DELETE
    Check 'Delete saved intent after restart' ($r.status -eq 200 -and $r.body.ok) $r
    Check 'Deleted row absent immediately' (@((Call '/api/watchlist').body.items|Where-Object id -eq $saved.id).Count -eq 0) 'Fresh GET'
} else {
    foreach($test in @(
        @{name='Browse rejects invalid type';path='/api/browse?type=invalid';status=400},
        @{name='Browse rejects invalid genre';path='/api/browse?type=films&genre=invalid';status=400},
        @{name='Search requires a query';path='/api/search/titles';status=400},
        @{name='Search bounds query length';path=('/api/search/titles?q='+('x'*201));status=400},
        @{name='Short suggest is empty';path='/api/suggest?q=x';status=200},
        @{name='Unsupported title provider is refused';path='/api/title/example?provider=invalid&providerId=1';status=400},
        @{name='Provider ID requires provider';path='/api/title/example?providerId=1';status=400}
    )) {
        $r=Call $test.path
        Check $test.name ($r.status -eq $test.status) $r
    }
    $r=Call '/api/search/titles?q=frieren&limit=40'
    Check 'Unified search includes the real Frieren anime' (@($r.body.results|Where-Object {$_.isSeries -and $_.title -like '*Frieren*'}).Count -gt 0) @($r.body.results|Select-Object -First 5)
    foreach($category in @('movies','series','anime')) {
        $r=Call ("/api/search/titles?q=frieren&category=$category&limit=40")
        Check "Search respects $category scope" ($r.status -eq 200 -and
            @($r.body.results|Where-Object category -ne $category).Count -eq 0) @($r.body.results|ForEach-Object {$_.category})
    }
    $r=Call '/api/artwork' POST @{items=@(@{title='Sintel';year=2010;mediaType='movie'})}
    Check 'Artwork lookup returns title/year key and nullable art fields' ($r.status -eq 200 -and $r.body.artwork.Contains('sintel:2010') -and
        $r.body.artwork['sintel:2010'].Contains('posterUrl') -and $r.body.artwork['sintel:2010'].Contains('backdropUrl')) $r.body
    $bad=Invoke-WebRequest ($BaseUrl+'/api/artwork') -Method POST -ContentType application/json -Body '{bad' -SkipHttpErrorCheck
    Check 'Malformed artwork JSON keeps legacy empty 200 response' ([int]$bad.StatusCode -eq 200 -and $bad.Content -eq '{"artwork":{}}') $bad.Content
    $frieren='/api/title/frieren-beyond-journeys-end-2023?t=Frieren&type=anime&provider=anilist&providerId=154587'
    $r=Call ($frieren+'&s=2')
    Check 'Selected Frieren season has exact coordinates and ten rows' ($r.body.season -eq 2 -and
        @($r.body.episodes).Count -eq 10 -and @($r.body.episodes|Where-Object season -ne 2).Count -eq 0) @($r.body.episodes|ForEach-Object {$_.label})
    $r=Call ($frieren+'&remembered=2')
    Check 'Remembered season is respected' ($r.body.season -eq 2 -and @($r.body.episodes).Count -eq 10) $r.body.season
    $r=Call '/api/title/example/progress'
    Check 'Nothing-active transfer projection is honest' ($null -eq $r.body.transfer -and
        $r.body.seasonTransfers.Count -eq 0 -and $r.body.episodeTransfers.Count -eq 0) $r.body
    $title=Call '/api/title/scorpion-2014?t=Scorpion&y=2014&type=tv&provider=tmdb&providerId=60797'
    $payload=$title.body.library.addPayload
    $a=Call '/api/watchlist' POST $payload
    $b=Call '/api/watchlist' POST $payload
    Check 'Repeated save reuses one WatchItem' ($a.status -eq 200 -and $b.status -eq 200 -and
        $a.body.item.id -eq $b.body.item.id -and $b.body.existed) @{first=$a.body.item.id;second=$b.body.item.id;existed=$b.body.existed}
    $id=$a.body.item.id
    $r=Call '/api/watchlist' PATCH @{id=$id;status='watching';monitored=$true;fromSeason=2;fromEpisode=3;preferredResolution=1080}
    Check 'Saved monitoring, start episode and hard quality intent' ($r.status -eq 200 -and $r.body.item.monitored -eq $true -and
        $r.body.item.fromSeason -eq 2 -and $r.body.item.fromEpisode -eq 3 -and $r.body.item.preferredResolution -eq 1080) $r.body.item
    $r=Call '/api/watchlist' PATCH @{id=$id;status='watching'}
    Check 'Partial patch preserves other intent' ($r.status -eq 200 -and $r.body.item.monitored -eq $true -and
        $r.body.item.fromSeason -eq 2 -and $r.body.item.fromEpisode -eq 3 -and $r.body.item.preferredResolution -eq 1080) $r.body.item
    foreach($bad in @(@{id=$id;status='0'},@{id=$id;preferredResolution='1080p'},@{id=$id;monitored='yes'},
        @{id=$id;fromSeason=999;fromEpisode=1})) {
        $r=Call '/api/watchlist' PATCH $bad
        Check ('Invalid watch intent rejected: '+($bad|ConvertTo-Json -Compress)) ($r.status -eq 400) $r
    }
    $r=Call '/api/watchlist' PATCH @{id='missing';status='watching'}
    Check 'Unknown watch ID is 404' ($r.status -eq 404) $r
    # Two simultaneous real HTTP saves exercise the database's unique/CAS path.
    $client=[Net.Http.HttpClient]::new()
    try {
        $tasks=@()
        foreach($i in 1..2) {
            $content=[Net.Http.StringContent]::new(($payload|ConvertTo-Json -Compress),[Text.Encoding]::UTF8,'application/json')
            $tasks += $client.PostAsync($BaseUrl+'/api/watchlist',$content)
        }
        [Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$tasks)
        Check 'Concurrent duplicate saves both succeed' (@($tasks|Where-Object {$_.Result.StatusCode -ne 200}).Count -eq 0) @($tasks|ForEach-Object {[int]$_.Result.StatusCode})
        Check 'Concurrent saves keep one row per work' (@((Call '/api/watchlist').body.items|Where-Object id -eq $id).Count -eq 1) $id
    } finally { $client.Dispose() }
    @{id=$id}|ConvertTo-Json|Set-Content $receipt -Encoding utf8
}
$suffix=$(if($AfterRestart){'restart'}else{'http'})
$checks|ConvertTo-Json -Depth 25|Set-Content (Join-Path $OutputDirectory "$suffix-checks.json") -Encoding utf8
$checks|Select-Object check,result|Format-Table -Wrap
if(@($checks|Where-Object result -eq FAIL).Count) { exit 1 }
