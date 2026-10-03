import ast
import json
import pathlib
import sys

root = pathlib.Path(__file__).resolve().parents[2]
proof = root / "tools" / ".mcold-proof"
registry = json.loads((root / "backend" / "contract" / "shapes.json").read_text(encoding="utf-8-sig"))
reference = pathlib.Path(r"D:\code\platformApps-worktrees\rebuild\tools\.apicontract2-proof\measure.py")
tree = ast.parse(reference.read_text(encoding="utf-8"))
functions = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("resolve", "kind", "compare")]
namespace = {"registry": registry}
exec(compile(ast.Module(body=functions, type_ignores=[]), str(reference), "exec"), namespace)
captures = {
    "all": r"captures\browse\all.json", "anime": r"captures\browse\anime.json",
    "films": r"captures\browse\films.json", "series": r"captures\browse\series.json",
    "extras": r"captures\title\rick-and-morty-2013-extras.json",
}
phase = sys.argv[1]
rows = []
for path in sorted(proof.glob(f"{phase}-*-cold.json")) + sorted(proof.glob(f"{phase}-*-warm.json")):
    name = path.stem.split("-")[-2]
    capture = next(c for c in registry["captures"] if c["capture"] == captures[name])
    route = "/api/title/{workKey}/extras" if name == "extras" else "/api/browse"
    declared = next(r["expectedResponse"] for r in registry["routes"] if r["method"] == "GET" and r["path"] == route)
    value = json.loads(path.read_text(encoding="utf-8"))
    errors, extras, notes = namespace["compare"](value, capture["schema"], declared)
    if name != "extras" and not value.get("rails"):
        errors.append("No browse rails: not a successful proof even if the array schema permits empty.")
    if name != "extras" and len(value.get("rails", [])) != {"all": 10, "anime": 11, "films": 14, "series": 11}[name]:
        errors.append("Incomplete rail set; not a successful cold/warm proof.")
    if name != "extras" and any(len(r["items"]) != 24 for r in value.get("rails", []) if r["id"] != "films-cinemas"):
        errors.append("A featured/type rail is not full.")
    if name != "extras":
        cards = [c for r in value.get("rails", []) for c in r["items"]]
        if len({c["workKey"] for c in cards}) != len(cards):
            errors.append("Duplicate work keys across browse rails.")
        if path.stem.endswith("-warm"):
            cold = json.loads(path.with_name(path.name.replace("-warm.json", "-cold.json")).read_text(encoding="utf-8"))
            cold_ids = {c["workKey"]: c["workId"] for r in cold["rails"] for c in r["items"]}
            if any(cold_ids.get(c["workKey"]) != c["workId"] for c in cards):
                errors.append("Canonical card identity changed between cold and warm reads.")
    if name == "extras" and (len(value.get("episodes", [])) != 11 or not value.get("moreLikeThis")):
        errors.append("Rick and Morty S1 must contain all 11 real episodes and real recommendations.")
    rows.append({"file": path.name, "errors": errors, "extra": extras, "unproven": notes})
(proof / f"{phase}-shapes.json").write_text(json.dumps(rows, indent=2), encoding="utf-8")
print(f"{sum(not r['errors'] for r in rows)}/{len(rows)} response shape and nonempty-content checks passed")
for row in rows:
    if row["errors"]:
        print(row["file"], row["errors"])
sys.exit(int(any(r["errors"] for r in rows)))
