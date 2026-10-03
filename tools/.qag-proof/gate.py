import datetime
import hashlib
import json
import pathlib
import time
import urllib.error
import urllib.request
from playwright.sync_api import sync_playwright

OUT = pathlib.Path(__file__).parent
BASE = "http://127.0.0.1:3962"
HASH = "e1d833fe2adc88bc76b8b29e380b80e2ce43f82c"
ROOT = pathlib.Path(r"D:\code\memtest\qag-library-final")

def call(path, body=None, method=None):
    req = urllib.request.Request(BASE + path, method=method or ("POST" if body is not None else "GET"))
    if body is not None:
        req.data = json.dumps(body).encode()
        req.add_header("Content-Type", "application/json")
    try:
        response = urllib.request.urlopen(req, timeout=100)
    except urllib.error.HTTPError as e:
        response = e
    raw = response.read().decode()
    data = json.loads(raw) if raw else None
    return {"status": response.status, "body": data}

def save(name, value):
    (OUT / (name + ".json")).write_text(json.dumps(value, indent=2), encoding="utf-8")

root_result = call("/api/dev/library/roots", {"path": str(ROOT), "kinds": [0,1,2,3], "priority": 1, "reserveBytes": 0, "confirmed": True})
save("gate-root", root_result)
if not root_result["body"].get("root"):
    raise RuntimeError("Fixture root was not enrolled: " + str(root_result))
work = call("/api/dev/plan-eval/metadata?workKey=tmdb:movie:45745")["body"]["work"]
for field, values in {"kind": ["Unknown", "Film", "Series"], "format": ["Unknown", "Movie", "Series", "Special"], "releasePrecision": ["Unknown", "Day", "Instant"]}.items():
    work["work"][field] = values.index(work["work"][field])
for n in work["names"]:
    n["label"] = ["English", "Romaji", "Synonym", "Native", "Original"].index(n["label"])
for link in work["links"]:
    link["status"] = ["Verified", "Suggested", "Rejected"].index(link["status"])
now = datetime.datetime.now(datetime.timezone.utc).isoformat()
id = work["work"]["id"] + "-qag-film"
target = {"id": id, "workId": work["work"]["id"], "kind": 0, "state": 4, "priority": 0, "rank": 0, "createdBy": "local", "origin": 0, "policyRevision": 1, "createdAt": now, "updatedAt": now, "version": 1}
req = {"magnet": "magnet:?xt=urn:btih:" + HASH, "placement": {"work": work, "targets": [target], "roots": [], "owned": [], "files": [], "assignment": {"hash": HASH, "targetIds": [id], "reservedPieceBytes": 129241752, "reason": "Licensed local QA Sintel", "files": [{"targetId": id, "fileIndex": 0, "role": 0}]}}}
save("gate-request", req)
save("gate-cap-initial", call("/api/settings/client", {"maxActiveDownloads": 1}, method="PUT"))
admitted = call("/api/dev/filing/", req)
save("gate-admitted", admitted)
print("admitted", admitted["status"], admitted["body"].get("accepted"), flush=True)
if not admitted["body"].get("accepted"):
    raise RuntimeError("Fixture admission failed: " + str(admitted))
with sync_playwright() as p:
    browser = p.chromium.launch(headless=True, channel="msedge")
    page = browser.new_page(viewport={"width":390,"height":900})
    for width in [390,1280]:
        page.set_viewport_size({"width":width,"height":900})
        page.goto(BASE + "/downloads", wait_until="domcontentloaded")
        page.wait_for_timeout(350)
        page.screenshot(path=str(OUT / "screenshots" / f"active-download-{width}.png"), full_page=True)
    deadline = time.monotonic() + 120
    states = []
    while time.monotonic() < deadline:
        state = call("/api/dev/filing/")
        states.append(state)
        if state["body"].get("media"):
            break
        time.sleep(.5)
    save("gate-filed-states", states)
    state = states[-1]["body"]
    media = state.get("media", [])
    verification = {"completed": bool(media), "files": [str(f.relative_to(ROOT)) for f in ROOT.rglob("*") if f.is_file()]}
    if media:
        f = pathlib.Path(media[0]["path"])
        seed = pathlib.Path(r"D:\code\memtest\qag-fixture\seed\Sintel.mp4")
        verification.update(path=str(f),bytes=f.stat().st_size,sha256=hashlib.sha256(f.read_bytes()).hexdigest(),seedSha256=hashlib.sha256(seed.read_bytes()).hexdigest(),partialLeftovers=[str(x) for x in ROOT.rglob("*.partial")])
    save("gate-completion", verification)
    for route,name in [("/downloads","completed-download"),("/title/tmdb:movie:45745","owned-film"),("/watchlist","filed-library")]:
        for width in [390,1280]:
            page.set_viewport_size({"width":width,"height":900})
            page.goto(BASE + route, wait_until="networkidle",timeout=30000)
            page.screenshot(path=str(OUT / "screenshots" / f"{name}-{width}.png"), full_page=True)
            save(f"{name}-{width}", {"text":page.locator("body").inner_text(),"buttons":page.locator("button").all_text_contents()})
    browser.close()
print(json.dumps(verification), flush=True)
