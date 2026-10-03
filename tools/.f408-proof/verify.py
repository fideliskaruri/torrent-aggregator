import hashlib
import json
import pathlib
import secrets
import sys
import time
import urllib.error
import urllib.request

OUT = pathlib.Path(__file__).parent
BASE = "http://127.0.0.1:3964"
FIXTURE = pathlib.Path(r"D:\code\memtest\fixture-f408")

def api(path, body=None, method=None, base=BASE, token=None):
    headers = {"Content-Type": "application/json"}
    if base != BASE:
        headers["Authorization"] = 'MediaBrowser Client="f408", Device="Local", DeviceId="OPS858", Version="1"'
    if token:
        headers["Authorization"] += f', Token="{token}"'
    request = urllib.request.Request(base + path, None if body is None else json.dumps(body).encode(),
                                     headers, method=method)
    with urllib.request.urlopen(request, timeout=60) as response:
        payload = response.read()
        return json.loads(payload) if payload else None

def save(name, value):
    (OUT / (name + ".json")).write_text(json.dumps(value, indent=2))

def bencode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode() + b"e"
    if isinstance(value, str):
        value = value.encode()
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, list):
        return b"l" + b"".join(map(bencode, value)) + b"e"
    return b"d" + b"".join(bencode(key) + bencode(value[key]) for key in sorted(value)) + b"e"

def prepare():
    seed = FIXTURE / "seed" / "Sintel.mp4"
    pieces = []
    with seed.open("rb") as stream:
        while part := stream.read(262144):
            pieces.append(hashlib.sha1(part).digest())
    requests = []
    for number in range(1, 6):
        info = {"name": "Sintel.mp4", "length": seed.stat().st_size, "piece length": 262144,
                "pieces": b"".join(pieces), "source": f"OPS-858 cold success {number}"}
        hashed = hashlib.sha1(bencode(info)).hexdigest()
        (FIXTURE / f"Cold{number}.torrent").write_bytes(bencode({"info": info}))
        request = json.loads((OUT.parent / ".delp-proof" / "request.json").read_text())
        request["magnet"] = "magnet:?xt=urn:btih:" + hashed
        request["placement"]["assignment"]["hash"] = hashed
        requests.append(request)
    save("cold-requests", requests)

def run():
    results = []
    expected = hashlib.sha256((FIXTURE / "seed" / "Sintel.mp4").read_bytes()).hexdigest()
    for number, request in enumerate(json.loads((OUT / "cold-requests.json").read_text()), 1):
        before = api("/api/dev/engine/torrents")
        hashed = request["placement"]["assignment"]["hash"]
        assert hashed not in [row["hash"] for row in before["diagnostics"]]
        started = time.monotonic()
        response = api("/api/dev/filing/", request)
        assert response.get("accepted") and not response.get("duplicate"), response
        save(f"admitted-{number}", response)
        for _ in range(120):
            state = api("/api/dev/filing/")
            if state["media"]:
                break
            time.sleep(0.25)
        else:
            raise RuntimeError("No real filed media: " + json.dumps(state))
        save(f"completed-{number}", state)
        media = state["media"][0]
        path = pathlib.Path(media["path"])
        digest = hashlib.sha256(path.read_bytes()).hexdigest()
        assert path.stat().st_size == 129241752 and digest == expected
        results.append({"run": number, "hash": hashed, "accepted": True, "filed": True,
                        "cold": True, "bytes": path.stat().st_size, "sha256": digest,
                        "seconds": round(time.monotonic() - started, 3)})
        save("successful-runs", results)
        print(json.dumps(results[-1]), flush=True)
        if number < 5:
            save(f"removed-{number}", api("/api/dev/filing/" + hashed, method="DELETE"))
    save("owned-title", api("/api/title/tmdb:movie:45745"))
    save("not-owned-title", api("/api/title/tmdb:movie:10378"))
    save("owned-library", api("/api/watchlist"))
    print("Five cold metadata handshakes, real downloads and verified filings passed.", flush=True)

def jellyfin():
    base = "http://127.0.0.1:8097"
    info = api("/System/Info/Public", base=base)
    password = secrets.token_urlsafe(24)
    assert not info["StartupWizardCompleted"], "Use fresh, isolated Jellyfin data for this proof."
    if not info["StartupWizardCompleted"]:
        api("/Startup/FirstUser", base=base)
        api("/Startup/Configuration", {"UICulture": "en-US", "MetadataCountryCode": "US",
            "PreferredMetadataLanguage": "en"}, base=base)
        api("/Startup/User", {"Name": "f408-test", "Password": password}, base=base)
        api("/Startup/RemoteAccess", {"EnableRemoteAccess": False, "EnableAutomaticPortMapping": False}, base=base)
        api("/Startup/Complete", {}, base=base)
    auth = api("/Users/AuthenticateByName", {"Username": "f408-test", "Pw": password}, base=base)
    token, user = auth["AccessToken"], auth["User"]["Id"]
    path = pathlib.Path(json.loads((OUT / "completed-5.json").read_text())["media"][0]["path"])
    path.with_suffix(".nfo").write_text('<movie><title>Sintel</title><uniqueid type="tmdb" default="true">45745</uniqueid></movie>')
    api("/Library/VirtualFolders?name=Movies&collectionType=movies&refreshLibrary=false",
        {"LibraryOptions": {"PathInfos": [{"Path": str(path.parent.parent)}],
            "EnableInternetProviders": False, "EnableRealtimeMonitor": False, "SaveLocalMetadata": False}}, base=base, token=token)
    api("/Library/Refresh", {}, base=base, token=token)
    movie = None
    for _ in range(90):
        scanned = api(f"/Items?UserId={user}&Recursive=true&IncludeItemTypes=Movie&Fields=Path,ProviderIds&EnableUserData=true",
                      base=base, token=token)
        movie = next((item for item in scanned["Items"] if item.get("ProviderIds", {}).get("Tmdb") == "45745"), None)
        if movie and movie.get("RunTimeTicks"):
            break
        time.sleep(1)
    assert movie and movie.get("RunTimeTicks"), scanned
    api(f"/UserItems/{movie['Id']}/UserData?userId={user}",
        {"Played": False, "PlaybackPositionTicks": movie["RunTimeTicks"] // 2, "PlayCount": 1}, base=base, token=token)
    api("/Auth/Keys?app=TorrentFlow-f408", {}, base=base, token=token)
    keys = api("/Auth/Keys", base=base, token=token)
    key = next(item["AccessToken"] for item in keys["Items"] if item["AppName"] == "TorrentFlow-f408")
    api("/api/settings/jellyfin", {"serverUrl": base, "apiKey": key, "userId": user}, method="PUT")
    save("jellyfin-test", api("/api/settings/jellyfin/test", {}))
    save("jellyfin-scanned", scanned)
    save("jellyfin-library", api("/api/watchlist"))
    save("jellyfin-title", api("/api/title/tmdb:movie:45745"))
    print("Actual Jellyfin scan and half-runtime user data set.", flush=True)

{"prepare": prepare, "run": run, "jellyfin": jellyfin}[sys.argv[1]]()
