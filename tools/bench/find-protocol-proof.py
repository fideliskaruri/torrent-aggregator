"""HTTP coordinator-contract checks. Supplied coverage is synthetic, NOT measured swarm health."""
import concurrent.futures
import json
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".find-proof"
BASE = "http://127.0.0.1:3947"


def start(episode=None, lane="owner"):
    url = BASE + "/api/dev/find?workKey=tvmaze:44&season=1&stream=true&feedback=true&lane=" + lane
    if episode is not None:
        url += "&episode=" + str(episode)
    begin = time.perf_counter()
    response = urllib.request.urlopen(url, timeout=180)
    for line in response:
        batch = json.loads(line)
        if batch["candidates"]:
            return response, batch, (time.perf_counter() - begin) * 1000
    raise AssertionError("No structural candidate arrived")


def send(batch, covered, stop=True, scraped=None):
    data = json.dumps({
        "poolRevision": batch["poolRevision"], "coveredEpisodeIds": covered,
        "filmCovered": False, "stop": stop, "needFallbackTier": False,
        "scrapedSeeders": scraped or {},
    }).encode()
    request = urllib.request.Request(
        BASE + "/api/dev/find/" + batch["sessionId"] + "/feedback",
        data=data, headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        assert response.status == 202


def finish(response, batch):
    final = batch
    for line in response:
        final = json.loads(line)
    response.close()
    assert final["complete"] and final["earlyStopped"]
    return final


def ids(batch):
    return list({item for candidate in batch["candidates"] for item in candidate["coverage"]["episodeIds"]})


def main():
    report = {"kind": "synthetic coordinator coverage over real HTTP, not swarm-health verification"}
    scope = json.loads((OUT / "scorpion-s1-1.json").read_text())["body"]["scope"]["episodeIds"]
    response, batch, first_ms = start()
    candidate = batch["candidates"][0]
    hashed = candidate["hash"]
    send(batch, scope[:1], scraped={hashed: 0})
    updated = batch
    for line in response:
        updated = json.loads(line)
        assert not updated["earlyStopped"], "One covered episode must not stop a season"
        if any(c["hash"] == hashed and c["scrapedSeeders"] == 0 for c in updated["candidates"]):
            break
    else:
        raise AssertionError("Scrape feedback was not applied")
    assert next(c for c in updated["candidates"] if c["hash"] == hashed)["trustedSeeds"] == 0
    send(updated, scope)
    final = finish(response, updated)
    report["seasonCoverageAndScrape"] = {
        "firstCandidateMs": first_ms, "requestedItems": len(scope),
        "partialCoverageDidNotStop": True, "zeroScrapeOverridesListed": True,
        "final": final,
    }
    # Two background scopes remain alive for coordinator feedback. The third waits;
    # an owner is admitted immediately into the owner reserve.
    bg1 = start(5, "background")
    bg2 = start(6, "background")
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as executor:
        third = executor.submit(start, 7, "background")
        time.sleep(0.5)
        assert not third.done(), "A third background scope was admitted before capacity"
        owner = start(8, "owner")
        assert not third.done(), "Queued background should still be waiting while owner is admitted"
        send(owner[1], ids(owner[1]))
        owner_final = finish(owner[0], owner[1])
        send(bg1[1], ids(bg1[1]))
        bg1_final = finish(bg1[0], bg1[1])
        bg3 = third.result(timeout=60)
        send(bg2[1], ids(bg2[1]))
        bg2_final = finish(bg2[0], bg2[1])
        send(bg3[1], ids(bg3[1]))
        bg3_final = finish(bg3[0], bg3[1])
    report["budget"] = {
        "thirdBackgroundWaited": True, "ownerAdmittedBeforeThirdBackground": True,
        "ownerFirstMs": owner[2], "thirdBackgroundFirstMs": bg3[2],
        "owner": owner_final, "background": [bg1_final, bg2_final, bg3_final],
    }
    # A disconnected stream must detach only that waiter. A simultaneous identical
    # stream remains alive and can receive feedback/finish.
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as executor:
        one = executor.submit(start, 9, "background")
        two = executor.submit(start, 9, "owner")
        first, second = one.result(timeout=90), two.result(timeout=90)
        first[0].close()
        latest = second[1]
        for line in second[0]:
            latest = json.loads(line)
            if latest["sharedInFlight"]:
                break
        send(latest, ids(latest))
        survivor = finish(second[0], latest)
    report["detach"] = {
        "survivingWaiterCompleted": True,
        "sharedInFlight": first[1]["sharedInFlight"] or latest["sharedInFlight"] or survivor["sharedInFlight"],
        "survivor": survivor,
    }
    assert report["detach"]["sharedInFlight"]
    (OUT / "protocol.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps({
        "seasonCoverage": len(scope), "partialDoesNotStop": True, "zeroScrape": True,
        "ownerFirstMs": owner[2], "thirdBackgroundFirstMs": bg3[2],
        "detachSurvivor": True, "shared": report["detach"]["sharedInFlight"],
    }), flush=True)


if __name__ == "__main__":
    main()
