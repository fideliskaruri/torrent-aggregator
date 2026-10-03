import json
from pathlib import Path
import sqlite3
import sys
import time
import urllib.request

proof = Path(__file__).parent
db = Path(r"D:\code\memtest\epid-data\converted\torrentflow.db")
mode = sys.argv[1]
c = sqlite3.connect(db)
c.row_factory = sqlite3.Row
work = c.execute("select id from Work where workKey='rick-and-morty-2013'").fetchone()[0]
if mode in ["renumber", "replacement"]:
    rows = [dict(r) for r in c.execute("""
        select e.* from Episode e join Season s on s.id=e.seasonId
        where s.workId=? and s.number=1 and e.number in (1,2,3)
        and e.mappingStatus!='unavailable' order by e.number""", (work,))]
    refs = {table: [dict(r) for r in c.execute(
        "select id,episodeId from " + table + " where workId=?", (work,))]
        for table in ["Target", "MediaFile"]}
    state = {"episodes": rows, "references": refs}
    (proof / (mode + "-before.json")).write_text(json.dumps(state, indent=2), encoding="utf8")
    if mode == "renumber":
        backup = sqlite3.connect(proof / "fixture-backup.db")
        c.backup(backup)
        backup.close()
        second_season = c.execute("select id from Season where workId=? and number=2", (work,)).fetchone()[0]
        c.execute("update Episode set number=100001 where id=?", (rows[0]["id"],))
        c.execute("update Episode set number=1 where id=?", (rows[1]["id"],))
        c.execute("update Episode set number=2 where id=?", (rows[0]["id"],))
        c.execute("update Episode set seasonId=?,number=999 where id=?", (second_season, rows[2]["id"]))
    else:
        c.execute("update Episode set providerEpisodeId='epid-proof-retired' where id=?", (rows[0]["id"],))
    c.execute("update Work set refreshedAt=null where id=?", (work,))
    c.commit()
    print("Seeded isolated " + mode + " fixture; real provider refresh required.")
elif mode in ["verify-renumber", "verify-replacement"]:
    kind = mode.removeprefix("verify-")
    until = time.monotonic() + 180
    while True:
        try:
            with urllib.request.urlopen("http://127.0.0.1:3967/api/title/rick-and-morty-2013?s=1",
                                        timeout=90) as response:
                body = json.load(response)
            if body.get("episodes"):
                break
        except Exception:
            pass
        assert time.monotonic() < until, "Provider refresh did not complete"
        time.sleep(3)
    before = json.loads((proof / (kind + "-before.json")).read_text())
    actual = {r["id"]: dict(r) for r in c.execute("select * from Episode")}
    refs = {table: [dict(r) for r in c.execute(
        "select id,episodeId from " + table + " where workId=?", (work,))]
        for table in ["Target", "MediaFile"]}
    assert refs == before["references"], "File/target references changed"
    for old in before["episodes"]:
        row = actual[old["id"]]
        assert row["number"] == old["number"] and row["seasonId"] == old["seasonId"], old["id"]
        if kind == "renumber":
            assert row["providerEpisodeId"] == old["providerEpisodeId"]
        elif old["number"] == 1:
            assert row["mappingStatus"] == "unavailable" and row["providerEpisodeId"] == "epid-proof-retired"
            replacement = c.execute("select * from Episode where provider=? and providerEpisodeId=?",
                                    (old["provider"], old["providerEpisodeId"])).fetchone()
            assert replacement is not None and replacement["id"] != old["id"]
            assert replacement["number"] == old["number"] and replacement["seasonId"] == old["seasonId"]
    assert c.execute("pragma integrity_check").fetchone()[0] == "ok"
    assert not c.execute("pragma foreign_key_check").fetchall()
    result = {"pass": True, "fixture": kind, "referenceCounts": {t: len(r) for t, r in refs.items()},
              "referencesUnchanged": True, "integrity": "ok", "fkFailures": 0,
              "httpEpisodeNumbers": [e["episode"] for e in body["episodes"]],
              "episodeRows": [actual[r["id"]] for r in before["episodes"]]}
    (proof / (kind + "-result.json")).write_text(json.dumps(result, indent=2), encoding="utf8")
    print(json.dumps(result))
elif mode == "restore":
    backup = sqlite3.connect(proof / "fixture-backup.db")
    backup.backup(c)
    backup.close()
    print("Restored exact pre-fixture converted database.")
else:
    raise ValueError(mode)
