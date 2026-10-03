import json
import pathlib
import urllib.error
import urllib.request

out = pathlib.Path(__file__).parent
results = []


def call(method, path, body=None, expected=200):
    request = urllib.request.Request("http://127.0.0.1:3966" + path, method=method)
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    try:
        response = urllib.request.urlopen(request, timeout=60)
    except urllib.error.HTTPError as error:
        response = error
    raw = response.read()
    value = json.loads(raw) if raw else None
    results.append({"method": method, "path": path, "expected": expected, "status": response.status,
                    "pass": response.status == expected, "body": value})
    assert response.status == expected, results[-1]
    return value


notifications = call("GET", "/api/notifications")
assert all("posterUrl" in item for item in notifications["items"])
assert any(item["posterUrl"] for item in notifications["items"])
if notifications["items"]:
    call("POST", "/api/notifications/read/" + notifications["items"][0]["id"], {}, 204)
call("POST", "/api/notifications/read/missing-contract-notification", {}, 404)
call("POST", "/api/notifications/read-all", {}, 204)
call("DELETE", "/api/notifications/push/subscription", {"endpoint": "https://example.invalid/contract"}, 204)
torrents = call("GET", "/api/client/torrents")
assert torrents["host"] == ""
for operation in ["keep", "open"]:
    call("POST", "/api/downloads/builtin:" + "0" * 40 + "/" + operation, {"mode": "reveal"}, 404)
    call("POST", "/api/downloads/not-a-download-id/" + operation, {"mode": "reveal"}, 400)
call("POST", "/api/settings/sources/contract-missing-source/test", {}, 404)
call("PUT", "/api/settings/sources/contract-missing-source", {"enabled": False}, 400)
call("DELETE", "/api/settings/sources/contract-missing-source", {}, 200)
sources = call("GET", "/api/settings/sources")
source = next(s for s in sources["sources"] if s["id"] == "cinemeta")
call("PUT", "/api/settings/sources/cinemeta", {"enabled": source["enabled"]}, 200)
call("DELETE", "/api/settings/sources/cinemeta", {}, 400)
call("PUT", "/api/settings/tmdb", {"apiKey": ""}, 400)
call("POST", "/api/settings/tmdb/test", {"apiKey": "invalid-contract-key"}, 400)
call("PUT", "/api/settings/tmdb", {"apiKey": "0123456789abcdef0123456789abcdef"}, 200)
call("POST", "/api/settings/tmdb/test", {"apiKey": "0123456789abcdef0123456789abcdef"}, 200)
call("DELETE", "/api/settings/tmdb", {}, 200)
call("PUT", "/api/requests/auto-approve", {"rules": [{"email": "contract@example.invalid", "mode": "none"}]}, 200)
call("PUT", "/api/requests/auto-approve", {"rules": []}, 200)
call("PUT", "/api/settings/remote-access",
     {"enabled": False, "tunnelPort": 3980, "ownerEmails": [], "allowRequesters": False}, 200)
rule = call("POST", "/api/rules", {"name": "API contract", "query": "Sintel", "category": "movies", "enabled": False})
call("PATCH", "/api/rules", {"id": rule["rule"]["id"], "enabled": False})
call("DELETE", "/api/rules?id=" + rule["rule"]["id"])
call("PATCH", "/api/rules", {"id": "missing-contract-rule", "enabled": False}, 404)
call("POST", "/api/rules", {"name": "Invalid", "query": "Sintel", "category": "Movies"}, 400)
call("DELETE", "/api/title/sintel-2010/links/tmdb/contract-missing", {}, 404)
call("POST", "/api/title/sintel-2010/releases", {"token": "invalid-contract-token"}, 400)
(out / "adapters.json").write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
print(f"{len(results)}/{len(results)} real HTTP adapter checks passed.")
