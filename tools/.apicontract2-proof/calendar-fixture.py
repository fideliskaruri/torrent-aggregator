import datetime
import json
import pathlib
import sqlite3

out = pathlib.Path(__file__).parent
db = sqlite3.connect(r"D:\code\memtest\apic2\data\torrentflow.db")
db.row_factory = sqlite3.Row
now = datetime.datetime.now(datetime.timezone.utc)
air = (now - datetime.timedelta(days=2)).isoformat()
old = "1999-12-17T00:00:00+00:00"
film = db.execute("SELECT * FROM Work WHERE workKey='stuart-little-1999'").fetchone()
assert film
template = dict(db.execute("SELECT * FROM Target WHERE episodeId IS NULL LIMIT 1").fetchone())
episode = db.execute("SELECT * FROM Target WHERE episodeId IS NOT NULL LIMIT 1").fetchone()
assert episode
# Controlled fixtures change only the independently converted backup, before the server starts.
db.execute("UPDATE Target SET state='removed'")
db.execute("UPDATE Follow SET enabled=0")
db.execute("UPDATE WatchItem SET status='dropped'")
template.update(workId=film["id"], state="done", expectedAt=None,
                episodeId=None, updatedAt=now.isoformat(), chosenReleaseHash=None)
db.execute("UPDATE Target SET state='done',expectedAt=NULL,updatedAt=?,chosenReleaseHash=NULL WHERE id=?",
           (now.isoformat(), template["id"]))
db.execute("UPDATE Work SET theatricalAt=?,digitalAt=NULL,physicalAt=NULL WHERE id=?", (old, film["id"]))
db.execute("UPDATE Target SET state='done',expectedAt=NULL,updatedAt=? WHERE id=?",
           ((now - datetime.timedelta(days=10)).isoformat(), episode["id"]))
db.execute("UPDATE Episode SET airAt=? WHERE id=?", (air, episode["episodeId"]))
db.commit()
series = db.execute("SELECT workKey FROM Work WHERE id=?", (episode["workId"],)).fetchone()[0]
fixture = {"filmWorkKey": film["workKey"], "filmTargetId": template["id"], "filmRelease": old,
           "episodeWorkKey": series, "episodeTargetId": episode["id"], "episodeAirAt": air,
           "episodeUpdatedAt": (now - datetime.timedelta(days=10)).isoformat(),
           "note": "Controlled dates/states on rows from read-only live backup; no live data modified."}
(out / "calendar-fixture.json").write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
print("Isolated back-catalogue and recent-release fixtures prepared.")
