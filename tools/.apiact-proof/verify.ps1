$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3967'
$source = 'D:\code\platformApps-worktrees\rebuild\tools\.filing-proof\seed\Sintel\Sintel.mp4'
$copy = 'D:\code\memtest\import-apiact\Sintel\Sintel.mp4'
function Save($name, $value) {
    $value | ConvertTo-Json -Depth 60 | Set-Content (Join-Path $PSScriptRoot "$name.json")
}
function Check($condition, $message) {
    if (-not $condition) { throw $message }
}
function ImportSintel {
    New-Item -ItemType Directory -Force (Split-Path $copy) | Out-Null
    Copy-Item $source $copy
    $start = Invoke-RestMethod "$base/api/library/imports/scan" -Method Post -ContentType application/json -Body '{"path":"D:\\code\\memtest\\import-apiact"}'
    $deadline = (Get-Date).AddMinutes(2)
    do {
        $scan = Invoke-RestMethod "$base/api/library/imports/$($start.scanId)"
        if ($scan.state -in @('complete','failed')) { break }
        Start-Sleep -Milliseconds 250
    } while ((Get-Date) -lt $deadline)
    Save 'scan' $scan
    Check ($scan.state -eq 'complete' -and $scan.items[0].group -eq 'Confident') 'Sintel scan failed.'
    $result = Invoke-RestMethod "$base/api/library/imports/$($scan.id)/confirm" -Method Post -ContentType application/json -Body (@{
        mode='TrackInPlace';items=@(@{itemId=$scan.items[0].id;workId=$scan.items[0].candidates[0].workId})
    } | ConvertTo-Json -Depth 5)
    Save 'import' $result
    Check $result.items[0].imported 'Track-in-place failed.'
}
ImportSintel
$watch = Invoke-RestMethod "$base/api/watchlist"
Save 'watchlist-imported' $watch
Check ($watch.items.Count -eq 1 -and $watch.items[0].ready) 'Owned title missing.'
$id = $watch.items[0].id
$preview = Invoke-RestMethod "$base/api/library/delete?watchListItemId=$id&scope=show"
Save 'delete-preview' $preview
Check ($preview.ok -and $preview.plan.outcome -eq 'deletes' -and $preview.plan.fileCount -eq 1) 'Preview did not include copied file.'
$unconfirmed = Invoke-WebRequest "$base/api/library/delete" -Method Post -ContentType application/json -Body (@{
    watchListItemId=$id;scope='show'
} | ConvertTo-Json) -SkipHttpErrorCheck
Save 'unconfirmed' @{status=$unconfirmed.StatusCode;body=$unconfirmed.Content}
Check ($unconfirmed.StatusCode -eq 400 -and (Test-Path $copy)) 'Unconfirmed action deleted bytes.'
$deleted = Invoke-RestMethod "$base/api/library/delete" -Method Post -ContentType application/json -Body (@{
    watchListItemId=$id;scope='show';confirm=$true
} | ConvertTo-Json)
Save 'delete-result' $deleted
Check ($deleted.ok -and $deleted.freedFiles -eq 1 -and -not (Test-Path $copy)) 'Scoped deletion failed.'
$empty = Invoke-RestMethod "$base/api/watchlist"
Save 'watchlist-after-delete' $empty
Check ($empty.items.Count -eq 0) 'Deleted file-only work survived.'
ImportSintel
$watch = Invoke-RestMethod "$base/api/watchlist"
$patch = Invoke-RestMethod "$base/api/watchlist" -Method Patch -ContentType application/json -Body (@{
    id=$watch.items[0].id;status='watching';monitored=$true
} | ConvertTo-Json)
Save 'intent-added' $patch
$watch = Invoke-RestMethod "$base/api/watchlist"
$deleted = Invoke-RestMethod "$base/api/library/delete" -Method Post -ContentType application/json -Body (@{
    watchListItemId=$watch.items[0].id;scope='show';confirm=$true
} | ConvertTo-Json)
Save 'owned-intent-delete' $deleted
Check ($deleted.ok -and -not (Test-Path $copy)) 'Owned plus intent deletion failed.'
$watch = Invoke-RestMethod "$base/api/watchlist"
Save 'owned-intent-after-delete' $watch
Check ($watch.items.Count -eq 0) 'Persisted intent survived scoped deletion.'
Save 'original-fixture' @{sha256=(Get-FileHash $source).Hash;bytes=(Get-Item $source).Length}
Write-Output 'OPS-843 HTTP assertions passed.'
