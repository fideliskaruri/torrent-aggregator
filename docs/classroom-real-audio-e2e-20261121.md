# Classroom of the Elite actual payload test — 21 November 2026

Release: packaged 0.4.2, product commit 38b4a480a91bad81304150a400fd83643207def1.
Isolated app3995; disposable database/media; installed app untouched.

## Actual journey
Headless Playwright MCP: Search → Classroom of the Elite (2017) → Season1 → Download S01E01 → confirm1080p → Downloads. English preference, default enabled sources, no manual release override.
Automatic acquisition selected Classroom.of.the.Elite.S01.1080p.Blu-Ray.10-Bit.Dual-Audio.TrueHD.x265-iAHD, hash61931a84cc32037a486cb832c671dd2bdcf7d12b.
Selected episode payload:1,291,800,877bytes. Engine logged selected-files completion at13:42:24+03:00 and stopped seeding.

## Actual audio evidence
ffprobe of the downloaded MKV: English TrueHD5.1, default audio stream1; Japanese TrueHD stereo stream2. Runtime24:02,1920×1080 video.
Decoded two20-second samples of stream1 at04:00 and08:00 with Jellyfin ffmpeg. Local multilingual Whisper tiny identified English with probabilities0.9694 and0.9935. Both transcripts are coherent school dialogue consistent with episode1; not commentary or a song. Audio was not uploaded. This verifies actual English dialogue beyond release/container labels, but is sampled rather than an audit of every second.
Evidence: artifacts/classroom-e2e-20261121/probe.json and decoded-audio-verification.json; WAV samples and downloaded payload retained locally.

## End-to-end result: NOT fully passing
English acquisition passed, but final library filing did not. App remains Finishing, retrying soon, with FileBusy reason: completed file cannot be read. Payload remains .mkv.partial and Open is unavailable. Do not report whole journey successful.
Source inspection: DownloadFiling.ValidatePartial uses File.OpenRead (read sharing only); Engine/PhysicalFiles opens read/write handles with FileShare.ReadWrite. A Windows sharing conflict is a candidate, not yet a proven root cause. ffprobe/ffmpeg can read the actual payload. No product changes made in this test.
Next: reproduce the finishing exception with diagnostic detail, fix its owning lifecycle/sharing contract, test publication plus Open; retain piece-validation guarantees. No manual rename/database edits used to fake completion.
