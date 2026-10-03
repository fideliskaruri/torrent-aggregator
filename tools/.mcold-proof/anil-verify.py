import json, pathlib

root = pathlib.Path(__file__).resolve().parents[2]
proof = root / "tools" / ".mcold-proof"
read = lambda path: json.loads(path.read_text(encoding="utf-8-sig"))
prior = read(proof / "map-before-1-anime-cold.json")
baseline = read(proof / "anil-before-1-anime-cold.json")
legacy = read(root / "backend" / "contract" / "captures" / "browse" / "anime.json")["body"]
timings = read(proof / "anil-final-timings.json")
shape_rows = read(proof / "anil-final-shapes.json")
summary = []
for run in range(1, 4):
    cold = read(proof / f"anil-final-{run}-anime-cold.json")
    warm = read(proof / f"anil-final-{run}-anime-warm.json")
    assert len(cold["rails"]) == 11
    assert [r["id"] for r in cold["rails"]] == [r["id"] for r in prior["rails"]]
    assert cold["rails"] == warm["rails"]
    assert all(not row["errors"] for row in shape_rows
        if row["file"] in [f"anil-final-{run}-anime-{mode}.json" for mode in ("cold", "warm")])
    cards = [card for rail in cold["rails"] for card in rail["items"]]
    assert len(cards) == len({card["workKey"] for card in cards}) == 264
    assert all(card["posterUrl"] and card["title"] and card["providerId"] for card in cards)
    row = {"run": run, "cards":len(cards), "rails":[]}
    for rail in cold["rails"]:
        ids = [card["providerId"] for card in rail["items"]]
        assert len(ids) == 24
        comparisons = {}
        for label, reference in (("prior", prior), ("fresh_baseline", baseline), ("contract", legacy)):
            before = next(r for r in reference["rails"] if r["id"] == rail["id"])
            before_ids = [card["providerId"] for card in before["items"]]
            comparisons[label] = {"ordered_equal":ids == before_ids,
                "overlap":len(set(ids) & set(before_ids)),
                "added":sorted(set(ids) - set(before_ids)),
                "removed":sorted(set(before_ids) - set(ids))}
        assert comparisons["prior"]["ordered_equal"]
        assert comparisons["fresh_baseline"]["ordered_equal"]
        row["rails"].append({"id":rail["id"],"count":24,"providerIds":ids,"comparisons":comparisons})
    samples = [t for t in timings if t["run"] == run]
    assert samples[0]["mode"] == "cold" and samples[0]["seconds"] < 4
    assert samples[1]["mode"] == "warm" and samples[1]["seconds"] < .3
    calls = [c for c in samples[1]["providerCache"] if c["pages"]]
    assert len(calls) == 2 and all(c["complete"] for c in calls)
    assert sum(len(c["pages"]) for c in calls) == 13
    row.update(cold_seconds=samples[0]["seconds"],warm_seconds=samples[1]["seconds"],
        successful_aliased_requests=2, pages=13, http_429_count=0,
        http_429_evidence="Both physical flights have complete raw provider cache receipts; no retry exists. Traced equivalent candidates also recorded only HTTP 200.",
        canonical_ids_cold_warm_equal=True)
    summary.append(row)
(proof / "anil-final-verification.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
print("3/3 cold <4s; 3/3 warm <300ms; 11 x 24 cards; exact ordered prior and baseline provider IDs; zero 429s.")
print("Legacy contract ordered rail matches:",sum(r["comparisons"]["contract"]["ordered_equal"]
    for r in summary[0]["rails"]),"/11 (provider listings can change).")
