param(
    [string] $NewUrl = 'http://127.0.0.1:3940',
    [string] $OldUrl = 'http://127.0.0.1:3931',
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\.catalog-proof')
)
$ErrorActionPreference = 'Stop'
$titles = @(
    @{ title='Scorpion'; year=2014; type='tv'; id='60797' },
    @{ title='Little Fires Everywhere'; year=2020; type='tv'; id='90257' },
    @{ title='Frieren: Beyond Journey''s End'; year=2023; type='anime'; id='154587'; provider='anilist' },
    @{ title='A Silent Voice'; year=2016; type='anime'; id='20954'; provider='anilist' },
    @{ title='Prison Break'; year=2005; type='tv'; id='2288' },
    @{ title='Money Heist'; year=2017; type='tv'; id='71446' },
    @{ title='Rick and Morty'; year=2013; type='tv'; id='60625' },
    @{ title='Sintel'; year=2010; type='movie'; id='45745' },
    @{ title='Big Buck Bunny'; year=2008; type='movie'; id='10378' }
)
$rows = @()
foreach ($t in $titles) {
    $provider = $(if($t.provider){$t.provider}else{'tmdb'})
    $key = (($t.title.ToLowerInvariant() -replace "['’]", '') -replace '[^a-z0-9]+','-').Trim('-') + '-' + $t.year
    $query = '?t=' + [uri]::EscapeDataString($t.title) + '&y=' + $t.year + '&type=' + $t.type +
        '&provider=' + $provider + '&providerId=' + $t.id
    $comparison = [ordered]@{ title=$t.title; key=$key; query=$query }
    foreach ($server in @(@{name='old';url=$OldUrl},@{name='new';url=$NewUrl})) {
        Write-Host "Comparing $($t.title): $($server.name)"
        $detail = Invoke-RestMethod ($server.url+'/api/title/'+$key+$query) -TimeoutSec 120
        $extras = Invoke-RestMethod ($server.url+'/api/title/'+$key+'/extras'+$query+'&s=1') -TimeoutSec 120
        $counts = @()
        foreach ($season in $extras.seasons) {
            $seasonExtras = $(if($season -eq 1){$extras}else{Invoke-RestMethod ($server.url+'/api/title/'+$key+'/extras'+$query+'&s='+$season) -TimeoutSec 120})
            $counts += [pscustomobject]@{season=$season;episodes=@($seasonExtras.episodes).Count}
        }
        $comparison[$server.name] = [ordered]@{
            title=$detail.title;mediaType=$detail.mediaType;isSeries=$detail.isSeries
            detailSeasons=@($detail.seasons | ForEach-Object { [pscustomobject]@{season=$_.season;knownEpisodes=$_.knownEpisodes} })
            catalogSeasons=$counts
        }
        @{detail=$detail;extras=$extras} | ConvertTo-Json -Depth 50 |
            Set-Content (Join-Path $OutputDirectory ($server.name+'-'+$key+'.json')) -Encoding utf8
    }
    $comparison['sameTitle'] = $comparison.old.title -eq $comparison.new.title
    $comparison['sameKind'] = $comparison.old.mediaType -eq $comparison.new.mediaType -and $comparison.old.isSeries -eq $comparison.new.isSeries
    $comparison['sameSeasons'] = ($comparison.old.catalogSeasons|ConvertTo-Json -Compress) -eq ($comparison.new.catalogSeasons|ConvertTo-Json -Compress)
    $rows += [pscustomobject]$comparison
}
$rows | ConvertTo-Json -Depth 25 | Set-Content (Join-Path $OutputDirectory 'title-comparison.json') -Encoding utf8
$rows | Select-Object title,sameTitle,sameKind,sameSeasons | Format-Table
