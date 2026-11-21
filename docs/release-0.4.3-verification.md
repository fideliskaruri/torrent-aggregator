# 0.4.3 — ordinary redownload must search again

Owner authorized installation and deletion/redownload of installed Classroom of the Elite S01E01 only,21November2026.

Installed0.4.2 reproduced the wrong release after delete→ordinary Download: T3KASHi07d77fa13ec33dd235557934e60ee523356a354b. Paused immediately. No unrelated transfer commands issued.

Root cause: BuildTargetWrites reused PickedReleaseHash from a Removed/Done target. DiscoveryPlan treats that as an explicit owner selection, calls SelectAsync rather than SearchAsync, and intentionally bypasses automatic English-first discovery. This stale intent survived physical deletion.

Fix: clear PickedReleaseHash only when ordinary admission reuses Removed/Done. New explicit selections retain their hash. Duplicate admission to an active wanted target preserves its current explicit selection. No schema/UI/settings change.

Verification: new reacquisition regression fails before the fix and passes after it. Full existing audio suite plus five new checks pass. Generated real MonoTorrent completion→drain→read→rename→digest fixture passes. Temporary exception instrumentation removed. Original transient isolated filing issue did not reproduce with generated files or subsequent real YURASUKA episode2; its root cause remains unconfirmed, and no speculative filing change is shipped.

Pending: package smoke, publish, updater installation, installed S01E01 delete→Download→Ready, actual downloaded audio verification. Do not mark complete before that evidence.
