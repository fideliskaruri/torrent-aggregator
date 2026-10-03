$ErrorActionPreference='Stop'
$root=(Resolve-Path "$PSScriptRoot\..\..\..").Path
$out="$root\backend\contract"
$index=Get-Content "$out\source-index.json" -Raw | ConvertFrom-Json -AsHashtable
$metadata=@{}
function Web($method,$path,$params,$type,$file,$screen) {
    $metadata["$method $path"]=@{parameters=$params;type=$type;typeFile=$file;screen=$screen;scope='web'}
}
Web GET /api/me 'none' MeInfo 'lib\session.tsx' 'SessionProvider; shell; connection watchdog'
Web GET /api/features 'none' Features 'lib\features.tsx' 'All screens; folder actions'
Web GET /api/activity 'limit?, cursor?, filter?=sent' ActivityPage 'app\notifications\page.tsx' 'Notifications; History; Activity redirects'
Web GET /api/activity/unread 'since?: ISO timestamp' '{count:number}' 'app\notifications\inbox.ts' 'Alerts inbox'
Web POST /api/artwork 'body: {items:[{title,year?,mediaType?}]}' '{artwork:Record<string,Artwork>}' 'hooks\use-work-artwork.ts' 'Downloads; Activity; artwork fallback'
Web GET /api/browse 'type?:all/films/series/anime; genre?' BrowsePayload 'lib\browse\types.ts' 'Home; browse board'
Web GET /api/client/torrents 'none' '{torrents:ClientTorrent[],...}' 'app\downloads\types.ts' 'Downloads; title transfer actions'
Web POST /api/client/torrents 'body: {action:pause/resume/delete/force,hash?:string,hashes?:string[],ownerClientType,deleteFiles?}; hashes is bulk delete' '{ok:boolean,results?:unknown[],...}' 'app\downloads\page.tsx' 'Downloads bulk and row actions'
Web POST /api/client/torrents/tidy 'none' TidyResult 'app\downloads\page.tsx' 'Downloads tidy'
Web GET /api/desktop 'none' DesktopStatus 'lib\desktop.ts' 'Settings desktop; update banner'
Web PUT /api/desktop/settings 'body: {startWithWindows?,checkForUpdates?}' DesktopStatus 'lib\desktop.ts' 'Settings desktop'
Web POST /api/desktop/update/check 'none; persists update-check state' DesktopStatus 'lib\desktop.ts' 'Settings desktop; update banner'
Web POST /api/desktop/update/install 'none; launches installer' '{ok:boolean,progress:DownloadProgress}' 'lib\desktop.ts' 'Update banner'
Web POST '/api/downloads/{transferId}/open' 'body: {mode:open/reveal}' OpenDownloadBody 'lib\open-download.ts' 'Downloads; title Open and Show in folder'
Web POST '/api/downloads/{transferId}/keep' 'none' '{ok?:boolean,message?:string}' 'app\downloads\page.tsx' 'Downloads held promotion'
Web POST '/api/downloads/{transferId}/find-another' 'none' '{ok?:boolean,message?:string}' 'app\downloads\page.tsx' 'Downloads find another'
Web POST /api/automation/run 'none' '{ok?:boolean,message?:string,...}' 'app\watchlist\page.tsx' 'Library run now'
Web GET /api/library/delete 'watchListItemId; scope:show/season/episode; season?; episode?' '{ok:boolean,title:string,plan:DeletePlan}' 'app\watchlist\page.tsx' 'Library deletion preview'
Web POST /api/library/delete 'body: {watchListItemId,scope,season?,episode?,confirm:true}' '{ok:boolean,freedBytes:number,freedFiles:number,deleted:unknown[],failed:unknown[],plan:DeletePlan}' 'app\watchlist\page.tsx' 'Library delete files'
Web POST /api/library/ondemand 'body: {watchListItemId?,workKey?,title?,action?,season?,episode?,quality?,...}' '{ok?:boolean,message?:string,...}' 'app\watchlist\page.tsx' 'Library on-demand; browse download'
Web GET /api/notifications 'limit?:number' '{items:NotificationItem[],unreadCount:number}' 'components\notifications\notification-feed.tsx' 'Notifications; bell'
Web POST '/api/notifications/read/{id}' 'none' 'ignored; HTTP success required' 'components\notifications\notification-feed.tsx' 'Notifications mark read'
Web POST /api/notifications/read-all 'none' 'ignored; HTTP success required' 'components\notifications\notification-feed.tsx' 'Notifications mark all read'
Web GET /api/notifications/push/public-key 'none' '{publicKey:string}' 'components\notifications\notification-feed.tsx' 'Browser push toggle'
Web POST /api/notifications/push/subscription 'body: {endpoint,p256dh,auth}' 'ignored; HTTP success required' 'components\notifications\notification-feed.tsx' 'Browser push enable'
Web DELETE /api/notifications/push/subscription 'body: {endpoint}' 'ignored; HTTP success required' 'components\notifications\notification-feed.tsx' 'Browser push disable'
Web GET /api/recommendations 'none' '{rail:RecommendationRail|null}' 'lib\recommend\index.ts' 'Home recommendation rail'
Web GET /api/requester/seasons 'provider;providerId;mediaType;title?;year?' '{seasons:number[]}' 'lib\requests.ts' 'Request dialog; requester only'
Web GET /api/requester/library 'none' '{items:RequesterLibraryTitle[]}' 'lib\requests.ts' 'Library requester view'
Web GET /api/requester/requests 'none' '{requests:RequesterRequest[]}' 'lib\requests.ts' 'Requests requester view'
Web POST /api/requester/requests 'body: RequestChoice; serialized provider identity by submitRequest (see lib/requests.ts)' 'RequestFailure / request result parsed by submitRequest' 'lib\requests.ts' 'Request dialog'
Web POST '/api/requester/requests/{id}/cancel' 'none' 'RequestFailure / HTTP success' 'lib\requests.ts' 'Requests cancel'
Web GET /api/requests 'status?:string (web omits)' '{requests:OwnerRequest[]}' 'lib\requests.ts' 'Requests owner view'
Web GET /api/requests/auto-approve 'none' AutoApproveConfig 'lib\requests.ts' 'Requests auto-approve panel'
Web PUT /api/requests/auto-approve 'body: {mode,rules:AutoApproveRule[]}' AutoApproveConfig 'lib\requests.ts' 'Requests auto-approve panel'
foreach($action in 'approve','retry','decline') { Web POST "/api/requests/{id}/$action" 'body: {reason?} for decline; otherwise none' '{ok?:boolean,message?:string,...}' 'app\requests\page.tsx' "Requests $action" }
Web POST '/api/requests/{id}/pick' 'body: {token}' '{ok:boolean,message?:string,status?:string}' 'components\releases\release-picker-dialog.tsx' 'Release picker for approved request'
Web GET /api/rules 'none' '{rules:Rule[]}' 'app\rules\page.tsx' 'Rules selects body.rules; Settings count selects its length'
Web POST /api/rules 'body: rule form (name,query,category,enabled,filters,...); id for update' '{rule?:Rule,error?:string,...}' 'app\rules\page.tsx' 'Rules create'
Web PATCH /api/rules 'body: {id,enabled?} or rule form' '{rule?:Rule,error?:string,...}' 'app\rules\page.tsx' 'Rules update'
Web DELETE /api/rules 'id' '{ok?:boolean,error?:string}' 'app\rules\page.tsx' 'Rules remove'
Web POST /api/rules/run 'none' '{ok?:boolean,message?:string,...}' 'app\rules\page.tsx' 'Rules run now'
Web GET /api/search/titles 'q;category?;limit?' '{results:WorkSearchHit[],query?:string,canonicalQuery?:string,partial?:boolean,failedProviders?:string[],stale?:boolean}' 'lib\search\work-search.ts' 'Search overlay; Search; Everything'
Web GET /api/settings/client 'none' '{settings:ClientForm & extra fields,defaults:unknown}' 'app\settings\page.tsx' 'Settings; Downloads cap; preferred quality; setup'
Web PUT /api/settings/client 'body: ClientForm partial; test?,testTarget?,switchToBuiltin?,maxActiveDownloads?,downloadWindows?,... (see source)' '{settings?:ClientForm,message?:string,error?:string,...}' 'app\settings\page.tsx' 'Settings; Downloads cap; setup'
Web GET /api/settings/browse-folders 'path?:string' '{path:string,parent:string|null,entries:FolderPickerEntry[],...}' 'components\settings\folder-picker.tsx' 'Folder picker'
Web POST /api/settings/open-folder 'body: {path?,hash?,...}' '{ok?:boolean,error?:string,message?:string}' 'app\settings\page.tsx' 'Settings; Downloads folder action'
Web GET /api/settings/download-recovery 'none' RecoveryInfo 'components\settings\download-recovery.tsx' 'Recovery dialog'
Web POST /api/settings/download-recovery 'none; restores persisted download storage' '{ok?:boolean,message?:string,...}' 'components\settings\download-recovery.tsx' 'Recovery restore'
Web GET /api/settings/download-recovery/sources 'none' SourceScan 'components\settings\download-recovery.tsx' 'Recovery external import'
Web POST /api/settings/download-recovery/sources 'body: {ids:string[],acknowledged:boolean}' '{ok?:boolean,message?:string,...}' 'components\settings\download-recovery.tsx' 'Recovery import selected'
Web GET /api/settings/remote-access 'none' RemoteAccessSettings 'components\settings\remote-access-section.tsx' 'Settings remote access'
Web PUT /api/settings/remote-access 'body: {enabled,tunnelPort,teamDomain?,audience?,ownerEmails:string[],allowRequesters}' RemoteAccessSettings 'components\settings\remote-access-section.tsx' 'Settings remote access'
Web GET /api/settings/remote-access/check 'none' RemoteAccessCheck 'components\settings\remote-access-section.tsx' 'Settings remote access check'
Web GET /api/settings/sources 'none' '{sources:Source[],error?:string|null}' 'components\settings\sources-settings.tsx' 'Settings sources'
Web PUT '/api/settings/sources/{id}' 'body: Update; enabled?,priority?,baseUrl?,mirrors?,timeoutMs?,categories?,options?,credential?,kind?,type?' '{sources:Source[],error?:string|null}' 'components\settings\sources-settings.tsx' 'Settings source save/add'
Web DELETE '/api/settings/sources/{id}' 'none' '{sources:Source[],error?:string|null}' 'components\settings\sources-settings.tsx' 'Settings remove custom source'
Web POST '/api/settings/sources/{id}/test' 'none; safe remote health probe' '{ok:boolean,status:string,message?:string|null}' 'components\settings\sources-settings.tsx' 'Settings source test'
Web GET /api/settings/tmdb 'none' Status 'components\settings\tmdb-settings.tsx' 'Settings TMDB'
Web PUT /api/settings/tmdb 'body: {apiKey:string}' Status 'components\settings\tmdb-settings.tsx' 'Settings TMDB save'
Web DELETE /api/settings/tmdb 'none' Status 'components\settings\tmdb-settings.tsx' 'Settings TMDB remove'
Web POST /api/settings/tmdb/test 'body: {apiKey?:string}; empty uses stored key' '{ok:boolean,status:string,message:string}' 'components\settings\tmdb-settings.tsx' 'Settings TMDB test'
Web GET /api/timeline 'none' TimelineResponse 'app\upcoming\timeline.ts' 'Upcoming'
Web GET '/api/title/{workKey}' 't?,y?,type?,s?,provider?,providerId?,sourceType?,format?,series?,remembered?' TitleDetailPayload 'components\title\types.ts' 'Title detail'
Web POST '/api/title/{workKey}' 'body: {action,season?,episode?,quality?,storageOverride?,...}; see title-action-request.ts' 'TitleGrabResponse / TitleSeasonGrabResponse' 'components\title\types.ts' 'Title download film/episode/season'
Web GET '/api/title/{workKey}/extras' 't?,y?,type?,s?,provider?,providerId?,poster?,sourceType?,format?,series?,v?' TitleExtrasPayload 'components\title\types.ts' 'Title metadata; owner request preview seasons'
Web GET '/api/title/{workKey}/progress' 'session?:poll identity' TitleProgressPayload 'components\title\types.ts' 'Title transfer polling'
Web GET '/api/title/{workKey}/links' 'none' '{links:WorkLink[]}' 'components\title\linked-records.tsx' 'Title linked records'
Web DELETE '/api/title/{workKey}/links/{provider}/{externalId}' 'none' '{links?:WorkLink[],message?:string}' 'components\title\linked-records.tsx' 'Title unlink record'
Web GET '/api/title/{workKey}/releases' 'season?,episode?,q?' PickList 'components\releases\release-picker-dialog.tsx' 'Release picker'
Web POST '/api/title/{workKey}/releases' 'body: {token}' '{ok:boolean,message?:string,infoHash?:string}' 'components\releases\release-picker-dialog.tsx' 'Release picker'
Web POST /api/torrent/send 'body: {magnet?,torrentUrl?,infoHash?,name?,category?,savePath?,source?,...}' 'SendError / send result (see source)' 'app\downloads\page.tsx' 'Downloads add torrent; Share; Library raw release'
Web GET /api/wanted 'none' '{wanted:WantedRow[],queue:unknown}' 'components\wanted\wanted-actions.tsx' 'Downloads Looking'
Web DELETE /api/wanted 'workKey;season?;episode?' '{ok:boolean,removed:number}' 'components\wanted\wanted-actions.tsx' 'Stop looking'
Web POST /api/wanted/try 'workKey;season?;episode?' '{ok:boolean}' 'components\wanted\wanted-actions.tsx' 'Try now'
Web GET /api/watchlist 'none' '{items:WatchItem[]}' 'app\watchlist\page.tsx' 'Library'
Web POST /api/watchlist 'body: title identity/addPayload; mediaType,externalId,title,posterUrl?,synopsis?,rating?,provider?,providerId?,workKey?,format?,monitorMode?,fromSeason?,fromEpisode?,preferredResolution?,monitored?' '{item?:WatchItem,error?:string,...}' 'app\watchlist\page.tsx' 'Library add; title library controls; recommendation add'
Web PATCH /api/watchlist 'body: {id,status?,monitored?,monitorMode?,fromSeason?,fromEpisode?,preferredResolution?,...}' '{item?:WatchItem,error?:string,...}' 'app\watchlist\page.tsx' 'Library edit; title monitor'
Web DELETE /api/watchlist 'id; deleteFiles? (web omits)' '{ok?:boolean,error?:string}' 'app\watchlist\page.tsx' 'Library remove; title remove'

$routes=@()
foreach($r in $index.routes) {
    $key="$($r.method) $($r.path)"
    $meta=$metadata[$key]
    if(!$meta){ $meta=@{parameters='See server handler and source-contracts.json';type='No web consumer (server response source)';typeFile=$null;screen='server only';scope='server only'} }
    $mutates=$r.method -ne 'GET' -and $r.path -notin '/api/artwork','/api/library/backfill-estimate','/api/settings/tmdb/test' -and $r.path -notmatch '^/api/settings/sources/[^/]+/test$'
    $family=($r.path -split '/')[2]
    $refs=@($index.webReferences | Where-Object { $_.file -eq "web\src\$($meta.typeFile)" })
    $ts=$index.types | Where-Object { $_.name -eq ($meta.type -replace '\[\]$','') -and $_.file -eq "web\src\$($meta.typeFile)" } | Select-Object -First 1
    $line=if($ts){$ts.line}elseif($refs.Count){$refs[0].line}else{1}
    $captures=@()
    $pattern='^'+[regex]::Replace([regex]::Escape($r.path),'\\\{[^}]+}','[^/?]+')+'(?:\?|$)'
    foreach($f in Get-ChildItem "$out\captures" -Recurse -Filter '*.json') {
        $j=Get-Content $f.FullName -Raw | ConvertFrom-Json -AsHashtable -DateKind String
        if($j.method -eq $r.method -and $j.path -match $pattern){$captures+=$f.FullName.Substring($out.Length+1)}
    }
    $routes += [ordered]@{
        method=$r.method;path=$r.path;family=$family;parameters=$meta.parameters;expectedType=$meta.type
        typeSource=if($meta.typeFile){"web\src\$($meta.typeFile):$line"}else{$null}
        consumer=$meta.screen;scope=$meta.scope;mutates=$mutates;serverSource="$($r.file):$($r.line)"
        evidence=if($captures.Count){'captured'}else{'from source, not captured'};captures=$captures
    }
}
$routes | ConvertTo-Json -Depth 20 | Set-Content "$out\routes.json" -Encoding utf8
$md=@('# Web API contract','','One row per method/path. `routes.json` is the machine-readable equivalent. Captures are owner-local sandbox responses; requester 403s do not describe requester success payloads. Source evidence includes exact handler excerpts in `source-contracts.json`.','','No EventSource, Hono/RPC, axios or React Query query-key callers were found in web/src. The query hook uses the URL/dataIdentity as its key and polls with fetch. Dynamic base URLs, notification suffixes, download actions and requester URL helpers are included. Search is the unified title endpoint, not the legacy torrent-search API.','')
foreach($family in $routes.family | Sort-Object -Unique){
    $md+="## $family"
    $md+='';$md+='| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |'
    $md+='|---|---|---|---|---|---|---|'
    foreach($r in $routes | Where-Object family -eq $family){
        $cell=@($r.method,$r.path,$r.parameters,"$($r.expectedType) ($($r.typeSource))",$r.consumer,$r.mutates,$r.evidence+"; "+$r.serverSource) | ForEach-Object { ([string]$_).Replace('|','\|').Replace("`n",' ') }
        $md+='| '+($cell -join ' | ')+' |'
    }
    $md+=''
}
$md | Set-Content "$out\routes.md" -Encoding utf8
# Exact source evidence, not invented observations, for uncaptured branches and mutations.
$source=@()
foreach($r in $routes){
    $parts=$r.serverSource -split ':'
    $text=Get-Content "$root\$($parts[0])"
    $start=[int]$parts[1]-1
    $end=$text.Count-1
    for($i=$start+1;$i -lt $text.Count;$i++){
        if($text[$i] -match '^\s*(?:\[Http|(?:app|group|requester)\.Map(?:Get|Post|Put|Delete))'){$end=$i-1;break}
    }
    $handler=($text[$start..$end] -join "`n")
    $fields=[ordered]@{}
    foreach($m in [regex]::Matches($handler,'(?:body|f|json)\.(Str|String|Int|Number|Bool|Enum)\("([^"]+)"([^)]*)\)')){
        $type=switch($m.Groups[1].Value){'Bool'{'boolean'};'Int'{'integer'};'Number'{'number'};default{'string'}}
        $fields[$m.Groups[2].Value]=@{type=$type;requiredFromAccessor=($m.Groups[3].Value -match '^\s*,\s*true');evidence='server accessor; validation may be delegated'}
    }
    $source += [ordered]@{method=$r.method;path=$r.path;evidence='from source, not captured';source=$r.serverSource;requestFields=$fields;requestParameters=$r.parameters;handler=$handler}
}
$source | ConvertTo-Json -Depth 12 | Set-Content "$out\source-contracts.json" -Encoding utf8
"Routes: $($routes.Count); web: $(@($routes|Where-Object scope -eq web).Count); server only: $(@($routes|Where-Object scope -eq 'server only').Count)"
