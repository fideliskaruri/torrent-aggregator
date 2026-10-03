$ErrorActionPreference='Stop'
$out=(Resolve-Path "$PSScriptRoot\..").Path
$routes=Get-Content "$out\routes.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
$shapes=Get-Content "$out\shapes.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
function Check-Arrays($value) {
    if($value -is [array]) {
        if($value.Count -gt 20){throw "A captured body array exceeds 20 entries"}
        foreach($item in $value){Check-Arrays $item}
    } elseif($value -is [System.Collections.IDictionary]) {
        foreach($key in $value.Keys){Check-Arrays $value[$key]}
    }
}
$files=@(Get-ChildItem "$out\captures" -Recurse -Filter '*.json')
foreach($file in $files){
    $c=Get-Content $file.FullName -Raw|ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String
    foreach($key in 'method','path','status','contentType','body'){
        if(!$c.ContainsKey($key)){throw "$($file.Name) missing $key"}
    }
    Check-Arrays $c.body
    $isolatedScan = $c.method -eq 'POST' -and $c.path -eq '/api/library/imports/scan' -and
        $c.evidence -eq 'Real HTTP response from isolated rebuild on 3966; not a legacy capture.' -and
        $c.requestBody.path -eq 'D:\code\memtest\apic2\empty-import'
    if(!$isolatedScan -and $c.method -ne 'GET' -and $c.path -ne '/api/artwork' -and $c.path -ne '/api/library/backfill-estimate' -and $c.path -ne '/api/settings/tmdb/test' -and $c.path -notmatch '^/api/settings/sources/[^/]+/test$'){
        throw "Unexpected mutation in captures: $($c.method) $($c.path)"
    }
}
foreach($route in $routes){
    if(!$route.mutates -and !$route.captures.Count){throw "Read route not captured: $($route.method) $($route.path)"}
    foreach($file in $route.captures){if(!(Test-Path "$out\$file")){throw "Missing capture $file"}}
}
$duplicates=@($routes|Group-Object { "$($_.method) $($_.path)" }|Where-Object Count -gt 1)
if($duplicates.Count){throw 'Duplicate route patterns'}
if($shapes.captures.Count -ne $files.Count){throw 'Capture/schema count differs'}
$findings=Get-Content "$out\ts-cross-check.json" -Raw|ConvertFrom-Json -AsHashtable -Depth 100
$unique=@($findings|ForEach-Object{foreach($finding in $_.findings){$_.route+' '+($finding.field -replace '\[\d+\]','[]')+' '+$finding.kind}}|Sort-Object -Unique)
$report=[ordered]@{
    routes=$routes.Count;webRoutes=@($routes|Where-Object scope -eq 'web').Count
    serverOnly=@($routes|Where-Object scope -eq 'server only').Count
    capturedRoutePatterns=@($routes|Where-Object evidence -like 'captured*').Count
    fromSourceOnly=@($routes|Where-Object evidence -notlike 'captured*').Count
    captures=$files.Count;schemas=$shapes.captures.Count;uniqueTSMismatches=$unique
    checks=@('All capture JSON parsed','All bodies recursively capped at 20','All non-mutating route patterns covered','No duplicate method/path','Only allowlisted read probes and isolated empty-folder scans captured','Every capture has a schema')
    success=$true
}
$report|ConvertTo-Json -Depth 20|Set-Content "$out\verification.json" -Encoding utf8
$report|ConvertTo-Json -Depth 20
