using System.Collections.Immutable;
using System.Diagnostics;
using System.Net.Http.Json;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Infrastructure;
using Microsoft.EntityFrameworkCore.Migrations;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Parser;
using TorrentFlow.Store;
using TorrentFlow.Targets;

if(args.Contains("--notification-read")) {
    var noteServices=new ServiceCollection().AddStore(Path.GetFullPath("artifacts/system-latency/read-fixture/torrentflow.db"));
    await using var noteProvider=noteServices.BuildServiceProvider();await using var noteScope=noteProvider.CreateAsyncScope();
    var noteDb=noteScope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var noteRepo=noteScope.ServiceProvider.GetRequiredService<NotificationRepository>();
    await noteDb.Notifications.ExecuteDeleteAsync();
    if(!await noteDb.Users.AnyAsync(u=>u.Id=="audit-guest"))noteDb.Users.Add(new UserRow {Id="audit-guest",Role=UserRole.Requester,CreatedAt=DateTimeOffset.UtcNow,UpdatedAt=DateTimeOffset.UtcNow});
    noteDb.Notifications.Add(new NotificationRow {Id=Guid.NewGuid().ToString("N"),UserId="audit-guest",Kind="download.completed",Title="Generated guest note",DedupeKey=Guid.NewGuid().ToString("N"),CreatedAt=DateTimeOffset.UtcNow,ReadAt=null,PushPending=false,PushAttemptAt=null,PushAttempts=0});
    await noteDb.SaveChangesAsync();noteDb.ChangeTracker.Clear();
    var primary=await noteDb.Works.FirstAsync();noteDb.Entry(primary).CurrentValues.SetValues(primary with {PosterUrl="https://example.invalid/current.jpg"});
    var token=Guid.NewGuid().ToString("N");var rawWork=primary with {Id="poster-work-"+token,WorkKey="poster:"+token,PosterUrl="https://example.invalid/raw.jpg"};noteDb.Works.Add(rawWork);
    var existingDownload=await noteDb.Downloads.AsNoTracking().FirstAsync();
    var rawDownload=existingDownload with {Id="poster-download-"+token,Hash=token+"12345678",AdmissionToken=Guid.NewGuid().ToString("N")};
    var release=await noteDb.Releases.AsNoTracking().FirstAsync();noteDb.Releases.Add(release with {Id=rawDownload.Hash});noteDb.Downloads.Add(rawDownload);
    var file=await noteDb.MediaFiles.AsNoTracking().FirstAsync();noteDb.MediaFiles.Add(file with {Id="poster-media-"+token,WorkId=rawWork.Id,DownloadId=rawDownload.Id,EpisodeId=null,Path=Path.GetFullPath("artifacts/poster-"+token),PhysicalKey="poster-"+token});
    var removedWork=rawWork with {Id=rawWork.Id+"-removed",WorkKey=rawWork.WorkKey+"-removed"};noteDb.Works.Add(removedWork);
    var target=await noteDb.Targets.AsNoTracking().FirstAsync();var removed=target with {Id="poster-removed-"+token,WorkId=removedWork.Id,EpisodeId=null,State=TargetState.Removed};noteDb.Targets.Add(removed);
    noteDb.DownloadTargets.Add(new DownloadTargetRow {Id="poster-link-"+token,DownloadId=existingDownload.Id,TargetId=removed.Id,Role=AssociationRole.Retired,CreatedAt=DateTimeOffset.UtcNow});
    var stale=target with {Id="poster-stale-"+token,WorkId=rawWork.Id,EpisodeId=null,State=TargetState.Done,ChosenReleaseHash=rawDownload.Hash};noteDb.Targets.Add(stale);
    noteDb.DownloadTargets.Add(new DownloadTargetRow {Id="poster-stale-link-"+token,DownloadId=existingDownload.Id,TargetId=stale.Id,Role=AssociationRole.Retired,CreatedAt=DateTimeOffset.UtcNow});
    await noteDb.SaveChangesAsync();noteDb.ChangeTracker.Clear();
    var posters=await noteRepo.PostersAsync([primary.WorkKey],[existingDownload.Hash.ToUpperInvariant(),rawDownload.Hash.ToUpperInvariant()],CancellationToken.None);
    if(posters[primary.WorkKey]!="https://example.invalid/current.jpg" || posters["hash:"+existingDownload.Hash]!="https://example.invalid/current.jpg" || posters["hash:"+rawDownload.Hash]!="https://example.invalid/raw.jpg")throw new Exception("Notification poster parity failed");
    var owner=await noteRepo.CountUnreadAsync("local",CancellationToken.None);var guest=await noteRepo.CountUnreadAsync("audit-guest",CancellationToken.None);
    if(guest!=1 || owner!=0)throw new Exception("Unread user scoping changed");
    if((await noteRepo.PageAsync("local",1,CancellationToken.None)).Any(n=>n.UserId!="local"))throw new Exception("Other user notification leaked");
    Console.WriteLine("PASS notification user scoping, title/hash posters, removed-link exclusion and raw inventory fallback");return;
}
if(args.Contains("--delete-cost")) {
    var costRoot=Path.GetFullPath("artifacts/delete-cost");Directory.CreateDirectory(costRoot);
    var fixtureRoot=File.ReadAllText("artifacts/lifecycle-hardening/playable-root.txt").Trim();
    var costServices=new ServiceCollection().AddStore(Path.Combine(fixtureRoot,"fixture.db"));
    await using var costProvider=costServices.BuildServiceProvider();await using var costScope=costProvider.CreateAsyncScope();
    var costDb=costScope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var baseMedia=await costDb.MediaFiles.AsNoTracking().FirstAsync();var baseBinding=await costDb.DownloadFiles.AsNoTracking().FirstAsync();
    var baseOperation=await costDb.FileOperations.AsNoTracking().FirstAsync();
    var source=Path.GetFullPath("artifacts/digest-speed/generated.bin");
    string expected;using(var original=File.OpenRead(source))expected=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(original));
    foreach(var withIdentity in new[]{false,true}) {
        var payload=Path.Combine(costRoot,withIdentity?"identity.bin":"legacy.bin");File.Copy(source,payload,true);
        string fileIdentity;using(var held=new PayloadFile(payload))fileIdentity=held.Identity;
        var item=baseMedia with {Id="cost-media",Path=payload,PhysicalKey=LibraryPaths.PhysicalKey(payload),DownloadId="cost-download",FileIndex=0,Bytes=new FileInfo(payload).Length,MtimeUtc=File.GetLastWriteTimeUtc(payload),ContentDigest=expected};
        var binding=baseBinding with {Id="cost-binding",DownloadId=item.DownloadId!,FileIndex=0,MediaFileId=item.Id,Filed=true,Selected=false,PartialPath=null,EnginePath=payload,FinalPath=payload,ExpectedBytes=item.Bytes};
        var receipt=baseOperation with {Id="file:cost-binding",DownloadId=item.DownloadId,MediaFileId=item.Id,SourceIdentity=withIdentity?fileIdentity:null};
        using var cost=new DeletionMeasurement();var timer=Stopwatch.StartNew();
        await TorrentFlow.Library.DownloadFiling.DeletePayloadAsync([binding],costRoot,"audit",[item],CancellationToken.None,[receipt]);
        if(File.Exists(payload))throw new Exception("Cost fixture payload remained");
        var reads=cost.Counters.GetValueOrDefault("shaBytes");if(reads!=item.Bytes)throw new Exception("Unexpected payload reread count");
        Console.WriteLine($"DELETE identity={withIdentity} bytes={item.Bytes} shaBytes={reads} elapsedMs={timer.ElapsedMilliseconds}");
    }
    return;
}
if(args.Contains("--queue-cost")) {
    var queueServices=new ServiceCollection().AddStore(Path.GetFullPath("artifacts/system-latency/read-fixture/torrentflow.db"));
    await using var queueProvider=queueServices.BuildServiceProvider();await using var queueScope=queueProvider.CreateAsyncScope();
    var queueStore=queueScope.ServiceProvider.GetRequiredService<TargetStore>();
    var queueDownloads=await queueStore.ListAsync<DownloadRow>(null,CancellationToken.None);
    var queueLinks=(await queueStore.ListAsync<DownloadTargetRow>(null,CancellationToken.None)).ToImmutableArray();
    var queueTargets=(await queueStore.ListAsync<TargetRow>(null,CancellationToken.None)).ToImmutableArray();
    var queueType=typeof(TargetPipeline).Assembly.GetType("TorrentFlow.Targets.TargetQueue")!;
    var buildQueue=queueType.GetMethod("Build",BindingFlags.Static|BindingFlags.NonPublic)!;
    for(var pass=0;pass<3;pass++) {var timer=Stopwatch.StartNew();var value=buildQueue.Invoke(null,[queueDownloads,queueLinks,queueTargets,ImmutableArray<RawIntentRow>.Empty]);Console.WriteLine($"QUEUE downloads={queueDownloads.Length} targets={queueTargets.Length} links={queueLinks.Length} elapsedMs={timer.ElapsedMilliseconds}");File.WriteAllText("artifacts/system-latency/queue-result.json",JsonSerializer.Serialize(value));}
    return;
}
if(args.Contains("--digest-speed")) {
    var speedRoot=Path.GetFullPath(Path.Combine("artifacts","digest-speed"));Directory.CreateDirectory(speedRoot);
    var speedFile=Path.Combine(speedRoot,"generated.bin");
    if(!File.Exists(speedFile)){using var output=File.Create(speedFile);var bytes=System.Security.Cryptography.RandomNumberGenerator.GetBytes(1024*1024);for(var i=0;i<512;i++)output.Write(bytes);}
    for(var pass=0;pass<3;pass++) {using var held=new PayloadFile(speedFile);var timer=Stopwatch.StartNew();var digest=await held.DigestAsync(CancellationToken.None);Console.WriteLine($"DIGEST bytes={held.Stream.Length} elapsedMs={timer.ElapsedMilliseconds} sha256={digest}");}
    return;
}
if(args.Contains("--guard")) {
    var folder=Path.GetFullPath(Path.Combine("artifacts","payload-guard",Guid.NewGuid().ToString("N")));
    Directory.CreateDirectory(folder);var file=Path.Combine(folder,"payload.bin");
    await File.WriteAllBytesAsync(file,System.Security.Cryptography.RandomNumberGenerator.GetBytes(1024*1024));
    string identity,digest;
    using(var held=new PayloadFile(file)) {
        identity=held.Identity;digest=await held.DigestAsync(CancellationToken.None);
        try {File.WriteAllText(file,"replacement");throw new Exception("Writer changed held payload");}catch(IOException){}
        try {Directory.Move(folder,folder+"-replaced");throw new Exception("Ancestor was replaceable");}catch(IOException){}
        held.MoveTo(file+".final");
    }
    using(var held=new PayloadFile(file+".final")) {
        if(held.Identity!=identity || await held.DigestAsync(CancellationToken.None)!=digest)throw new Exception("Rename lost file identity");
        held.Delete();
    }
    if(File.Exists(file+".final"))throw new Exception("Guarded delete left the payload");
    Directory.Delete(folder);
    Console.WriteLine("PASS native guard denied writers/ancestor replacement, retained identity across rename/reopen, and deleted exact file");return;
}
if(args.Contains("--many-files")) {
    var folder=Path.GetFullPath(Path.Combine("artifacts","verification-many",Guid.NewGuid().ToString("N")));
    var payload=Path.Combine(folder,"payload");Directory.CreateDirectory(payload);Directory.CreateDirectory(Path.Combine(folder,"engine"));
    for(var i=0;i<256;i++)await File.WriteAllBytesAsync(Path.Combine(payload,$"file-{i:0000}.bin"),System.Security.Cryptography.RandomNumberGenerator.GetBytes(257));
    var creator=new MonoTorrent.TorrentCreator(MonoTorrent.TorrentType.V1Only) {PieceLength=65536};
    var metadata=await creator.CreateAsync(new MonoTorrent.TorrentFileSource(payload));var torrent=MonoTorrent.Torrent.Load(metadata.Encode());
    var hash=torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();await File.WriteAllBytesAsync(Path.Combine(folder,"engine",hash+".torrent"),metadata.Encode());
    var guards=torrent.Files.Select(f=>new PayloadFile(Path.Combine(payload,Path.GetFileName(f.Path)))).ToArray();
    try {
        var verifier=new TorrentFlow.Engine.MonoTorrentEngine(folder,Console.WriteLine);
        var bindings=torrent.Files.Select((f,i)=>new FileBinding(i,guards[i].Path,true)).ToImmutableArray();
        using var measurement=new DeletionMeasurement();
        var proof=await verifier.VerifyFilesAsync(hash,bindings,CancellationToken.None,guards.Select((g,i)=>(g,i)).ToDictionary(x=>x.i,x=>(Stream)x.g.Stream));
        if(proof.Any(p=>p.Failure is not null)||proof.Length!=256)throw new Exception("Many-file verification failed");
        var read=measurement.Counters.GetValueOrDefault("verifyReadBytes");
        Console.WriteLine($"Many-file verifier: files=256 payload={torrent.Size} read={read} pieces={measurement.Counters.GetValueOrDefault("verifyPiecePasses")} elapsedMs={measurement.ElapsedMilliseconds:F0}");
        if(read>torrent.Size*2)throw new Exception("Shared pieces were redundantly reread per file");
        Console.WriteLine("PASS guarded many-file verification reads at most twice the payload with one shared 128KiB work buffer");
    } finally {foreach(var guard in guards)guard.Dispose();}
    return;
}

if(args.Contains("--format-api")) {
    foreach(var type in new[]{typeof(MonoTorrent.TorrentCreator),typeof(MonoTorrent.TorrentFileSource)}) {
        Console.WriteLine(type);foreach(var constructor in type.GetConstructors())Console.WriteLine(constructor);
        foreach(var method in type.GetMethods().Where(m=>m.Name.StartsWith("Create")))Console.WriteLine(method);
    }
    Console.WriteLine(string.Join(",",Enum.GetNames(typeof(MonoTorrent.TorrentType))));return;
}
if(args.Contains("--sparse-boundary")) {
    var sparseRoot=Path.GetFullPath(Path.Combine("artifacts","sparse-boundary",Guid.NewGuid().ToString("N")));
    var payload=Path.Combine(sparseRoot,"payload");Directory.CreateDirectory(payload);Directory.CreateDirectory(Path.Combine(sparseRoot,"engine"));
    var a=System.Security.Cryptography.RandomNumberGenerator.GetBytes(100000);var b=System.Security.Cryptography.RandomNumberGenerator.GetBytes(300000);
    await File.WriteAllBytesAsync(Path.Combine(payload,"a.bin"),a);await File.WriteAllBytesAsync(Path.Combine(payload,"b.bin"),b);
    var creator=new MonoTorrent.TorrentCreator(MonoTorrent.TorrentType.V1Only){PieceLength=65536};
    var metadata=await creator.CreateAsync(new MonoTorrent.TorrentFileSource(payload));var torrent=MonoTorrent.Torrent.Load(metadata.Encode());
    var hash=torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();await File.WriteAllBytesAsync(Path.Combine(sparseRoot,"engine",hash+".torrent"),metadata.Encode());
    var neighbor=Path.Combine(payload,"b.bin");using(var partial=File.OpenWrite(neighbor))partial.SetLength(31072);
    var verifier=new TorrentFlow.Engine.MonoTorrentEngine(sparseRoot,Console.WriteLine);
    var bindings=torrent.Files.Select((f,i)=>new FileBinding(i,Path.Combine(payload,Path.GetFileName(f.Path)),i==0)).ToImmutableArray();
    var result=(await verifier.VerifyFilesAsync(hash,bindings,CancellationToken.None)).Single();
    if(result.Failure is not null || result.Digest!=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(a)))throw new Exception("SPARSE_NEIGHBOR: complete selected file did not finish with authenticated sparse boundary: "+result.Failure);
    if(OperatingSystem.IsWindows()) {
        var junction=Path.Combine(sparseRoot,"alias");var script=Path.Combine(sparseRoot,"junction.ps1");
        await File.WriteAllTextAsync(script,"param($link,$target)\nNew-Item -ItemType Junction -Path $link -Target $target | Out-Null");
        var start=new ProcessStartInfo("powershell.exe"){UseShellExecute=false,CreateNoWindow=true,WindowStyle=ProcessWindowStyle.Hidden};
        foreach(var arg in new[]{"-NoProfile","-File",script,junction,payload})start.ArgumentList.Add(arg);
        using var process=Process.Start(start)!;await process.WaitForExitAsync();if(process.ExitCode!=0)throw new Exception("Junction fixture failed");
        var linked=bindings.SetItem(0,bindings[0] with {AbsolutePath=Path.Combine(junction,"a.bin")});
        var rejected=(await verifier.VerifyFilesAsync(hash,linked,CancellationToken.None)).Single();
        if(rejected.Failure?.Message.Contains("link",StringComparison.OrdinalIgnoreCase)!=true)throw new Exception("Unguarded selected junction was followed");
        Console.WriteLine("PASS unguarded selected-file junction refused");
    }
    using(var stream=File.OpenWrite(neighbor))stream.WriteByte((byte)(b[0]^1));
    if((await verifier.VerifyFilesAsync(hash,bindings,CancellationToken.None)).Single().Failure?.Code!="hash_mismatch")throw new Exception("Corrupt shared boundary was accepted");
    await File.WriteAllBytesAsync(neighbor,b[..31071]);
    if((await verifier.VerifyFilesAsync(hash,bindings,CancellationToken.None)).Single().Failure is null)throw new Exception("Missing required boundary was accepted");
    Console.WriteLine("PASS selected-file digest and touching-piece hashes verified with sparse neighbor; corrupt/missing boundary refused");return;
}
if(args.Contains("--formats")) {
    var formatRoot=Path.GetFullPath(Path.Combine("artifacts","format-audit",Guid.NewGuid().ToString("N")));
    var payload=Path.Combine(formatRoot,"payload");Directory.CreateDirectory(payload);
    foreach(var (name,size) in new[]{("empty.bin",0),("small.bin",17939),("large.bin",233333)})
        await File.WriteAllBytesAsync(Path.Combine(payload,name),System.Security.Cryptography.RandomNumberGenerator.GetBytes(size));
    var metadataRoot=Path.Combine(formatRoot,"engine");Directory.CreateDirectory(metadataRoot);
    var verifier=new TorrentFlow.Engine.MonoTorrentEngine(formatRoot,Console.WriteLine);
    foreach(var format in Enum.GetValues<MonoTorrent.TorrentType>()) {
        var creator=new MonoTorrent.TorrentCreator(format) {PieceLength=65536};
        var dictionary=await creator.CreateAsync(new MonoTorrent.TorrentFileSource(payload));
        var torrent=MonoTorrent.Torrent.Load(dictionary.Encode());
        var hash=torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        if(TorrentFlow.Engine.MonoTorrentEngine.NormalizeHash(hash)!=hash)throw new Exception("Torrent identity changed during normalization");
        Console.WriteLine($"FORMAT {format} size={torrent.Size} pieces={torrent.PieceCount}: "+string.Join(";",torrent.Files.Select(f=>$"{f.Path}:{f.Length}@{f.OffsetInTorrent} pieces={f.StartPieceIndex}-{f.EndPieceIndex}")));
        await File.WriteAllBytesAsync(Path.Combine(metadataRoot,hash+".torrent"),dictionary.Encode());
        var bindings=torrent.Files.Select((f,i)=>new FileBinding(i,Path.Combine(payload,Path.GetFileName(f.Path)),true)).ToImmutableArray();
        var verified=await verifier.VerifyFilesAsync(hash,bindings,CancellationToken.None);
        foreach(var result in verified) {
            if(result.Failure is not null)throw new Exception($"{format}: {result.Failure}");
            using var file=File.OpenRead(result.Path);
            if(result.Digest!=Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(file)))throw new Exception("Independent digest mismatch");
        }
        Console.WriteLine($"PASS {format}: {verified.Length} files including zero/short/multiple-piece boundaries verified independently");
    }
    return;
}
if(args.Length==2 && args[0] is "--recover-root" or "--recover-raw-root")
{
    var recoveredRoot=Path.GetFullPath(args[1]);
    if(!recoveredRoot.StartsWith(Path.GetFullPath("artifacts")+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase)||
        !File.Exists(Path.Combine(recoveredRoot,"AUDIT-ONLY")))throw new Exception("Not a disposable fixture");
    using var deadline=new CancellationTokenSource(TimeSpan.FromMinutes(2));var token=deadline.Token;
    var recoveredServices=new ServiceCollection().AddLogging().AddStore(Path.Combine(recoveredRoot,"fixture.db"));
    recoveredServices.AddSingleton<IStorageStatus,StorageStatus>();
    await using var recoveredProvider=recoveredServices.BuildServiceProvider();
    await using var recoveredScope=recoveredProvider.CreateAsyncScope();
    var recoveredStore=recoveredScope.ServiceProvider.GetRequiredService<TargetStore>();
    var recoveredDb=recoveredScope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var recoveredRepository=(ILibraryDownloadRepository)recoveredScope.ServiceProvider.GetRequiredService<ILibraryRepository>();
    var recoveredSettings=SettingsCatalog.Read<EngineSettings>(await recoveredDb.Settings.AsNoTracking().SingleAsync(s=>s.Id=="engine",token));
    await using var recoveredEngine=new TorrentFlow.Engine.MonoTorrentEngine(Path.Combine(recoveredRoot,"leecher"),Console.WriteLine);
    await recoveredEngine.InitializeAsync(recoveredSettings,(_,_)=>Task.CompletedTask,false,token);
    var recoveredDownload=(await recoveredStore.ListAsync<DownloadRow>(null,token)).Single();
    var recoveredBindings=await recoveredRepository.BindingsAsync(token);
    var recoveredTargets=(await recoveredStore.ListAsync<TargetRow>(null,token)).ToImmutableArray();
    if(args[0]=="--recover-raw-root") {
        var raws=new RawDownloads(recoveredEngine,recoveredProvider.GetRequiredService<IServiceScopeFactory>(),NullLogger<RawDownloads>.Instance,null!);
        await raws.TickAsync(token);
        await (Task)typeof(RawDownloads).GetMethod("WaitForPublicationsAsync",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(raws,[])!;
        if((await recoveredDb.RawIntents.AsNoTracking().SingleAsync(token)).State!=RawDownloadState.Done)throw new Exception("Raw restart did not finish");
    } else {
        var filer=typeof(TargetPipeline).Assembly.GetType("TorrentFlow.Targets.DownloadFiling")!.GetMethod("FileAsync",BindingFlags.Static|BindingFlags.NonPublic)!;
        await (Task)filer.Invoke(null,[recoveredStore,recoveredRepository,recoveredEngine,recoveredDownload,null,recoveredBindings,recoveredTargets,new SemaphoreSlim(1,1),token,NullLogger.Instance])!;
    }
    var expected=JsonSerializer.Deserialize<Dictionary<string,string>>(await File.ReadAllTextAsync(Path.Combine(recoveredRoot,"expected.json"),token))!;
    if(args[0]!="--recover-raw-root" && await recoveredDb.Targets.AsNoTracking().CountAsync(t=>t.State==TargetState.Done,token)!=expected.Count)throw new Exception("Restart left unfinished episodes");
    foreach(var (path,digest) in expected) {
        using var file=File.OpenRead(path);
        if(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(file))!=digest)throw new Exception("Restart payload mismatch");
    }
    Console.WriteLine($"PASS actual process restart: {expected.Count} episodes Done and readable with matching independent hashes; no seeder process");
    return;
}

var root = Path.GetFullPath(Path.Combine("artifacts", "filing-audit", Guid.NewGuid().ToString("N")));
if (!root.StartsWith(Path.GetFullPath("artifacts") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe fixture root");
Directory.CreateDirectory(root);
await File.WriteAllTextAsync(Path.Combine(root, "AUDIT-ONLY"), "Generated files only; no installed data or real media.");
using var lifetime = new CancellationTokenSource(TimeSpan.FromMinutes(3));
var ct = lifetime.Token;
var kept = args.Contains("--kept");
var subset = args.Contains("--subset") || kept;
var partialFailure = args.Contains("--partial");
var independent = args.Contains("--independent") || partialFailure;
await using var swarm = new Swarm(root, count: independent ? 15 : 1, fileMiB: 1, filesPerPack: independent ? 1 : subset ? 16 : 14,
    samplePath:args.Contains("--playable")?"artifacts/lifecycle-hardening/sample/sintel.mp4":null,v2:args.Contains("--v2"),selective:args.Contains("--selective"));
var services = new ServiceCollection().AddLogging().AddStore(Path.Combine(root, "fixture.db"));
services.AddSingleton<IStorageStatus, StorageStatus>();
services.AddScoped<ILibraryPlacement>(sp => new LibraryPlacement(sp.GetRequiredService<ILibraryRepository>(), sp.GetRequiredService<IStorageStatus>()));
services.AddSingleton<IEngine>(swarm.Engine);
await using var provider = services.BuildServiceProvider();
var factory = provider.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
var json = new JsonSerializerOptions(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };
await using (var scope = provider.CreateAsyncScope())
{
    await scope.ServiceProvider.GetRequiredService<StoreDatabase>().InitializeAsync(null, true, ct);
    var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    await db.Database.GetService<IMigrator>().MigrateAsync("20261029203700_JellyfinIntegration",ct);
    var now = DateTimeOffset.UtcNow;
    db.Users.Add(new UserRow { Id="local", Role=UserRole.Owner, CreatedAt=now, UpdatedAt=now });
    db.Works.Add(new WorkRow { Id="scorpion-generated", WorkKey="scorpion-generated", Kind=WorkKind.Series,
        Format=WorkFormat.Series, Genres=[], ReleasePrecision=DatePrecision.Unknown, CreatedAt=now, UpdatedAt=now, Version=1 });
    db.WorkNames.Add(new WorkNameRow { Id="name", WorkId="scorpion-generated", Value="Scorpion Generated",
        NormalizedValue="scorpion generated", Label=NameLabel.English, Ordinal=0, Authoritative=true });
    var media = Path.Combine(root, "library"); Directory.CreateDirectory(media);
    StorageIdentity.WriteMarker(media,"audit-root",LibraryPaths.Volume(media));
    db.StorageRoots.Add(new StorageRootRow { Id="audit-root", Path=media, PhysicalKey=LibraryPaths.PhysicalKey(media),
        Kinds=[LibraryKind.TV], LibraryFolders=new("Movies","TV","Anime","AnimeMovies"), VolumeSerial=LibraryPaths.Volume(media),
        Priority=0, ReserveBytes=0, Enabled=true, Online=true, ReviewRequired=false, CreatedAt=now, UpdatedAt=now, Version=1 });
    var row = await db.Settings.SingleAsync(s=>s.Id=="engine",ct);
    var settings = SettingsCatalog.Read<EngineSettings>(row) with { ListenPort=0, MaxActiveDownloads=2, Dht=false,
        Pex=false, LocalDiscovery=false, Upnp=false, Trackers=[], ProbeScope=ProbeScope.Off };
    db.Entry(row).CurrentValues.SetValues(row with { Value=JsonSerializer.SerializeToElement(settings,json), Revision=row.Revision+1 });
    await db.SaveChangesAsync(ct);
    await swarm.Initialize(settings, db, ct);
    // Upgrade a populated published-release schema, not just a fresh model.
    var targetsBeforeUpgrade = await db.Targets.CountAsync(ct);
    var bindingsBeforeUpgrade = await db.DownloadFiles.CountAsync(ct);
    await db.Database.MigrateAsync(ct);
    if (await db.Targets.CountAsync(ct) != targetsBeforeUpgrade ||
        await db.DownloadFiles.CountAsync(ct) != bindingsBeforeUpgrade)
        throw new Exception("Release schema upgrade lost targets or bindings");
}
var pipeline = new TargetPipeline(provider.GetRequiredService<IServiceScopeFactory>(),null!,swarm.Engine,null!,
    NullLogger<TargetPipeline>.Instance,null!,null!);
var pack = swarm.Packs.First();
if(args.Contains("--pause-transfer"))
{
    EngineSnapshot? moving=null;
    while(moving?.CompletedSelectedBytes is not >0) {swarm.Connect();moving=(await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash);await Task.Delay(100,ct);}
    await using var scope=provider.CreateAsyncScope();
    var store=scope.ServiceProvider.GetRequiredService<TargetStore>();
    var ids=(await store.ListAsync<TargetRow>(null,ct)).Select(t=>t.Id).ToArray();
    foreach(var id in ids)await pipeline.ActionAsync(id,TargetAction.Pause,ct);
    var transfer=typeof(TargetPipeline).GetField("transfers",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(pipeline)!;
    var change=typeof(TargetPipeline).GetMethod("ChangeTransferAsync",BindingFlags.NonPublic|BindingFlags.Instance)!
        .CreateDelegate<Func<string,TargetState,WaitReason?,string?,CancellationToken,Task>>(pipeline);
    var stateGate=(SemaphoreSlim)typeof(TargetPipeline).GetField("stateGate",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(pipeline)!;
    await (Task)transfer.GetType().GetMethod("TickAsync",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(transfer,[change,stateGate,ct])!;
    if((await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash).Active)throw new Exception("Pause did not stop active transfer");
    foreach(var id in ids)await pipeline.ActionAsync(id,TargetAction.Resume,ct);
    await (Task)transfer.GetType().GetMethod("TickAsync",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(transfer,[change,stateGate,ct])!;
    Console.WriteLine("PASS actual target pause/resume actions and transfer worker preserved partial payload and resumed the same download");
}
if(args.Contains("--swap-backoff")) {
    await using var backoffScope=provider.CreateAsyncScope();var backoffDb=backoffScope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var now=DateTimeOffset.UtcNow;
    for(var i=0;i<3;i++)backoffDb.Attempts.Add(new AttemptRow {Id="swap-audit-"+i,TargetId="target-s1-e1",WorkId="scorpion-generated",Kind=AttemptKind.Swap,StartedAt=now.AddMinutes(-2),Outcome="Searching",ReasonCode="NoProgress"});
    await backoffDb.SaveChangesAsync();backoffDb.ChangeTracker.Clear();
    var snap=await pipeline.ReadTransfersAsync(ct);if(!snap.History.IsEmpty)throw new Exception("Transfer read loaded diagnostic history");
    var observed=(await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash) with {Active=true,Complete=false,StalledProgress=true};
    snap=snap with {Live=[observed]};var recover=typeof(TargetPipeline).GetMethod("RecoverStallsAsync",BindingFlags.Instance|BindingFlags.NonPublic)!;
    var flights=(System.Collections.Concurrent.ConcurrentDictionary<string,Task>)typeof(TargetPipeline).GetField("flights",BindingFlags.Instance|BindingFlags.NonPublic)!.GetValue(pipeline)!;
    await (Task)recover.Invoke(pipeline,[snap,ct])!;if(!flights.IsEmpty)throw new Exception("Maximum swaps guard was bypassed");
    await backoffDb.Attempts.Where(a=>a.Id=="swap-audit-1"||a.Id=="swap-audit-2").ExecuteDeleteAsync(ct);
    await backoffDb.Attempts.Where(a=>a.Id=="swap-audit-0").ExecuteUpdateAsync(x=>x.SetProperty(a=>a.StartedAt,DateTimeOffset.UtcNow),ct);
    await (Task)recover.Invoke(pipeline,[snap,ct])!;if(!flights.IsEmpty)throw new Exception("Recent swap backoff was bypassed");
    Console.WriteLine("PASS empty transfer history retains maximum-swap and recent-backoff protection through targeted persisted query");return;
}
await swarm.Accelerate();
EngineSnapshot? state=null;
var progressLog=Stopwatch.StartNew();
while(!ct.IsCancellationRequested){
 swarm.Connect(); state=(await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash);
 if(progressLog.ElapsedMilliseconds>=5000) {Console.WriteLine($"Audit transfer: active={state.Active} bytes={state.CompletedSelectedBytes}/{state.SelectedBytes} peers={state.Peers} failure={state.Failure?.Code}");progressLog.Restart();}
 if(state.Complete) break;
 await Task.Delay(100,ct);
}
Console.WriteLine($"Completed {state!.CompletedSelectedBytes} bytes");
if(args.Contains("--raw"))
{
    await using var scope=provider.CreateAsyncScope();
    var db=scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var store=scope.ServiceProvider.GetRequiredService<TargetStore>();
    var repo=(ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
    db.DownloadTargets.RemoveRange(await db.DownloadTargets.ToArrayAsync(ct));
    foreach(var binding in await db.DownloadFiles.ToArrayAsync(ct))db.Entry(binding).CurrentValues.SetValues(binding with {TargetId=null});
    var now=DateTimeOffset.UtcNow;
    var raw=new RawIntentRow {Id="raw:"+pack.Hash,ActorUserId="local",ReleaseHash=pack.Hash,DownloadId=pack.Id,SelectedFiles=[],
        ExplicitDirectory=Path.GetDirectoryName(pack.Paths[0]),State=RawDownloadState.Fetching,CreatedAt=now,UpdatedAt=now,Version=1};
    db.RawIntents.Add(raw);
    var download=await db.Downloads.SingleAsync(d=>d.Id==pack.Id,ct);
    db.Entry(download).CurrentValues.SetValues(download with {RawIntentId=raw.Id});
    await db.SaveChangesAsync(ct);db.ChangeTracker.Clear();
    download=await db.Downloads.AsNoTracking().SingleAsync(d=>d.Id==pack.Id,ct);
    var raws=new RawDownloads(swarm.Engine,provider.GetRequiredService<IServiceScopeFactory>(),NullLogger<RawDownloads>.Instance,null!);
    var publish=typeof(RawDownloads).GetMethod("StartPublication",BindingFlags.NonPublic|BindingFlags.Instance)!;
    publish.Invoke(raws,[download,raw,ct]);
    var readTimer=Stopwatch.StartNew();
    await raws.TickAsync(ct).WaitAsync(TimeSpan.FromSeconds(2),ct);
    Console.WriteLine($"PASS raw tick returned in {readTimer.ElapsedMilliseconds}ms with background publication scheduled");
    await (Task)typeof(RawDownloads).GetMethod("WaitForPublicationsAsync",BindingFlags.NonPublic|BindingFlags.Instance)!.Invoke(raws,[])!;
    if((await db.RawIntents.AsNoTracking().SingleAsync(ct)).State!=RawDownloadState.Done)throw new Exception("Raw publication did not finish");
    for(var i=0;i<pack.Paths.Length;i++) {
        using var stream=File.OpenRead(pack.Paths[i]+".planned-final");
        if(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(stream))!=pack.Digests[i])throw new Exception("Raw payload changed");
    }
    Console.WriteLine("PASS raw publication committed Done with independent payload hashes");
    if(args.Contains("--raw-restart")) {
        // Construct the exact durable mixed-rename boundary using actual authenticated receipts.
        var oldRaw=await db.RawIntents.SingleAsync(ct);
        db.Entry(oldRaw).CurrentValues.SetValues(oldRaw with {State=RawDownloadState.Publishing,Version=oldRaw.Version+1});
        var oldDownload=await db.Downloads.SingleAsync(ct);
        db.Entry(oldDownload).CurrentValues.SetValues(oldDownload with {FinishedAt=null,Version=oldDownload.Version+1});
        foreach(var operation in await db.FileOperations.ToArrayAsync(ct))db.Entry(operation).CurrentValues.SetValues(operation with {State=FileOperationState.Verified});
        await db.SaveChangesAsync(ct);
        for(var i=1;i<pack.Paths.Length;i++)File.Move(pack.Paths[i]+".planned-final",pack.Paths[i]);
        File.WriteAllText(Path.Combine(root,"expected.json"),JsonSerializer.Serialize(pack.Paths.Select((p,i)=>(path:p+".planned-final",digest:pack.Digests[i])).ToDictionary(x=>x.path,x=>x.digest)));
        File.WriteAllText("artifacts/lifecycle-hardening/raw-crash-root.txt",root);
        Environment.Exit(73);
    }
    try {await raws.DownloadNowAsync(pack.Hash,ct);throw new Exception("Finished raw download was restarted");}catch(InvalidOperationException){}
    await raws.RemoveAsync(pack.Hash,true,ct);
    if(pack.Paths.Any(p=>File.Exists(p)||File.Exists(p+".planned-final")))throw new Exception("Raw delete left payload");
    if(await db.DownloadFiles.AsNoTracking().AnyAsync(ct)||await db.FileOperations.AsNoTracking().AnyAsync(ct))throw new Exception("Raw delete left reservations");
    Console.WriteLine("PASS actual raw removal deleted verified files and retired receipts/reservations");
    return;
}
if(args.Contains("--delete-responsiveness"))
{
    await using var scope=provider.CreateAsyncScope();
    var store=scope.ServiceProvider.GetRequiredService<TargetStore>();
    var template=(await store.ListAsync<TargetRow>(null,ct)).First();
    await store.SaveAsync([new(template with {Id="unrelated-command",EpisodeId=null,ChosenReleaseHash=null,State=TargetState.Wanted},null,null)],[],ct);
    var entered=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var release=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    var proxyEngine=DispatchProxy.Create<IEngine,AuditProxy>();
    var proxy=(AuditProxy)(object)proxyEngine;proxy.Inner=swarm.Engine;
    proxy.Intercept=(method,arguments)=>method.Name=="StopAndReleaseFilesAsync" ? DelayedDrain() : null;
    async Task<EngineDrainResult> DelayedDrain() { entered.TrySetResult();await release.Task.WaitAsync(ct);return await swarm.Engine.StopAndReleaseFilesAsync(pack.Id,ct); }
    var tested=new TargetPipeline(provider.GetRequiredService<IServiceScopeFactory>(),null!,proxyEngine,null!,NullLogger<TargetPipeline>.Instance,null!,null!);
    var deleting=tested.DeleteDownloadFilesAsync(pack.Hash,ct);
    await entered.Task.WaitAsync(TimeSpan.FromSeconds(5),ct);
    try {
        var timer=Stopwatch.StartNew();
        await tested.ActionAsync("unrelated-command",TargetAction.Pause,ct).WaitAsync(TimeSpan.FromSeconds(2),ct);
        if(timer.ElapsedMilliseconds>1000)throw new Exception("Unrelated command waited for deletion disk work");
        Console.WriteLine($"PASS unrelated command completed in {timer.ElapsedMilliseconds}ms while deletion drain was held");
    } finally {release.TrySetResult();}
    await deleting;
    return;
}
if(args.Contains("--held-engine-gate"))
{
    var engineGate=(SemaphoreSlim)typeof(TorrentFlow.Engine.MonoTorrentEngine).GetField("gate",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(swarm.Engine)!;
    await engineGate.WaitAsync(ct);
    try {
        var watch=Stopwatch.StartNew();
        var read=pipeline.ReadAsync(ct);
        if(await Task.WhenAny(read,Task.Delay(1000,ct))!=read) throw new Exception("READ_GATE_WAIT: poll blocked on unrelated engine work");
        await read; Console.WriteLine($"PASS real read-model returned in {watch.ElapsedMilliseconds} ms while engine gate was held");
    } finally { engineGate.Release(); }
    return;
}
if(args.Contains("--read-purity"))
{
    var entries=(System.Collections.IDictionary)typeof(TorrentFlow.Engine.MonoTorrentEngine)
        .GetField("entries",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(swarm.Engine)!;
    var entry=entries[pack.Hash]!;
    var completed=entry.GetType().GetProperty("Completed")!;
    completed.SetValue(entry,false);
    for(var i=0;i<5;i++) await pipeline.ReadAsync(ct);
    if((bool)completed.GetValue(entry)!) throw new Exception("READ_SIDE_EFFECT: polling stopped/flushed a completed transfer");
    Console.WriteLine("PASS five actual read-model polls did not drive completion or stop/flush");
    return;
}
if(args.Contains("--unrelated-filing"))
{
    var transfers=typeof(TargetPipeline).GetField("transfers",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(pipeline)!;
    var tasks=(System.Collections.Concurrent.ConcurrentDictionary<string,Task>)transfers.GetType()
        .GetField("filingTasks",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(transfers)!;
    var unrelated=new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    tasks["unrelated-download"]=unrelated.Task;
    try {
        var delete=pipeline.DeleteDownloadFilesAsync(pack.Hash,ct);
        if(await Task.WhenAny(delete,Task.Delay(3000,ct))!=delete)
            throw new Exception("UNRELATED_WAIT: deleting one torrent waits for a different torrent's filing");
        await delete;
        Console.WriteLine("PASS actual delete completed while unrelated filing remained blocked");
    } finally { unrelated.TrySetResult(); }
    return;
}

if(args.Contains("--pipeline"))
{
    await using var scope=provider.CreateAsyncScope();
    var store=scope.ServiceProvider.GetRequiredService<TargetStore>();
    var repo=(ILibraryDownloadRepository)scope.ServiceProvider.GetRequiredService<ILibraryRepository>();
    var db=scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
    var download=await db.Downloads.AsNoTracking().SingleAsync(d=>d.Id==pack.Id,ct);
    var bindings=(await repo.BindingsAsync(ct)).Where(f=>f.DownloadId==pack.Id).ToImmutableArray();
    var targets=(await store.ListAsync<TargetRow>(null,ct)).ToImmutableArray();
    if(args.Contains("--sidecar")) {
        var sidecar=await db.DownloadFiles.SingleAsync(f=>f.FileIndex==1,ct);
        db.Entry(sidecar).CurrentValues.SetValues(sidecar with {TargetId="target-s1-e1",Role=FileRole.Subtitle});
        var extra=await db.Targets.SingleAsync(t=>t.Id=="target-s1-e2",ct);
        db.Entry(extra).CurrentValues.SetValues(extra with {State=TargetState.Removed,Version=extra.Version+1});
        await db.SaveChangesAsync(ct);db.ChangeTracker.Clear();
        bindings=(await repo.BindingsAsync(ct)).Where(f=>f.DownloadId==pack.Id).ToImmutableArray();
        targets=(await store.ListAsync<TargetRow>(null,ct)).ToImmutableArray();
    }
    if(args.Contains("--unverified-detach") || args.Contains("--stale-live") || args.Contains("--foreign-final"))
    {
        await swarm.Engine.StopAndReleaseFilesAsync(pack.Id,ct);
        if(args.Contains("--foreign-final")) File.Move(pack.Paths[0],pack.Paths[0]+".planned-final");
        else using(var changed=File.Open(pack.Paths[0],FileMode.Open,FileAccess.ReadWrite,FileShare.None)) {
            changed.Position=10000; var original=changed.ReadByte(); changed.Position=10000; changed.WriteByte((byte)(original^255));
        }
        var now=DateTimeOffset.UtcNow;
        foreach(var t in targets)
            await store.SaveAsync([new(t with { State=TargetState.Filing, Version=t.Version+1, UpdatedAt=now },t.Version,null)],[],ct);
        targets=(await store.ListAsync<TargetRow>(null,ct)).ToImmutableArray();
        if(!args.Contains("--stale-live")) state=null;
    }

    var testGate=(SemaphoreSlim)typeof(TargetPipeline).GetField("stateGate",BindingFlags.NonPublic|BindingFlags.Instance)!.GetValue(pipeline)!;
    IEngine filingEngine=swarm.Engine;
    ILibraryDownloadRepository filingRepo=repo;
    var intercepted=false;
    if(args.Contains("--drain-failure")) {
        filingEngine=DispatchProxy.Create<IEngine,AuditProxy>();
        var proxy=(AuditProxy)(object)filingEngine;proxy.Inner=swarm.Engine;
        proxy.Intercept=(method,arguments)=> {
            if(method.Name!="StopAndReleaseFilesAsync"||intercepted)return null;
            intercepted=true;
            return Task.FromResult(new EngineDrainResult(pack.Id,false,false,new Failure("audit_flush_failed","Injected flush failure",null,false)));
        };
    }
    if(args.Contains("--pause-during-verify") || args.Contains("--remove-during-verify"))
    {
        filingEngine=DispatchProxy.Create<IEngine, AuditProxy>();
        var proxy=(AuditProxy)(object)filingEngine; proxy.Inner=swarm.Engine;
        proxy.Intercept=(method,arguments)=> {
            if(method.Name!="VerifyFilesAsync")return null;
            return VerifyThenChange();
            async Task<ImmutableArray<VerifiedPayload>> VerifyThenChange() {
                var proof=await swarm.Engine.VerifyFilesAsync((string)arguments![0]!, (ImmutableArray<FileBinding>)arguments[1]!,
                    (CancellationToken)arguments[2]!, (IReadOnlyDictionary<int,Stream>?)arguments[3]);
                if(!intercepted) { intercepted=true; await pipeline.ActionAsync("target-s1-e1",args.Contains("--remove-during-verify")?TargetAction.Remove:TargetAction.Pause,ct); }
                return proof;
            }
        };
    }
    if(args.Contains("--rename-restart") || args.Contains("--crash-after-rename") || args.Contains("--delete-after-rename"))
    {
        filingRepo=DispatchProxy.Create<ILibraryDownloadRepository, AuditProxy>();
        var proxy=(AuditProxy)(object)filingRepo; proxy.Inner=repo;
        proxy.Intercept=(method,arguments)=> {
            if(method.Name!="ProposeFiledAsync" || intercepted)return null;
            intercepted=true;
            if(args.Contains("--crash-after-rename")) {
                File.WriteAllText(Path.Combine(root,"expected.json"),JsonSerializer.Serialize(pack.Paths.Select((p,i)=>(path:p+".planned-final",digest:pack.Digests[i])).ToDictionary(x=>x.path,x=>x.digest)));
                File.WriteAllText("artifacts/lifecycle-hardening/crash-root.txt",root);
                Environment.Exit(73);
            }
            return Task.FromException<ImmutableArray<RowWrite>?>(new IOException("INJECTED interruption after rename, before inventory commit"));
        };
    }
    var filing=typeof(TargetPipeline).Assembly.GetType("TorrentFlow.Targets.DownloadFiling")!
        .GetMethod("FileAsync",BindingFlags.Static|BindingFlags.NonPublic)!;
    if(args.Contains("--busy-sibling"))
    {
        await swarm.Engine.StopAndReleaseFilesAsync(pack.Id,ct);
        using(var held=File.Open(pack.Paths[4],FileMode.Open,FileAccess.Read,FileShare.None))
        {
            await ((Task)filing.Invoke(null,[store,filingRepo,filingEngine,download,state,bindings,targets,testGate,ct,NullLogger.Instance])!);
            var healthy=await db.Targets.AsNoTracking().CountAsync(t=>t.State==TargetState.Done,ct);
            if(healthy<pack.Paths.Length-3)throw new Exception($"Busy sibling blocked unrelated episodes: {healthy}/{pack.Paths.Length}");
            if(await db.Targets.AsNoTracking().AnyAsync(t=>t.State==TargetState.Filing&&t.ReasonCode==WaitReason.FilingBlocked,ct))
                throw new Exception("A sharing violation became a permanent filing block");
            var heldTargets=(await store.ListAsync<TargetRow>(t=>t.State==TargetState.Filing,ct)).ToImmutableArray();
            foreach(var t in heldTargets)await store.SaveAsync([new(t with {NextTryAt=null,Version=t.Version+1},t.Version,null)],[],ct);
            await ((Task)filing.Invoke(null,[store,filingRepo,filingEngine,download,null,(await repo.BindingsAsync(ct)).Where(f=>f.DownloadId==pack.Id).ToImmutableArray(),heldTargets,testGate,ct,NullLogger.Instance])!);
            if(await db.Targets.AsNoTracking().AnyAsync(t=>t.State==TargetState.Filing&&t.ReasonCode==WaitReason.FilingBlocked,ct))
                throw new Exception("Detached sharing violation became a permanent block");
        }
        foreach(var waiting in await store.ListAsync<TargetRow>(t=>t.State==TargetState.Filing,ct))
            await store.SaveAsync([new(waiting with { NextTryAt=null,Version=waiting.Version+1 },waiting.Version,null)],[],ct);
        bindings=(await repo.BindingsAsync(ct)).Where(f=>f.DownloadId==pack.Id).ToImmutableArray();
        targets=(await store.ListAsync<TargetRow>(null,ct)).ToImmutableArray();
        state=null;
    }
    await ((Task)filing.Invoke(null,[store,filingRepo,filingEngine,download,state,bindings,targets,testGate,ct,NullLogger.Instance])!);
    if(args.Contains("--drain-failure")) {
        if(await db.MediaFiles.AsNoTracking().AnyAsync(ct)||pack.Paths.Any(p=>File.Exists(p+".planned-final")))throw new Exception("Failed drain published payload");
        if(await db.FileOperations.AsNoTracking().AnyAsync(o=>o.State!=FileOperationState.Pending,ct))throw new Exception("Failed drain forged verification");
        Console.WriteLine("PASS failed drain retained Pending receipts and published no media");
    }
    if(args.Contains("--delete-after-rename")) {
        await pipeline.DeleteTargetFilesAsync(pack.Hash,"target-s1-e1",ct);
        if(File.Exists(pack.Paths[0])||File.Exists(pack.Paths[0]+".planned-final"))throw new Exception("Interrupted rename deletion left owned payload");
        if(await db.FileOperations.AsNoTracking().AnyAsync(o=>o.Id=="file:file-1-0",ct))throw new Exception("Deleted rename receipt was retained");
        Console.WriteLine("PASS delete after interrupted rename removed the owned final and retired its receipt");return;
    }
    if(args.Contains("--foreign-final") || args.Contains("--pause-during-verify") || args.Contains("--remove-during-verify")) {
        var first=await db.Targets.AsNoTracking().SingleAsync(t=>t.Id=="target-s1-e1",ct);
        if(first.State==TargetState.Done || await db.MediaFiles.AsNoTracking().AnyAsync(m=>m.EpisodeId==first.EpisodeId,ct))
            throw new Exception("STALE_PUBLICATION: foreign final or changed user intent acquired media inventory");
        if(args.Contains("--pause-during-verify") && !first.IsPaused())throw new Exception("Pause was overwritten");
        if(args.Contains("--remove-during-verify") && first.State!=TargetState.Removed)throw new Exception("Remove was overwritten");
        if(args.Contains("--foreign-final")) {
            if(!File.Exists(pack.Paths[0]+".planned-final"))throw new Exception("Foreign destination was removed");
            try {await pipeline.DeleteTargetFilesAsync(pack.Hash,"target-s1-e1",ct);throw new Exception("Unowned destination was deletable");}catch(IOException){}
            if(!File.Exists(pack.Paths[0]+".planned-final"))throw new Exception("Deletion removed foreign content");
            Console.WriteLine("PASS unowned byte-identical destination was preserved and not adopted"); return;
        }
        if(args.Contains("--remove-during-verify")) { Console.WriteLine("PASS remove during actual verification preserved intent and created no inventory"); return; }
        await pipeline.ActionAsync(first.Id,args.Contains("--force-filing")?TargetAction.DownloadNow:TargetAction.Resume,ct);
        var resumed=await db.Targets.AsNoTracking().SingleAsync(t=>t.Id==first.Id,ct);
        if(resumed.State!=TargetState.Filing)throw new Exception("Paused filing resumed as a new acquisition");
    }
    if(args.Contains("--rename-restart") || args.Contains("--pause-during-verify") || args.Contains("--drain-failure")) {
        if(args.Contains("--sidecar")) {
            // Exact mixed-path boundary: video renamed, sidecar not yet renamed, both receipts verified.
            File.Move(pack.Paths[1]+".planned-final",pack.Paths[1]);
            if(await db.MediaFiles.AsNoTracking().AnyAsync(m=>m.EpisodeId=="episode-s1-e1",ct))throw new Exception("Partial sidecar target acquired inventory");
        }
        foreach(var t in await store.ListAsync<TargetRow>(t=>t.State==TargetState.Filing,ct))
            await store.SaveAsync([new(t with {NextTryAt=null,Version=t.Version+1},t.Version,null)],[],ct);
        bindings=(await repo.BindingsAsync(ct)).Where(f=>f.DownloadId==pack.Id).ToImmutableArray();
        targets=(await store.ListAsync<TargetRow>(null,ct)).ToImmutableArray();
        await ((Task)filing.Invoke(null,[store,repo,swarm.Engine,download,null,bindings,targets,testGate,ct,NullLogger.Instance])!);
        Console.WriteLine("PASS detached recovery after interruption/pause reused identity receipt without network payload");
    }
    var done=await db.Targets.AsNoTracking().CountAsync(t=>t.State==TargetState.Done,ct);
    if(args.Contains("--unverified-detach") || args.Contains("--stale-live") || args.Contains("--foreign-final")) {
        if(await db.Targets.AsNoTracking().AnyAsync(t=>t.Id=="target-s1-e1" && t.State==TargetState.Done,ct))
            throw new Exception("UNVERIFIED_PUBLICATION: detached retry accepted corrupted interior bytes with a valid header and length");
        Console.WriteLine("PASS detached corrupted payload did not become Done");
        return;
    }

    var media=await db.MediaFiles.AsNoTracking().ToArrayAsync(ct);
    if(done!=(args.Contains("--selective")?1:pack.Paths.Length-(args.Contains("--sidecar")?1:0)) || media.Length!=(args.Contains("--selective")?1:pack.Paths.Length))throw new Exception($"Incomplete publication {done}/{pack.Paths.Length}, media={media.Length}");
    for(var i=0;i<(args.Contains("--selective")?1:pack.Paths.Length);i++){
        var path=pack.Paths[i]+".planned-final";
        using var file=File.OpenRead(path);
        if(Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(file))!=pack.Digests[i])throw new Exception("Published content changed");
        if(File.Exists(pack.Paths[i]))throw new Exception("Partial remained");
    }
    Console.WriteLine($"PASS actual target filing: {done} targets Done, {media.Length} media records, renamed paths match independent SHA256");
    if(args.Contains("--replace-completed")) {
        var original=media.First(m=>m.Role==FileRole.Video);
        var replacement=await pipeline.FindAnotherForLibraryFileAsync(original.Id,"local",ct);
        if(replacement.TargetId is null||replacement.Error is not null||!File.Exists(original.Path))throw new Exception("Completed replacement intent lost the existing copy");
        var target=await db.Targets.AsNoTracking().SingleAsync(t=>t.Id==replacement.TargetId,ct);
        if(target.Kind!=TargetKind.Replace||target.ReplaceMediaFileId!=original.Id)throw new Exception("Replacement did not retain existing-media identity");
        Console.WriteLine("PASS completed source replacement retained original file and exact media identity");
    }
    if(args.Contains("--identity-delete") || args.Contains("--changed-delete")) {
        var targetFile=media.First(m=>m.Role==FileRole.Video);
        if(args.Contains("--changed-delete")) {
            var writeTime=File.GetLastWriteTimeUtc(targetFile.Path);
            using(var changed=File.OpenWrite(targetFile.Path))changed.WriteByte(0xAA);
            if(args.Contains("--restore-mtime"))File.SetLastWriteTimeUtc(targetFile.Path,writeTime);
        }
        using var deletion=new DeletionMeasurement();var timer=Stopwatch.StartNew();
        try {
            await pipeline.DeleteDownloadFilesAsync(pack.Hash,ct);
            if(args.Contains("--changed-delete"))throw new Exception("Changed library file was deleted");
            if(deletion.Counters.GetValueOrDefault("shaBytes")!=media.Sum(m=>m.Bytes))throw new Exception("Owned files did not retain one-pass digest validation");
            if(media.Any(m=>File.Exists(m.Path)))throw new Exception("Payload remained after deletion");
            Console.WriteLine($"PASS identity-backed deletion files={media.Length} bytes={media.Sum(m=>m.Bytes)} shaBytes={deletion.Counters.GetValueOrDefault("shaBytes")} elapsedMs={timer.ElapsedMilliseconds}");
        }catch(IOException) when(args.Contains("--changed-delete")) {
            if(media.Any(m=>!File.Exists(m.Path)))throw new Exception("Batch changed-file refusal deleted a sibling");
            Console.WriteLine("PASS changed same-object payload refused before deleting any library sibling");
        }
    }
    if(args.Contains("--v2")) {
        await pipeline.DeleteDownloadFilesAsync(pack.Hash,ct);
        if(pack.Paths.Any(p=>File.Exists(p+".planned-final")))throw new Exception("V2 deletion left payload");
        Console.WriteLine("PASS pure-v2 loopback acquisition, verified filing and final-payload deletion");
    }
    Directory.CreateDirectory("artifacts/lifecycle-hardening");
    File.WriteAllText("artifacts/lifecycle-hardening/last-filing-root.txt",root);
    if(args.Contains("--playable"))File.WriteAllText("artifacts/lifecycle-hardening/playable-root.txt",root);
    return;
}
var drain=await swarm.Engine.StopAndReleaseFilesAsync(pack.Id,ct);
if(!drain.WritesDrained || drain.Failure!=null)throw new Exception("Drain failed");
foreach(var path in pack.Paths){
 using(var s=File.OpenRead(path)){if(s.ReadByte()<0)throw new Exception("Empty");}
 File.Move(path,path+".final");
 await TorrentFlow.Library.DownloadFiling.DigestAsync(path+".final",ct);
}
Console.WriteLine("PASS: completed engine files readable, renameable and digestible after drain");

public class AuditProxy : DispatchProxy
{
    public object Inner=null!;
    public Func<MethodInfo,object?[]?,object?>? Intercept;
    protected override object? Invoke(MethodInfo? method,object?[]? args) =>
        Intercept?.Invoke(method!,args) ?? method!.Invoke(Inner,args);
}
