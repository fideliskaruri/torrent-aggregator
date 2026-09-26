# Notifications

The bell in both owner and requester headers opens `/notifications`. Read state
is stored on the server, not in browser storage. Each signed-in requester sees
only notifications for their user row (mapped from their verified email); all
owner sessions share the local owner's feed.

Owners receive new-request, download-completed and download-failed notifications.
Requesters receive approval, decline and fulfillment updates, plus an update if
an approved request cannot find a download. Streaming/prewarm transfers do not
generate owner alerts. Notifications start when this version is installed;
historical activity remains in the download log.

## API

All endpoints require the existing local-owner or verified remote session.
No endpoint accepts a recipient supplied by the caller.

* `GET /api/notifications?limit=100`: latest entries and total `unreadCount`.
* `POST /api/notifications/read/{id}`: mark one own entry read; foreign IDs return 404.
* `POST /api/notifications/read-all`: mark all own entries read.
* `GET /api/me`: includes `unreadNotifications` (null if the count is unavailable).
* `GET /api/notifications/push/public-key`: public VAPID key only.
* `POST /api/notifications/push/subscription`: `{ endpoint, p256dh, auth }`.
* `DELETE /api/notifications/push/subscription`: `{ endpoint }`, scoped to caller.

Responses are not cached. The feed is capped at 100 entries; its unread count and
mark-all operation include older entries. The UI polls every 15 seconds.

## Web Push

Enable/disable push explicitly using **Browser notifications** in the feed.
Permission is requested only after clicking Enable. Push requires a supported
browser and a secure origin (HTTPS or localhost); iOS requires an installed web
app. Plain HTTP LAN access still supports the in-app feed, but not Web Push.

The P-256 VAPID pair is generated at first startup and saved as `push-vapid.json` in
the configured TorrentFlow data directory. Keep this file private and include it
in backups; deleting it invalidates existing browser subscriptions. Never commit
it. Only its public key is returned by the API.

Subscription endpoints are limited to browser push providers (Google, Mozilla,
Apple, Windows), HTTPS and the default port; redirects are disabled. 404/410
responses prune dead subscriptions; transient failures keep them. Up to ten
devices are stored per recipient. A browser subscription is associated with the
last account that explicitly enables it. Disable push before changing accounts
on a shared device.

Delivery is best effort: the feed persists first, then push is attempted in the
background. A process shutdown can lose an outstanding push, not its feed entry.
Notification clicks open an app link without navigating an active playback tab.
