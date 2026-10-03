import json
import pathlib
import time
import urllib.error
import urllib.request

out = pathlib.Path(__file__).parent
body = json.loads((out / "isolated-request.json").read_text())
results = []
for number in range(1, 6):
    started = time.monotonic()
    request = urllib.request.Request("http://127.0.0.1:3964/api/dev/filing/",
        json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=45) as response:
            status, payload = response.status, json.load(response)
    except urllib.error.HTTPError as error:
        status, payload = error.code, json.load(error)
    results.append({"run": number, "status": status, "body": payload,
                    "seconds": round(time.monotonic() - started, 3)})
    print(json.dumps(results[-1]), flush=True)
    (out / "baseline-matched-runs.json").write_text(json.dumps(results, indent=2))
    assert status == 408, results[-1]
