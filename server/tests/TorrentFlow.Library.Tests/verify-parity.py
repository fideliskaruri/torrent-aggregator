"""Compare read-only API results from already-running isolated parity hosts."""
import argparse
import json
import urllib.error
import urllib.request


def read(port, path, body=None):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=90) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.loads(error.read())


def differences(left, right, path=""):
    if isinstance(left, dict) and isinstance(right, dict):
        out = []
        for key in sorted(left.keys() | right.keys()):
            # Clock and concurrently changing volume free-space are not deterministic.
            if key in ("generatedAt", "freeBytes", "freeLabel"):
                continue
            if key not in left or key not in right:
                out.append({"path": path + "/" + key, "next": left.get(key, "<missing>"), "dotnet": right.get(key, "<missing>")})
            else:
                out.extend(differences(left[key], right[key], path + "/" + key))
        return out
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return [{"path": path + "/length", "next": len(left), "dotnet": len(right)}]
        return [d for index, (a, b) in enumerate(zip(left, right)) for d in differences(a, b, path + "/" + str(index))]
    return [] if left == right else [{"path": path, "next": left, "dotnet": right}]


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--next-port", type=int, default=3102)
    parser.add_argument("--api-port", type=int, default=5102)
    parser.add_argument("--work-keys", nargs="+", default=["breaking-bad", "dune-2021", "attack-on-titan"])
    parser.add_argument("--output")
    args = parser.parse_args()
    if 3000 in (args.next_port, args.api_port):
        parser.error("The owner's port 3000 is never a parity target.")
    routes = ["/api/watchlist", "/api/history", "/api/activity", "/api/activity?limit=7",
              "/api/activity/unread", "/api/progress", "/api/progress?active=1", "/api/rules"]
    routes += ["/api/title/" + key for key in args.work_keys]
    routes += ["/api/title/" + key + "/progress" for key in args.work_keys]
    routes += ["/api/library/backfill-estimate"]
    report = []
    for route in routes:
        body = {"fromSeason": 1, "toSeason": 2} if route.endswith("backfill-estimate") else None
        a, b = read(args.next_port, route, body), read(args.api_port, route, body)
        diffs = differences(a[1], b[1])
        if a[0] != b[0]:
            diffs.insert(0, {"path": "/status", "next": a[0], "dotnet": b[0]})
        report.append({"route": route, "nextStatus": a[0], "dotnetStatus": b[0], "differences": diffs})
        print(f"{route}: {len(diffs)} differences")
    text = json.dumps(report, indent=2, ensure_ascii=False)
    if args.output:
        with open(args.output, "w", encoding="utf-8") as output:
            output.write(text)
    else:
        print(text)
