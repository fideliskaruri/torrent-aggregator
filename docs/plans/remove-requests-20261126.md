# Remove Requests — bounded product change

Owner explicitly removes the user Requests feature and authorizes Terra React/backend performance audit. Base: released 0.4.5 f670fc0, reuse release worktree; extensive app/ work is unrelated and preserved. No installed mutation, release or update requested for this new change.

Flow/source contract: Browse/Search -> Title stays; owner Download/Save/Auto-download remains. Guest Browse/Search/Title and available-library browsing stay read-only, with no Request action. Requests inbox/nav/dialog and approve/decline/pick/create APIs retire; old Requests URL returns Browse. Request reconciliation stops, so old pending requests cannot create new acquisitions. Existing accepted downloads and stored rows remain untouched. Notification inbox and automation stay registered. Access roles/security remain.

Source bridge: navigation/router -> request page; TitleHeroActions -> RequestAction/RequestDialog -> requester API; RequestEndpoints -> RequestService -> TargetPipeline; Module -> RequestReconciler. Module also owns HunterScheduler + NotificationWorker and must retain both. /api/me pending count no longer scans Request table. Read-only library projection remains separate from submission.

Visual/research contract: this removes a destination/action, adds no new visual pattern; reuse current navigation, title actions, route redirect and guest library. No visual redesign or new component/library. Current source is authority; historical Graphify extraction is stale. Verify owner/guest routes, absence of request controls/requests traffic, old API refusal and preservation of automation/notifications/download capabilities on isolated data. Build backend/web; inspect desktop/mobile navigation with headless MCP. Test old request rows do not reconcile.

Acceptance checklist
- [x] No visible Request action, inbox or navigation.
- [x] Legacy request mutation endpoints cannot create/approve/pick anything.
- [x] Request reconciliation is not registered; automation/notifications remain.
- [x] Guest read-only library remains usable and guest cannot acquire.
- [x] Existing schema/media/download state retained.
- [x] Web/backend checks and isolated HTTP/browser checks pass.
- [x] Terra audit reviewed; no unmeasured performance claims.

## Verification record

Backend and production web builds passed. Seven retired API routes returned410 feature_removed on disposable port3988; health/session/downloads/watchlist/notifications stayed HTTP200. Actual router redirected /requests to Browse. Headless built UI at390/768/1280 showed no Request links/actions; guest preview hid owner Downloads and title actions. Captures inspected locally. Guest preview is not authenticated Cloudflare testing: remote JWT integration was not exercised; existing authorization preserved. No schema migration/data deletion; installed app unchanged. Request processing implementations removed; shared HunterScheduler/NotificationWorker remain registered. Existing accepted Targets remain independent.

Terra audit in docs/performance-system-audit-20261126.md completed and key notification/shell-poll source findings spot-checked. React Profiler and per-phase backend attribution remain proposed. This task includes no performance fix or installed update claim.
