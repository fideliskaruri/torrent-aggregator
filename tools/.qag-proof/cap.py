import json
import pathlib
import time
import urllib.error
import urllib.request

OUT = pathlib.Path(__file__).parent
BASE = "http://127.0.0.1:3961"
first = "e1d833fe2adc88bc76b8b29e380b80e2ce43f82c"
second = json.loads((OUT / "cap-fixture.json").read_text())["hash"]
ROOT = pathlib.Path(r"D:\code\memtest\qag-data\cap-payload")
rows = []

def call(path, body=None, method=None):
    request = urllib.request.Request(BASE + path, method=method or ("POST" if body is not None else "GET"))
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    try:
        response = urllib.request.urlopen(request, timeout=50)
    except urllib.error.HTTPError as e:
        response = e
    text = response.read().decode()
    result = {"path":path,"payload":body,"status":response.status,"body":json.loads(text) if text else None}
    rows.append(result)
    (OUT/"cap.json").write_text(json.dumps(rows,indent=2),encoding="utf-8")
    return result

call("/api/settings/client", {"maxActiveDownloads":2}, method="PUT")
for hash in [first,second]:
    call("/api/dev/engine/add",{"magnet":"magnet:?xt=urn:btih:"+hash,"files":[0],"savePath":str(ROOT/hash)})
time.sleep(2)
call("/api/dev/engine/torrents")
call("/api/settings/client",{"maxActiveDownloads":1}, method="PUT")
time.sleep(1)
call("/api/dev/engine/torrents")
call("/api/settings/client",{"maxActiveDownloads":2}, method="PUT")
time.sleep(1)
call("/api/dev/engine/torrents")
call("/api/settings/client",{"maxActiveDownloads":1}, method="PUT")
time.sleep(1)
call("/api/dev/engine/torrents")
for hash in [first,second]:
    call("/api/dev/engine/"+hash+"?data=true",method="DELETE")
call("/api/dev/engine/torrents")
(OUT/"cap-leftovers.json").write_text(json.dumps({"files":[str(f) for f in ROOT.rglob("*") if f.is_file()],"note":"Cap test uses development admission of two distinct licensed Sintel identities; public settings path drives the real Engine cap."},indent=2))
call("/api/settings/client",{"maxActiveDownloads":5}, method="PUT")
print("cap proof complete",flush=True)
