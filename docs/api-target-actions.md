# Targets public actions

Targets alone writes target state, policy, origin and release choice. HTTP adapters and
automation call its public methods; request adapters only attach request items.

- `AcceptAutomationAsync(AcquireInput, origin, ruleId, minSeeders, maxBytes, ct)` accepts
  confirmed missing films/episodes with Follow, Rule or Hunter attribution. It retains
  existing intent, including removed tombstones, and skips imported/downloaded ownership.
  Automated accepts cannot acquire owner rank. Their first discovery uses the background
  lane, and date-based priority remains BackCatalogue or FreshRelease. Upgrade watches
  remain notification-only, with no automatic replacement of owned files.
- `AcceptRequestAsync` creates request-attributed targets through the same acceptance path.
- `PickAsync(targetId, releaseHash, ct)` persists an exact indexed release choice.
  Find rehydrates and structurally validates that release through its public `SelectAsync`;
  Check and Plan still enforce ownership, safety, language, quality, blocks and seed policy.
  An unavailable/unknown choice waits; the pipeline never silently picks a different hash.
  Active or retained transfers use the existing swap/resume actions, not Pick.
- `SetQualityAsync(workKeyOrTargetId, resolution, ct)` persists the target quality wanted,
  bumps policy/version, cancels stale discovery and wakes pending intent. A work-wide call
  also saves its preference for later accepts. It never automatically replaces owned files.

## Owner HTTP routes

The calendar can call **`PUT /api/title/{escapedWorkKey}/quality`**, with
`{"resolution":1080}` (or `null` to clear the floor). This works in production, not only
Development. `PUT /api/targets/{escapedTargetId}/quality` changes just one target.

`POST /api/requests/{requestId}/pick` accepts
`{"targetId":"target:…","releaseHash":"40-or-64-hex-hash"}`. The request must be approved
and the selected target must be an unfinished item attached to that request. These
routes are owner-only. `POST /api/rules/run` and the existing Hunter scheduler now accept
targets rather than returning the former public-API boundary placeholder.

The TargetPublicActions migration stores minimum listed seeders and the pinned release
hash on Target. Choice, quality and deterministic item IDs survive restarts.

Targeted real-data HTTP evidence is in gitignored `tools/.targetsapi-proof/`. The proof
uses an isolated copy of the preserved 3930 dataset, a real imported Family Guy episode,
Abbott Elementary follows, a Sintel rule, and a Big Buck Bunny request. Non-free targets
are paused before enabling the worker. Unknown-health choices are honestly reported as
waiting, not as completed downloads.
