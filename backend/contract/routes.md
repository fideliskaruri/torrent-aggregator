# Web API contract

One row per method/path. `routes.json` is the machine-readable equivalent. Captures are owner-local sandbox responses; requester 403s do not describe requester success payloads. Source evidence includes exact handler excerpts in `source-contracts.json`.

No EventSource, Hono/RPC, axios or React Query query-key callers were found in web/src. The query hook uses the URL/dataIdentity as its key and polls with fetch. Dynamic base URLs, notification suffixes, download actions and requester URL helpers are included. Search is the unified title endpoint, not the legacy torrent-search API.

## activity

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/activity | limit?, cursor?, filter?=sent | ActivityPage (web\src\app\notifications\page.tsx:49) | Notifications; History; Activity redirects | False | captured | ;  | server\TorrentFlow.Library\Features\Activity\ActivityController.cs:29 |
| GET | /api/activity/unread | since?: ISO timestamp | {count:number} (web\src\app\notifications\inbox.ts:168) | Alerts inbox | False | captured | ;  | server\TorrentFlow.Library\Features\Activity\ActivityController.cs:32 |

## artwork

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/artwork | body: {items:[{title,year?,mediaType?}]} | {artwork:Record<string,Artwork>} (web\src\hooks\use-work-artwork.ts:47) | Downloads; Activity; artwork fallback | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\ArtworkController.cs:14 |

## automation

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/automation/run | none | {ok?:boolean,message?:string,...} (web\src\app\watchlist\page.tsx:56) | Library run now | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Automation\AutomationScheduler.cs:54 |

## browse

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/browse | type?:all/films/series/anime; genre? | BrowsePayload (web\src\lib\browse\types.ts:130) | Home; browse board | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\BrowseController.cs:18 |

## client

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/client/torrents | none | {torrents:ClientTorrent[],...} (web\src\app\downloads\types.ts:1) | Downloads; title transfer actions | False | captured | ;  | server\TorrentFlow.Engine\Controllers\ClientTorrentsController.cs:43 |
| POST | /api/client/torrents | body: {action:pause/resume/delete/force,hash?:string,hashes?:string[],ownerClientType,deleteFiles?}; hashes is bulk delete | {ok:boolean,results?:unknown[],...} (web\src\app\downloads\page.tsx:168) | Downloads bulk and row actions | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\ClientTorrentsController.cs:297 |
| POST | /api/client/torrents/tidy | none | TidyResult (web\src\app\downloads\page.tsx:169) | Downloads tidy | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\LayoutTidyController.cs:10 |
| GET | /api/client/torrents/{hash}/alternatives | source?:source id | ReleaseAlternatives (web\src\components\releases\release-swap-dialog.tsx:67) | Find another source dialog | False | captured | ;  | server\TorrentFlow.Library\Features\Grabs\ReleaseSwapController.cs:8 |
| POST | /api/client/torrents/{hash}/alternatives | body: {token?,allowBlocked?,best?,source?} | {ok:boolean,message?:string,hash?:string} (web\src\components\releases\release-swap-dialog.tsx:7) | Find another source dialog | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Grabs\ReleaseSwapController.cs:21 |

## desktop

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/desktop | none | DesktopStatus (web\src\lib\desktop.ts:12) | Settings desktop; update banner | False | captured | ;  | server\TorrentFlow.Api\Desktop\DesktopEndpoints.cs:42 |
| PUT | /api/desktop/settings | body: {startWithWindows?,checkForUpdates?} | DesktopStatus (web\src\lib\desktop.ts:12) | Settings desktop | True | from source, not captured | ;  | server\TorrentFlow.Api\Desktop\DesktopEndpoints.cs:49 |
| POST | /api/desktop/update/check | none; persists update-check state | DesktopStatus (web\src\lib\desktop.ts:12) | Settings desktop; update banner | True | from source, not captured | ;  | server\TorrentFlow.Api\Desktop\DesktopEndpoints.cs:93 |
| POST | /api/desktop/update/install | none; launches installer | {ok:boolean,progress:DownloadProgress} (web\src\lib\desktop.ts:30) | Update banner | True | from source, not captured | ;  | server\TorrentFlow.Api\Desktop\DesktopEndpoints.cs:103 |

## diagnostics

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/diagnostics/health | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Engine\Controllers\DiagnosticsHealthController.cs:25 |

## downloads

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/downloads/{transferId}/open | body: {mode:open/reveal} | OpenDownloadBody (web\src\lib\open-download.ts:7) | Downloads; title Open and Show in folder | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadOpenController.cs:25 |
| POST | /api/downloads/{transferId}/keep | none | {ok?:boolean,message?:string} (web\src\app\downloads\page.tsx:168) | Downloads held promotion | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadPromotionController.cs:17 |
| POST | /api/downloads/{transferId}/find-another | none | {ok?:boolean,message?:string} (web\src\app\downloads\page.tsx:168) | Downloads held promotion | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadPromotionController.cs:20 |

## features

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/features | none | Features (web\src\lib\features.tsx:5) | All screens; folder actions | False | captured | ;  | server\TorrentFlow.Api\Program.cs:185 |

## health

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/health | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Api\Program.cs:208 |

## history

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/history | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Library\Features\Activity\ActivityController.cs:12 |
| DELETE | /api/history | See server handler and source-contracts.json | No web consumer (server response source) () | server only | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Activity\ActivityController.cs:21 |

## library

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/library/ondemand | body: {watchListItemId?,workKey?,title?,action?,season?,episode?,quality?,...} | {ok?:boolean,message?:string,...} (web\src\app\watchlist\page.tsx:56) | Library on-demand; browse download | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Grabs\OnDemandController.cs:15 |
| POST | /api/library/backfill-estimate | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Library\Features\Storage\BackfillController.cs:18 |
| GET | /api/library/delete | watchListItemId; scope:show/season/episode; season?; episode? | {ok:boolean,title:string,plan:DeletePlan} (web\src\app\watchlist\page.tsx:56) | Library deletion preview | False | captured | ;  | server\TorrentFlow.Library\Features\Storage\DeletionController.cs:136 |
| POST | /api/library/delete | body: {watchListItemId,scope,season?,episode?,confirm:true} | {ok:boolean,freedBytes:number,freedFiles:number,deleted:unknown[],failed:unknown[],plan:DeletePlan} (web\src\app\watchlist\page.tsx:56) | Library delete files | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Storage\DeletionController.cs:136 |

## me

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/me | none | MeInfo (web\src\lib\session.tsx:37) | SessionProvider; shell; connection watchdog | False | captured | ;  | server\TorrentFlow.Api\RemoteAccess\RemoteAccessEndpoints.cs:13 |

## notifications

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/notifications | limit?:number | {items:NotificationItem[],unreadCount:number} (web\src\components\notifications\notification-feed.tsx:14) | Notifications; bell | False | captured | ;  | server\TorrentFlow.Api\Notifications\NotificationEndpoints.cs:17 |
| POST | /api/notifications/read/{id} | none | ignored; HTTP success required (web\src\components\notifications\notification-feed.tsx:14) | Notifications mark read | True | from source, not captured | ;  | server\TorrentFlow.Api\Notifications\NotificationEndpoints.cs:23 |
| POST | /api/notifications/read-all | none | ignored; HTTP success required (web\src\components\notifications\notification-feed.tsx:14) | Notifications mark all read | True | from source, not captured | ;  | server\TorrentFlow.Api\Notifications\NotificationEndpoints.cs:26 |

## recommendations

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/recommendations | none | {rail:RecommendationRail\|null} (web\src\lib\recommend\index.ts:1) | Home recommendation rail | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\BrowseController.cs:34 |

## requester

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/requester/titles | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:27 |
| GET | /api/requester/seasons | provider;providerId;mediaType;title?;year? | {seasons:number[]} (web\src\lib\requests.ts:7) | Request dialog; requester only | False | captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:43 |
| GET | /api/requester/requests | none | {requests:RequesterRequest[]} (web\src\lib\requests.ts:7) | Requests requester view | False | captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:59 |
| POST | /api/requester/requests | body: RequestChoice; serialized provider identity by submitRequest (see lib/requests.ts) | RequestFailure / request result parsed by submitRequest (web\src\lib\requests.ts:7) | Request dialog | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:62 |
| POST | /api/requester/requests/{id}/cancel | none | RequestFailure / HTTP success (web\src\lib\requests.ts:7) | Requests cancel | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:93 |
| GET | /api/requester/library | none | {items:RequesterLibraryTitle[]} (web\src\lib\requests.ts:7) | Library requester view | False | captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:107 |

## requests

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/requests/{id}/approve | body: {reason?} for decline; otherwise none | {ok?:boolean,message?:string,...} (web\src\app\requests\page.tsx:24) | Requests approve | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:111 |
| POST | /api/requests/{id}/retry | body: {reason?} for decline; otherwise none | {ok?:boolean,message?:string,...} (web\src\app\requests\page.tsx:24) | Requests retry | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:118 |
| POST | /api/requests/{id}/pick | body: {token} | {ok:boolean,message?:string,status?:string} (web\src\components\releases\release-picker-dialog.tsx:6) | Release picker for approved request | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:126 |
| POST | /api/requests/{id}/decline | body: {reason?} for decline; otherwise none | {ok?:boolean,message?:string,...} (web\src\app\requests\page.tsx:24) | Requests decline | True | from source, not captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:145 |
| GET | /api/requests | status?:string (web omits) | {requests:OwnerRequest[]} (web\src\lib\requests.ts:7) | Requests owner view | False | captured | ;  | server\TorrentFlow.Api\Requests\RequestEndpoints.cs:178 |

## rules

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/rules | none | {rules:Rule[]} (web\src\app\rules\page.tsx:27) | Rules selects body.rules; Settings count selects its length | False | captured | ;  | server\TorrentFlow.Library\Features\Rules\RulesController.cs:13 |
| POST | /api/rules | body: rule form (name,query,category,enabled,filters,...); id for update | {rule?:Rule,error?:string,...} (web\src\app\rules\page.tsx:27) | Rules create | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Rules\RulesController.cs:20 |
| PATCH | /api/rules | body: {id,enabled?} or rule form | {rule?:Rule,error?:string,...} (web\src\app\rules\page.tsx:27) | Rules update | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Rules\RulesController.cs:20 |
| DELETE | /api/rules | id | {ok?:boolean,error?:string} (web\src\app\rules\page.tsx:27) | Rules remove | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Rules\RulesController.cs:65 |
| POST | /api/rules/run | none | {ok?:boolean,message?:string,...} (web\src\app\rules\page.tsx:27) | Rules run now | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Rules\RulesController.cs:74 |

## search

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/search/titles | q;category?;limit? | {results:WorkSearchHit[],query?:string,canonicalQuery?:string,partial?:boolean,failedProviders?:string[],stale?:boolean} (web\src\lib\search\work-search.ts:1) | Search overlay; Search; Everything | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\TitleSearchController.cs:13 |
| GET | /api/search | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Search\SearchController.cs:12 |

## settings

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/settings/remote-access | none | RemoteAccessSettings (web\src\components\settings\remote-access-section.tsx:24) | Settings remote access | False | captured | ;  | server\TorrentFlow.Api\RemoteAccess\RemoteAccessEndpoints.cs:48 |
| PUT | /api/settings/remote-access | body: {enabled,tunnelPort,teamDomain?,audience?,ownerEmails:string[],allowRequesters} | RemoteAccessSettings (web\src\components\settings\remote-access-section.tsx:24) | Settings remote access | True | from source, not captured | ;  | server\TorrentFlow.Api\RemoteAccess\RemoteAccessEndpoints.cs:54 |
| GET | /api/settings/remote-access/check | none | RemoteAccessCheck (web\src\components\settings\remote-access-section.tsx:45) | Settings remote access check | False | captured | ;  | server\TorrentFlow.Api\RemoteAccess\RemoteAccessEndpoints.cs:101 |
| GET | /api/settings/download-recovery | none | RecoveryInfo (web\src\components\settings\download-recovery.tsx:17) | Recovery dialog | False | captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadRecoveryController.cs:37 |
| POST | /api/settings/download-recovery | none; restores persisted download storage | {ok?:boolean,message?:string,...} (web\src\components\settings\download-recovery.tsx:45) | Recovery restore | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadRecoveryController.cs:48 |
| GET | /api/settings/download-recovery/sources | none | SourceScan (web\src\components\settings\download-recovery.tsx:35) | Recovery external import | False | captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadRecoveryController.cs:59 |
| POST | /api/settings/download-recovery/sources | body: {ids:string[],acknowledged:boolean} | {ok?:boolean,message?:string,...} (web\src\components\settings\download-recovery.tsx:45) | Recovery import selected | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\DownloadRecoveryController.cs:67 |
| GET | /api/settings/browse-folders | path?:string | {path:string,parent:string\|null,entries:FolderPickerEntry[],...} (web\src\components\settings\folder-picker.tsx:58) | Folder picker | False | captured | ;  | server\TorrentFlow.Engine\Controllers\FoldersController.cs:14 |
| POST | /api/settings/open-folder | body: {path?,hash?,...} | {ok?:boolean,error?:string,message?:string} (web\src\app\settings\page.tsx:50) | Settings; Downloads folder action | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\FoldersController.cs:56 |
| POST | /api/settings/untracked-files | See server handler and source-contracts.json | No web consumer (server response source) () | server only | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\FoldersController.cs:135 |
| GET | /api/settings/client | none | {settings:ClientForm & extra fields,defaults:unknown} (web\src\app\settings\page.tsx:50) | Settings; Downloads cap; preferred quality; setup | False | captured | ;  | server\TorrentFlow.Engine\Controllers\SettingsClientController.cs:28 |
| PUT | /api/settings/client | body: ClientForm partial; test?,testTarget?,switchToBuiltin?,maxActiveDownloads?,downloadWindows?,... (see source) | {settings?:ClientForm,message?:string,error?:string,...} (web\src\app\settings\page.tsx:50) | Settings; Downloads cap; setup | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\SettingsClientController.cs:129 |
| GET | /api/settings/sources | none | {sources:Source[],error?:string\|null} (web\src\components\settings\sources-settings.tsx:57) | Settings sources | False | captured | ;  | server\TorrentFlow.Metadata\Settings\SourcesController.cs:15 |
| PUT | /api/settings/sources/{id} | body: Update; enabled?,priority?,baseUrl?,mirrors?,timeoutMs?,categories?,options?,credential?,kind?,type? | {sources:Source[],error?:string\|null} (web\src\components\settings\sources-settings.tsx:57) | Settings source save/add | True | from source, not captured | ;  | server\TorrentFlow.Metadata\Settings\SourcesController.cs:23 |
| DELETE | /api/settings/sources/{id} | none | {sources:Source[],error?:string\|null} (web\src\components\settings\sources-settings.tsx:57) | Settings remove custom source | True | from source, not captured | ;  | server\TorrentFlow.Metadata\Settings\SourcesController.cs:49 |
| POST | /api/settings/sources/{id}/test | none; safe remote health probe | {ok:boolean,status:string,message?:string\|null} (web\src\components\settings\sources-settings.tsx:57) | Settings source test | False | captured | ;  | server\TorrentFlow.Metadata\Settings\SourcesController.cs:59 |
| GET | /api/settings/tmdb | none | Status (web\src\components\settings\tmdb-settings.tsx:8) | Settings TMDB | False | captured | ;  | server\TorrentFlow.Metadata\Settings\TmdbSettingsController.cs:16 |
| PUT | /api/settings/tmdb | body: {apiKey:string} | Status (web\src\components\settings\tmdb-settings.tsx:8) | Settings TMDB save | True | from source, not captured | ;  | server\TorrentFlow.Metadata\Settings\TmdbSettingsController.cs:23 |
| DELETE | /api/settings/tmdb | none | Status (web\src\components\settings\tmdb-settings.tsx:8) | Settings TMDB remove | True | from source, not captured | ;  | server\TorrentFlow.Metadata\Settings\TmdbSettingsController.cs:37 |
| POST | /api/settings/tmdb/test | body: {apiKey?:string}; empty uses stored key | {ok:boolean,status:string,message:string} (web\src\components\settings\tmdb-settings.tsx:24) | Settings TMDB test | False | captured | ;  | server\TorrentFlow.Metadata\Settings\TmdbSettingsController.cs:46 |

## suggest

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/suggest | See server handler and source-contracts.json | No web consumer (server response source) () | server only | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\TitleSearchController.cs:55 |

## title

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/title/{workKey} | t?,y?,type?,s?,provider?,providerId?,sourceType?,format?,series?,remembered? | TitleDetailPayload (web\src\components\title\types.ts:157) | Title detail | False | captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:23 |
| GET | /api/title/{workKey}/links | none | {links:WorkLink[]} (web\src\components\title\linked-records.tsx:3) | Title linked records | False | captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:75 |
| DELETE | /api/title/{workKey}/links/{provider}/{externalId} | none | {links?:WorkLink[],message?:string} (web\src\components\title\linked-records.tsx:3) | Title unlink record | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:84 |
| GET | /api/title/{workKey}/progress | session?:poll identity | TitleProgressPayload (web\src\components\title\types.ts:76) | Title transfer polling | False | captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:92 |
| POST | /api/title/{workKey} | body: {action,season?,episode?,quality?,storageOverride?,...}; see title-action-request.ts | TitleGrabResponse / TitleSeasonGrabResponse (web\src\components\title\types.ts:9) | Title download film/episode/season | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:95 |
| GET | /api/title/{workKey}/releases | season?,episode?,q? | PickList (web\src\components\releases\release-picker-dialog.tsx:32) | Release picker | False | captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:281 |
| POST | /api/title/{workKey}/releases | body: {token} | {ok:boolean,message?:string,infoHash?:string} (web\src\components\releases\release-picker-dialog.tsx:6) | Release picker | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Titles\TitleController.cs:285 |
| GET | /api/title/{workKey}/extras | t?,y?,type?,s?,provider?,providerId?,poster?,sourceType?,format?,series?,v? | TitleExtrasPayload (web\src\components\title\types.ts:280) | Title metadata; owner request preview seasons | False | captured | ;  | server\TorrentFlow.Metadata\Controllers\BrowseController.cs:39 |

## torrent

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| POST | /api/torrent/send | body: {magnet?,torrentUrl?,infoHash?,name?,category?,savePath?,source?,...} | SendError / send result (see source) (web\src\app\downloads\page.tsx:168) | Downloads add torrent; Share; Library raw release | True | from source, not captured | ;  | server\TorrentFlow.Engine\Controllers\TorrentSendController.cs:37 |

## wanted

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/wanted | none | {wanted:WantedRow[],queue:unknown} (web\src\components\wanted\wanted-actions.tsx:10) | Downloads Looking | False | captured | ;  | server\TorrentFlow.Library\Features\Grabs\WantedController.cs:15 |
| DELETE | /api/wanted | workKey;season?;episode? | {ok:boolean,removed:number} (web\src\components\wanted\wanted-actions.tsx:10) | Stop looking | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Grabs\WantedController.cs:39 |
| POST | /api/wanted/try | workKey;season?;episode? | {ok:boolean} (web\src\components\wanted\wanted-actions.tsx:10) | Try now | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Grabs\WantedController.cs:48 |

## watchlist

| Method | Path | Query/body | Expected TypeScript response (source) | Consumer | Mutates | Evidence |
|---|---|---|---|---|---|---|
| GET | /api/watchlist | none | {items:WatchItem[]} (web\src\app\watchlist\page.tsx:56) | Library | False | captured | ;  | server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:24 |
| POST | /api/watchlist | body: title identity/addPayload; mediaType,externalId,title,posterUrl?,synopsis?,rating?,provider?,providerId?,workKey?,format?,monitorMode?,fromSeason?,fromEpisode?,preferredResolution?,monitored? | {item?:WatchItem,error?:string,...} (web\src\app\watchlist\page.tsx:56) | Library add; title library controls; recommendation add | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:50 |
| PATCH | /api/watchlist | body: {id,status?,monitored?,monitorMode?,fromSeason?,fromEpisode?,preferredResolution?,...} | {item?:WatchItem,error?:string,...} (web\src\app\watchlist\page.tsx:56) | Library edit; title monitor | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:50 |
| DELETE | /api/watchlist | id; deleteFiles? (web omits) | {ok?:boolean,error?:string} (web\src\app\watchlist\page.tsx:56) | Library remove; title remove | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:348 |
| POST | /api/watchlist/check | See server handler and source-contracts.json | No web consumer (server response source) () | server only | True | from source, not captured | ;  | server\TorrentFlow.Library\Features\Watchlist\WatchlistController.cs:363 |
