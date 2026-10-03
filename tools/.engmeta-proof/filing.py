import concurrent.futures
import datetime
import json
import os
import pathlib
import time
import urllib.error
import urllib.parse
import urllib.request

OUT = pathlib.Path(__file__).parent
BASE = "http://127.0.0.1:3965"


def call(path, data=None, method=None):
    request = urllib.request.Request(
        BASE + path,
        None if data is None else json.dumps(data).encode(),
        {"Content-Type": "application/json"},
        method=method or ("POST" if data is not None else "GET"),
    )
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, json.loads(response.read())
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def placement(tmdb, hash_value, iteration):
    _, result = call("/api/dev/plan-eval/metadata?workKey=tmdb:movie:" + str(tmdb))
    work = result["work"]
    target_id = work["work"]["id"] + "-engmeta-" + str(iteration)
    work["work"]["kind"] = ["Unknown", "Film", "Series"].index(work["work"]["kind"])
    work["work"]["format"] = ["Unknown", "Movie", "Series", "Special"].index(work["work"]["format"])
    work["work"]["releasePrecision"] = ["Unknown", "Day", "Instant"].index(work["work"]["releasePrecision"])
    for name in work["names"]:
        name["label"] = ["English", "Romaji", "Synonym", "Native", "Original"].index(name["label"])
    for link in work["links"]:
        link["status"] = ["Verified", "Suggested", "Rejected"].index(link["status"])
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    target = {
        "id": target_id, "workId": work["work"]["id"], "kind": 0, "state": 4,
        "preferredResolution": 720, "priority": 0, "rank": 0, "createdBy": "local",
        "origin": 0, "policyRevision": 1, "createdAt": now, "updatedAt": now, "version": 1,
    }
    return {
        "work": work, "targets": [target],
        "assignment": {
            "hash": hash_value, "targetIds": [target_id],
            "files": [{"targetId": target_id, "fileIndex": 0, "role": 0}],
            "reservedPieceBytes": 276134947 if tmdb == 10378 else 129241752,
            "reason": "OPS-845 licensed local transfer",
        },
        "files": [], "roots": [], "owned": [], "explicitRootId": None,
        "explicitDirectory": None, "explicitKind": None,
    }


def attempt(tmdb, hash_value, label):
    payload = {"magnet": "magnet:?xt=urn:btih:" + hash_value, "placement": placement(tmdb, hash_value, label)}
    (OUT / (label + "-request.json")).write_text(json.dumps(payload, indent=2))
    samples = []
    start = time.monotonic()
    with concurrent.futures.ThreadPoolExecutor() as pool:
        future = pool.submit(call, "/api/dev/filing/", payload)
        while not future.done():
            samples.append({"seconds": round(time.monotonic() - start, 3),
                            "engine": call("/api/dev/engine/torrents")[1]})
            time.sleep(1)
        status, response = future.result()
    result = {"status": status, "seconds": round(time.monotonic() - start, 3),
              "response": response, "samples": samples}
    (OUT / (label + ".json")).write_text(json.dumps(result, indent=2))
    print(json.dumps({"label": label, "status": status, "seconds": result["seconds"],
                      "accepted": response.get("accepted")}), flush=True)
    return result


if __name__ == "__main__":
    import sys
    call("/api/dev/library/roots", {
        "path": os.environ.get("ENGMETA_LIBRARY", r"D:\code\memtest\engmeta-library"), "kinds": [0],
        "priority": 0, "reserveBytes": 0, "confirmed": True,
    })
    films = [(45745, "e1d833fe2adc88bc76b8b29e380b80e2ce43f82c"),
             (10378, "015b076a321698a65baa6bc62e15421a5fe745a3")]
    for i in range(int(sys.argv[2]) if len(sys.argv) > 2 else 2):
        tmdb, hash_value = films[i % 2]
        attempt(tmdb, hash_value, sys.argv[1] + "-" + str(i + 1))
