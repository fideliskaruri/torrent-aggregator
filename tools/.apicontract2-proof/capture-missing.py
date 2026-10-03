import json
import pathlib
import urllib.error
import urllib.request

root = pathlib.Path(__file__).resolve().parents[2]
contract = root / "backend" / "contract"
fixture = pathlib.Path(r"D:\code\memtest\apic2\empty-import")
fixture.mkdir(exist_ok=True)


def schema(value):
    if isinstance(value, dict):
        return {"type": "object", "properties": {k: schema(v) for k, v in value.items()},
                "required": list(value), "additionalProperties": True}
    if isinstance(value, list):
        return {"type": "array", "items": schema(value[0]) if value else {"x-unobserved": True}}
    return {"type": "null" if value is None else "boolean" if isinstance(value, bool)
            else "number" if isinstance(value, (int, float)) else "string"}


routes = json.loads((contract / "routes.json").read_text(encoding="utf-8-sig"))
shapes = json.loads((contract / "shapes.json").read_text(encoding="utf-8-sig"))
cases = [
    ("POST", "/api/library/imports/scan", {"path": str(fixture)}, "library", "imports-scan", 202,
     r"web\src\components\library\folder-import.tsx", r"backend\src\Api\ImportEndpoints.cs"),
    ("GET", "/api/library/roots", None, "library", "roots", 200,
     r"web\src\components\library\storage-roots.tsx", r"backend\src\Api\ImportEndpoints.cs"),
    ("GET", "/api/requester/calendar", None, "requester", "calendar-owner-denied", 403,
     r"web\src\app\upcoming\page.tsx", r"backend\src\Api\Requests\RequestEndpoints.cs"),
]
for method, path, payload, family, name, expected, web, server in cases:
    request = urllib.request.Request("http://127.0.0.1:3966" + path, method=method)
    if payload is not None:
        request.data = json.dumps(payload).encode()
        request.add_header("Content-Type", "application/json")
    try:
        response = urllib.request.urlopen(request, timeout=30)
    except urllib.error.HTTPError as error:
        response = error
    body = json.loads(response.read())
    assert response.status == expected, (path, response.status)
    relative = str(pathlib.Path("captures") / family / (name + ".json"))
    capture = {"method": method, "path": path, "status": response.status,
               "contentType": response.headers.get("Content-Type"), "body": body}
    if payload is not None:
        capture["requestBody"] = payload
    capture["evidence"] = "Real HTTP response from isolated rebuild on 3966; not a legacy capture."
    destination = contract / relative
    destination.parent.mkdir(exist_ok=True)
    destination.write_text(json.dumps(capture, indent=2) + "\n", encoding="utf-8")
    routes = [r for r in routes if not (r["method"] == method and r["path"] == path)]
    routes.append({"method": method, "path": path, "scope": "web", "family": family,
                   "parameters": "JSON path" if payload is not None else "none",
                   "expectedType": "{scanId:string,state:string}" if method == "POST" else
                       "{roots:StorageRoot[]}" if family == "library" else "{entries:unknown[]}",
                   "typeSource": web, "consumer": name, "mutates": method != "GET",
                   "evidence": "captured (isolated rebuild, not legacy)",
                   "captures": [relative], "webSources": [web], "serverSource": server})
    shapes["captures"] = [c for c in shapes["captures"] if c["capture"] != relative]
    shapes["captures"].append({"capture": relative, "method": method, "path": path,
                               "status": response.status, "schema": schema(body)})
    shapes["routes"] = [r for r in shapes["routes"] if not (r["method"] == method and r["path"] == path)]
    shapes["routes"].append({"method": method, "path": path, "expectedResponse": schema(body),
                             "evidence": capture["evidence"]})
    print(method, path, response.status)
(contract / "routes.json").write_text(json.dumps(routes, indent=2) + "\n", encoding="utf-8")
(contract / "shapes.json").write_text(json.dumps(shapes, indent=2) + "\n", encoding="utf-8")
