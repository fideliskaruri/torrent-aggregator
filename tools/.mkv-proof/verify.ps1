$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3961'
function Check($condition, $message) {
    if (-not $condition) { throw $message }
}
function Scan($name, $path) {
    $start = Invoke-RestMethod "$base/api/library/imports/scan" -Method Post -ContentType application/json -Body (@{path=$path} | ConvertTo-Json)
    $deadline = (Get-Date).AddMinutes(3)
    do {
        $scan = Invoke-RestMethod "$base/api/library/imports/$($start.scanId)"
        if ($scan.state -in @('complete','failed')) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    $scan | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $PSScriptRoot "$name.json")
    Check ($scan.state -eq 'complete') "Scan failed: $name"
    return $scan
}
$native = Get-Content (Join-Path $PSScriptRoot 'native-read.json') -Raw | ConvertFrom-Json
$edgeRoot = Join-Path $PSScriptRoot 'edges'
$edge = @($native | Where-Object { $_.path.StartsWith($edgeRoot + '\', [StringComparison]::OrdinalIgnoreCase) })
foreach ($row in $edge) {
    if ($row.path -match 'float4|float8|odd-padding') {
        Check ($row.Width -eq 1024 -and $row.Height -eq 436 -and [Math]::Abs($row.RuntimeSeconds - 888.064) -lt 0.1) "Valid metadata variant failed: $($row.path)"
    } else {
        Check ($null -eq $row.RuntimeSeconds) "Invalid duration was accepted: $($row.path)"
    }
}
Check (@($native | Where-Object { $_.readBytes -gt 100000 }).Count -eq 0) 'Reader exceeded the bounded header budget.'
$fixture = Join-Path $PSScriptRoot 'http-fixtures'
New-Item -ItemType Directory -Force "$fixture\valid","$fixture\wrong","$fixture\unreadable" | Out-Null
Copy-Item (Join-Path $PSScriptRoot 'fixtures\Sintel.mkv') "$fixture\valid\Sintel.mkv"
Copy-Item (Join-Path $PSScriptRoot 'fixtures\Sintel.mkv') "$fixture\wrong\Dune (2021).mkv"
Copy-Item (Join-Path $PSScriptRoot 'edges\missing-duration.mkv') "$fixture\unreadable\Sintel (2010).mkv"
$positive = Scan 'http-sintel' "$fixture\valid"
$item = $positive.items[0]
Check ($positive.items.Count -eq 1 -and $item.group -eq 'Confident' -and $item.candidates[0].title -eq 'Sintel') 'Sintel MKV was not Confident Sintel.'
foreach ($extension in 'webm','avi') {
    New-Item -ItemType Directory -Force "$fixture\$extension" | Out-Null
    Copy-Item (Join-Path $PSScriptRoot "fixtures\Sintel.$extension") "$fixture\$extension\Sintel.$extension"
    $scan = Scan "http-sintel-$extension" "$fixture\$extension"
    Check ($scan.items[0].group -eq 'Confident' -and $scan.items[0].candidates[0].title -eq 'Sintel') "Sintel $extension was not Confident Sintel."
}
$wrong = Scan 'http-wrong-runtime' "$fixture\wrong"
Check ($wrong.items[0].group -eq 'NeedsPick' -and $wrong.items[0].message -match 'runtime does not fit') 'Renamed MKV did not fail runtime comparison.'
$unreadable = Scan 'http-unreadable' "$fixture\unreadable"
Check ($unreadable.items[0].group -eq 'NeedsPick' -and $unreadable.items[0].message -match 'runtime could not be read') 'Unreadable duration became Confident.'
$result = Invoke-RestMethod "$base/api/library/imports/$($positive.id)/confirm" -Method Post -ContentType application/json -Body (@{
    mode='TrackInPlace';items=@(@{itemId=$item.id;workId=$item.candidates[0].workId})
} | ConvertTo-Json -Depth 5)
$result | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $PSScriptRoot 'http-confirm.json')
Check $result.items[0].imported 'MKV explicit import failed.'
$owned = Invoke-RestMethod "$base/api/library/owned/$($item.candidates[0].workId)"
$owned | ConvertTo-Json -Depth 40 | Set-Content (Join-Path $PSScriptRoot 'http-owned.json')
Write-Output 'Native metadata edge checks and real HTTP import assertions passed.'
