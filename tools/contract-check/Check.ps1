param(
    [string] $BaseUrl = 'http://127.0.0.1:3940',
    [string] $OutputDirectory = (Join-Path $PSScriptRoot '..\.catalog-proof'),
    [switch] $AllReads
)
$ErrorActionPreference = 'Stop'
$contract = Join-Path $PSScriptRoot '..\..\backend\contract'
$registry = Get-Content (Join-Path $contract 'shapes.json') -Raw | ConvertFrom-Json -AsHashtable -DateKind String
$catalogPatterns = @('/api/browse', '/api/recommendations', '/api/search/titles', '/api/suggest',
    '/api/title/{workKey}', '/api/title/{workKey}/extras', '/api/title/{workKey}/links',
    '/api/title/{workKey}/progress', '/api/watchlist', '/api/artwork')
$rows = [Collections.Generic.List[object]]::new()
New-Item $OutputDirectory -ItemType Directory -Force | Out-Null

function Resolve-Schema($schema) {
    if ($schema -and $schema.ContainsKey('$ref')) {
        $name = $schema['$ref'].Split('/')[-1]
        return $registry.typescript[$name]
    }
    return $schema
}
function Get-Type($value) {
    if ($null -eq $value) { return 'null' }
    if ($value -is [Collections.IDictionary]) { return 'object' }
    if ($value -is [array]) { return 'array' }
    if ($value -is [bool]) { return 'boolean' }
    if ($value -is [string]) { return 'string' }
    return 'number'
}
function Compare-Shape($actual, $schema, $declared, [string] $path, $errors, $notes) {
    $schema = Resolve-Schema $schema
    $declared = Resolve-Schema $declared
    if (!$declared) { $declared = @{ properties = @{} } }
    if (!$declared.properties) { $declared.properties = @{} }
    if (!$schema -or $schema['x-unobserved'] -or $schema['x-unresolved']) {
        $notes.Add("$path unobserved in baseline") | Out-Null
        if (!$declared -or $declared['x-unresolved']) { return }
        $schema = $declared
    }
    if ($schema.anyOf) {
        foreach ($option in $schema.anyOf) {
            $attempt = [Collections.Generic.List[string]]::new()
            Compare-Shape $actual $option $declared $path $attempt $notes
            if ($attempt.Count -eq 0) { return }
        }
        $errors.Add("$path does not match baseline union") | Out-Null
        return
    }
    $actualType = Get-Type $actual
    if ($schema.type -and $actualType -notin @($schema.type)) {
        # Captures describe one state, not all states. A declared nullable field
        # allows an honest empty inventory, and a null-only observation proves no non-null type.
        $allowed = @($declared.type)
        if ($declared.anyOf) { $allowed += @($declared.anyOf | ForEach-Object { (Resolve-Schema $_).type }) }
        if ($actualType -in $allowed -or $schema.type -eq 'null') {
            $notes.Add("$path baseline=$($schema.type), actual=$actualType (declared/state variant)") | Out-Null
            $replacement = $declared
            if ($declared.anyOf) { $replacement = $declared.anyOf | ForEach-Object { Resolve-Schema $_ } | Where-Object { $actualType -in @($_.type) } | Select-Object -First 1 }
            if ($replacement -and $actualType -in @($replacement.type)) {
                Compare-Shape $actual $replacement $null $path $errors $notes
            }
        } else {
            $errors.Add("$path expected $($schema.type), got $actualType") | Out-Null
        }
        return
    }
    if ($actualType -eq 'object') {
        foreach ($key in $schema.required) {
            if (!$actual.Contains($key)) { $errors.Add("$path.$key missing") | Out-Null }
        }
        foreach ($key in @($schema.properties.Keys)) {
            if ($actual.Contains($key)) {
                Compare-Shape $actual[$key] $schema.properties[$key] $declared.properties[$key] "$path.$key" $errors $notes
            }
        }
        # TypeScript also detects wrong types for fields null/absent in the capture.
        foreach ($key in $declared.properties.Keys) {
            if ($actual.Contains($key) -and (!$schema.properties -or !$schema.properties.Contains($key))) {
                Compare-Shape $actual[$key] $declared.properties[$key] $null "$path.$key" $errors $notes
            }
        }
    } elseif ($actualType -eq 'array') {
        if ($actual.Count -eq 0 -and $schema.items -and !$schema.items['x-unobserved']) {
            $notes.Add("$path empty; element shape unverified") | Out-Null
        }
        for ($i = 0; $i -lt $actual.Count; $i++) {
            Compare-Shape $actual[$i] $schema.items $declared.items "$path[$i]" $errors $notes
        }
    }
}
foreach ($capture in $registry.captures) {
    $route = $registry.routes | Where-Object { $_.method -eq $capture.method -and $_.captures -contains $capture.capture } | Select-Object -First 1
    if (!$route) { continue }
    $inScope = $route.path -in $catalogPatterns
    if ($capture.method -ne 'GET' -and $route.path -ne '/api/artwork') { continue }
    if (!$inScope) {
        if ($AllReads) {
            try { $deferred = Invoke-WebRequest ($BaseUrl.TrimEnd('/')+$capture.path) -SkipHttpErrorCheck -TimeoutSec 30; $status=[int]$deferred.StatusCode }
            catch { $status=0 }
            $reason = switch -Regex ($route.path) {
                '^/api/(me|features|health|settings/remote-access)' { 'Foundation/access route: independently verified in tasks 2.1/2.2, outside catalog shape gate'; break }
                '^/api/(title/.*/releases|client|wanted|search$|settings/(client|download-recovery|sources))' { 'Requires Find/Engine/Targets/download state; phases 3/4'; break }
                '^/api/library' { 'Requires Library inventory and filesystem operations; phase 5'; break }
                default { 'Requires administration, requests, notifications or desktop services; phase 6' }
            }
            $rows.Add([ordered]@{ route=$route.path; request=$capture.path; result='DEFERRED'; status=$status; errors=@(); notes=@($reason) })
        }
        continue
    }
    $errors = [Collections.Generic.List[string]]::new()
    $notes = [Collections.Generic.List[string]]::new()
    try {
        $params = @{ Uri=$BaseUrl.TrimEnd('/')+$capture.path; Method=$capture.method; SkipHttpErrorCheck=$true; TimeoutSec=180 }
        if ($capture.method -eq 'POST') {
            $params.ContentType = 'application/json'
            $params.Body = '{"items":[{"title":"Sintel","year":2010,"mediaType":"movie"}]}'
        }
        $response = Invoke-WebRequest @params
        $actual = $response.Content | ConvertFrom-Json -AsHashtable -DateKind String
        if ([int]$response.StatusCode -ne $capture.status) { $errors.Add("status expected $($capture.status), got $($response.StatusCode)") }
        Compare-Shape $actual $capture.schema $route.expectedResponse '$' $errors $notes
        $status = [int]$response.StatusCode
        $file = ($capture.capture -replace '[\\/:]', '_')
        $response.Content | Set-Content (Join-Path $OutputDirectory $file) -Encoding utf8
    } catch { $errors.Add($_.Exception.Message); $status = 0 }
    $rows.Add([ordered]@{ route=$route.path; request=$capture.path; result= $(if($errors.Count){'FAIL'}else{'PASS'}); status=$status; errors=@($errors); notes=@($notes | Select-Object -Unique) })
}
$rows | ConvertTo-Json -Depth 30 | Set-Content (Join-Path $OutputDirectory 'contract-results.json') -Encoding utf8
$rows | ForEach-Object { [pscustomobject]$_ } | Select-Object request,result,status,@{n='details';e={$_.errors -join '; '}} | Format-Table -Wrap
if (@($rows | Where-Object result -eq FAIL).Count) { exit 1 }
