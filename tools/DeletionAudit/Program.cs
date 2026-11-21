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

var root = Path.GetFullPath(Path.Combine("artifacts", "deletion-audit", Guid.NewGuid().ToString("N")));
if (!root.StartsWith(Path.GetFullPath("artifacts") + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new Exception("Unsafe fixture root");
Directory.CreateDirectory(root);
await File.WriteAllTextAsync(Path.Combine(root, "AUDIT-ONLY"), "Generated files only; no installed data or real media.");
using var lifetime = new CancellationTokenSource(TimeSpan.FromMinutes(3));
var ct = lifetime.Token;
var kept = args.Contains("--kept");
var subset = args.Contains("--subset") || kept;
var partialFailure = args.Contains("--partial");
var independent = args.Contains("--independent") || partialFailure;
await using var swarm = new Swarm(root, count: independent ? 15 : 1, fileMiB: 1, filesPerPack: independent ? 1 : subset ? 16 : 14);
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
EngineSnapshot? before = null;
var connectUntil = Stopwatch.StartNew();
while (connectUntil.Elapsed < TimeSpan.FromSeconds(25))
{
    swarm.Connect();
    before = (await swarm.Engine.SnapshotAsync(ct)).SingleOrDefault(s=>s.Hash==pack.Hash);
    if (before?.CompletedSelectedBytes > 0 && !before.Complete) break;
    await Task.Delay(150,ct);
}
if (before?.CompletedSelectedBytes is not > 0 || before.Complete) throw new Exception("Fixture did not establish a real active unfinished transfer");
if (args.Contains("--prepare-ui"))
{
    Console.WriteLine(JsonSerializer.Serialize(new {scenario="ui-fixture",root,database=Path.Combine(root,"fixture.db"),pack.Hash},json));
    return;
}
var apiType = Assembly.Load("TorrentFlow").GetType("TorrentFlow.Api.DownloadsApi")!;
var actionType = Assembly.Load("TorrentFlow").GetType("TorrentFlow.Api.DownloadEndpoints+DownloadAction")!;
var api = Activator.CreateInstance(apiType, pipeline,null!,swarm.Engine,factory,new ConfigurationBuilder().Build(),
    new ReleaseParser(2027),provider.GetRequiredService<IStorageStatus>())!;
var action = apiType.GetMethod("ActionAsync",BindingFlags.Instance|BindingFlags.NonPublic)!;
var builder = WebApplication.CreateBuilder(new WebApplicationOptions { Args=[],ContentRootPath=root });
builder.WebHost.UseUrls("http://127.0.0.1:0");
builder.Logging.SetMinimumLevel(LogLevel.Warning);
await using var host = builder.Build();
object? observed = null;
host.MapPost("/api/client/torrents", async (HttpContext http) =>
{
    using var measurement = new DeletionMeasurement();
    try
    {
        var body = await JsonSerializer.DeserializeAsync(http.Request.Body,actionType,json,http.RequestAborted);
        var task = (Task)action.Invoke(api,[body,http.RequestAborted])!;
        await task;
        return Results.Json(task.GetType().GetProperty("Result")!.GetValue(task),json);
    }
    finally { observed = new { measurement.OperationId, measurement.ElapsedMilliseconds,
        counters=measurement.Counters.ToDictionary(p=>p.Key,p=>p.Value) }; }
});
await host.StartAsync(ct);
using var client = new HttpClient { BaseAddress=new Uri(host.Urls.Single()),Timeout=TimeSpan.FromMinutes(2) };
var selected = independent
    ? swarm.Packs.Take(14).Select(p => (Pack:p, Index:0)).ToArray()
    : Enumerable.Range(0,14).Select(i => (Pack:pack, Index:i)).ToArray();
// A malformed final selector must not remove the earlier valid selection.
foreach (var invalid in new object[] {
    new { action="delete", deleteFiles=true, transferIds=new[] {$"builtin:{pack.Hash}:target-s1-e1", $"builtin:{pack.Hash}:STALE-target"} },
    new { action="delete", deleteFiles=true, confirmCurrentFiles=true, transferIds=new[] {$"builtin:{pack.Hash}:target-s1-e1"} }
})
{
    using var measurement = new DeletionMeasurement();
    var body = JsonSerializer.Deserialize(JsonSerializer.Serialize(invalid,json),actionType,json);
    try { await (Task)action.Invoke(api,[body,ct])!; throw new Exception("Invalid deletion was accepted"); }
    catch (ArgumentException) { }
    if (measurement.Counters.GetValueOrDefault("drainCalls") != 0)
        throw new Exception("Validation mutated the engine before rejecting the request");
    await using var unchanged = await factory.CreateDbContextAsync(ct);
    if (await unchanged.Targets.AnyAsync(t=>t.State==TargetState.Removed,ct))
        throw new Exception("Invalid final selector removed an earlier target");
}
var requestTimer = Stopwatch.StartNew();
var locked = args.Contains("--locked");
if (partialFailure)
{
    var second = swarm.Packs[1];
    Directory.CreateDirectory(Path.GetDirectoryName(second.Paths[0])!);
    await using (var pin = new FileStream(second.Paths[0],FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
    {
        await pin.WriteAsync("LOCKED-SECOND-DOWNLOAD"u8.ToArray(),ct); await pin.FlushAsync(ct);
        var partial = await client.PostAsJsonAsync("/api/client/torrents",new { action="delete",deleteFiles=true,
            transferIds=selected.Select(i=>$"builtin:{i.Pack.Hash}").ToArray() },ct);
        var body = JsonDocument.Parse(await partial.Content.ReadAsStringAsync(ct)).RootElement;
        if (body.GetProperty("ok").GetBoolean() || body.GetProperty("resolvedTransferIds").GetArrayLength()!=1 ||
            body.GetProperty("resolvedTransferIds")[0].GetString()!=$"builtin:{pack.Hash}")
            throw new Exception("Partial batch did not report the one completed download accurately");
        await using var partialDb = await factory.CreateDbContextAsync(ct);
        if (await partialDb.Downloads.AnyAsync(d=>d.Id==pack.Id,ct) ||
            !await partialDb.Targets.AnyAsync(t=>t.Id=="target-s2-e1" && t.ReasonCode==WaitReason.RemovalIncomplete,ct))
            throw new Exception("Earlier success or later failure was not durable");
    }
}
if (locked)
{
    await swarm.Engine.SaveDevStateAsync(ct);
    var staleState = await File.ReadAllBytesAsync(Path.Combine(root,"leecher","engine","dev-engine.state"),ct);
    Directory.CreateDirectory(Path.GetDirectoryName(pack.Paths[13])!);
    await using (var pin = new FileStream(pack.Paths[13],FileMode.OpenOrCreate,FileAccess.ReadWrite,FileShare.None))
    {
        await pin.WriteAsync("LOCKED-OWNER-FILE"u8.ToArray(),ct);
        await pin.FlushAsync(ct);
        var failed = await client.PostAsJsonAsync("/api/client/torrents",new { action="delete",deleteFiles=true,
            transferIds=selected.Select(i=>$"builtin:{i.Pack.Hash}:target-s{i.Pack.Season}-e{i.Index+1}").ToArray() },ct);
        var failureBody = JsonDocument.Parse(await failed.Content.ReadAsStringAsync(ct)).RootElement;
        if (failureBody.GetProperty("ok").GetBoolean()) throw new Exception("Locked file deletion unexpectedly succeeded");
        await using var heldDb = await factory.CreateDbContextAsync(ct);
        if (await heldDb.Targets.CountAsync(t=>t.ReasonCode==WaitReason.RemovalIncomplete,ct) != 14 ||
            await heldDb.Targets.AnyAsync(t=>t.State==TargetState.Removed,ct))
            throw new Exception("Failed deletion hid selected records instead of holding them");
        foreach (var command in new[] {TargetAction.TryNow,TargetAction.DownloadNow,TargetAction.Resume,TargetAction.Remove})
        {
            try { await pipeline.ActionAsync("target-s1-e14",command,ct); throw new Exception("Ordinary action cleared interrupted-removal fence"); }
            catch (InvalidOperationException) { }
        }
        var stateType = Assembly.Load("TorrentFlow").GetType("TorrentFlow.Api.EngineModule+FilingFileState")!;
        var state = (IEngineFileState)Activator.CreateInstance(stateType,provider.GetRequiredService<IServiceScopeFactory>())!;
        var restartRoot = Path.Combine(root,"restart"); Directory.CreateDirectory(Path.Combine(restartRoot,"engine"));
        await File.WriteAllBytesAsync(Path.Combine(restartRoot,"engine","dev-engine.state"),staleState,ct);
        await using var restart = new TorrentFlow.Engine.MonoTorrentEngine(restartRoot,_=>{},fileState:state);
        var config = SettingsCatalog.Read<EngineSettings>(await heldDb.Settings.AsNoTracking().SingleAsync(s=>s.Id=="engine",ct)) with {ListenPort=0};
        await restart.InitializeAsync(config,(_,_)=>Task.CompletedTask,true,ct);
        await restart.RecoverAsync([.. await heldDb.Downloads.AsNoTracking().ToListAsync(ct)],
            [.. await heldDb.DownloadFiles.AsNoTracking().ToListAsync(ct)],ct);
        if (!(await restart.SnapshotAsync(ct)).IsEmpty) throw new Exception("Restart replayed an interrupted removal");
    }
    var retryOne = await client.PostAsJsonAsync("/api/client/torrents",new { action="delete",deleteFiles=true,
        transferIds=new[] {$"builtin:{pack.Hash}:target-s1-e14"} },ct);
    if (!retryOne.IsSuccessStatusCode) throw new Exception("Single failed member could not be retried");
    await using var retryDb = await factory.CreateDbContextAsync(ct);
    if (await retryDb.Targets.CountAsync(t=>t.ReasonCode==WaitReason.RemovalIncomplete,ct)!=13 ||
        !(await swarm.Engine.SnapshotAsync(ct)).IsEmpty)
        throw new Exception("Retrying one member revived another interrupted deletion");
}
if (kept)
{
    await swarm.Engine.SetIntentAsync(pack.Id,false,ct);
    foreach (var index in new[] {14,15})
    {
        await pipeline.ActionAsync($"target-s1-e{index+1}",TargetAction.Remove,ct);
        Directory.CreateDirectory(Path.GetDirectoryName(pack.Paths[index])!);
        await File.WriteAllTextAsync(pack.Paths[index],"KEPT-OWNER-FILE",ct);
    }
    using var replay = new DeletionMeasurement();
    var replayBody = JsonSerializer.Deserialize(JsonSerializer.Serialize(new {action="delete",deleteFiles=true,
        transferIds=new[] {$"builtin:{pack.Hash}:target-s1-e16"}},json),actionType,json);
    await (Task)action.Invoke(api,[replayBody,ct])!;
    if (replay.Counters.GetValueOrDefault("drainCalls")!=0 ||
        await File.ReadAllTextAsync(pack.Paths[15],ct)!="KEPT-OWNER-FILE")
        throw new Exception("A removed-target replay touched kept files or live siblings");
}
var response = await client.PostAsJsonAsync("/api/client/torrents", new { action="delete",deleteFiles=true,
    hashes=args.Contains("--overlap") || kept ? new[] {pack.Hash.ToUpperInvariant()} : Array.Empty<string>(),
    transferIds=selected.Where(i=>!locked || i.Index!=13).Select(i=>$"builtin:{i.Pack.Hash}:target-s{i.Pack.Season}-e{i.Index+1}")
        .Concat(new[] {$"builtin:{pack.Hash.ToUpperInvariant()}:target-s1-e1"}).ToArray() },ct);
var reply = await response.Content.ReadAsStringAsync(ct);
requestTimer.Stop();
if (!response.IsSuccessStatusCode || !JsonDocument.Parse(reply).RootElement.GetProperty("ok").GetBoolean())
    throw new Exception($"Delete HTTP {(int)response.StatusCode}: {reply}");
var measured = JsonSerializer.SerializeToElement(observed,json).GetProperty("counters");
var drains = measured.GetProperty("drainCalls").GetInt64();
var recoveries = measured.TryGetProperty("recoverCalls",out var recovered) ? recovered.GetInt64() : 0;
if (drains != (independent ? partialFailure ? 13 : 14 : 1) || recoveries != (subset && !kept ? 1 : 0))
    throw new Exception($"Batch regression: drains={drains}, recoveries={recoveries}");
await using var check = await factory.CreateDbContextAsync(ct);
var remainingPayload = selected.Count(i=>File.Exists(i.Pack.Paths[i.Index]));
var remainingDownloads = await check.Downloads.CountAsync(ct);
var remainingBindings = await check.DownloadFiles.CountAsync(ct);
var removedTargets = await check.Targets.CountAsync(t=>t.State==TargetState.Removed,ct);
if (remainingPayload!=0 || remainingDownloads!=(subset || independent ? 1 : 0) || remainingBindings!=(subset ? 16 : independent ? 1 : 0) || removedTargets!=(kept ? 16 : 14))
    throw new Exception($"Physical/metadata outcome mismatch: files{remainingPayload}, downloads{remainingDownloads}, bindings{remainingBindings}, removed{removedTargets}");
if (kept)
{
    foreach (var index in new[] {14,15})
        if (await File.ReadAllTextAsync(pack.Paths[index],ct) != "KEPT-OWNER-FILE")
            throw new Exception("Previously kept file was changed or deleted");
}
if (subset && !kept)
{
    await swarm.Accelerate();
    var finish = Stopwatch.StartNew();
    while (finish.Elapsed < TimeSpan.FromSeconds(30))
    {
        swarm.Connect();
        var live = (await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash);
        if (live.Complete) break;
        await Task.Delay(150,ct);
    }
    foreach (var index in new[] {14,15})
    {
        using var file = File.OpenRead(pack.Paths[index]);
        if (Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(file)) != pack.Digests[index])
            throw new Exception("Surviving cross-piece sibling did not complete correctly");
    }
    if (selected.Any(i=>File.Exists(i.Pack.Paths[i.Index]))) throw new Exception("Deleted public paths were recreated by recovery");
}
var result = new { scenario=independent ? "14-independent-torrents" : subset ? "14-episode-subset-of-16-pack" : "14-episode-active-pack-full-delete", passed=true, realLoopback=true,
    transferredBefore=before.CompletedSelectedBytes, before.SelectedBytes, requestMs=requestTimer.Elapsed.TotalMilliseconds,
    remainingPayload,remainingDownloads,remainingBindings,removedTargets,measurement=observed,
    limitations="Generated small allocated fixture. Endpoint shim invokes released DownloadsApi.ActionAsync over HTTP; authorization rendering not covered. Not physical disk throughput." };
Console.WriteLine(JsonSerializer.Serialize(result,json));
await File.WriteAllTextAsync(Path.Combine(root,"result.json"),JsonSerializer.Serialize(result,json),ct);
await host.StopAsync(ct);

// Separate completed-file profile: no claim of constant-time legacy verification.
var completed = Path.Combine(root,"legacy-completed.mkv");
await File.WriteAllBytesAsync(completed,System.Security.Cryptography.RandomNumberGenerator.GetBytes(2*1024*1024),ct);
var digest = await TorrentFlow.Library.DownloadFiling.DigestAsync(completed,ct);
using (var measurement = new DeletionMeasurement())
{
    var media = new MediaFileRow { Id="media",WorkId="generated",Path=completed,PhysicalKey=LibraryPaths.PhysicalKey(completed),
        Role=FileRole.Video,Bytes=2*1024*1024,MtimeUtc=File.GetLastWriteTimeUtc(completed),Tracks=[],Origin=MediaOrigin.Downloaded,
        DownloadId="completed",FileIndex=0,AddedAt=DateTimeOffset.UtcNow,Status=FilePresence.Present,ContentDigest=digest,Version=1 };
    var binding = new DownloadFileRow { Id="binding",DownloadId="completed",FileIndex=0,Selected=true,Role=FileRole.Video,
        ExpectedBytes=media.Bytes,FinalPath=completed,EnginePath=completed,Filed=true,MediaFileId=media.Id };
    await TorrentFlow.Library.DownloadFiling.DeletePayloadAsync([binding],root,new string('a',40),[media],ct);
    Console.WriteLine(JsonSerializer.Serialize(new { scenario="legacy-completed-file-verification",passed=!File.Exists(completed),
        measurement.Counters,measurement.ElapsedMilliseconds },json));
    // Preserve the release's last content verification before unlink. A path-only
    // digest cache would widen the replacement window while other files hash.
    if (measurement.Counters.GetValueOrDefault("shaCalls") != 2)
        throw new Exception("Historical final-path verification was bypassed");
}
