# Automation HTTP adapter

`AutomationEndpoints.cs` preserves the web's `/api/rules`, `/api/rules/run`,
`/api/automation/run`, and follow routes. Rule persistence and scheduling live
in `TorrentFlow.Requests` (`backend/src/Requests`).

Each scheduled or explicit rule pass resolves catalog matches for enabled rules
and accepts only unowned items without an active target. The shared Targets
pipeline owns subsequent search, planning and download work. Accepted targets
retain `Rule` origin even if their rule is later deleted. Follow records remain
available to existing pages, but are not materialized by the rule-run endpoint.
