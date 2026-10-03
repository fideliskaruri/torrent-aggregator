# Reusable local filing recipe

Always launch **source**, not `seeder-bin\Seeder.dll`. The historical binary in
that directory was built before the explicit-server change: it ignores a second
argument and polls **3973**, even when the receiving instance is on another port.
It hashes every piece but never learns that instance's peer listen port.

```powershell
# A dedicated fixture directory; do not modify or move the original seed.
New-Item -ItemType Directory -Force D:\code\memtest\my-fixture\seed
Copy-Item tools\.filing-proof\seed\Sintel\Sintel.mp4 D:\code\memtest\my-fixture\seed
Copy-Item tools\.jelly-proof\Sintel.torrent D:\code\memtest\my-fixture

# Rebuilds the owning tool, then runs with this exact receiving instance.
.\tools\.jelly-proof\Seed.ps1 `
  -FixtureDirectory D:\code\memtest\my-fixture `
  -ServerUrl http://127.0.0.1:3964
```

The receiver must run in Development, with fresh isolated data, scheduler
disabled, a child-only `TMDB_API_KEY`, and a normal confirmed Library storage
root. Open `/api/title/tmdb:movie:45745` first. Read its current work through
`/api/dev/plan-eval/metadata?workKey=tmdb:movie:45745`; use that work and the
ordinary film placement input in `POST /api/dev/filing/`. The original Sintel
torrent's hash is `e1d833fe2adc88bc76b8b29e380b80e2ce43f82c`; a regenerated
single-file torrent has a **different** hash. Always use the loaded torrent's
hash printed by the seeder, not one copied from another recipe.

For that original Sintel fixture, this is the complete receiver-side request
(run in a second PowerShell after the seeder has printed `494/494`):

```powershell
$base = 'http://127.0.0.1:3964'
$root = 'D:\code\memtest\my-library' # New, empty, dedicated to this proof.
function Post($path, $body) {
  Invoke-RestMethod "$base$path" -Method Post -ContentType application/json `
    -Body ([Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Depth 40)))
}
$added = Post '/api/dev/library/roots' @{
  path=$root; kinds=@(0,1,2,3); priority=1; reserveBytes=0; confirmed=$true
}
if (!$added.root) { throw ($added.failure | ConvertTo-Json) }
Invoke-RestMethod "$base/api/title/tmdb:movie:45745" | Out-Null
$work = (Invoke-RestMethod "$base/api/dev/plan-eval/metadata?workKey=tmdb:movie:45745").work
if (!$work) { throw 'TMDB did not resolve Sintel. Check the child-only TMDB_API_KEY.' }
# Dev metadata is string-enum output; filing's ordinary HTTP input is numeric.
$work.work.kind = @('Unknown','Film','Series').IndexOf($work.work.kind)
$work.work.format = @('Unknown','Movie','Series','Special').IndexOf($work.work.format)
$work.work.releasePrecision = @('Unknown','Day','Instant').IndexOf($work.work.releasePrecision)
foreach ($name in $work.names) {
  $name.label = @('English','Romaji','Synonym','Native','Original').IndexOf($name.label)
}
foreach ($link in $work.links) {
  $link.status = @('Verified','Suggested','Rejected').IndexOf($link.status)
}
$hash = 'e1d833fe2adc88bc76b8b29e380b80e2ce43f82c'
$id = "$($work.work.id)-proof-film"
$now = [DateTimeOffset]::UtcNow.ToString('o')
$target = @{
  id=$id; workId=$work.work.id; kind=0; state=4; priority=0; rank=0
  createdBy='local'; origin=0; policyRevision=1; createdAt=$now; updatedAt=$now; version=1
}
$request = @{
  magnet="magnet:?xt=urn:btih:$hash"
  placement=@{
    work=$work; targets=@($target); roots=@(); owned=@(); files=@()
    assignment=@{
      hash=$hash; targetIds=@($id); reservedPieceBytes=129241752
      reason='Licensed local filing proof'
      files=@(@{targetId=$id; fileIndex=0; role=0})
    }
  }
}
$admitted = Post '/api/dev/filing/' $request
if (!$admitted.accepted) { throw ($admitted | ConvertTo-Json -Depth 20) }
$deadline = [DateTimeOffset]::UtcNow.AddSeconds(120)
do {
  Start-Sleep -Milliseconds 250
  $filed = Invoke-RestMethod "$base/api/dev/filing/"
  if ([DateTimeOffset]::UtcNow -gt $deadline) {
    throw ("Filing did not finish: " + ($filed.reasons | ConvertTo-Json))
  }
} until ($filed.media.Count -gt 0)
$filed.media | Select-Object path, bytes, resolution, contentDigest
Get-FileHash $filed.media[0].path -Algorithm SHA256 | Format-List Algorithm,Hash,Path
```

Expected log sequence: `pieces=494/494`, `inject ... port=<receiver peer port>`,
then `connected=...`. The seed file sits **directly** in `seed`, not `seed\Sintel`.
The fixture's torrent and the magnet must identify the same hash.

Discovery is deliberate: the tool polls the supplied server's development
**diagnostics**, including metadata probes (not the payload-only `torrents`
array), and injects that receiver's active hash and **current** peer listen port.
The magnet needs no `x.pe`. There is no reliance on trackers, DHT, LSD, public
seeders, or a fixed peer port. The seeder binds IPv4 loopback on an ephemeral
port, with DHT/LSD/UPnP off; the receiver accepts IPv4 on its separately allocated
TCP/UDP port. A stored receiver port is reused only while available; Engine
selects and persists another when occupied. HTTP port and peer port are different.
Do not copy a stored port into a second agent's tool.

Poll `GET /api/dev/filing/` until `media` contains the final file; admission alone
is not completion. Verify its length and SHA-256 against the unchanged seed.
Capture the server and seeder process IDs, then stop only those literal IDs and
remove your own fixture, data, library and isolated build after verification.

Regression evidence: `tools\.f408-proof\report.md`. No Engine/DevFiling timeout,
encryption, tracker or admission workaround is needed for a stale proof binary.
