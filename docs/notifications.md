# Notifications

The bell in both owner and requester headers opens `/notifications`. Read state
is stored on the server, not in browser storage. Each signed-in requester sees
only notifications for their user row (mapped from their verified email); all
owner sessions share the local owner's feed.

Owners receive new-request, download-completed and download-failed notifications.
Requesters receive approval, decline and fulfillment updates, plus an update if
an approved request cannot find a download. Notifications start when this version is installed;
historical activity remains in the download log.

Each season download (a Download season click or an approved request's season) is
one run with a persisted id (`AcquisitionTarget.RunId`). After the wanted queue's
first pass for that run the owner gets exactly one `download.summary` notification
with counts only, built by `SeasonFailureSummary.Counts`: "Frieren: Beyond
Journey's End S1: 36 started, 2 not found yet". Its link
(`/title/{workKey}?s={season}&run={runId}`) is unique to the run, so later finds
(queue retries, a season pack, a hand-picked release) change the numbers of that
same notification in place, keeping its time and read state without adding a second
feed entry.
The reasons for what is still missing stay on the title page.

## API

All endpoints require the existing local-owner or verified remote session.
No endpoint accepts a recipient supplied by the caller.

* `GET /api/notifications?limit=100`: latest entries and total `unreadCount`.
* `POST /api/notifications/read/{id}`: mark one own entry read; foreign IDs return 404.
* `POST /api/notifications/read-all`: mark all own entries read.
* `GET /api/me`: includes `unreadNotifications` (null if the count is unavailable).

Responses are not cached. The feed is capped at 100 entries; its unread count and
mark-all operation include older entries. The UI polls every 15 seconds.
