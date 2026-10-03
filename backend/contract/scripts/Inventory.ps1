param([string]$Root = (Resolve-Path "$PSScriptRoot\..\..\..").Path)
$ErrorActionPreference = 'Stop'
$out = Join-Path $Root 'backend\contract'
$web = @(Get-ChildItem "$Root\web\src" -Recurse -File | Where-Object Extension -in '.ts','.tsx')
$calls = @()
$types = @()
foreach ($file in $web) {
    $text = [IO.File]::ReadAllText($file.FullName)
    $rel = $file.FullName.Substring($Root.Length + 1)
    foreach ($match in [regex]::Matches($text, '(?m)(?:export\s+)?(?:interface|type)\s+(\w+)[^\r\n]*')) {
        $line = ($text.Substring(0,$match.Index) -split "`n").Count
        $types += [ordered]@{ name=$match.Groups[1].Value; file=$rel; line=$line; declaration=$match.Value }
    }
    foreach ($match in [regex]::Matches($text, '(?m)^.*(?:/api/|fetch\(|sessionAwareFetch\(|useApiQuery|EventSource|queryKey|\bhc\().*$')) {
        $line = ($text.Substring(0,$match.Index) -split "`n").Count
        $calls += [ordered]@{ file=$rel; line=$line; text=$match.Value.Trim() }
    }
}
$routes = @()
foreach ($file in Get-ChildItem "$Root\server" -Recurse -File -Filter '*.cs' | Where-Object FullName -NotMatch '\\(?:tests|obj|bin)\\') {
    $text = [IO.File]::ReadAllText($file.FullName)
    $rel = $file.FullName.Substring($Root.Length + 1)
    $prefix = ''
    $base = [regex]::Match($text,'Route\("([^"]+)"\)')
    if ($base.Success) { $prefix = '/' + $base.Groups[1].Value.Trim('/') }
    if ($file.Name -like '*Controller.cs' -or $file.Name -eq 'AutomationScheduler.cs') {
    foreach ($m in [regex]::Matches($text,'Http(Get|Post|Put|Patch|Delete)(?:\("([^"]*)"\))?')) {
        $suffix = $m.Groups[2].Value
        $path = if ($suffix -match '^/?api/') { '/'+$suffix.TrimStart('/') } elseif ($suffix) { "$prefix/$suffix" } else { $prefix }
        if (!$path.StartsWith('/api/')) { continue }
        $line = ($text.Substring(0,$m.Index) -split "`n").Count
        $routes += [ordered]@{ method=$m.Groups[1].Value.ToUpperInvariant(); path=$path; file=$rel; line=$line }
    }
    }
    $groups = @{}
    foreach ($g in [regex]::Matches($text,'var\s+(\w+)\s*=\s*\w+\.MapGroup\("([^"]+)"\)')) { $groups[$g.Groups[1].Value]=$g.Groups[2].Value }
    foreach ($m in [regex]::Matches($text,'(\w+)\.Map(Get|Post|Put|Delete|Patch)\("([^"]*)"')) {
        $path=$m.Groups[3].Value
        if ($groups.ContainsKey($m.Groups[1].Value)) { $path=$groups[$m.Groups[1].Value]+$path }
        if (!$path.StartsWith('/api/')) { continue }
        $routes += [ordered]@{ method=$m.Groups[2].Value.ToUpperInvariant(); path=$path; file=$rel; line=($text.Substring(0,$m.Index) -split "`n").Count }
    }
}
[ordered]@{ routes=$routes; webReferences=$calls; types=$types } | ConvertTo-Json -Depth 15 | Set-Content "$out\source-index.json" -Encoding utf8
$routes | ForEach-Object { "$($_.method) $($_.path) $($_.file):$($_.line)" }
