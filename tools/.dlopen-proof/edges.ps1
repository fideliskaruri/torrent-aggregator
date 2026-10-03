$ErrorActionPreference = 'Stop'
$base = 'http://127.0.0.1:3963'
$hash = 'e1d833fe2adc88bc76b8b29e380b80e2ce43f82c'
$results = @()
function Check($id, $body, $expected, $reason) {
    $r = Invoke-WebRequest "$base/api/downloads/$id/open" -Method Post `
        -ContentType application/json -Body ($body | ConvertTo-Json) -SkipHttpErrorCheck
    $data = $r.Content | ConvertFrom-Json
    if ($r.StatusCode -ne $expected -or $data.reason -ne $reason) { throw "Unexpected refusal: $($r.Content)" }
    @{id=$id; status=$r.StatusCode; response=$data}
}
$results += Check 'invalid' @{mode='open'} 400 'invalid-id'
$results += Check ('builtin:' + ('a' * 40)) @{mode='open'} 404 'not-found'
$results += Check "qbittorrent:$hash" @{mode='open'} 409 'other-client'
$results += Check "builtin:$hash" @{mode='play'} 400 'invalid-mode'
$file = (Get-Content "$PSScriptRoot\open.json" -Raw | ConvertFrom-Json).path
Move-Item -LiteralPath $file -Destination "$file.proof-held"
try {
    $results += Check "builtin:$hash" @{mode='open'} 410 'files-missing'
    $results += Check "builtin:$hash" @{mode='reveal'} 410 'files-missing'
}
finally { Move-Item -LiteralPath "$file.proof-held" -Destination $file }
$restored = Invoke-RestMethod "$base/api/downloads/builtin:$hash/open" -Method Post `
    -ContentType application/json -Body '{"mode":"open"}'
if (!$restored.ok -or $restored.launched) { throw 'Restore did not reopen without launch' }
@{refusals=$results; restored=$restored} | ConvertTo-Json -Depth 10 | Set-Content "$PSScriptRoot\edges.json"
'Invalid/unknown/external ids, invalid mode, missing-file refusals and restore pass.'
