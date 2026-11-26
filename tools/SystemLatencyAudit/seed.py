from pathlib import Path
import sqlite3,json,uuid
out=Path('artifacts/system-latency/read-fixture');out.mkdir(parents=True,exist_ok=True)
sourceRoot=Path(Path('artifacts/lifecycle-hardening/last-filing-root.txt').read_text().strip()).resolve();
if not sourceRoot.is_relative_to(Path('artifacts').resolve()) or not (sourceRoot/'AUDIT-ONLY').is_file():raise RuntimeError('Not a disposable fixture')
a=sqlite3.connect(sourceRoot/'fixture.db');db=sqlite3.connect(out/'torrentflow.db');a.backup(db);a.close();db.row_factory=sqlite3.Row;db.execute('pragma foreign_keys=off')
def row(t):return dict(db.execute('select * from "'+t+'" limit 1').fetchone())
def put(t,r):db.execute('insert into "'+t+'" ('+','.join('"'+k+'"' for k in r)+') values ('+','.join('?' for _ in r)+')',list(r.values()))
base={t:row(t) for t in ['Release','Download','Target','DownloadTarget','DownloadFile','MediaFile','Episode']}
for i in range(600):
 h=f'{i+1:040x}';d=f'perf-download-{i}';t=f'perf-target-{i}';e=f'perf-episode-{i}';m=f'perf-media-{i}';p=str((out/f'payload-{i}.mkv').resolve())
 put('Release',dict(base['Release'],hash=h));put('Download',dict(base['Download'],id=d,hash=h,admissionToken=uuid.uuid4().hex));put('Episode',dict(base['Episode'],id=e,number=i+100))
 put('Target',dict(base['Target'],id=t,chosenReleaseHash=h,episodeId=e));put('DownloadTarget',dict(base['DownloadTarget'],id=f'perf-link-{i}',downloadId=d,targetId=t))
 put('MediaFile',dict(base['MediaFile'],id=m,path=p,physicalKey=p.lower(),downloadId=d,episodeId=e));put('DownloadFile',dict(base['DownloadFile'],id=f'perf-file-{i}',downloadId=d,targetId=t,mediaFileId=m,enginePath=p,finalPath=p))
for i in range(5000):put('Release',dict(base['Release'],hash=f'{i+100000:040x}'))
cols={r[1]:None for r in db.execute('pragma table_info(Attempt)')};print('Attempt columns',list(cols));now=base['Target']['createdAt']
for i in range(10000):
 r=dict(cols,id=f'perf-attempt-{i}',targetId='target-s1-e1',workId='scorpion-generated',kind='plan',startedAt=now,endedAt=now,outcome='planned',actorUserId='local');k=next(k for k in cols if k.startswith('legacyContext'));r[k]=json.dumps({'audit':'x'*8192});put('Attempt',r)
db.commit();db.close();print('Seeded 614 rows, 5601 releases, 10000 history attempts; generated only')
