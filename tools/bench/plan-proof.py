"""Real HTTP proof for Plan. No payload download and no unit-test mocks."""
import copy
import datetime as dt
import hashlib
import json
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".plan-proof"
BASE = "http://127.0.0.1:3949"
NOW = dt.datetime.now(dt.timezone.utc)
STAMP = NOW.isoformat()
SLUGS = [
    "scorpion-s1", "little-fires-everywhere-s1", "frieren-s1", "frieren-s1e5",
    "a-silent-voice", "prison-break-s1", "money-heist-s1", "rick-and-morty-s1",
    "sintel", "big-buck-bunny",
]


def http(path, body=None):
    request = urllib.request.Request(BASE + path, data=None if body is None else
                                     json.dumps(body).encode(), headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response:
        return json.load(response)


def load_scope(slug):
    recorded = json.loads((ROOT / "tools" / ".find-proof" / (slug + "-1.json")).read_text())["body"]
    metadata = http("/api/dev/plan-eval/metadata?workKey=" + urllib.parse.quote(recorded["workKey"]))["work"]
    (OUT / (slug + "-metadata.json")).write_text(json.dumps(metadata, indent=2))
    return slug, recorded, metadata


def target(work, episode=None):
    return dict(
        id="plan:" + (episode["id"] if episode else work["work"]["id"]), workId=work["work"]["id"],
        episodeId=episode["id"] if episode else None, kind="Acquire", state="Planning",
        resumeState=None, reasonCode=None, reasonText=None, nextTryAt=None, expectedAt=None,
        resolutionFloor=None, preferredResolution=1080, audioLanguage=None, maxBytes=None,
        ownerRanked=False, rank=0, nowAt=None, createdBy="proof", origin="Owner",
        autoRuleId=None, chosenReleaseHash=None, replaceMediaFileId=None, replacementMode=None,
        batchId=None, clickedAt=STAMP, substantiveMisses=0, helpNotifiedAt=None,
        policyRevision=0, leaseUntil=None, leaseToken=None, createdAt=STAMP, updatedAt=STAMP, version=0)


def synth_candidate(recorded, work, scope_episodes):
    p = copy.deepcopy(recorded["parse"])
    pack = p["pack"] or p["kind"] in ["SeasonPack", "MultiSeason", "CompleteSeries"]
    episodes = scope_episodes
    if not pack and work["work"]["kind"] != "Film":
        episodes = [e for e in scope_episodes if e["number"] in p["episodes"] or
                    e.get("absoluteNumber") in p["absoluteNumbers"]]
        if not episodes:
            episodes = scope_episodes[:1]
    amount = recorded.get("bytes") or (len(episodes) or 1) * 500_000_000
    files = []
    if work["work"]["kind"] == "Film":
        # These public short-film pools do not label resolution in the release name.
        # File resolution is synthesized, not claimed as measured payload quality.
        suffix = ".1080p" if work["work"]["workKey"] in ["imdb:movie:tt1727587", "imdb:movie:tt1254207"] and p["quality"]["resolution"] is None else ""
        paths = [recorded["name"] + suffix + ".mkv"]
    else:
        paths = [
            p["title"] + ".S%02dE%02d.mkv" % (
                next(s["number"] for s in work["seasons"] if s["id"] == e["seasonId"]), e["number"])
            for e in episodes]
    for index, path in enumerate(paths):
        size = amount // max(1, len(paths))
        files.append(dict(index=index, relativePath=path, bytes=size, offset=index * size))
    if "(Digital) (1r0n)" in recorded["name"]:
        files = [dict(index=0, relativePath="A Silent Voice.cbz", bytes=amount, offset=0),
                 dict(index=1, relativePath="pages/001.jpg", bytes=50000, offset=amount)]
    release = dict(id=recorded["hash"], name=recorded["name"], parsed=p, totalBytes=amount,
                   torrentUri=None, magnet=None, files=files, metadataDigest=None, private=False,
                   firstSeenAt=STAMP, lastSeenAt=STAMP)
    observations = [dict(id=recorded["hash"] + str(i), hash=recorded["hash"],
                         sourceId=s["sourceId"], sourceItemId=None, query=s["query"],
                         listedSeeders=s["listedSeeders"], listedLeechers=s["listedLeechers"],
                         uploadedAt=s["uploadedAt"], observedAt=STAMP, torrentUri=None, webSeeds=[])
                    for i, s in enumerate(recorded["sources"])]
    return dict(release=release, observations=observations,
                conservativeListedSeeders=recorded["conservativeListedSeeders"])


def evidence(candidate, band="Good"):
    return dict(hash=candidate["release"]["id"], band=band, files=candidate["release"]["files"],
                connectedPeers=4, connectedSeeders=2, byteSendingPeers=2, bytesDelivered=1_000_000,
                window="00:00:05", scrapedSeeders=None, reason="Synthesized Plan-only evidence",
                checkedAt=STAMP, expiresAt=(NOW + dt.timedelta(hours=6)).isoformat(),
                fromLiveTransfer=False, persistable=False, admissionHandle=None)


def evaluate(name, payload, assertion, note="Synthetic verdicts and hash-bound file lists"):
    started = time.perf_counter()
    response = http("/api/dev/plan-eval/", payload)
    elapsed = (time.perf_counter() - started) * 1000
    result = response["result"]
    ok = assertion(result)
    reasons = all(r.get("code") and r.get("explanation") for r in result["rejections"])
    chosen = [a["hash"] for a in result["assignments"]]
    row = dict(case=name, passed=bool(ok and reasons), httpMs=elapsed,
               evaluationMs=response["elapsedMs"], chosen=chosen, synthesis=note,
               assignments=result["assignments"], rejections=result["rejections"],
               uncovered=result["uncoveredTargetIds"])
    RESULTS.append(row)
    (OUT / (str(len(RESULTS)).zfill(2) + "-input.json")).write_text(json.dumps(payload, indent=2))
    (OUT / (str(len(RESULTS)).zfill(2) + "-result.json")).write_text(json.dumps(response, indent=2))
    print(name, "PASS" if row["passed"] else "FAIL", round(response["elapsedMs"], 3), chosen)
    return row


def chosen(r, candidate):
    return any(a["hash"] == candidate["release"]["id"] for a in r["assignments"])


def rejected(r, code):
    return any(x["code"] == code for x in r["rejections"])


def clone(candidate, label, resolution=None):
    c = copy.deepcopy(candidate)
    c["release"]["id"] = hashlib.sha1(label.encode()).hexdigest()
    if resolution is not None:
        c["release"]["parsed"]["quality"]["resolution"] = resolution
    return c


def case_input(template, candidates, bands=None):
    p = copy.deepcopy(template)
    p["input"]["pool"] = candidates
    p["input"]["evidence"] = [evidence(c, band) for c, band in zip(candidates, bands or ["Good"] * len(candidates))]
    p["input"]["fileMetadata"] = [dict(hash=c["release"]["id"], pieceLength=262144, parsedFiles={}) for c in candidates]
    return p


def owned(work, episode):
    video = dict(
        id="owned:" + episode["id"], workId=work["work"]["id"], episodeId=episode["id"],
        rootId=None, path="D:\\proof\\episode.mkv", physicalKey="owned:" + episode["id"],
        role="Video", parentMediaFileId=None, bytes=500000000, mtimeUtc=STAMP, resolution=1080,
        source="webdl", container="mkv", videoCodec=None, videoProfile=None, width=None, height=None,
        hdr=None, runtimeSeconds=None, bitrateBps=None, tracks=[], origin="Imported",
        downloadId=None, fileIndex=None, addedAt=STAMP, lastSeenAt=STAMP, missingSince=None,
        status="Present", missingConfirmedAt=None, verifiedAt=STAMP, contentDigest=None, version=0)
    return dict(workId=work["work"]["id"], episodeId=episode["id"], videos=[video])


OUT.mkdir(parents=True, exist_ok=True)
RESULTS = []
SCOPES = {}
with ThreadPoolExecutor(max_workers=2) as executor:
    for slug, recorded, work in executor.map(load_scope, SLUGS):
        season = next((s for s in work["seasons"] if s["number"] == 1), None)
        episodes = sorted([e for e in work["episodes"] if e["seasonId"] == (season or {}).get("id")],
                          key=lambda e: e["number"])
        if slug == "frieren-s1e5":
            episodes = [e for e in episodes if e["number"] == 5]
        targets = [target(work, e) for e in episodes] if work["work"]["kind"] != "Film" else [target(work)]
        candidates = [synth_candidate(c, work, episodes) for c in recorded["result"]["candidates"]]
        template = dict(workKey=recorded["workKey"], input=dict(
            work=None, mode="Catalog", ownerSelectedFiles=[], targets=targets, pool=[], evidence=[],
            owned=[], blocks=[], now=STAMP, queriesExhausted=True, fileMetadata=[]))
        payload = case_input(template, candidates)
        resolutions = {c["release"]["id"]: c["release"]["parsed"]["quality"]["resolution"] for c in candidates}
        evaluate(slug + ": real Find pool, preferred 1080p", payload,
                 lambda r, resolutions=resolutions: bool(r["assignments"]) and
                 all(resolutions[a["hash"]] == 1080 or resolutions[a["hash"]] is None and
                     "1080p quality fit" in a["reason"] for a in r["assignments"]),
                 "Synthetic verdicts and file lists; short films additionally synthesize 1080p in filenames because the real pools omit resolution")
        SCOPES[slug] = work, episodes, template, candidates

work, episodes, template, candidates = SCOPES["sintel"]
base = next(c for c in candidates if c["release"]["parsed"]["quality"]["resolution"] is None)
good = clone(base, "Good1080", 1080)
weak = clone(base, "Weak1080", 1080)
unknown = clone(base, "Unknown1080", 1080)
dead = clone(base, "Dead1080", 1080)
for name, pool, bands, expected in [
    ("Good beats Weak and Unknown", [unknown, weak, good], ["Unknown", "Weak", "Good"], good),
    ("Weak beats Unknown", [unknown, weak], ["Unknown", "Weak"], weak),
    ("Dead never selected", [dead, weak], ["Dead", "Weak"], weak),
    ("Unknown safe exhausted fallback", [unknown], ["Unknown"], unknown),
]:
    evaluate(name, case_input(template, pool, bands), lambda r, expected=expected: chosen(r, expected))
p = case_input(template, [unknown], ["Unknown"])
p["input"]["queriesExhausted"] = False
evaluate("Unknown deferred before queries exhausted", p, lambda r: not r["assignments"] and rejected(r, "unknown_deferred"))
p = case_input(template, [unknown], ["Unknown"])
p["input"]["evidence"][0]["files"] = None
p["input"]["pool"][0]["release"]["files"] = None
evaluate("Unknown needs complete safe metadata", p, lambda r: not r["assignments"] and rejected(r, "metadata_required"))
upper, lower = clone(base, "2160-fit", 2160), clone(base, "720-fit", 720)
upper["release"]["files"][0]["bytes"] = 500000000
lower["release"]["files"][0]["bytes"] = 100000000
evaluate("Quality fit: nearest above before below", case_input(template, [lower, upper]),
         lambda r: chosen(r, upper))
p = case_input(template, [lower, upper])
p["input"]["targets"][0]["maxBytes"] = 200000000
evaluate("Size cap: lower after upper rejected", p, lambda r: chosen(r, lower) and rejected(r, "size_cap"))
p = case_input(template, [lower])
p["input"]["targets"][0]["resolutionFloor"] = 1080
evaluate("Explicit quality floor rejects lower", p, lambda r: not r["assignments"] and rejected(r, "quality_floor"))
for ext, code in [("setup.mkv.exe. ", "unsafe_program"), ("movie.zip", "archive_only"), ("pages/001.jpg", "no_video"),
                  ("book.cbr", "no_video")]:
    c = clone(base, ext)
    c["release"]["files"][0]["relativePath"] = ext
    evaluate(ext + " rejected", case_input(template, [c]), lambda r, code=code: not r["assignments"] and rejected(r, code))
c = clone(base, "wrong-year")
c["release"]["parsed"]["year"] = work["work"]["year"] - 1
evaluate("Wrong-year film rejected", case_input(template, [c]), lambda r: rejected(r, "wrong_year") and not r["assignments"])
c = clone(base, "Russian-only")
c["release"]["parsed"].update(clearlyForeign=True, foreign="Yes", languageMarkers=["rus"])
evaluate("Clearly foreign rejected", case_input(template, [c]), lambda r: rejected(r, "foreign_language") and not r["assignments"])
evaluate("Unknown audio accepted", case_input(template, [good]), lambda r: chosen(r, good))
p = case_input(template, [good])
p["input"]["blocks"] = [dict(id="proof-block", hash=good["release"]["id"].upper(),
    workKey=work["work"]["workKey"], reason="Owner block", origin="Owner", replacedByHash=None, createdAt=STAMP, until=None)]
evaluate("Scoped hash block rejected", p, lambda r: rejected(r, "blocked_hash") and not r["assignments"])
p["input"]["blocks"][0]["workKey"] = "different-work"
evaluate("Other work block does not reject", p, lambda r: chosen(r, good))
p["input"]["blocks"][0]["workKey"] = None
evaluate("Global hash block rejected", p, lambda r: rejected(r, "blocked_hash") and not r["assignments"])
work, episodes, template, candidates = SCOPES["a-silent-voice"]
manga = next(c for c in candidates if "(Digital) (1r0n)" in c["release"]["name"])
evaluate("Real A Silent Voice manga scan rejected by file list", case_input(template, [manga]),
         lambda r: not r["assignments"] and rejected(r, "no_video"))

work, episodes, template, candidates = SCOPES["scorpion-s1"]
w = copy.deepcopy(work)
episodes = episodes[:10]
season_id = episodes[0]["seasonId"]
w["episodes"] = episodes
w["seasons"] = [s for s in w["seasons"] if s["id"] == season_id]
w["seasons"][0]["expectedEpisodeCount"] = 10
t = copy.deepcopy(template)
t["workKey"] = None
t["input"]["work"] = w
t["input"]["targets"] = [target(w, e) for e in episodes]
t["input"]["owned"] = [owned(w, e) for e in episodes[:3]]
pack = clone(next(c for c in candidates if c["release"]["parsed"]["quality"]["resolution"] == 1080),
             "ten-episode-pack")
size = 500000000
pack["release"]["files"] = [dict(index=i, relativePath="Scorpion.S01E%02d.mkv" % e["number"],
                               bytes=size, offset=i * size) for i, e in enumerate(episodes)]
singles = []
for i, e in enumerate(episodes):
    single = clone(pack, "single:" + str(e["number"]))
    single["release"]["parsed"].update(kind="Episode", pack=False, episodes=[e["number"]])
    single["release"]["files"] = [dict(index=0, relativePath="Scorpion.S01E%02d.mkv" % e["number"],
                                     bytes=size, offset=0)]
    singles.append(single)
note = "Real Scorpion metadata first ten episodes; synthesized ten-episode season cardinality, files, verdicts and owned media"
evaluate("Finished season: healthy pack selects seven missing files",
         case_input(t, [pack] + singles, ["Good"] + ["Weak"] * 10),
         lambda r: len(r["assignments"]) == 1 and chosen(r, pack) and
         [f["fileIndex"] for f in r["assignments"][0]["files"]] == list(range(3, 10)) and not r["uncoveredTargetIds"], note)
evaluate("Finished season: dead pack falls back to singles",
         case_input(t, [pack] + singles, ["Dead"] + ["Good"] * 10),
         lambda r: len(r["assignments"]) == 7 and not chosen(r, pack) and not r["uncoveredTargetIds"], note)
evaluate("Finished season: weak pack loses to Good singles",
         case_input(t, [pack] + singles, ["Weak"] + ["Good"] * 10),
         lambda r: len(r["assignments"]) == 7 and not chosen(r, pack), note)
p = case_input(t, [pack])
p["input"]["work"]["episodes"][-1]["airAt"] = (NOW + dt.timedelta(days=1)).isoformat()
evaluate("Still-airing season never picks pack", p,
         lambda r: not r["assignments"] and rejected(r, "season_unfinished"), note)
ambiguous = clone(pack, "duplicate-episode")
ambiguous["release"]["files"].append(dict(index=10, relativePath="Scorpion.S01E04.other.mkv",
                                        bytes=size, offset=10 * size))
evaluate("Duplicate pack video stays uncovered", case_input(t, [ambiguous]),
         lambda r: t["input"]["targets"][3]["id"] in r["uncoveredTargetIds"] and rejected(r, "file_mapping_uncertain"), note)

# Additional contract edges go through the same running HTTP endpoint.
for suffix, expected in [("malware.exe", "unsafe_program"), ("archive.zip", "pack_archive"),
                         ("disc.iso", "disc_image"), ("Scorpion.S02E01.mkv", "other_season_file")]:
    c = clone(pack, suffix)
    c["release"]["files"].append(dict(index=10, relativePath=suffix, bytes=size, offset=10 * size))
    evaluate("Pack skipped file: " + suffix, case_input(t, [c]),
             lambda r, expected=expected: not r["assignments"] and rejected(r, expected), note)
c = clone(pack, "range-video")
c["release"]["files"][3]["relativePath"] = "Scorpion.S01E04-E05.mkv"
evaluate("Range video cannot satisfy a single item", case_input(t, [c]),
         lambda r: t["input"]["targets"][3]["id"] in r["uncoveredTargetIds"], note)
c = clone(pack, "pack-sidecars")
c["release"]["files"] += [
    dict(index=10, relativePath="Scorpion.S01E04.en.forced.srt", bytes=10000, offset=10 * size),
    dict(index=11, relativePath="Scorpion.S01E01.en.srt", bytes=10000, offset=10 * size + 10000),
    dict(index=12, relativePath="Subs/S01E05/English.srt", bytes=10000, offset=10 * size + 20000)]
evaluate("Pack selects only missing episodes' associated sidecars", case_input(t, [c]),
         lambda r: sorted(f["fileIndex"] for a in r["assignments"] for f in a["files"]) == list(range(3, 11)) + [12], note)
for status, confirmed in [("Offline", None), ("Missing", None)]:
    p = case_input(t, [pack])
    for item in p["input"]["owned"]:
        item["videos"][0]["status"] = status
        item["videos"][0]["missingConfirmedAt"] = confirmed
    evaluate(status + " ownership excludes reacquisition", p,
             lambda r: len(r["assignments"][0]["files"]) == 7 and not r["uncoveredTargetIds"], note)
p = case_input(t, [pack])
p["input"]["targets"][3]["kind"] = "Replace"
p["input"]["targets"][3]["replacementMode"] = "Upgrade"
p["input"]["owned"].append(owned(w, episodes[3]))
evaluate("Upgrade must improve known owned quality", p,
         lambda r: rejected(r, "replacement_quality") and p["input"]["targets"][3]["id"] in r["uncoveredTargetIds"], note)
p["input"]["targets"][3]["replacementMode"] = "Replace"
evaluate("Replace may retain own existing quality", p,
         lambda r: any(f["fileIndex"] == 3 for a in r["assignments"] for f in a["files"]), note)

work, _, template, _ = SCOPES["sintel"]
p = case_input(template, [good])
p["input"]["preference"] = dict(id="pref", workId=work["work"]["id"], resolutionFloor=None,
    preferredResolution=2160, audioLanguage="ru", maxBytesPerItem=50000,
    storageRootOverrideId=None, updatedAt=STAMP, version=0)
evaluate("Per-title size preference enforced", p, lambda r: rejected(r, "size_cap") and not r["assignments"])
p["input"]["targets"][0]["maxBytes"] = 1000000000
evaluate("Target policy overrides per-title size cap", p, lambda r: chosen(r, good))
c = clone(good, "tiny-video")
c["release"]["files"][0]["bytes"] = 50000
evaluate("Tiny video fails runtime/size plausibility", case_input(template, [c]),
         lambda r: rejected(r, "implausible_size") and not r["assignments"])
c = clone(good, "low-bitrate")
c["release"]["files"][0]["bytes"] = 2000000
evaluate("Implausible bitrate rejected", case_input(template, [c]),
         lambda r: rejected(r, "implausible_size") and not r["assignments"])
p = case_input(template, [good])
p["input"]["evidence"][0]["expiresAt"] = (NOW - dt.timedelta(minutes=1)).isoformat()
evaluate("Expired health becomes Unknown, never stale Good", p,
         lambda r: chosen(r, good) and "Waiting for seeders" in r["assignments"][0]["reason"])
c = clone(good, "English-with-Russian")
c["release"]["parsed"].update(clearlyForeign=True, foreign="Yes", languageMarkers=["rus", "eng"])
evaluate("Explicit English evidence disambiguates foreign marker", case_input(template, [c]),
         lambda r: chosen(r, c))
c = clone(good, "unknown-resolution")
c["release"]["parsed"]["quality"]["resolution"] = None
c["release"]["files"][0]["relativePath"] = "Sintel.mkv"
p = case_input(template, [c])
p["input"]["targets"][0]["resolutionFloor"] = 1080
evaluate("Genuinely unknown resolution cannot meet explicit floor", p,
         lambda r: rejected(r, "quality_floor") and not r["assignments"])
exact, above, below = clone(good, "preferred-exact", 1080), clone(good, "above-2160", 2160), clone(good, "below-720", 720)
evaluate("Exact resolution beats above and below", case_input(template, [below, above, exact]),
         lambda r: chosen(r, exact))
more_peers = clone(below, "more-byte-sending-peers")
p = case_input(template, [exact, more_peers])
p["input"]["evidence"][1]["byteSendingPeers"] = 3
evaluate("Within-band measured peers precede quality", p, lambda r: chosen(r, more_peers))
a, b = clone(good, "stable-a"), clone(good, "stable-b")
p = case_input(template, [b, a])
evaluate("Stable hash tiebreak independent of input ordering", p,
         lambda r: r["assignments"][0]["hash"] == min(a["release"]["id"], b["release"]["id"]))
p = case_input(template, [good])
p["input"]["mode"] = "ExplicitRaw"
p["workKey"] = None
p["input"]["targets"] = []
p["input"]["ownerSelectedFiles"] = [0]
evaluate("ExplicitRaw selects video without invented catalog identity", p,
         lambda r: chosen(r, good) and r["assignments"][0]["targetIds"] == [] and
         all(f["targetId"] is None for f in r["assignments"][0]["files"]))
p["input"]["ownerSelectedFiles"] = [99]
evaluate("ExplicitRaw rejects nonexistent selection indices", p,
         lambda r: rejected(r, "no_selected_video") and not r["assignments"])

work, episodes, template, candidates = SCOPES["frieren-s1e5"]
single = next(c for c in candidates if not c["release"]["parsed"]["pack"] and
              c["release"]["parsed"]["quality"]["resolution"] == 1080)
absolute = clone(single, "absolute-mapped-episode")
absolute["release"]["parsed"].update(seasons=[], episodes=[], absoluteNumbers=[episodes[0]["absoluteNumber"]])
evaluate("Confirmed absolute episode maps to stable metadata", case_input(template, [absolute]),
         lambda r: chosen(r, absolute))
wrong = clone(single, "wrong-single-season")
wrong["release"]["parsed"]["seasons"] = [2]
evaluate("Wrong season single rejected", case_input(template, [wrong]),
         lambda r: rejected(r, "wrong_episode") and not r["assignments"])
wrong = clone(single, "wrong-single-file")
wrong["release"]["files"][0]["relativePath"] = "Frieren.S01E06.1080p.mkv"
evaluate("Single release cannot conceal a different file episode", case_input(template, [wrong]),
         lambda r: rejected(r, "wrong_file_episode") and not r["assignments"])
wrong = clone(single, "range-candidate")
wrong["release"]["parsed"]["episodeRanges"] = [dict(first=5, last=6)]
evaluate("Episode range candidate never blindly satisfies one item", case_input(template, [wrong]),
         lambda r: rejected(r, "wrong_episode") and not r["assignments"])

work, _, template, _ = SCOPES["sintel"]
p = case_input(template, [good])
c = clone(good, "source-better")
c["release"]["parsed"]["quality"]["source"] = "bluray"
evaluate("Source preference within equal health and resolution", case_input(template, [good, c]),
         lambda r: chosen(r, c))
p = case_input(template, [good])
total = good["release"]["files"][0]["offset"] + good["release"]["files"][0]["bytes"]
evaluate("Single file union-piece reservation is exact", p,
         lambda r: r["assignments"][0]["reservedPieceBytes"] == total)
p["input"]["fileMetadata"] = []
evaluate("Unknown piece geometry conservatively reserves full torrent", p,
         lambda r: r["assignments"][0]["reservedPieceBytes"] == total)
p = case_input(t, [pack])
length = 262144
total = 10 * size
expected = total - ((3 * size) // length) * length
evaluate("Selective pack reserves touched-piece union including boundaries", p,
         lambda r: r["assignments"][0]["reservedPieceBytes"] == expected, note)
p = case_input(template, [good])
p["input"]["blocks"] = [dict(id="expired", hash=good["release"]["id"], workKey=None,
    reason="Temporary", origin="Owner", replacedByHash=None, createdAt=STAMP,
    until=(NOW - dt.timedelta(seconds=1)).isoformat())]
evaluate("Expired block does not reject", p, lambda r: chosen(r, good))
c = clone(good, "scorpion-lookalike")
c["release"]["parsed"]["title"] = "Sintel King"
evaluate("Token-sharing lookalike rejected against exact catalog identity", case_input(template, [c]),
         lambda r: rejected(r, "wrong_work") and not r["assignments"])
p = case_input(template, [good])
p["input"]["pool"][0]["release"]["parsed"]["year"] = None
evaluate("Absent film year is unknown, not a refusal", p, lambda r: chosen(r, good))
c, old = clone(good, "new-upload"), clone(good, "old-upload")
c["release"]["files"][0]["bytes"] *= 2
c["observations"][0]["uploadedAt"] = STAMP
old["observations"][0]["uploadedAt"] = (NOW - dt.timedelta(days=10)).isoformat()
evaluate("Film recency tiebreak is not overridden by file size", case_input(template, [old, c]),
         lambda r: chosen(r, c))
a, b = clone(good, "seeds-a"), clone(good, "seeds-b")
a["conservativeListedSeeders"] = 1
b["conservativeListedSeeders"] = 100
evaluate("Conservative listed seeds break equal measured-health ties", case_input(template, [a, b]),
         lambda r: chosen(r, b))
c = clone(good, "duplicate-file-index")
c["release"]["files"].append(copy.deepcopy(c["release"]["files"][0]))
evaluate("Duplicate file indices return explained rejection", case_input(template, [c]),
         lambda r: rejected(r, "invalid_files") and not r["assignments"])

for index, row in enumerate(RESULTS[:10], 1):
    payload = json.loads((OUT / (str(index).zfill(2) + "-input.json")).read_text())
    started = time.perf_counter()
    repeat = http("/api/dev/plan-eval/", payload)
    row["warmHttpMs"] = (time.perf_counter() - started) * 1000
    row["warmEvaluationMs"] = repeat["elapsedMs"]
    row["deterministicRepeat"] = repeat["result"] == json.loads((OUT / (str(index).zfill(2) + "-result.json")).read_text())["result"]
    row["passed"] = row["passed"] and row["deterministicRepeat"]
    (OUT / (str(index).zfill(2) + "-warm-result.json")).write_text(json.dumps(repeat, indent=2))

summary = dict(
    scope="Task 4.1 pure Plan via real isolated HTTP API. No swarm probes or payload downloads.",
    source="tools/.find-proof/report.json and corresponding recorded pools; fresh metadata from port 3949",
    synthesis="All health verdicts, file lists, piece lengths and ownership are synthetic. Catalog metadata and base release names/hashes/Parser output are real. Mutated gate/rank cases use explicitly synthetic hashes and parsed facts.",
    total=len(RESULTS), passed=sum(r["passed"] for r in RESULTS), failed=sum(not r["passed"] for r in RESULTS),
    cases=RESULTS)
(OUT / "summary.json").write_text(json.dumps(summary, indent=2))
print("SUMMARY", summary["passed"], "/", summary["total"])
if summary["failed"]:
    raise SystemExit(1)
