using System.Reflection;
using System.Security.Cryptography;
using MonoTorrent;
using MonoTorrent.BEncoding;
using MonoTorrent.Client;
using MonoTorrent.PieceWriter;
using ReusableTasks;

if (!OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("This check uses Windows file sharing.");
var noCache = args.Contains("--no-cache");
if (args.Contains("--loopback"))
{
    await Loopback.RunAsync(noCache ? 0 : 32 * 1024 * 1024);
    return;
}
var failWrite = args.Contains("--write-failure");
if (failWrite && !noCache) throw new ArgumentException("Use --no-cache for the write-error check.");
var root = Path.GetFullPath(Path.Combine("artifacts", "cache-drain-audit", Guid.NewGuid().ToString("N")));
Directory.CreateDirectory(root);
var content = RandomNumberGenerator.GetBytes(16 * 1024);
var fileLength = content.Length / 2;
var files = new BEncodedList();
foreach (var name in new[] { "first.partial", "second.partial" })
{
    files.Add(new BEncodedDictionary { ["length"] = new BEncodedNumber(fileLength), ["path"] = new BEncodedList { new BEncodedString(name) } });
    await File.WriteAllBytesAsync(Path.Combine(root, name), new byte[fileLength]);
}
var info = new BEncodedDictionary { ["name"] = new BEncodedString("generated"), ["files"] = files, ["private"] = new BEncodedNumber(1),
    ["piece length"] = new BEncodedNumber(content.Length), ["pieces"] = new BEncodedString(SHA1.HashData(content)) };
var torrent = Torrent.Load(new BEncodedDictionary { ["info"] = info }.Encode());
GatedWriter writer = null!;
IBlockCache cache = null!;
var factories = Factories.Default
    .WithPieceWriterCreator(limit => writer = new(Factories.Default.CreatePieceWriter(limit), failWrite))
    .WithBlockCacheCreator((pieceWriter, capacity, policy, pool) =>
        cache = Factories.Default.CreateBlockCache(pieceWriter, capacity, policy, pool));
var settings = new EngineSettingsBuilder { CacheDirectory = Path.Combine(root, "cache"), ListenEndPoints = [],
    DhtEndPoint = null, AllowLocalPeerDiscovery = false, AllowPortForwarding = false,
    AutoSaveLoadDhtCache = false, AutoSaveLoadFastResume = false, UsePartialFiles = false,
    DiskCacheBytes = noCache ? 0 : content.Length * 2, DiskCachePolicy = CachePolicy.WritesOnly }.ToSettings();
using var engine = new ClientEngine(settings, factories);
var manager = await engine.AddAsync(torrent, root, new TorrentSettingsBuilder { CreateContainingDirectory = false,
    AllowDht = false, AllowPeerExchange = false }.ToSettings());
if (manager.Files.Count != 2 || manager.Files[0].Length != fileLength) throw new Exception("Invalid two-file torrent");
writer.First = manager.Files[0];
var secondPath = manager.Files[1].FullPath;
await engine.DiskManager.FlushAsync(manager); // Capture the library's own serialized I/O context.
var diskContext = writer.Context ?? throw new Exception("Missing disk I/O context");
var timeout = TimeSpan.FromSeconds(15);
Task OnDisk(Func<Task> operation)
{
    var completed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    diskContext.Post(async _ =>
    {
        try { await operation(); completed.TrySetResult(); }
        catch (Exception ex) { completed.TrySetException(ex); }
    }, null);
    return completed.Task.WaitAsync(timeout);
}

var block = new BlockInfo(0, 0, content.Length);
// Exercise precisely the pinned StoppingMode disk close without peer or tracker timing.
var close = typeof(DiskManager).GetMethod("CloseFilesAsync", BindingFlags.NonPublic | BindingFlags.Instance)!;
Task CloseFiles() => ((Task)close.Invoke(engine.DiskManager, [manager])!).WaitAsync(timeout);
var write = OnDisk(async () => await cache.WriteAsync(manager, block, content, preferSkipCache: false));
if (noCache)
{
    await writer.FirstWritten.Task.WaitAsync(timeout);
    await OnDisk(async () =>
    {
        if (cache.CacheUsed != 0 || await cache.ReadFromCacheAsync(manager, block, new byte[content.Length]))
            throw new Exception("An unwritten block was visible through the disabled cache");
    });
    if (write.IsCompleted) throw new Exception("Cross-file write returned before the second file");
    writer.ReleaseFirst.TrySetResult();
    if (failWrite)
    {
        try { await write; throw new Exception("Write unexpectedly succeeded"); }
        catch (IOException ex) when (ex.Message == GatedWriter.Error) { }
    }
    else await write;
    await CloseFiles();
    await engine.RemoveAsync(manager, RemoveMode.KeepAllData);
    if (engine.DiskManager.OpenFiles != 0) throw new Exception("Handoff retained streams");
    foreach (var file in manager.Files)
        using (File.Open(file.FullPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
    if (!failWrite) await VerifyContent();
    Console.WriteLine(failWrite ? "PASS write surfaced the injected disk error, without cached data or retained handles." :
        "PASS stock zero-capacity write waited for both files. After close and removal both paths are exclusively accessible and all 16 KiB match.");
    return;
}
await write;
Task ReadFromCache() => OnDisk(async () =>
{
    var fromCache = new byte[content.Length];
    if (!await cache.ReadFromCacheAsync(manager, block, fromCache) || !content.SequenceEqual(fromCache))
        throw new Exception("Expected a complete, correct cache hit");
});
var firstRead = ReadFromCache();
await writer.FirstWritten.Task.WaitAsync(timeout);
var secondRead = ReadFromCache();
await Task.WhenAll(firstRead, secondRead).WaitAsync(timeout);
if (writer.SecondWritten.Task.IsCompleted)
    throw new Exception("Cache did not return the block ahead of the cross-file write");

await CloseFiles();
if (engine.DiskManager.OpenFiles != 0) throw new Exception("Initial close left an open stream");
using (File.Open(secondPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None)) { }
writer.ReleaseFirst.TrySetResult();
await writer.SecondWritten.Task.WaitAsync(timeout);
await engine.DiskManager.FlushAsync(manager);
if (engine.DiskManager.OpenFiles != 1) throw new Exception("The late write did not reopen exactly one stream");
await engine.RemoveAsync(manager, RemoveMode.KeepAllData);
try
{
    using var unexpected = File.OpenRead(secondPath);
    throw new Exception("Expected the same read-sharing conflict as filing");
}
catch (IOException ex) when ((uint)ex.HResult == 0x80070020u) { }
await OnDisk(async () => await writer.CloseAsync(manager.Files[1]));
await VerifyContent();
Console.WriteLine("PASS pinned cache returned a valid two-file block with disk work pending. Stop's real close reached zero handles; a late write reopened one. After manager removal File.OpenRead returned 0x80070020. Final close released it and all 16 KiB match.");

async Task VerifyContent()
{
    var first = await File.ReadAllBytesAsync(writer.First.FullPath);
    var second = await File.ReadAllBytesAsync(secondPath);
    if (!first.Concat(second).SequenceEqual(content)) throw new Exception("Post-close bytes differ from the source");
}

sealed class GatedWriter(IPieceWriter inner, bool failWrite) : IPieceWriter
{
    public const string Error = "Injected write failure on second file";
    public ITorrentManagerFile First { get; set; } = null!;
    public SynchronizationContext? Context { get; private set; }
    public TaskCompletionSource FirstWritten { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource ReleaseFirst { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public TaskCompletionSource SecondWritten { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    public int OpenFiles => inner.OpenFiles;
    public int MaximumOpenFiles => inner.MaximumOpenFiles;
    public async ReusableTask WriteAsync(ITorrentManagerFile file, long offset, ReadOnlyMemory<byte> buffer)
    {
        if (failWrite && !ReferenceEquals(file, First)) throw new IOException(Error);
        await inner.WriteAsync(file, offset, buffer);
        if (ReferenceEquals(file, First))
        {
            FirstWritten.TrySetResult();
            await ReleaseFirst.Task;
        }
        else SecondWritten.TrySetResult();
    }
    public ReusableTask FlushAsync(ITorrentManagerFile file)
    {
        Context ??= SynchronizationContext.Current;
        return inner.FlushAsync(file);
    }
    public ReusableTask CloseAsync(ITorrentManagerFile file) => inner.CloseAsync(file);
    public ReusableTask<bool> ExistsAsync(ITorrentManagerFile file) => inner.ExistsAsync(file);
    public ReusableTask MoveAsync(ITorrentManagerFile file, string newPath, bool overwrite) => inner.MoveAsync(file, newPath, overwrite);
    public ReusableTask<int> ReadAsync(ITorrentManagerFile file, long offset, Memory<byte> buffer) => inner.ReadAsync(file, offset, buffer);
    public ReusableTask SetMaximumOpenFilesAsync(int count) => inner.SetMaximumOpenFilesAsync(count);
    public void Dispose() => inner.Dispose();
}
