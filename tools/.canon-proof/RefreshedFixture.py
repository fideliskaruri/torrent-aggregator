import datetime
import hashlib
import json
from pathlib import Path
import sqlite3
import sys

proof = Path(__file__).parent
c = sqlite3.connect(r"D:\code\memtest\canon-data\converted\torrentflow.db")
c.row_factory = sqlite3.Row
owner = "cmurncg9qbuom9jsyhu3rn32g"
duplicate = "canon-proof-refreshed-duplicate"
tables = ["MediaFile", "Target", "WatchItem", "Follow", "WorkFolder", "Download", "DownloadFile"]
unchanged = {}
for table in tables:
    rows = [dict(r) for r in c.execute('select * from "' + table + '" order by id')]
    unchanged[table] = {"count": len(rows), "sha256": hashlib.sha256(json.dumps(rows, sort_keys=True).encode()).hexdigest()}
(proof / "reference-before.json").write_text(json.dumps(unchanged, indent=2), encoding="utf-8")


def insert(table, row):
    columns = ",".join('"' + k + '"' for k in row)
    marks = ",".join("?" for _ in row)
    c.execute("insert into " + table + "(" + columns + ") values (" + marks + ")", list(row.values()))


work = dict(c.execute("select * from Work where id=?", (owner,)).fetchone())
work.update(id=duplicate, workKey="tmdb:tv:60625",
            refreshedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(), ratingSource="tmdb")
insert("Work", work)
link = dict(c.execute("select * from WorkLink where workId=? and provider='tmdb'", (owner,)).fetchone())
c.execute("update WorkLink set status='suggested' where id=?", (link["id"],))
link.update(id=duplicate + "-tmdb", workId=duplicate, status="verified", isPrimary=1)
insert("WorkLink", link)
for index, old in enumerate(c.execute("select * from WorkLink where workId=? and provider in ('imdb','tvdb')", (owner,)).fetchall()):
    row = dict(old)
    row.update(id=duplicate + "-external-" + str(index), workId=duplicate,
               status="suggested", source="provider", isPrimary=0)
    insert("WorkLink", row)
for index, old in enumerate(c.execute("select * from WorkName where workId=?", (owner,)).fetchall()):
    row = dict(old)
    row.update(id=duplicate + "-name-" + str(index), workId=duplicate, linkId=link["id"])
    insert("WorkName", row)
episodes = 0
for old in c.execute("select * from Season where workId=?", (owner,)).fetchall():
    season = dict(old)
    old_id = season["id"]
    season.update(id=duplicate + "-season-" + str(season["number"]), workId=duplicate)
    insert("Season", season)
    for item in c.execute("select * from Episode where seasonId=?", (old_id,)).fetchall():
        row = dict(item)
        provider_episode_id = row["providerEpisodeId"] if row["provider"] == "tmdb" else None
        if "--provider-ids" in sys.argv and provider_episode_id is not None:
            c.execute("update Episode set provider=NULL,providerEpisodeId=NULL where id=?", (row["id"],))
        row.update(id=duplicate + "-episode-" + str(episodes), seasonId=season["id"],
                   provider="tmdb", providerEpisodeId=provider_episode_id if "--provider-ids" in sys.argv else None)
        insert("Episode", row)
        episodes += 1
c.commit()
(proof / "refreshed-fixture.json").write_text(json.dumps({
    "description": "Proof-only recreation of an earlier fully refreshed, unreferenced catalog duplicate, using the real copied work's metadata and coordinates. Native provider IDs are not invented.",
    "owner": owner, "duplicate": duplicate, "metadataEpisodes": episodes,
    "providerEpisodeIdentitiesTransferredToDuplicate": "--provider-ids" in sys.argv,
    "duplicateMediaFiles": c.execute("select count(*) from MediaFile where workId=?", (duplicate,)).fetchone()[0],
    "ownerMediaFiles": c.execute("select count(*) from MediaFile where workId=?", (owner,)).fetchone()[0]
}, indent=2), encoding="utf-8")
