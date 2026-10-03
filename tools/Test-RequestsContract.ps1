$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$proof = Join-Path $PSScriptRoot '.requests-proof'
New-Item -ItemType Directory -Force $proof | Out-Null
$owner = 'http://127.0.0.1:3952'
$remote = 'http://127.0.0.1:48952'
$data = 'D:\code\memtest\rebuild-requests'
$dll = 'D:\code\memtest\bin-requests\TorrentFlow.dll'
$results = [System.Collections.Generic.List[string]]::new()
$rsa = [Security.Cryptography.RSA]::Create(2048)
function B64([byte[]]$bytes) { [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
$key = $rsa.ExportParameters($false)
@{ keys = @(@{ kty='RSA'; alg='RS256'; use='sig'; kid='requests-proof'; n=(B64 $key.Modulus); e=(B64 $key.Exponent) }) } |
    ConvertTo-Json -Depth 10 | Set-Content "$proof\jwks.json"
function Token($email) {
    $head = B64 ([Text.Encoding]::UTF8.GetBytes('{"alg":"RS256","kid":"requests-proof"}'))
    $body = B64 ([Text.Encoding]::UTF8.GetBytes((@{iss='https://requests-proof.cloudflareaccess.com';aud=@('requests-proof');
        exp=[DateTimeOffset]::UtcNow.AddHours(1).ToUnixTimeSeconds();email=$email} | ConvertTo-Json -Compress)))
    "$head.$body.$(B64 ($rsa.SignData([Text.Encoding]::ASCII.GetBytes("$head.$body"),[Security.Cryptography.HashAlgorithmName]::SHA256,[Security.Cryptography.RSASignaturePadding]::Pkcs1)))"
}
function Call($name,$path,$method='GET',$body=$null,$email=$null,$expected=200) {
    $base = if ($email) {$remote} else {$owner}
    $options=@{Uri="$base$path";Method=$method;NoProxy=$true;SkipHttpErrorCheck=$true;TimeoutSec=60}
    if ($email) {$options.Headers=@{'Cf-Access-Jwt-Assertion'=(Token $email)}}
    if ($null -ne $body) {$options.Body=$body | ConvertTo-Json -Depth 30 -Compress;$options.ContentType='application/json'}
    $r=Invoke-WebRequest @options
    $json=if($r.Content){$r.Content | ConvertFrom-Json -Depth 80}else{$null}
    @{status=[int]$r.StatusCode;body=$json} | ConvertTo-Json -Depth 80 | Set-Content "$proof\$name.json"
    if ([int]$r.StatusCode -ne $expected) {throw "$name expected $expected got $($r.StatusCode): $($r.Content)"}
    $results.Add("PASS $name HTTP $expected")
    $json
}
function StartApi($development) {
    $info=[Diagnostics.ProcessStartInfo]::new('dotnet')
    $info.UseShellExecute=$false
    $info.RedirectStandardOutput=$true
    $info.RedirectStandardError=$true
    foreach($a in @($dll,'--urls',$owner,'--TorrentFlow:DataDirectory',$data,'--TorrentFlow:Scheduler:Disabled','true','--background','--no-browser')) {$info.ArgumentList.Add($a)}
    if ($development) {
        foreach($a in @('--environment','Development','--TorrentFlow:RemoteAccess:Enabled','true',
            '--TorrentFlow:RemoteAccess:TunnelPort','48952','--TorrentFlow:RemoteAccess:TeamDomain','requests-proof',
            '--TorrentFlow:RemoteAccess:Audience','requests-proof','--TorrentFlow:RemoteAccess:OwnerEmails','owner@example.test',
            '--TorrentFlow:RemoteAccess:DevJwksPath',"$proof\jwks.json")) {$info.ArgumentList.Add($a)}
    }
    $info.Environment['TMDB_API_KEY']=(Get-Content 'C:\Users\fwachira\.copilot\session-state\88fafede-1c4e-4fcb-aa69-48d8dede6235\files\debug30\tmdb.key' -Raw).Trim()
    $script:api=[Diagnostics.Process]::Start($info)
    $script:stdout=$api.StandardOutput.ReadToEndAsync()
    $script:stderr=$api.StandardError.ReadToEndAsync()
    $api.Id | Set-Content "$proof\server.pid"
    for($i=0;$i -lt 80;$i++) {
        if($api.HasExited){throw "Server exited: $($stdout.Result) $($stderr.Result)"}
        try {
            $health=Invoke-WebRequest "$owner/api/health" -NoProxy -TimeoutSec 1 -SkipHttpErrorCheck
            if($health.StatusCode -in @(200,503)) { $script:healthStatus=[int]$health.StatusCode; return }
        }catch{}
        Start-Sleep -Milliseconds 250
    }
    throw 'Server did not become ready.'
}
function StopApi {
    if($script:api -and !$script:api.HasExited) {
        # The exact PID is captured from our child, never a process-name selector.
        Stop-Process -Id $script:api.Id
        $script:api.WaitForExit()
        $script:stdout.Result | Add-Content "$proof\server.log"
        $script:stderr.Result | Add-Content "$proof\server-error.log"
    }
}
try {
    if(Get-NetTCPConnection -LocalPort 3952,48952 -State Listen -ErrorAction SilentlyContinue){throw 'Proof ports occupied.'}
    StartApi $false
    $null=Call 'health' '/api/health' GET $null $null $script:healthStatus
    if($script:healthStatus -ne 200){$results.Add('FAIL database readiness HTTP 503, tracked as OPS-780; request API proof continues.')}
    StopApi
    StartApi $true
    $null=Call 'requester-session' '/api/me' GET $null 'requester@example.test'
    $draft=@{provider='tmdb';providerId='45745';mediaType='movie';title='Sintel';year=2010;scope='movie';seasons=@();note='Free film requests proof'}
    $created=Call 'create-sintel' '/api/requester/requests' POST $draft 'requester@example.test' 201
    $id=$created.request.id
    $null=Call 'duplicate-own-request' '/api/requester/requests' POST $draft 'requester@example.test' 409
    $null=Call 'owner-requester-route-denied' '/api/requester/requests' GET $null $null 403
    $null=Call 'calendar-own' '/api/requester/calendar' GET $null 'requester@example.test'
    $calendar=Call 'calendar-other' '/api/requester/calendar' GET $null 'other@example.test'
    if($calendar.items.Count -ne 0){throw 'Calendar leaked another user request.'}
    $null=Call 'requester-owner-denied' "/api/requests/$id/approve" POST $null 'requester@example.test' 403
    $null=Call 'private-other-user' '/api/requester/requests' GET $null 'other@example.test'
    $other=Call 'private-other-user-check' '/api/requester/requests' GET $null 'other@example.test'
    if($other.requests.Count -ne 0){throw 'Request leaked to another user.'}
    $null=Call 'decline' "/api/requests/$id/decline" POST @{reason='Proof decline'}
    $null=Call 'declined-details' '/api/requester/requests' GET $null 'requester@example.test'
    $null=Call 'retry-declined' "/api/requests/$id/retry" POST
    $null=Call 'approve-idempotent' "/api/requests/$id/approve" POST
    $null=Call 'auto-approve-put' '/api/requests/auto-approve' PUT @{rules=@(@{email='other@example.test';mode='moviesOnly'})}
    $auto=Call 'auto-approved-create' '/api/requester/requests' POST $draft 'other@example.test' 201
    if($auto.request.status -eq 'pending'){throw 'Auto-approve did not approve.'}
    $details=Call 'mine-full-details' '/api/requester/requests' GET $null 'requester@example.test'
    if($details.requests.Count -ne 1 -or $details.requests[0].id -ne $id){throw 'Requester list includes another user request.'}
    foreach($field in @('id','title','year','mediaType','provider','providerId','posterUrl','scope','seasons',
        'note','status','decisionReason','decidedAt','createdAt','updatedAt','done','total','airing',
        'quality','size','releaseName','seeders','progress','speed','eta','pickReasons','expectedDate')) {
        if($details.requests[0].PSObject.Properties.Name -notcontains $field){throw "Requester contract missing $field"}
    }
    $baseline=Get-Content "$root\backend\contract\captures\requests\owner.json" -Raw | ConvertFrom-Json
    $ownerRows=Call 'owner-requests' '/api/requests'
    foreach($field in $baseline.body.PSObject.Properties.Name) {
        if($ownerRows.PSObject.Properties.Name -notcontains $field){throw "Owner capture shape missing $field"}
    }
    if($ownerRows.requests.Count -ne 1 -or $ownerRows.requests[0].requesters.Count -ne 2){throw 'Shared owner request card was not grouped.'}
    $results.Add('PASS populated requester web-contract fields and owner capture shape.')
    $null=Call 'readonly-cancel' "/api/requester/requests/$id/cancel" POST $null 'requester@example.test' 403
    $null=Call 'library' '/api/requester/library' GET $null 'requester@example.test'
    $null=Call 'auto-approve-get' '/api/requests/auto-approve'
    $null=Call 'pick-missing-public-api' "/api/requests/$id/pick" POST @{token='proof'} $null 409
    $results.Add('REMAINS manual pick: Targets public API has no picker command.')
    $results.Add('REMAINS actual transfer and owned-item proof: inspect target/download evidence.')
    $results | Set-Content "$proof\results.txt"
} catch {
    $results.Add("FAIL $($_.Exception.Message)")
    $results | Set-Content (Join-Path $proof $(if($Continue){'transfer-results.txt'}else{'results.txt'}))
    throw
} finally { StopApi; $rsa.Dispose() }
