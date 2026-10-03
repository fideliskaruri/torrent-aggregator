param([switch]$Details)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path "$PSScriptRoot\..\..\..").Path
$out = "$root\backend\contract"
$base = 'http://127.0.0.1:3931'
# This script deliberately has no configurable host or mutating request support.
Invoke-WebRequest "$base/api/me" -TimeoutSec 10 | Out-Null
function Trim-Arrays($value) {
    if ($null -eq $value) { return $null }
    if ($value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $value.Keys) { $copy[$key] = Trim-Arrays $value[$key] }
        return $copy
    }
    if ($value -is [array]) {
        $copy = [System.Collections.Generic.List[object]]::new()
        for($i=0;$i -lt [Math]::Min(20,$value.Count);$i++){ $copy.Add((Trim-Arrays $value[$i])) }
        return ,$copy.ToArray()
    }
    return $value
}
function Capture([string]$Family, [string]$Name, [string]$Path, [string]$Method='GET', $RequestBody=$null) {
    if ($Method -ne 'GET' -and $Path -ne '/api/artwork' -and $Path -ne '/api/library/backfill-estimate' -and $Path -ne '/api/settings/tmdb/test' -and $Path -notmatch '^/api/settings/sources/[^/]+/test$') {
        throw "Not an allowlisted read: $Method $Path"
    }
    $args = @{ Uri="$base$Path"; Method=$Method; TimeoutSec=35; SkipHttpErrorCheck=$true }
    if ($null -ne $RequestBody) { $args.Body=($RequestBody | ConvertTo-Json -Depth 30 -Compress); $args.ContentType='application/json' }
    $dir="$out\captures\$Family"
    New-Item $dir -ItemType Directory -Force | Out-Null
    try {
        $r=Invoke-WebRequest @args
        $ct=[string]($r.Headers['Content-Type'] -join '; ')
        $body= if ($ct -like '*json*' -and $r.Content) { Trim-Arrays ($r.Content | ConvertFrom-Json -AsHashtable -Depth 100 -DateKind String) } else { [string]$r.Content }
        [ordered]@{ method=$Method; path=$Path; status=[int]$r.StatusCode; contentType=$ct; body=$body } |
            ConvertTo-Json -Depth 100 | Set-Content "$dir\$Name.json" -Encoding utf8
        "$Method $Path => $($r.StatusCode)"
        return $body
    } catch {
        [ordered]@{ method=$Method; path=$Path; transportError=$_.Exception.Message } |
            ConvertTo-Json | Set-Content "$dir\$Name.transport-error.json" -Encoding utf8
        Write-Warning "$Path : $($_.Exception.Message)"
        return $null
    }
}
if (!$Details) {
    $reads=@(
        @('me','owner','/api/me'), @('features','default','/api/features'),
        @('activity','all','/api/activity?limit=100'), @('activity','unread','/api/activity/unread'),
        @('activity','history','/api/history'), @('browse','all','/api/browse'),
        @('client','torrents','/api/client/torrents'), @('desktop','status','/api/desktop'),
        @('notifications','inbox','/api/notifications'), @('notifications','push-key','/api/notifications/push/public-key'),
        @('recommendations','rail','/api/recommendations'), @('requests','owner','/api/requests'),
        @('requests','auto-approve','/api/requests/auto-approve'), @('rules','all','/api/rules'),
        @('settings','client','/api/settings/client'), @('settings','sources','/api/settings/sources'),
        @('settings','tmdb','/api/settings/tmdb'), @('settings','recovery','/api/settings/download-recovery'),
        @('settings','recovery-sources','/api/settings/download-recovery/sources'),
        @('settings','remote-access','/api/settings/remote-access'), @('settings','remote-check','/api/settings/remote-access/check'),
        @('settings','folders','/api/settings/browse-folders?path=D%3A%5Ccode%5Cmemtest%5Crebuild-baseline'),
        @('timeline','all','/api/timeline'), @('wanted','all','/api/wanted'), @('watchlist','all','/api/watchlist'),
        @('requester','titles-owner-denied','/api/requester/titles?q=Sintel'),
        @('requester','seasons-owner-denied','/api/requester/seasons?source=tmdb&sourceId=1399&mediaType=tv'),
        @('requester','requests-owner-denied','/api/requester/requests'),
        @('requester','library-owner-denied','/api/requester/library'),
        @('health','health','/api/health'), @('health','diagnostics','/api/diagnostics/health'),
        @('search','titles','/api/search/titles?q=Sintel'), @('search','suggest','/api/suggest?q=Sintel'),
        @('search','releases','/api/search?q=Sintel&category=movies')
    )
    foreach ($read in $reads) { $null=Capture @read }
    $null=Capture artwork sintel /api/artwork POST @{items=@(@{title='Sintel';year=2010;mediaType='movie'})}
    $null=Capture library backfill-estimate /api/library/backfill-estimate POST @{fromSeason=1;toSeason=2}
    $null=Capture settings tmdb-test /api/settings/tmdb/test POST @{}
    $null=Capture settings source-test /api/settings/sources/cinemeta/test POST @{}
} else {
    $watch=(Get-Content "$out\captures\watchlist\all.json" -Raw | ConvertFrom-Json -AsHashtable).body
    foreach ($item in @($watch.items | Select-Object -First 3)) {
        $key=$item.workKey
        if (!$key) { $key=($item.title.ToLowerInvariant() -replace '[^a-z0-9]+','-').Trim('-') + $(if($item.year){"-$($item.year)"}) }
        $enc=[Uri]::EscapeDataString($key)
        $hint='t='+[Uri]::EscapeDataString($item.title)
        if($item.mediaType){$hint+='&type='+[Uri]::EscapeDataString($item.mediaType)}
        $null=Capture title "$key-detail" "/api/title/$enc`?$hint"
        $null=Capture title "$key-progress" "/api/title/$enc/progress?session=contract-capture"
        $null=Capture title "$key-links" "/api/title/$enc/links"
        $null=Capture title "$key-extras" "/api/title/$enc/extras?$hint&s=1"
        $null=Capture title "$key-releases" "/api/title/$enc/releases?season=1&episode=1"
        $null=Capture library "$key-delete-plan" ("/api/library/delete?watchListItemId="+[Uri]::EscapeDataString($item.id)+'&scope=show')
    }
    foreach($view in 'films','series','anime'){ $null=Capture browse $view "/api/browse?type=$view" }
    $null=Capture title sintel-detail '/api/title/sintel-2010?t=Sintel&y=2010&type=movie'
    $null=Capture title sintel-extras '/api/title/sintel-2010/extras?t=Sintel&y=2010&type=movie'
    $null=Capture activity sent '/api/activity?filter=sent&limit=20'
}
