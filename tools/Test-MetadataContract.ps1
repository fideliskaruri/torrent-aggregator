param([string] $BaseUrl = 'http://127.0.0.1:3940', [string] $EvidenceDirectory = "$PSScriptRoot\.metadata-proof")
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Path $EvidenceDirectory -Force | Out-Null
$cases = @(
    @{ title = 'Scorpion'; year = 2014; kind = 'Series'; anime = $false },
    @{ title = 'Little Fires Everywhere'; year = 2020; kind = 'Series'; anime = $false },
    @{ title = 'Frieren'; year = 2023; kind = 'Series'; anime = $true },
    @{ title = 'A Silent Voice'; year = 2016; kind = 'Film'; anime = $true },
    @{ title = 'Prison Break'; year = 2005; kind = 'Series'; anime = $false },
    @{ title = 'Money Heist'; year = 2017; kind = 'Series'; anime = $false },
    @{ title = 'Rick and Morty'; year = 2013; kind = 'Series'; anime = $false },
    @{ title = 'Sintel'; year = 2010; kind = 'Film'; anime = $false },
    @{ title = 'Big Buck Bunny'; year = 2008; kind = 'Film'; anime = $false }
)
$table = @()
foreach ($case in $cases) {
    $query = @{ title = $case.title; year = $case.year; kind = $case.kind } | ConvertTo-Json
    $cold = [Diagnostics.Stopwatch]::StartNew()
    $result = Invoke-RestMethod "$BaseUrl/resolve" -Method Post -ContentType 'application/json' -Body $query -TimeoutSec 180
    $cold.Stop()
    $result | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $EvidenceDirectory "$($case.title).json")
    $warm = [Diagnostics.Stopwatch]::StartNew()
    $again = Invoke-RestMethod "$BaseUrl/resolve" -Method Post -ContentType 'application/json' -Body $query -TimeoutSec 180
    $warm.Stop()
    if (!$result.work) { throw "$($case.title): $($result.failure | ConvertTo-Json -Compress)" }
    if ($result.work.work.kind -ne $case.kind -or $result.work.work.anime -ne $case.anime) {
        throw "$($case.title): incorrect kind/anime"
    }
    if ($again.work.work.id -ne $result.work.work.id) { throw "$($case.title): unstable work identity" }
    $names = $result.work.names | Sort-Object ordinal
    if ($names[0].label -ne 'English') { throw "$($case.title): English name must be first" }
    if ($names | Where-Object { [string]::IsNullOrWhiteSpace($_.value) }) {
        throw "$($case.title): blank labelled name"
    }
    $coordinates = @($result.work.episodes | ForEach-Object { "$($_.seasonId):$($_.number)" })
    if ($coordinates.Count -ne @($coordinates | Select-Object -Unique).Count) {
        throw "$($case.title): duplicate episode coordinates"
    }
    if ($result.work.episodes | Where-Object { !$_.airAt -and $_.airPrecision -ne 'Unknown' }) {
        throw "$($case.title): unknown air date must retain unknown precision"
    }
    $sample = @($result.work.episodes | Where-Object { $_.absoluteNumber } | Sort-Object absoluteNumber |
        Select-Object -First 1 -Last 1 | ForEach-Object {
            $episode = $_
            $season = $result.work.seasons | Where-Object id -eq $episode.seasonId
            "S$($season.number)E$($episode.number)=$($episode.absoluteNumber)"
        }) -join ','
    if ($case.title -eq 'Frieren') {
        if (!( $result.work.seasons | Where-Object number -eq 2 )) { throw 'Frieren S2 missing' }
        if (!( $result.work.episodes | Where-Object { $_.number -eq 1 -and $_.absoluteNumber -eq 29 } )) {
            throw 'Frieren S2E1 must map to absolute 29'
        }
        if ($result.work.seasons | Where-Object {
            $_.expectedEpisodeCount -eq 0 -and $_.mappingStatus -eq 'Confirmed'
        }) { throw 'Unknown announced sequel count cannot be confirmed empty' }
    }
    if ($case.title -eq 'Money Heist' -and !($names | Where-Object {
        $_.label -eq 'Original' -and ($_.value -ieq 'La Casa de Papel')
    })) { throw 'Money Heist original name missing or incorrectly labelled' }
    $table += [pscustomobject]@{
        title = $case.title; kind = $result.work.work.kind; anime = $result.work.work.anime
        ids = (@($result.work.links | ForEach-Object { "$($_.provider):$($_.externalId)" }) | Select-Object -Unique) -join ','
        names = (@($names | ForEach-Object { "$($_.label):$($_.value)" }) | Select-Object -Unique) -join '; '
        seasons = @($result.work.seasons).Count; episodes = @($result.work.episodes).Count
        absolute = $sample; complete = $result.complete; coldMs = $cold.ElapsedMilliseconds; warmMs = $warm.ElapsedMilliseconds
    }
    $table[-1] | ConvertTo-Json -Compress
}
$table | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $EvidenceDirectory 'results.json')
