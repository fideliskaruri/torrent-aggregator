import concurrent.futures
import json
import pathlib
import time
import urllib.error
import urllib.request
import hashlib

OUT = pathlib.Path(__file__).parent
BASE = "http://127.0.0.1:3964"

def api(path, body=None, method=None):
    request = urllib.request.Request(BASE + path, None if body is None else json.dumps(body).encode(),
                                     {"Content-Type": "application/json"}, method=method)
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)

body = json.loads((OUT.parent / ".delp-proof" / "request.json").read_text())
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

seed = pathlib.Path(r"D:\code\memtest\fixture-f408\seed\Sintel.mp4")
pieces = []
with seed.open("rb") as stream:
    while part := stream.read(262144):
        pieces.append(hashlib.sha1(part).digest())
info = {"name": "Sintel.mp4", "length": seed.stat().st_size, "piece length": 262144,
        "pieces": b"".join(pieces), "source": "OPS-858 stale-binary reproduction"}
isolated_hash = hashlib.sha1(bencode(info)).hexdigest()
(seed.parent.parent / "Isolated.torrent").write_bytes(bencode({"info": info}))
body["magnet"] = "magnet:?xt=urn:btih:" + isolated_hash
body["placement"]["assignment"]["hash"] = isolated_hash
(OUT / "isolated-request.json").write_text(json.dumps(body, indent=2))
print("isolated hash " + isolated_hash, flush=True)
time.sleep(3)
root_status, root = api("/api/dev/library/roots", {"path": r"D:\code\memtest\library-f408-fail",
                       "confirmed": True, "kinds": [0, 1, 2, 3], "priority": 1, "reserveBytes": 0})
(OUT / "baseline-root.json").write_text(json.dumps(root, indent=2))
results = []
for run in range(5):
    with concurrent.futures.ThreadPoolExecutor() as executor:
        started = time.monotonic()
        pending = executor.submit(api, "/api/dev/filing/", body)
        time.sleep(2)
        status, diagnostics = api("/api/dev/engine/torrents")
        (OUT / f"baseline-diagnostics-{run + 1}.json").write_text(json.dumps(diagnostics, indent=2))
        status, result = pending.result()
        results.append({"run": run + 1, "status": status, "seconds": time.monotonic() - started, "body": result})
        print(json.dumps(results[-1]), flush=True)
        (OUT / "baseline-runs.json").write_text(json.dumps(results, indent=2))
        if status != 408:
            break
