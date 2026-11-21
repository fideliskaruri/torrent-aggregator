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
await swarm.Accelerate();
EngineSnapshot? state=null;
while(!ct.IsCancellationRequested){
 swarm.Connect(); state=(await swarm.Engine.SnapshotAsync(ct)).Single(s=>s.Hash==pack.Hash);
 if(state.Complete) break;
 await Task.Delay(100,ct);
}
Console.WriteLine($"Completed {state!.CompletedSelectedBytes} bytes");
var drain=await swarm.Engine.StopAndReleaseFilesAsync(pack.Id,ct);
if(!drain.WritesDrained || drain.Failure!=null)throw new Exception("Drain failed");
foreach(var path in pack.Paths){
 using(var s=File.OpenRead(path)){if(s.ReadByte()<0)throw new Exception("Empty");}
 File.Move(path,path+".final");
 await TorrentFlow.Library.DownloadFiling.DigestAsync(path+".final",ct);
}
Console.WriteLine("PASS: completed engine files readable, renameable and digestible after drain");
