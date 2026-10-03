$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3963'
$proof = $PSScriptRoot
function Post($path, $body) {
    Invoke-RestMethod "$base$path" -Method Post -ContentType application/json `
        -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 40)))
}
$added = Post '/api/dev/library/roots' @{
    path='D:\code\memtest\dlopen-library'; kinds=@(0,1,2,3); priority=1; reserveBytes=0; confirmed=$true
}
if (!$added.root) { throw ($added.failure | ConvertTo-Json) }
Invoke-RestMethod "$base/api/title/tmdb:movie:45745" | Out-Null
$work = (Invoke-RestMethod "$base/api/dev/plan-eval/metadata?workKey=tmdb:movie:45745").work
if (!$work) { throw 'Sintel metadata did not resolve' }
$work.work.kind = @('Unknown','Film','Series').IndexOf($work.work.kind)
$work.work.format = @('Unknown','Movie','Series','Special').IndexOf($work.work.format)
$work.work.releasePrecision = @('Unknown','Day','Instant').IndexOf($work.work.releasePrecision)
foreach ($name in $work.names) { $name.label = @('English','Romaji','Synonym','Native','Original').IndexOf($name.label) }
foreach ($link in $work.links) { $link.status = @('Verified','Suggested','Rejected').IndexOf($link.status) }
$hash = 'e1d833fe2adc88bc76b8b29e380b80e2ce43f82c'
$id = "$($work.work.id)-proof-film"
$now = [DateTimeOffset]::UtcNow.ToString('o')
$target = @{
    id=$id; workId=$work.work.id; kind=0; state=4; priority=0; rank=0
    createdBy='local'; origin=0; policyRevision=1; createdAt=$now; updatedAt=$now; version=1
}
$request = @{
    magnet="magnet:?xt=urn:btih:$hash"
    placement=@{
        work=$work; targets=@($target); roots=@(); owned=@(); files=@()
        assignment=@{
            hash=$hash; targetIds=@($id); reservedPieceBytes=129241752
            reason='Licensed local filing proof'
            files=@(@{targetId=$id; fileIndex=0; role=0})
        }
    }
}
$admitted = Post '/api/dev/filing/' $request
$admitted | ConvertTo-Json -Depth 40 | Set-Content "$proof\admission.json"
if (!$admitted.accepted) { throw ($admitted | ConvertTo-Json -Depth 20) }
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
do {
    Start-Sleep -Milliseconds 250
    $filed = Invoke-RestMethod "$base/api/dev/filing/"
    if ([DateTimeOffset]::UtcNow -gt $deadline) { throw ("Filing did not finish: " + ($filed.reasons | ConvertTo-Json)) }
} until ($filed.media.Count -gt 0)
$filed | ConvertTo-Json -Depth 40 | Set-Content "$proof\filed.json"
$seed = Get-FileHash 'D:\code\memtest\dlopen-fixture\seed\Sintel.mp4' -Algorithm SHA256
$final = Get-FileHash $filed.media[0].path -Algorithm SHA256
if ($seed.Hash -ne $final.Hash) { throw 'Final digest differs from seed' }
@{seed=$seed; final=$final; bytes=(Get-Item $filed.media[0].path).Length} | ConvertTo-Json -Depth 8 | Set-Content "$proof\digest.json"
foreach ($mode in @('open','reveal')) {
    $result = Post "/api/downloads/builtin:$hash/open" @{mode=$mode}
    if (!$result.ok -or $result.launched -or $result.path -ne $filed.media[0].path) { throw "Invalid $mode result" }
    $result | ConvertTo-Json -Depth 8 | Set-Content "$proof\$mode.json"
}
Invoke-RestMethod "$base/api/client/torrents" | ConvertTo-Json -Depth 40 | Set-Content "$proof\torrents.json"
'Sintel filed; identical digest; Open and Show in folder resolve final path without launch.'
