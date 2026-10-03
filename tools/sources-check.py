"""Real-HTTP sources benchmark; no production assembly references or mocks."""
import argparse
import concurrent.futures
import csv
import json
import pathlib
import time
import urllib.parse
import urllib.request

QUERIES = [
    ("Scorpion", "tt3514324", "series"),
    ("Little Fires Everywhere", "tt8089592", "series"),
    ("Frieren", "tt22248376", "anime"),
    ("A Silent Voice", None, "anime-film"),
    ("Prison Break", "tt0455275", "series"),
    ("Money Heist", "tt6468322", "series"),
    ("Rick and Morty S01", "tt2861424", "series"),
    ("Sintel", None, "film"),
    ("Big Buck Bunny", None, "film"),
]
SOURCES = ["apibay", "nyaa", "eztv", "yts", "torrentscsv", "knaben", "animetosho"]
FALLBACKS = ["therarbg", "bitsearch", "limetorrents", "torrentdownloads", "torrentdownloadinfo"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--url", default="http://127.0.0.1:3945")
    parser.add_argument("--tier", choices=["core", "fallback"], default="core")
    args = parser.parse_args()
    root = pathlib.Path(__file__).resolve().parent
    proof = root / ".sources-proof"
    proof.mkdir(exist_ok=True)
    sources = SOURCES if args.tier == "core" else FALLBACKS
    audit = list(csv.DictReader((root.parent / "docs" / "source-audit.csv").open(encoding="utf-8-sig")))

    def lane(source):
        results = []
        for query, imdb, kind in QUERIES:
            if source in ("nyaa", "animetosho") and kind not in ("anime", "anime-film"):
                continue
            if source == "eztv" and imdb is None:
                continue
            if source == "yts" and kind not in ("film", "anime-film"):
                continue
            params = {"q": query, "source": source, "lane": "owner"}
            if imdb:
                params["imdb"] = imdb
            # All preserves the source's raw window; downstream Find/Parser own work filtering.
            started = time.monotonic()
            with urllib.request.urlopen(args.url + "/api/dev/sources/search?" + urllib.parse.urlencode(params), timeout=9) as response:
                answer = json.load(response)
            ms = round((time.monotonic() - started) * 1000, 1)
            seeds = [row["listedSeeders"] for row in answer["results"] if row.get("listedSeeders") is not None]
            previous = [row for row in audit if row.get("record_type") == "query" and row.get("source") == source
                        and row.get("query", "").startswith(query.split(" S01")[0])
                        and row.get("attempt") == "1"]
            results.append({
                "source": source, "query": query, "kind": kind, "count": len(answer["results"]),
                "maxListedSeeders": max(seeds) if seeds else None, "latencyMs": ms,
                "outcome": answer["outcome"], "complete": answer["complete"],
                "diagnostics": answer["diagnostics"], "error": answer.get("error"),
                "auditCounts": [int(row["result_count"]) for row in previous],
                "response": answer,
            })
            print(source, query, len(answer["results"]), max(seeds) if seeds else None, ms, answer["outcome"], flush=True)
        return results

    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as executor:
        all_results = [row for rows in executor.map(lane, sources) for row in rows]
    (proof / f"{args.tier}.json").write_text(json.dumps(all_results, indent=2), encoding="utf-8")
    lines = ["| Query | " + " | ".join(sources) + " |", "|---|" + "---|" * len(sources)]
    for query, _, _ in QUERIES:
        cells = []
        for source in sources:
            row = next((r for r in all_results if r["query"] == query and r["source"] == source), None)
            cells.append("n/a" if row is None else f'{row["count"]}/{row["maxListedSeeders"] or 0}/{round(row["latencyMs"])} {row["outcome"]}')
        lines.append("| " + query + " | " + " | ".join(cells) + " |")
    print("\n".join(lines))
    (proof / f"{args.tier}-table.txt").write_text("\n".join(lines), encoding="utf-8")


if __name__ == "__main__":
    main()
