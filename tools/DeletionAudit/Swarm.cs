// Adapted generated loopback fixture from existing Delete20Audit; product code is the released baseline.
using System.Collections.Immutable;
using System.Net;
using System.Reflection;
using System.Security.Cryptography;
using MonoTorrent;
using MonoTorrent.BEncoding;
using MonoTorrent.Client;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Store;

sealed class Swarm : IAsyncDisposable {
    public MonoTorrentEngine Engine { get; }
    public ClientEngine Physical { get; private set; } = null!;
    private ClientEngine seed = null!;
    public List<Pack> Packs { get; } = []; public object RepeatedLogs()=>logs.Where(p=>p.Value>1).Select(p=>new{message=p.Key,count=p.Value}).ToArray();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string,int> logs=new(); private readonly string root; private readonly int count; private readonly bool single; private readonly int fileMiB; private readonly int filesPerPack;
    private readonly byte[]? sampleVideo; private readonly bool v2;
    public Swarm(string directory,int count=4,bool single=false,int fileMiB=8,int filesPerPack=14,string? samplePath=null,bool v2=false) { this.v2=v2; root = directory; this.count=count;this.single=single;this.fileMiB=fileMiB; this.filesPerPack=filesPerPack; sampleVideo=samplePath is null?null:File.ReadAllBytes(samplePath); Engine = new(Path.Combine(root, "leecher"),message=>{if(logs.Count<256){var repeats=logs.AddOrUpdate(message,1,(_,n)=>n+1);if(repeats==1)Console.WriteLine(message);}}); }
    public async Task Initialize(TorrentFlow.Domain.EngineSettings settings, TorrentFlowDbContext db, CancellationToken ct) {
        await Engine.InitializeAsync(settings, (_, _) => Task.CompletedTask, false, ct);
        Physical = (ClientEngine)typeof(MonoTorrentEngine).GetField("client", BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(Engine)!;
        await Rate(32 * 1024);
        seed = new ClientEngine(new EngineSettingsBuilder { CacheDirectory = Path.Combine(root,"seed-cache"), ListenEndPoints = new() { ["ipv4"] = new(IPAddress.Loopback,3989) }, DhtEndPoint = null,
            AllowLocalPeerDiscovery=false, AllowPortForwarding=false, AutoSaveLoadDhtCache=false, AutoSaveLoadFastResume=false, UsePartialFiles=false, MaximumUploadRate=64*1024 }.ToSettings());
        for (var season=1; season<=count; season++) await Add(season, db, ct);
        await db.SaveChangesAsync(ct);
    }
    public Task Rate(int rate) => Physical.UpdateSettingsAsync(new EngineSettingsBuilder(Physical.Settings) { ListenEndPoints=new() { ["ipv4"]=new(IPAddress.Loopback,Engine.ListenPort) }, MaximumDownloadRate=rate }.ToSettings());
    public async Task Accelerate() { await Rate(8*1024*1024); await seed.UpdateSettingsAsync(new EngineSettingsBuilder(seed.Settings) { MaximumUploadRate=8*1024*1024 }.ToSettings()); }
    public void Connect() {
        var loop=typeof(ClientEngine).GetField("MainLoop",BindingFlags.Static|BindingFlags.Public|BindingFlags.NonPublic)!.GetValue(null)!;
        var add=typeof(TorrentManager).GetMethod("AddPeers",BindingFlags.Instance|BindingFlags.NonPublic)!;
        foreach(var pack in Packs) {
            var manager=Physical.Torrents.FirstOrDefault(m=>m.InfoHashes.V1OrV2.ToHex().Equals(pack.Hash,StringComparison.OrdinalIgnoreCase)); if(manager is null)continue;
            Action action=()=>add.Invoke(manager,[new[]{new PeerInfo(new Uri("ipv4://127.0.0.1:3989"))},manager.InfoHashes.V1OrV2,false,true]);
            loop.GetType().GetMethod("QueueWait",[typeof(Action)])!.Invoke(loop,[action]);
        }
    }
    public string[] VerifyAvailable() {
        var verified=new List<string>();
        foreach(var p in Packs) foreach(var i in new[]{0,2}) {
            if(!File.Exists(p.Paths[i]) || new FileInfo(p.Paths[i]).Length != p.Lengths[i])continue;
            using var stream=File.Open(p.Paths[i],FileMode.Open,FileAccess.Read,FileShare.ReadWrite);
            if(Convert.ToHexString(SHA256.HashData(stream)) == p.Digests[i]) verified.Add($"S{p.Season:00}E{i+1:00}");
        }
        return verified.ToArray();
    }
    private async Task Add(int season,TorrentFlowDbContext db,CancellationToken ct) {
        int[] lengths=Enumerable.Range(0,filesPerPack).Select(i=>(sampleVideo?.Length??fileMiB*1024*1024)+137+97*i).ToArray();
        var data=new byte[lengths.Sum()]; RandomNumberGenerator.Fill(data); var headerOffset=0; foreach(var length in lengths){
            if(sampleVideo is not null) {
                sampleVideo.CopyTo(data,headerOffset);
                System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(data.AsSpan(headerOffset+sampleVideo.Length,4),length-sampleVideo.Length);
                "free"u8.CopyTo(data.AsSpan(headerOffset+sampleVideo.Length+4));
            } else {
                System.Buffers.Binary.BinaryPrimitives.WriteInt32BigEndian(data.AsSpan(headerOffset,4),length);"ftypisom"u8.CopyTo(data.AsSpan(headerOffset+4));
            }
            headerOffset+=length;
        }
        var pieces=new byte[((data.Length+16383)/16384)*20];
        for(var at=0;at<data.Length;at+=16384)SHA1.HashData(data.AsSpan(at,Math.Min(16384,data.Length-at))).CopyTo(pieces,at/16384*20);
        var names=Enumerable.Range(1,lengths.Length).Select(i=>$"Scorpion.S{season:00}E{i:00}.GENERATED.1080p.mkv").ToArray();
        var files=new BEncodedList(); for(var i=0;i<lengths.Length;i++)files.Add(new BEncodedDictionary { ["length"]=new BEncodedNumber(lengths[i]),["path"]=new BEncodedList { new BEncodedString(names[i]) } });
        var bytes=new BEncodedDictionary { ["info"]=new BEncodedDictionary { ["name"]=new BEncodedString($"Scorpion.S{season:00}.GENERATED.private.audit"),["files"]=files,["piece length"]=new BEncodedNumber(16384),["pieces"]=new BEncodedString(pieces),["private"]=new BEncodedNumber(1) } }.Encode();
        var torrent=Torrent.Load(bytes); var hash=torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        var seedDir=Path.Combine(root,$"seed-{season}");Directory.CreateDirectory(seedDir);
        var paths=names.Select(n=>Path.Combine(root,"library",$"payload-{season}",n)).ToArray();var digests=new string[lengths.Length];var offset=0;
        for(var i=0;i<lengths.Length;i++) {var content=data.AsMemory(offset,lengths[i]).ToArray();offset+=lengths[i];await File.WriteAllBytesAsync(Path.Combine(seedDir,names[i]),content,ct);digests[i]=Convert.ToHexString(SHA256.HashData(content));}
        if(v2) {
            var creator=new TorrentCreator(TorrentType.V2Only) { PieceLength=65536 };
            var dictionary=await creator.CreateAsync(new TorrentFileSource(seedDir));
            ((BEncodedDictionary)dictionary["info"])["private"]=new BEncodedNumber(1);
            bytes=dictionary.Encode();torrent=Torrent.Load(bytes);hash=torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        }
        var seeder=await seed.AddAsync(torrent,seedDir,new TorrentSettingsBuilder { AllowDht=false,AllowPeerExchange=false,AllowInitialSeeding=false,CreateContainingDirectory=false }.ToSettings());
        await seeder.StartAsync();while(seeder.State!=TorrentState.Seeding)await Task.Delay(100,ct);
        var now=DateTimeOffset.UtcNow;var id=$"targets:frontend-pack-{season}";var token=Guid.NewGuid().ToString("N");
        var release=new ReleaseRow { Id=hash,Name=$"Scorpion.S{season:00}.GENERATED.1080p.WEB.private.audit",Parsed=new("Scorpion","Scorpion",null,[season],[],[],[],false,false,null,new(1080,"WEB",null,null),null,[],false,false,false),FirstSeenAt=now,LastSeenAt=now,TotalBytes=data.Length,
            Files=[..names.Select((n,i)=>new TorrentFlow.Domain.TorrentFile(i,n,lengths[i],lengths.Take(i).Sum()))] };
        var download=new DownloadRow { Id=id,Hash=hash,Intent=DownloadIntent.Queued,RootId="audit-root",AddedAt=now,AdmissionToken=token,Version=1 };
        db.Releases.Add(release);db.Downloads.Add(download);
        db.Seasons.Add(new SeasonRow { Id=$"season-{season}",WorkId="scorpion-generated",Number=season,MappingStatus=MappingStatus.Confirmed,CreatedAt=now,UpdatedAt=now,Version=1 });
        for(var i=0;i<lengths.Length;i++) {
            string? target=true?$"target-s{season}-e{i+1}":null;
            db.Episodes.Add(new EpisodeRow { Id=$"episode-s{season}-e{i+1}",SeasonId=$"season-{season}",Number=i+1,AirPrecision=DatePrecision.Unknown,MappingStatus=MappingStatus.Confirmed,CreatedAt=now,UpdatedAt=now,Version=1 });
            if(target!=null) {
                db.Targets.Add(new TargetRow { Id=target,WorkId="scorpion-generated",EpisodeId=$"episode-s{season}-e{i+1}",Kind=TargetKind.Acquire,State=TargetState.Fetching,ChosenReleaseHash=hash,CreatedBy="local",Origin=IntentOrigin.Owner,DownloadNow=false,SubstantiveMisses=0,CreatedAt=now,UpdatedAt=now,Version=1 });
                db.DownloadTargets.Add(new DownloadTargetRow { Id=$"link-{target}",DownloadId=id,TargetId=target,Role=AssociationRole.Current,CreatedAt=now });
            }
            db.DownloadFiles.Add(new DownloadFileRow { Id=$"file-{season}-{i}",DownloadId=id,TargetId=target,FileIndex=i,Selected=target!=null,Role=target!=null?FileRole.Video:FileRole.Unwanted,ExpectedBytes=lengths[i],EnginePath=paths[i],PartialPath=paths[i],FinalPath=paths[i]+".planned-final",Filed=false });
        }
        await Engine.PrepareExternalAsync(bytes,hash,ct);if(season<=2 || !single){var claim=await Engine.ClaimAdmissionAsync(new(token,hash,id,null,now.AddMinutes(1)),ct);if(!claim.Accepted)throw new Exception(claim.Failure?.Message);
        var admitted=await Engine.AdmitExternalAsync(new(download,new(release,[],null),[..paths.Select((p,i)=>new FileBinding(i,p,true,Path.Combine(root,"library")))],token),ct);if(!admitted.Accepted)throw new Exception(admitted.Failure?.Message);}
        Packs.Add(new(season,id,hash,paths,digests,lengths));
    }
    public async ValueTask DisposeAsync() { await Engine.DisposeAsync(); seed?.Dispose(); }
}
sealed record Pack(int Season,string Id,string Hash,string[] Paths,string[] Digests,int[] Lengths);
