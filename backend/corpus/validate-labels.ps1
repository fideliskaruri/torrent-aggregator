param([switch]$Fix)

$ErrorActionPreference = 'Stop'
$path = Join-Path $PSScriptRoot 'names.tsv'
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$text = $utf8.GetString([IO.File]::ReadAllBytes($path))
$lines = $text.TrimEnd("`n") -split "`n"
$columns = $lines[0].Split([char]9)
if ($columns.Count -ne 20 -or $text.Contains("`r") -or -not $text.EndsWith("`n")) {
    throw 'Expected UTF-8, LF, final newline and 20 columns.'
}
foreach ($line in $lines) {
    if ($line.Split([char]9).Count -ne 20) { throw 'Invalid TSV field count.' }
}
$rows = @(Import-Csv $path -Delimiter "`t")
$raw = @(Import-Csv (Join-Path $PSScriptRoot 'raw-names.tsv') -Delimiter "`t")
$cache = @($rows | Where-Object origin -EQ 'cache')
if ($cache.Count -ne 3234 -or $cache.Count -ne $raw.Count) { throw 'Cache row loss.' }
for ($i = 0; $i -lt $raw.Count; $i++) {
    if ($cache[$i].name -cne $raw[$i].name -or $cache[$i].query -cne $raw[$i].query) {
        throw "Cache name/query changed at row $i."
    }
}

function Normalize([string]$name) {
    $name -replace '[._]', ' ' -replace '[–—−]', '-'
}
function Has-English([string]$name) {
    $name -match '(?i)\bENG(?:LISH)?\b|\bDUAL\b|\bMULTI\b(?![- ]*SUB)'
}
function Get-SeasonEpisode([string]$name) {
    $m = [regex]::Match($name, '(?i)\b(?:S(?<s>\d{1,2})(?!E\d)|(?<s>\d{1,2})(?:st|nd|rd|th)\s+Season|Season\s*(?<s>\d{1,2}))\s+(?:-\s*)?(?<e>\d{1,3})(?:v\d+)?(?=\s|[\[()]|$)')
    if (-not $m.Success) { return $null }
    $tokens = [regex]::Matches($name, '(?i)\bS\d{1,2}(?![\dE])|\b(?:\d{1,2}(?:st|nd|rd|th)\s+Season|Seasons?\s*\d{1,2})\b')
    if ($tokens.Count -ne 1) { return $null }
    $m
}
function Get-SceneGroup([string]$name) {
    $tail = [regex]::Match($name, '(?i)\b(?<g>BONE|NTb|FLUX|VARYG|ToonsHub|MeGusta|Kitsune|ION265|NeoNoir)(?:\s+(?:EZTV|mkv|avi|mp4))?$')
    if ($tail.Success -and $name -match '(?i)\b(?:x26[45]|H[ .]?26[45]|HEVC)\b') { return $tail.Groups['g'].Value }
    $m = [regex]::Match($name, '(?i)(?:[xh][ .]?26[45]|HEVC|XviD|AV1|MSubs|ESub)\s*-(?<g>[A-Za-z0-9][A-Za-z0-9_&-]*?)(?=(?:\[[^\]]+\])?(?:\.(?:mkv|mp4|avi))?(?:\s|[()]|$))')
    $group = $m.Groups['g'].Value -replace '(?i)-(?:avi|mkv|mp4)$', ''
    if ($m.Success -and $group -notmatch '(?i)^\d+bits?\b|^(?:x26[45]|HEVC|AVC|AAC|FLAC|DTS|Opus)$') {
        return $group
    }
    $null
}
function Get-Flags($row) {
    $n = Normalize $row.name
    $completeUnderscore = $row.name -match '(?i)Complete.*S\d{1,2}_\d{1,2}'
    if ($row.kind -eq 'multi_season' -and -not $completeUnderscore -and (Get-SeasonEpisode $n)) { 'season-token-read-as-range' }
    if ($row.kind -eq 'season_pack' -and $n -match '(?i)\bS\d{1,2}\s*-?\s*E\d|\bE(?:P(?:ISODE)?)?\s*\d|\bEP(?:ISODE)?\s*\(') { 'pack-with-episode-token' }
    if ($row.kind -eq 'season_pack' -and $row.episodes -match '(?:a?\d+)-(?:a?\d+)') { 'pack-with-episode-range' }
    $range = [regex]::Match($n, '(?i)\bS(?<s>\d{1,2})E(?<a>\d{1,3})\s*-\s*S\k<s>E(?<b>\d{1,3})\b')
    if ($range.Success -and ($row.kind -ne 'episode' -or $row.episodes -ne "$([int]$range.Groups['a'].Value)-$([int]$range.Groups['b'].Value)")) { 'repeated-season-episode-range' }
    if ($row.kind -eq 'episode' -and $row.episodes -match '-' -and $row.note -notmatch '(?i)episode range') { 'episode-range-note' }
    if ($row.foreign -eq 'unknown' -and (Has-English $n)) { 'unknown-with-english-marker' }
    if ($row.foreign -eq 'yes' -and (Has-English $n)) { 'foreign-with-english-marker' }
    $group = Get-SceneGroup $row.name
    if ($group -and $row.group -cne $group) { 'explicit-scene-group' }
    if ($row.group -match '(?i)^\d+bits?\b') { 'technical-token-as-group' }
    if ($row.name -eq 'Piyoko Sousou no Frieren Marumaru no Mahou Mini Anime 15 WEB 1080p YT VP9 AAC 2 0' -and $row.episodes -ne 'a15') { 'mini-anime-number' }
    if ($row.name -match '(?i)Complete.*S01_03' -and ($row.kind -ne 'multi_season' -or $row.seasons -ne '1-3')) { 'complete-underscore-season-range' }
}

$before = [Collections.Generic.List[object]]::new()
$changed = 0
foreach ($row in $rows) {
    $flags = @(Get-Flags $row)
    foreach ($flag in $flags) { $before.Add([pscustomobject]@{ flag = $flag; name = $row.name }) }
    if (-not $Fix -or -not $flags.Count) { continue }
    $n = Normalize $row.name
    $m = Get-SeasonEpisode $n
    if ($flags -contains 'season-token-read-as-range') {
        $row.kind = 'episode'
        $row.seasons = ([int]$m.Groups['s'].Value).ToString()
        $row.episodes = ([int]$m.Groups['e'].Value).ToString()
        $row.note += ' Correction: season token followed by a dash/number denotes one seasonal episode, not multiple seasons.'
    }
    if ($flags -contains 'pack-with-episode-token' -or $flags -contains 'pack-with-episode-range') {
        $row.kind = 'episode'
        if ($row.episodes -match '-') { $row.note += ' Correction: episode range; not an implied whole-season pack.' }
        else { $row.note += ' Correction: explicit episode token; not an implied whole-season pack.' }
    }
    if ($flags -contains 'repeated-season-episode-range') {
        $range = [regex]::Match($n, '(?i)\bS(?<s>\d{1,2})E(?<a>\d{1,3})\s*-\s*S\k<s>E(?<b>\d{1,3})\b')
        $row.kind = 'episode'
        $row.seasons = ([int]$range.Groups['s'].Value).ToString()
        $row.episodes = "$([int]$range.Groups['a'].Value)-$([int]$range.Groups['b'].Value)"
    }
    if ($row.kind -eq 'episode' -and $row.episodes -match '-' -and $row.note -notmatch '(?i)episode range') {
        $row.note += ' Correction: episode range; not an implied whole-season pack.'
    }
    if ($flags -contains 'unknown-with-english-marker' -or $flags -contains 'foreign-with-english-marker') {
        $row.foreign = 'no'
        $row.note += ' Correction: explicit English/MULTi/dual marker takes precedence over foreign-language markers.'
    }
    if ($flags -contains 'explicit-scene-group') {
        $row.group = Get-SceneGroup $row.name
        $row.note += ' Correction: explicit codec-adjacent scene group retained even before trailing platform/site or alias text.'
    }
    if ($flags -contains 'technical-token-as-group') {
        $row.group = ''
        $row.note += ' Correction: encoding bit-depth/audio tokens are not a release group.'
    }
    if ($flags -contains 'mini-anime-number') {
        $row.episodes = 'a15'
        $row.note += ' Correction: mini-anime absolute episode 15 is stated before WEB quality tokens.'
    }
    if ($flags -contains 'complete-underscore-season-range') {
        $row.kind = 'multi_season'
        $row.seasons = '1-3'
        $row.episodes = ''
        $row.note += ' Correction: Complete S01_03 is an underscore-separated multi-season pack, not S01 - 03 episode notation.'
    }
    $row.note = $row.note.Trim()
    $changed++
}
if ($Fix) {
    $out = [Collections.Generic.List[string]]::new()
    $out.Add($columns -join "`t")
    foreach ($row in $rows) {
        $out.Add((($columns | ForEach-Object { [string]$row.$_ }) -join "`t"))
    }
    [IO.File]::WriteAllText($path, ($out -join "`n") + "`n", [Text.UTF8Encoding]::new($false))
}
$before | Group-Object flag | ForEach-Object { "BEFORE $($_.Name): $($_.Count)" }
if (-not $Fix) {
    $before | ForEach-Object { "$($_.flag)`t$($_.name)" }
}
$after = @($rows | ForEach-Object { Get-Flags $_ })
"Rows: $($rows.Count); changed: $changed; remaining flags: $($after.Count)"
if ($after.Count) { exit 1 }
