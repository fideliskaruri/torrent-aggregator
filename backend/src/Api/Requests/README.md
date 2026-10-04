# Request HTTP adapter

`RequestEndpoints.cs` owns the requester and owner HTTP routes, authorization,
request-body parsing and response projection. Request behavior lives in
`TorrentFlow.Requests` (`backend/src/Requests`); that module links request items
to Targets, settles approved items, and creates request-origin Wanted targets
through the shared Targets acceptance path.

Requester routes remain read-only apart from creating a request. The legacy
cancel route remains mapped and returns an honest `403`. The owner inbox keeps
its existing approve, decline, retry and release-pick routes. Local loopback
access is owner-only; requester HTTP flows require the configured remote-access
identity.
