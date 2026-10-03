param(
    [string] $DataDirectory = 'D:\code\memtest\rebuild-dev\data',
    [string] $LanAddress,
    [int] $OwnerPort = 3940
)
$ErrorActionPreference = 'Stop'
if (Get-NetTCPConnection -LocalPort $OwnerPort,3941 -State Listen -ErrorAction SilentlyContinue) {
    throw "Ports $OwnerPort/3941 are occupied; refusing to stop another process."
}
$local = "http://127.0.0.1:$OwnerPort"
$root = Split-Path $PSScriptRoot -Parent
$proof = Join-Path $PSScriptRoot '.access-proof'
New-Item -ItemType Directory -Force $proof | Out-Null
$dll = Join-Path $root 'backend\src\Api\bin\Debug\net10.0\TorrentFlow.dll'
$results = [System.Collections.Generic.List[string]]::new()
$process = $null
$original = $null

function Assert-Shape($Expected, $Actual, [string] $Path = '$', [bool] $NullableVariants = $false) {
    if ($null -eq $Expected) {
        if ($NullableVariants -and $Path -match '\.(teamDomain|audience|issuer|tunnelUrl|keysError)$' -and $Actual -is [string]) { return }
        if ($NullableVariants -and $Path -match '\.keyCount$' -and $Actual -is [ValueType]) { return }
        if ($null -ne $Actual) { throw "$Path expected observed null" }
        return
    }
    if ($Expected -is [System.Management.Automation.PSCustomObject]) {
        if ($Actual -isnot [System.Management.Automation.PSCustomObject]) { throw "$Path expected object" }
        foreach ($p in $Expected.PSObject.Properties) {
            if ($Actual.PSObject.Properties.Name -notcontains $p.Name) { throw "$Path missing $($p.Name)" }
            Assert-Shape $p.Value $Actual.($p.Name) "$Path.$($p.Name)" $NullableVariants
        }
    } elseif ($Expected -is [Array]) {
        if ($Actual -isnot [Array]) { throw "$Path expected array" }
        if ($Expected.Count -gt 0) {
            foreach ($item in $Actual) { Assert-Shape $Expected[0] $item "$Path[]" $NullableVariants }
        }
    } elseif ($Expected -is [bool]) {
        if ($Actual -isnot [bool]) { throw "$Path expected boolean" }
    } elseif ($Expected -is [string]) {
        if ($Actual -isnot [string]) { throw "$Path expected string" }
    } elseif ($Actual -isnot [ValueType] -or $Actual -is [bool]) { throw "$Path expected number" }
}
function Call([string] $Name, [string] $Url, [int] $Status, [string] $Method = 'GET', $Body = $null, $Headers = @{}) {
    $options = @{ Uri = $Url; Method = $Method; Headers = $Headers; SkipHttpErrorCheck = $true; TimeoutSec = 20; NoProxy = $true }
    if ($null -ne $Body) { $options.Body = ($Body | ConvertTo-Json -Depth 20 -Compress); $options.ContentType = 'application/json' }
    $response = Invoke-WebRequest @options
    if ([int] $response.StatusCode -ne $Status) { throw "$Name expected $Status, got $($response.StatusCode): $($response.Content)" }
    $data = if ($response.Content) { $response.Content | ConvertFrom-Json -Depth 50 } else { $null }
    @{ status = [int]$response.StatusCode; body = $data } | ConvertTo-Json -Depth 50 |
        Set-Content (Join-Path $proof "$Name.json") -Encoding utf8
    $results.Add("PASS $Name HTTP $Status")
    return $data
}
function Start-Api([bool] $Remote) {
    $argsList = @($dll, '--urls', $local, '--TorrentFlow:DataDirectory', $DataDirectory,
        '--TorrentFlow:Scheduler:Disabled', 'true', '--background', '--no-browser')
    if ($Remote) { $argsList += @('--environment', 'Development', '--TorrentFlow:RemoteAccess:DevJwksPath', (Join-Path $proof 'jwks.json')) }
    $script:process = Start-Process dotnet -ArgumentList $argsList -PassThru -RedirectStandardOutput (Join-Path $proof 'server.log') -RedirectStandardError (Join-Path $proof 'server-error.log')
    for ($i = 0; $i -lt 80; $i++) {
        if ($process.HasExited) { throw "Server exited: $(Get-Content (Join-Path $proof 'server.log') -Raw) $(Get-Content (Join-Path $proof 'server-error.log') -Raw)" }
        try {
            $health = Invoke-WebRequest "$local/api/health" -TimeoutSec 1 -NoProxy
            if ($health.StatusCode -eq 200) { return }
        } catch { Start-Sleep -Milliseconds 250 }
    }
    throw 'Server was not ready.'
}
function Stop-Api {
    if ($script:process -and !$script:process.HasExited) {
        Stop-Process -Id $script:process.Id
        $script:process.WaitForExit()
    }
    $script:process = $null
}
function Check-Logout([string] $Url, $Headers, [string] $ExpectedLocation, [string] $Name) {
    $handler = [Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $false
    $handler.UseProxy = $false
    $client = [Net.Http.HttpClient]::new($handler)
    try {
        foreach ($key in $Headers.Keys) { $null = $client.DefaultRequestHeaders.TryAddWithoutValidation($key, [string]$Headers[$key]) }
        $response = $client.GetAsync($Url).GetAwaiter().GetResult()
        try {
            if ([int]$response.StatusCode -ne 302 -or $response.Headers.Location.OriginalString -ne $ExpectedLocation) {
                throw "$Name expected 302 to $ExpectedLocation, got $($response.StatusCode) $($response.Headers.Location)"
            }
            $results.Add("PASS $Name HTTP 302 Location $ExpectedLocation")
        } finally { $response.Dispose() }
    } finally { $client.Dispose() }
}
function Base64Url([byte[]] $Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_') }
function Token([string] $Email, [string] $Audience = 'testaud1', [string] $Issuer = 'https://verification-team.cloudflareaccess.com',
    [int] $Seconds = 3600, [string] $Algorithm = 'RS256', [System.Security.Cryptography.RSA] $Signer = $rsa) {
    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $header = Base64Url ([Text.Encoding]::UTF8.GetBytes((@{ alg = $Algorithm; kid = 'proof'; typ = 'JWT' } | ConvertTo-Json -Compress)))
    $payload = Base64Url ([Text.Encoding]::UTF8.GetBytes((@{ iss = $Issuer; aud = @($Audience); exp = $now + $Seconds; nbf = $now - 5; email = $Email } | ConvertTo-Json -Compress)))
    $signed = "$header.$payload"
    $signature = $Signer.SignData([Text.Encoding]::ASCII.GetBytes($signed), [Security.Cryptography.HashAlgorithmName]::SHA256, [Security.Cryptography.RSASignaturePadding]::Pkcs1)
    "$signed.$(Base64Url $signature)"
}

try {
    if (!$LanAddress) {
        $LanAddress = Get-NetIPAddress -AddressFamily IPv4 | Where-Object {
            $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' -and $_.AddressState -eq 'Preferred'
        } | Select-Object -First 1 -ExpandProperty IPAddress
    }
    if (!$LanAddress) { throw 'No non-loopback IPv4 address is available.' }
    Start-Api $false
    $baseline = @(
        @{ name = 'me'; path = '/api/me'; capture = 'me\owner.json' },
        @{ name = 'features'; path = '/api/features'; capture = 'features\default.json' },
        @{ name = 'remote-settings'; path = '/api/settings/remote-access'; capture = 'settings\remote-access.json' },
        @{ name = 'remote-check'; path = '/api/settings/remote-access/check'; capture = 'settings\remote-check.json' }
    )
    foreach ($case in $baseline) {
        $actual = Call $case.name "$local$($case.path)" 200
        $expected = Get-Content (Join-Path $root "backend\contract\captures\$($case.capture)") -Raw | ConvertFrom-Json -Depth 50
        Assert-Shape $expected.body $actual
        $results.Add("SHAPE PASS GET $($case.path) against $($case.capture)")
        if ($case.name -eq 'remote-settings') { $original = $actual }
    }
    Check-Logout "$local/cdn-cgi/access/logout" @{} '/' 'local-sign-out'
    foreach ($case in @(
        @{ name = 'wrong-content-type'; status = 415; contentType = 'text/plain'; body = '{}' },
        @{ name = 'empty-body'; status = 400; contentType = 'application/json'; body = '' },
        @{ name = 'malformed-body'; status = 400; contentType = 'application/json'; body = '{' },
        @{ name = 'non-object-body'; status = 400; contentType = 'application/json'; body = '[]' },
        @{ name = 'oversized-body'; status = 413; contentType = 'application/json'; body = ('x' * 16385) }
    )) {
        $response = Invoke-WebRequest "$local/api/settings/remote-access" -Method PUT `
            -Body $case.body -ContentType $case.contentType -SkipHttpErrorCheck -NoProxy
        if ([int]$response.StatusCode -ne $case.status) { throw "$($case.name) expected $($case.status), got $($response.StatusCode)" }
        $results.Add("PASS $($case.name) HTTP $($case.status)")
    }
    if ($original.enabled) { throw 'This proof requires remote access initially disabled.' }
    $null = Call 'invalid-settings' "$local/api/settings/remote-access" 400 PUT @{ enabled = $true }
    $null = Call 'unknown-settings' "$local/api/settings/remote-access" 400 PUT @{ password = 'not-supported' }
    $null = Call 'cross-site-settings' "$local/api/settings/remote-access" 403 PUT @{ enabled = $false } @{ 'Sec-Fetch-Site' = 'cross-site' }
    $null = Call 'spoofed-owner' "$local/api/me" 421 GET $null @{ 'Cf-Access-Jwt-Assertion' = 'forged'; 'X-Forwarded-For' = '127.0.0.1' }
    $config = @{ enabled = $true; tunnelPort = 3941; tunnelBindAddress = '0.0.0.0'; teamDomain = 'verification-team';
        audience = 'testaud1'; ownerEmails = @('OWNER@verification.invalid'); allowRequesters = $true }
    $saved = Call 'enable-remote' "$local/api/settings/remote-access" 200 PUT $config
    Assert-Shape $original $saved '$' $true
    $results.Add('SHAPE PASS PUT /api/settings/remote-access against GET capture')
    if (!$saved.restartRequired -or $saved.ownerEmails[0] -ne 'owner@verification.invalid') { throw 'Settings normalization/restart semantics failed.' }
    Stop-Api
    $rsa = [Security.Cryptography.RSA]::Create(2048)
    $public = $rsa.ExportParameters($false)
    @{ keys = @(@{ kty = 'RSA'; kid = 'proof'; use = 'sig'; alg = 'RS256'; n = (Base64Url $public.Modulus); e = (Base64Url $public.Exponent) }) } |
        ConvertTo-Json -Depth 10 | Set-Content (Join-Path $proof 'jwks.json') -Encoding utf8
    Start-Api $true
    $remote = "http://${LanAddress}:3941"
    $owner = @{ 'Cf-Access-Jwt-Assertion' = (Token 'owner@verification.invalid') }
    $requester = @{ 'Cf-Access-Jwt-Assertion' = (Token 'friend@verification.invalid') }
    Check-Logout "$remote/cdn-cgi/access/logout" $requester 'https://verification-team.cloudflareaccess.com/cdn-cgi/access/logout' 'requester-sign-out'
    Check-Logout "$remote/cdn-cgi/access/logout" $owner 'https://verification-team.cloudflareaccess.com/cdn-cgi/access/logout' 'owner-sign-out'
    $null = Call 'remote-anonymous' "$remote/api/me" 401
    $me = Call 'remote-owner-me' "$remote/api/me" 200 GET $null $owner
    if ($me.role -ne 'owner' -or $me.via -ne 'tunnel') { throw 'Remote owner identity failed.' }
    $me = Call 'remote-requester-me' "$remote/api/me" 200 GET $null $requester
    if ($me.role -ne 'requester' -or $me.via -ne 'tunnel' -or $null -ne $me.pendingRequests) { throw 'Requester identity failed.' }
    $null = Call 'remote-requester-repeat' "$remote/api/me" 200 GET $null $requester
    $null = Call 'requester-settings-forbidden' "$remote/api/settings/remote-access" 403 GET $null $requester
    $null = Call 'requester-settings-write-forbidden' "$remote/api/settings/remote-access" 403 PUT $config $requester
    $null = Call 'requester-me-write-forbidden' "$remote/api/me" 403 POST @{} $requester
    $null = Call 'requester-path-case-forbidden' "$remote/API/SETTINGS/REMOTE-ACCESS" 403 GET $null $requester
    $null = Call 'requester-unknown-forbidden' "$remote/api/new-owner-endpoint" 403 GET $null $requester
    $remoteFeatures = Call 'requester-features' "$remote/api/features" 200 GET $null $requester
    if ($remoteFeatures.openFolder) { throw 'Requester can open owner folders.' }
    Assert-Shape (Get-Content (Join-Path $root 'backend\contract\captures\features\default.json') -Raw | ConvertFrom-Json).body $remoteFeatures
    $results.Add('SHAPE PASS requester GET /api/features against owner capture')
    $remoteSettings = Call 'remote-owner-settings' "$remote/api/settings/remote-access" 200 GET $null $owner
    if ($remoteSettings.editable -or $remoteSettings.restartRequired -or !$remoteSettings.running.listening) { throw 'Remote listener/settings state failed.' }
    $null = Call 'remote-owner-write-forbidden' "$remote/api/settings/remote-access" 403 PUT $config $owner
    $null = Call 'remote-owner-open-forbidden' "$remote/api/downloads/proof/open" 409 POST @{} $owner
    $check = Call 'remote-setup-check' "$local/api/settings/remote-access/check" 200
    if (!$check.ok -or $check.keyCount -ne 1) { throw 'Remote setup check failed.' }
    foreach ($case in @(
        @{ name = 'expired'; token = (Token 'friend@verification.invalid' -Seconds -120) },
        @{ name = 'wrong-audience'; token = (Token 'friend@verification.invalid' -Audience 'wrong-aud') },
        @{ name = 'wrong-issuer'; token = (Token 'friend@verification.invalid' -Issuer 'https://wrong.invalid') },
        @{ name = 'unsigned-algorithm'; token = (Token 'friend@verification.invalid' -Algorithm 'none') },
        @{ name = 'service-token'; token = (Token '') }
    )) {
        $null = Call $case.name "$remote/api/me" 401 GET $null @{ 'Cf-Access-Jwt-Assertion' = $case.token }
    }
    $other = [Security.Cryptography.RSA]::Create(2048)
    try { $forged = Token 'owner@verification.invalid' -Signer $other } finally { $other.Dispose() }
    $null = Call 'forged-signature' "$remote/api/me" 401 GET $null @{ 'Cf-Access-Jwt-Assertion' = $forged }
    $config.allowRequesters = $false
    $null = Call 'disable-requesters' "$local/api/settings/remote-access" 200 PUT $config
    $null = Call 'disabled-requester' "$remote/api/me" 403 GET $null $requester
    $null = Call 'disable-remote' "$local/api/settings/remote-access" 200 PUT @{ enabled = $false }
    $null = Call 'disabled-remote-owner' "$remote/api/me" 401 GET $null $owner
    $restore = @{ enabled = $original.enabled; tunnelPort = $original.tunnelPort; tunnelBindAddress = $original.tunnelBindAddress;
        teamDomain = $original.teamDomain; audience = $original.audience; ownerEmails = $original.ownerEmails; allowRequesters = $original.allowRequesters }
    $null = Call 'restore-settings' "$local/api/settings/remote-access" 200 PUT $restore
    $results.Add("REMOTE PASS non-loopback $LanAddress via RS256 JWT: owner 200, requester 200, owner-only 403")
    Stop-Api
    Start-Api $false
    $persisted = Call 'persisted-restored-settings' "$local/api/settings/remote-access" 200
    if ($persisted.enabled -or $persisted.restartRequired) { throw 'Settings did not survive restart.' }
    $results.Add('PERSISTENCE PASS settings survived restart')
} finally {
    if ($process -and !$process.HasExited -and $original) {
        try {
            $restore = @{ enabled = $original.enabled; tunnelPort = $original.tunnelPort; tunnelBindAddress = $original.tunnelBindAddress;
                teamDomain = $original.teamDomain; audience = $original.audience; ownerEmails = $original.ownerEmails; allowRequesters = $original.allowRequesters }
            $null = Invoke-WebRequest "$local/api/settings/remote-access" -Method PUT -Body ($restore | ConvertTo-Json -Compress) -ContentType 'application/json' -NoProxy
        } catch { Write-Warning "Could not restore scratch settings: $_" }
    }
    Stop-Api
    if ($rsa) { $rsa.Dispose() }
    $results | Set-Content (Join-Path $proof 'results.txt') -Encoding utf8
    $results
}
