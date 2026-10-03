"""Real HTTP error-cache proof against the explicitly configured diagnostic host."""
import json
import sqlite3
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tools" / ".find-proof"
DB = "file:D:/code/memtest/rebuild-dev/data/torrentflow.db?mode=ro"
URL = "http://127.0.0.1:3947/api/dev/find?workKey=tmdb:movie:45745&lane=owner"
FAILURE_PATH = "__find_ops698_failure_v2"


def fetch():
    started = time.perf_counter()
    with urllib.request.urlopen(URL, timeout=60) as response:
        body = json.load(response)
    return {"httpMs": (time.perf_counter() - started) * 1000, "body": body}


def rows():
    with sqlite3.connect(DB, uri=True) as db:
        records = db.execute(
            "SELECT scopeKey,payloadJson,createdAt,expiresAt FROM SearchCache "
            "WHERE sourceId='apibay' ORDER BY id"
        ).fetchall()
    return [
        {"key": json.loads(key), "payload": json.loads(payload), "createdAt": created, "expiresAt": expiry}
        for key, payload, created, expiry in records
        if FAILURE_PATH in key
    ]


def main():
    restart = "--restart" in sys.argv
    before = rows()
    replies = [fetch()]
    initial_requests = replies[0]["body"]["sourceRequests"]
    first_path = OUT / ("failure-first-restart.json" if restart else "failure-first.json")
    first_path.write_text(json.dumps(replies[0], indent=2), encoding="utf-8")
    if not restart:
        for _ in range(100):
            time.sleep(0.2)
            replies.append(fetch())
            if replies[-1]["body"]["windowSourceRequests"] == initial_requests * 2:
                break
        else:
            raise AssertionError("The original request and one background retry were not observed")
        time.sleep(1)
    replies.extend(fetch() for _ in range(3))
    after = rows()
    assert len(after) == 3, after
    for row in after:
        payload = row["payload"]
        assert payload["failureRetryAttempted"], payload
        assert payload["sourceResult"]["outcome"].lower() == "failed", payload
        assert payload["sourceResult"]["diagnostics"]["httpStatus"] == 404, payload
    for reply in replies[1:]:
        assert reply["body"]["sourceRequests"] == 0, reply
        assert reply["httpMs"] < 1000, reply
    if restart:
        assert replies[0]["body"]["sourceRequests"] == 0
        assert before == after, "Restart or cached read extended the expiry or scheduled another retry"
    else:
        assert initial_requests == 3
        assert replies[-1]["body"]["windowSourceRequests"] == 6
    result = {"restart": restart, "replies": replies, "cacheRowsBefore": before, "cacheRowsAfter": after}
    path = OUT / ("failure-restart.json" if restart else "failure-window.json")
    path.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps({"restart": restart, "firstRequests": replies[0]["body"]["sourceRequests"],
                      "windowRequests": replies[-1]["body"]["windowSourceRequests"],
                      "repeatMs": [round(r["httpMs"], 1) for r in replies[-3:]],
                      "httpStatus": 404, "retryPersisted": True}), flush=True)


if __name__ == "__main__":
    main()
