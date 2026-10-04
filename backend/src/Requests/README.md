# Requests module

This module owns request, rule and notification behavior that is independent of
HTTP. It depends on Domain, Targets and Store only. The API keeps route mapping
and delegates into this module.

Requests create and settle their own request rows while accepting Wanted targets
through Targets. Rules resolve catalog matches and create Wanted targets with
`Rule` origin; Targets performs later discovery and acquisition. Notifications
consume the committed target event stream, and own the activity read models.
When an owner uses Download now on a pending request target, this module approves
the associated request; Targets does not make that request decision.

Web Push, calendar, request auto-approval settings and quality-watch upgrades are
not implemented in v1. Existing web-used routes remain mapped where applicable.
