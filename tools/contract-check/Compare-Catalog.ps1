param(
    [string] $OldBase = 'http://127.0.0.1:3931',
    [string] $NewBase = 'http://127.0.0.1:3940',
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\.catalog-proof')
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $OutputDirectory | Out-Null
function NameKey([string] $Title) {
    $Title.Normalize([Text.NormalizationForm]::FormKD).Replace([string][char]0x2019, [string][char]0x27).
        Replace([string][char]0x2013, '-').ToLowerInvariant()
}
function Read([string] $Base, [string] $Path) {
    Invoke-RestMethod ($Base.TrimEnd('/') + $Path) -TimeoutSec 180
}
$searchRows = foreach ($query in 'frieren','a silent voice','money heist','scorpion','rick and morty','sintel') {
    $path = '/api/search/titles?q=' + [Uri]::EscapeDataString($query)
    $old = Read $OldBase $path
    $new = Read $NewBase $path
    @{ query=$query; old=$old; new=$new } | ConvertTo-Json -Depth 30 |
        Set-Content (Join-Path $OutputDirectory ('search-' + $query.Replace(' ', '-') + '.json'))
    $oldTop = @($old.results | Select-Object -First 3)
    $newTop = @($new.results | Select-Object -First 3)
    $oldKeys = @($oldTop | ForEach-Object { (NameKey $_.title) + ':' + $_.year + ':' + $_.category })
    $newKeys = @($newTop | ForEach-Object { (NameKey $_.title) + ':' + $_.year + ':' + $_.category })
    [pscustomobject]@{
        query=$query; result=if(($oldKeys -join '|') -ceq ($newKeys -join '|')){'PASS'}else{'FAIL'}
        old=($oldTop.title -join ' | '); new=($newTop.title -join ' | ')
        oldCount=$oldTop.Count; newCount=$newTop.Count; partial=$new.partial
    }
}
$oldBrowse = Read $OldBase '/api/browse'
$newBrowse = Read $NewBase '/api/browse'
$oldBrowse | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $OutputDirectory 'rail-old-fresh-browse.json')
$newBrowse | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $OutputDirectory 'rail-new-browse.json')
$railRows = foreach ($rail in $oldBrowse.rails | Where-Object id -ne 'your-library') {
    $other = $newBrowse.rails | Where-Object id -eq $rail.id | Select-Object -First 1
    $oldTop = @($rail.items | Select-Object -First 6)
    $newTop = @($other.items | Select-Object -First 6)
    $positions = 0
    $shared = 0
    for ($i=0; $i -lt $oldTop.Count; $i++) {
        $key = NameKey $oldTop[$i].title
        if ($i -lt $newTop.Count -and $key -ceq (NameKey $newTop[$i].title)) { $positions++ }
        if (@($newTop | Where-Object { (NameKey $_.title) -ceq $key }).Count) { $shared++ }
    }
    [pscustomobject]@{
        rail=$rail.title; id=$rail.id; positions=$positions; shared=$shared
        oldCount=$oldTop.Count; newCount=$newTop.Count
        old=($oldTop.title -join ' | '); new=($newTop.title -join ' | ')
    }
}
@{ search=@($searchRows); rails=@($railRows); capturedAt=[DateTimeOffset]::UtcNow } |
    ConvertTo-Json -Depth 30 | Set-Content (Join-Path $OutputDirectory 'catalog-comparison.json')
$searchRows | Format-Table query,result,oldCount,newCount,partial -AutoSize |
    Out-String | Tee-Object (Join-Path $OutputDirectory 'search-table.txt')
$railRows | Format-Table rail,positions,shared,oldCount,newCount -AutoSize |
    Out-String | Tee-Object (Join-Path $OutputDirectory 'rail-table.txt')
if (@($searchRows | Where-Object { $_.result -ne 'PASS' -or $_.partial }).Count) { exit 1 }
if (@($railRows | Where-Object { $_.newCount -eq 0 }).Count) { exit 1 }
