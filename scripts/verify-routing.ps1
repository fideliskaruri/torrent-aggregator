$BBB  = "magnet:?xt=urn:btih:dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"
$HASH = "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"
$wl = (Invoke-RestMethod http://127.0.0.1:3000/api/watchlist -TimeoutSec 30).items
function Id($t) { ($wl | Where-Object { $_.title -like "*$t*" } | Select-Object -First 1).id }

$cases = @(
  @{ label="watchlist anime (clean SxxEyy, no anime cues)"; n="Frieren Beyond Journeys End S01E12 1080p WEB-DL x265-GRP"; id=(Id "Frieren");  want="Anime"  }
  @{ label="watchlist tv   (same shape, western show)";     n="The Bear S03E01 1080p HEVC x265-MeGusta";                 id=(Id "The Bear"); want="TV"     }
  @{ label="watchlist anime (absolute numbering)";          n="One Piece 1170 1080p";                                    id=(Id "One Piece");want="Anime"  }
  @{ label="watchlist movie";                               n="Dune Part Two 2024 2160p WEB-DL x265";                    id=(Id "Dune");     want="Movies" }
  @{ label="search card: TMDB ja + Animation";              n="Solo Leveling S02E05 1080p WEB-DL x265-GRP";              meta=@{source="tmdb";mediaType="tv";externalId="127532";title="Solo Leveling";genres=@("Animation","Action & Adventure");originalLanguage="ja";originCountry=@("JP")}; want="Anime" }
  @{ label="search card: TMDB en drama (same-named anime)"; n="The Bear S03E01 1080p HEVC x265-MeGusta";                 meta=@{source="tmdb";mediaType="tv";externalId="136315";title="The Bear";genres=@("Drama","Comedy");originalLanguage="en";originCountry=@("US")}; want="TV" }
  @{ label="JP live action must NOT become anime";          n="Shogun S01E03 1080p WEB-DL x265-GRP";                     meta=@{source="tmdb";mediaType="tv";externalId="126308";title="Shogun";genres=@("Drama","War & Politics");originalLanguage="ja";originCountry=@("JP")}; want="TV" }
)

$pass = 0; $fail = 0
foreach ($c in $cases) {
  $b = @{ magnet=$BBB; name=$c.n }
  if ($c.id)   { $b.watchListItemId = $c.id }
  if ($c.meta) { $b.metadata = $c.meta }
  try {
    $r = Invoke-RestMethod -Uri http://127.0.0.1:3000/api/torrent/send -Method Post -ContentType 'application/json' -Body ($b | ConvertTo-Json -Depth 6) -TimeoutSec 90
    $sp = $r.target.savePath
    if ($sp -like "*\$($c.want)\*" -or $sp -like "*\$($c.want)") { $pass++; $st="PASS" } else { $fail++; $st="FAIL" }
    "{0}  {1,-46} kind={2,-7} {3}" -f $st, $c.label, $r.smart.kind, $sp
  } catch { $fail++; "ERR   $($c.label) :: $_" }
  Start-Sleep -Seconds 2
  try { Invoke-RestMethod -Uri http://127.0.0.1:3000/api/client/torrents -Method Post -ContentType 'application/json' -Body (@{action='delete';hash=$HASH;deleteFiles=$true} | ConvertTo-Json) -TimeoutSec 60 | Out-Null } catch {}
  Start-Sleep -Seconds 2
}
""
"RESULT: $pass passed, $fail failed"
