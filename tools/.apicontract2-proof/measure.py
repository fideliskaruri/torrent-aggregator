import concurrent.futures
import collections
import json
import pathlib
import re
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(r"D:\code\platformApps-worktrees\rebuild")
OUT = ROOT / "tools" / ".apicontract2-proof"
CONTRACT = ROOT / "backend" / "contract"
registry = json.loads((CONTRACT / "shapes.json").read_text(encoding="utf-8-sig"))
routes = json.loads((CONTRACT / "routes.json").read_text(encoding="utf-8-sig"))
sources = json.loads((CONTRACT / "source-contracts.json").read_text(encoding="utf-8-sig"))
BASE = "http://127.0.0.1:3966"
rows = json.loads((OUT / "raw.json").read_text()) if (OUT / "raw.json").exists() else []


def call(method, path, body=None, timeout=45):
    request = urllib.request.Request(BASE + path, method=method)
    if body is not None:
        request.data = json.dumps(body).encode()
        request.add_header("Content-Type", "application/json")
    start = time.monotonic()
    try:
        response = urllib.request.urlopen(request, timeout=timeout)
    except urllib.error.HTTPError as error:
        response = error
    except Exception as error:
        return 0, {"transportError": str(error)}, round(time.monotonic() - start, 3)
    raw = response.read().decode("utf-8", errors="replace")
    try:
        value = json.loads(raw)
    except ValueError:
        value = raw or None
    return response.code, value, round(time.monotonic() - start, 3)


def resolve(schema):
    if isinstance(schema, dict) and "$ref" in schema:
        name = schema["$ref"].split("/")[-1]
        resolved = dict(registry["typescript"].get(name, {}))
        if "x-extends" in resolved:
            parent = resolve({"$ref": "#/typescript/" + resolved["x-extends"]})
            resolved["properties"] = {**parent.get("properties", {}), **resolved.get("properties", {})}
            resolved["required"] = list(set(parent.get("required", []) + resolved.get("required", [])))
        if name == "ClientTorrent":
            # The capture generator picked the homonymous lib/torrents type.
            # Downloads uses app/downloads/types.ts, whose identity fields are nullable.
            resolved["properties"] = dict(resolved.get("properties", {}))
            for field, kind in [("season", "number"), ("episode", "number"), ("posterUrl", "string"),
                                ("workId", "string"), ("workKey", "string"), ("workTitle", "string"),
                                ("workYear", "number"), ("workMediaType", "string"), ("magnet", "string")]:
                resolved["properties"][field] = {"type": [kind, "null"]}
        if name == "NotificationItem":
            # Legacy NotificationView explicitly always serializes a nullable PosterUrl.
            resolved["properties"] = {**resolved.get("properties", {}),
                                      "posterUrl": {"type": ["string", "null"]}}
        return resolved
    return schema or {}


def kind(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, dict):
        return "object"
    if isinstance(value, list):
        return "array"
    if isinstance(value, str):
        return "string"
    return "number"


def compare(value, schema, declared=None, path="$"):
    schema, declared = resolve(schema), resolve(declared)
    errors, extras, notes = [], [], []
    if not schema or schema.get("x-unresolved") or schema.get("x-unobserved"):
        schema = declared
        if not schema or schema.get("x-unresolved") or schema.get("x-unobserved"):
            return [], [], [path + " schema unproven"]
    if "anyOf" in schema:
        attempts = [compare(value, option, None, path) for option in schema["anyOf"]]
        good = [a for a in attempts if not a[0]]
        return good[0] if good else min(attempts, key=lambda a: len(a[0]))
    actual_type = kind(value)
    allowed = schema.get("type")
    allowed = allowed if isinstance(allowed, list) else [allowed]
    if allowed[0] and actual_type not in allowed:
        alternative = compare(value, declared, None, path) if declared and declared != schema else None
        if alternative and not alternative[0]:
            return alternative[0], alternative[1], [path + " declared state variant"] + alternative[2]
        if allowed == ["null"]:
            return [], [], [path + " null-only baseline; non-null type unproven"]
        return [f"{path} type changed: expected {allowed}, actual {actual_type}"], [], []
    if isinstance(value, dict):
        if isinstance(declared.get("additionalProperties"), dict):
            for key, item in value.items():
                e, x, n = compare(item, declared["additionalProperties"], None, path + ".*")
                errors += e
                extras += x
                notes += n
            return sorted(set(errors)), sorted(set(extras)), sorted(set(notes))
        properties = schema.get("properties", {})
        declared_properties = declared.get("properties", {})
        for key in schema.get("required", []):
            if key not in value:
                errors.append(path + "." + key + " missing")
        for key, item in value.items():
            if key not in properties and key not in declared_properties:
                extras.append(path + "." + key + " extra (allowed by baseline)")
                continue
            e, x, n = compare(item, properties.get(key), declared_properties.get(key), path + "." + key)
            errors += e
            extras += x
            notes += n
    elif isinstance(value, list):
        if not value and schema.get("items") and not schema["items"].get("x-unobserved"):
            notes.append(path + " empty; element shape unverified")
        for item in value:
            e, x, n = compare(item, schema.get("items"), declared.get("items"), path + "[]")
            errors += e
            extras += x
            notes += n
    return sorted(set(errors)), sorted(set(extras)), sorted(set(notes))


def measure(route, path, body, expected_status, schema, label, notes=None):
    status, actual, seconds = call(route["method"], path, body)
    expected = next((r["expectedResponse"] for r in registry["routes"]
                     if r["method"] == route["method"] and r["path"] == route["path"]), {})
    errors, extras, shape_notes = compare(actual, schema, expected)
    absent_route = isinstance(actual, dict) and actual.get("message") == "This API route does not exist."
    if status == 404 and absent_route:
        category = "404"
    elif status == 0:
        category = "transport failure"
    elif status != expected_status:
        category = "404" if status == 404 else "5xx" if status >= 500 else "status mismatch"
    elif errors:
        category = "shape mismatch"
    else:
        category = "pass"
    row = dict(method=route["method"], route=route["path"], request=path, payload=body,
               expectedStatus=expected_status, status=status, category=category,
               missingOrTypeChanged=errors, extra=extras, notes=(notes or []) + shape_notes,
               seconds=seconds, fixture=label, body=actual, family=route["family"],
               oldSource=route["serverSource"])
    return row


def read_route(route):
    captures = [c for c in registry["captures"] if c["capture"] in route["captures"]]
    if captures:
        return [measure(route, capture["path"], None, capture["status"], capture["schema"],
                        capture["capture"]) for capture in captures]
    path = route["path"].replace("{hash}", "0" * 40).replace("{workKey}", "tmdb-movie-45745")
    if path == "/api/requester/seasons":
        path += "?provider=tmdb&providerId=45745&mediaType=movie&title=Sintel&year=2010"
    status = 403 if path.startswith("/api/requester/") else 404 if "{hash}" in route["path"] else 200
    schema = {"type": "object", "properties": {"error": {"type": "string"}}, "required": ["error"]} if status != 200 else None
    return [measure(route, path, None, status, schema, "source-derived owner-local branch")]


def save():
    (OUT / "raw.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
    counts = collections.Counter(row["category"] for row in rows)
    covered = {(row["method"], row["route"]) for row in rows}
    text = ["# Phase 6 web contract gate", "",     "Build: isolated wt-apic2. Port 3966.",
            "Stable data copied with SQLite backup, converted from the copy. Scheduler disabled.",
            "No original payload root was mapped: imported transfers are stopped and ownership is not inferred.",
            "All mutating requests use Sintel or harmless/no-op/error-branch fixtures.",
            "Extras are listed but allowed by the baseline README. Empty/unresolved shapes are explicitly unproven.",
            "Owner-local requester refusal is checked; requester success requires a separate authenticated-role run.",
            "Source-only mutations have no recorded old HTTP sample; expected status/schema uses the old handler branch.",
            "", f"Coverage: {len(covered)}/{len(web)} web method/path routes; {len(rows)} samples.",
            f"Counts: {dict(counts)}", "",
            "| Method | Route | Actual request / fixture | Expected / actual status | Result | Missing / type-changed | Extra fields | Unproven / notes |",
            "|---|---|---|---|---|---|---|---|"]
    for row in sorted(rows, key=lambda x: (x["route"], x["method"], x["fixture"])):
        cells = [row["method"], row["route"], row["request"] + " (" + row["fixture"] + ")",
                 f'{row["expectedStatus"]} / {row["status"]}', row["category"],
                 "; ".join(row["missingOrTypeChanged"]), "; ".join(row["extra"]), "; ".join(row["notes"])]
        text.append("| " + " | ".join(c.replace("|", "\\|").replace("\n", " ") for c in cells) + " |")
    (OUT / "report.md").write_text("\n".join(text) + "\n", encoding="utf-8")
    print("COUNTS", dict(counts), "COVERED", len(covered), flush=True)


web = [r for r in routes if r["scope"] == "web"]
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
    jobs = [pool.submit(read_route, route) for route in web if route["method"] == "GET"
            and not any(r["method"] == route["method"] and r["route"] == route["path"] for r in rows)]
    for job in concurrent.futures.as_completed(jobs):
        rows.extend(job.result())
        save()

error_schema = {"type": "object", "required": ["error"], "properties": {"error": {"type": "string"}}}
fixture_id = "contract-harmless-missing"
watch_id = fixture_id
rule_id = fixture_id
for route in [r for r in web if r["method"] != "GET"]:
    method, pattern = route["method"], route["path"]
    if any(r["method"] == method and r["route"] == pattern for r in rows):
        continue
    path = pattern.replace("{workKey}", "tmdb-movie-45745").replace("{hash}", "0" * 40)
    path = path.replace("{transferId}", fixture_id).replace("{id}", fixture_id)
    path = path.replace("{provider}", "tmdb").replace("{externalId}", "45745")
    body, status, schema = {}, 200, None
    label = "harmless source-derived branch"
    if pattern == "/api/desktop/settings":
        body = {"checkForUpdates": False}
    elif pattern == "/api/library/imports/scan":
        directory = pathlib.Path(r"D:\code\memtest\apic2\empty-import")
        directory.mkdir(exist_ok=True)
        body = {"path": str(directory)}
        status = 202
        schema = next(c["schema"] for c in registry["captures"] if c["path"] == pattern)
    elif pattern.startswith("/api/desktop/update/"):
        status, schema = 409, error_schema
    elif pattern == "/api/notifications/read/{id}":
        status, schema = 404, None
    elif pattern == "/api/notifications/read-all":
        status = 204
    elif pattern.endswith("/push/subscription"):
        body = {"endpoint": "https://example.invalid/contract", "p256dh": "", "auth": ""}
        if method == "POST":
            status, schema = 400, error_schema
        else:
            status = 204
    elif pattern == "/api/settings/remote-access":
        body = {"enabled": False, "tunnelPort": 3980, "ownerEmails": [], "allowRequesters": False}
    elif pattern.startswith("/api/requester/"):
        status, schema = 403, error_schema
        body = {"provider": "tmdb", "providerId": "45745", "mediaType": "movie", "title": "Sintel",
                "year": 2010, "scope": "movie", "seasons": []}
    elif pattern == "/api/requests/auto-approve":
        body = {"rules": []}
    elif pattern.startswith("/api/requests/"):
        status, schema = 404, error_schema
        body = {"token": "invalid-contract-token"} if pattern.endswith("/pick") else {"reason": "Contract measurement"}
    elif pattern == "/api/client/torrents":
        body = {"action": "pause", "hash": "0" * 40, "ownerClientType": "builtin"}
        status = 200
    elif pattern.startswith("/api/downloads/"):
        path = pattern.replace("{transferId}", "builtin:" + "0" * 40)
        body = {"mode": "reveal"}
        status, schema = 404, error_schema
    elif pattern == "/api/settings/download-recovery/sources":
        body = {"ids": [], "acknowledged": True}
    elif pattern == "/api/settings/open-folder":
        settings_status, settings, _ = call("GET", "/api/settings/client")
        body = {"path": str(pathlib.Path(settings["settings"]["baseDownloadPath"]) / "contract-no-such-folder")}
        status, schema = 404, error_schema
    elif pattern == "/api/settings/client":
        body = {"maxActiveDownloads": 5, "baseDownloadPath": r"D:\\code\\memtest\\rebuild-contract\\library"}
    elif pattern == "/api/torrent/send":
        body = {}
        status = 400
        schema = {"type": "object", "required": ["ok", "message"],
                  "properties": {"ok": {"type": "boolean"}, "message": {"type": "string"}}}
    elif pattern == "/api/library/ondemand":
        body = {"title": "Sintel", "workKey": "tmdb-movie-45745", "action": "invalid-contract-action"}
        status = 400
        schema = None
    elif pattern.endswith("/alternatives"):
        body = {"token": "invalid-contract-token"}
        status, schema = 404, error_schema
    elif pattern in ("/api/wanted", "/api/wanted/try"):
        path += "?workKey=tmdb-movie-45745"
    elif pattern == "/api/rules":
        if method == "POST":
            body = {"name": "Contract Sintel", "query": "Sintel", "category": "movies",
                    "enabled": False}
        elif method == "PATCH":
            body = {"id": rule_id, "enabled": False}
        else:
            path += "?id=" + rule_id
    elif pattern == "/api/library/delete":
        body = {"watchListItemId": fixture_id, "scope": "show", "confirm": False}
        status = 400
        schema = {"type": "object", "required": ["ok", "error", "message", "reason"],
                  "properties": {"ok": {"type": "boolean"}, "error": {"type": "string"},
                                 "message": {"type": "string"}, "reason": {"type": "string"}}}
    elif pattern == "/api/title/{workKey}":
        body = {"action": "grab", "provider": "tmdb", "providerId": "45745", "mediaType": "movie",
                "title": "Sintel", "year": 2010, "scope": "title", "quality": "1080p"}
    elif pattern == "/api/title/{workKey}/releases":
        body = {"token": "invalid-contract-token"}
        status = 400
        schema = None
    elif pattern == "/api/title/{workKey}/links/{provider}/{externalId}":
        path = pattern.replace("{workKey}", "tmdb-movie-45745").replace("{provider}", "tmdb").replace("{externalId}", "contract-missing")
        status, schema = 404, None
    elif pattern == "/api/watchlist":
        if method == "POST":
            body = {"workKey": "tmdb-movie-45745", "provider": "tmdb", "providerId": "45745",
                    "mediaType": "movie", "externalId": "45745", "title": "Sintel",
                    "year": 2010, "monitored": False}
        elif method == "PATCH":
            body = {"id": watch_id, "monitored": False}
        else:
            path += "?id=" + watch_id
    elif pattern.startswith("/api/settings/sources/"):
        path = pattern.replace("{id}", "contract-missing-source")
        if method == "PUT":
            body = {"enabled": False}
        status = 400 if method == "PUT" else 200 if method == "DELETE" else 404
        schema = error_schema if method != "DELETE" else None
    elif pattern == "/api/artwork":
        body = {"items": [{"title": "Sintel", "year": 2010, "mediaType": "movie"}]}
    elif pattern == "/api/settings/tmdb":
        if method == "PUT":
            body = {"apiKey": ""}
            status, schema = 400, error_schema
    elif pattern == "/api/settings/tmdb/test":
        body = {"apiKey": "invalid-contract-key"}
        status, schema = 400, None
    row = measure(route, path, body, status, schema, label)
    if pattern == "/api/watchlist" and method == "POST" and isinstance(row["body"], dict):
        watch_id = row["body"].get("item", {}).get("id", fixture_id)
    if pattern == "/api/rules" and method == "POST" and isinstance(row["body"], dict):
        rule_id = row["body"].get("rule", {}).get("id", fixture_id)
    rows.append(row)
    save()
save()
