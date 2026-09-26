using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using MonoTorrent;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Library;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Controllers;

namespace TorrentFlow.Engine.Settings;

public sealed record DownloadRecoveryResult(int Imported, int RestoredTorrents, int Skipped, int FailedTorrents = 0);

internal sealed class DownloadRecoveryService(
    IDbContextFactory<TorrentFlowDbContext> factory, ClientSettingsStore settings,
    IOptions<EngineOptions> options, TorrentEngineService engine, ILogger<DownloadRecoveryService> logger,
    ILibraryDownloadRecovery? library = null)
{
    internal const string ImportedMarker = "imported:local";
    internal const string SeedingMarker = "recovered:seed";
    internal const string ContainingDirectoryMarker = "recovered:client-container";
    internal static bool IsRecoveredTorrent(string? marker) => marker is SeedingMarker or ContainingDirectoryMarker;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private static StringComparer PathComparer => OperatingSystem.IsWindows() ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;

    public async Task<bool> HasMediaAsync(CancellationToken ct) =>
        SettingsDiskInventory.MediaFiles((await settings.GetConfigAsync(ct)).DownloadRoot, ct).Count > 0;

    public async Task<DownloadRecoveryResult> ImportAsync(CancellationToken ct)
    {
        await _gate.WaitAsync(ct);
        try
        {
            var config = await settings.GetConfigAsync(ct);
            var root = config.DownloadRoot;
            if (string.IsNullOrWhiteSpace(root)) throw new InvalidOperationException("Choose and save a download folder in Settings first.");
            root = Path.GetFullPath(root);
            var files = SettingsDiskInventory.MediaFiles(root, ct);
            await using var db = await factory.CreateDbContextAsync(ct);
            var rows = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id && r.Status != EngineTorrentStatus.Removed).ToListAsync(ct);
            var tracked = rows.SelectMany(TorrentEngineService.VerifiedFiles).Select(f => f.FullPath ?? (Path.IsPathRooted(f.Path) ? f.Path : null))
                .OfType<string>().Select(Path.GetFullPath).ToHashSet(PathComparer);
            foreach (var row in rows)
            {
                var live = await engine.GetAsync(row.Hash, ct);
                foreach (var file in live?.Files ?? [])
                    if (file.FullPath is { } path) tracked.Add(Path.GetFullPath(path));
            }
            bool Claimed(string path) => tracked.Contains(path) || rows.Any(r =>
                !string.IsNullOrWhiteSpace(r.SavePath) && !string.IsNullOrWhiteSpace(r.Name)
                && FoldersController.IsWithin(path, Path.GetFullPath(Path.Combine(r.SavePath, r.Name))));
            var available = files.Where(f => !Claimed(f.FullName)).ToList();
            var imported = 0;
            var restored = 0;
            var restoredFiles = 0;
            var failedTorrents = 0;
            // Both explicitly-added torrents and MonoTorrent's cached magnet metadata are recoverable.
            foreach (var folder in new[] { "torrents", "metadata" })
            {
                var metadataDir = Path.Combine(options.Value.EngineDirectory, folder);
                if (!Directory.Exists(metadataDir)) continue;
                foreach (var metadata in new DirectoryInfo(metadataDir).EnumerateFiles("*.torrent",
                    new EnumerationOptions { AttributesToSkip = FileAttributes.ReparsePoint }))
                {
                    ct.ThrowIfCancellationRequested();
                    try
                    {
                        var bytes = await File.ReadAllBytesAsync(metadata.FullName, ct);
                        var torrent = Torrent.Load(bytes);
                        var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
                        if (rows.Any(r => r.Hash == hash)) continue;
                        var match = MatchTorrent(torrent, available, root);
                        if (match is null) continue;
                        if (match.Value.Paths.Any(Claimed)) continue;
                        var row = NewRow(hash, torrent.Name, match.Value.Root, SeedingMarker);
                        row.SizeBytes = torrent.Size;
                        row.Status = "seeding";
                        row.VerifiedFilesJson = JsonSerializer.Serialize(match.Value.Paths.Select(path =>
                        {
                            var info = new FileInfo(path);
                            return new TorrentEngineService.ManifestFile(Path.GetRelativePath(match.Value.Root, path),
                                info.Length, new DateTimeOffset(info.LastWriteTimeUtc).ToUnixTimeMilliseconds(), path);
                        }), new JsonSerializerOptions(JsonSerializerDefaults.Web));
                        db.EngineTorrents.Add(row);
                        await db.SaveChangesAsync(ct);
                        rows.Add(row);
                        foreach (var path in match.Value.Paths) tracked.Add(path);
                        restoredFiles += available.RemoveAll(f => tracked.Contains(f.FullName));
                        if (await engine.RestoreForSeedingAsync(row.Hash, bytes, ct)) restored++;
                        else failedTorrents++;
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or TorrentException or FormatException or ArgumentException)
                    {
                        logger.LogWarning(ex, "Could not recover saved torrent metadata {File}", metadata.Name);
                    }
                }
            }
            foreach (var file in available)
            {
                ct.ThrowIfCancellationRequested();
                var path = Path.GetFullPath(file.FullName);
                var identity = OperatingSystem.IsWindows() ? path.ToUpperInvariant() : path;
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes("TorrentFlow imported file:" + identity)))[..40].ToLowerInvariant();
                if (await db.EngineTorrents.AnyAsync(r => r.UserId == LocalUser.Id && r.Hash == hash, ct)) continue;
                var size = file.Length;
                var modified = file.LastWriteTimeUtc;
                // Do not call an actively changing file complete, or follow a link swapped in after enumeration.
                file.Refresh();
                if (!file.Exists || file.Length != size || file.LastWriteTimeUtc != modified ||
                    file.Attributes.HasFlag(FileAttributes.ReparsePoint) || FoldersController.HasLinkBetween(root, path)) continue;
                var row = NewRow(hash, file.Name, file.DirectoryName!, ImportedMarker);
                row.Status = EngineTorrentStatus.Parked;
                row.Progress = 1;
                row.SizeBytes = size;
                row.VerifiedAt = DateTime.UtcNow;
                row.VerifiedFilesJson = JsonSerializer.Serialize(new[]
                {
                    new TorrentEngineService.ManifestFile(file.Name, size, new DateTimeOffset(modified).ToUnixTimeMilliseconds(), path),
                }, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                db.EngineTorrents.Add(row);
                await db.SaveChangesAsync(ct);
                imported++;
            }
            if (library is not null)
            {
                var recovered = await db.EngineTorrents.Where(r => r.UserId == LocalUser.Id
                    && (r.TorrentUrl == ImportedMarker || r.TorrentUrl == SeedingMarker) && r.Status != EngineTorrentStatus.Removed)
                    .Select(r => r.Hash).ToListAsync(ct);
                await library.RegisterAsync(recovered, ct);
            }
            return new(imported, restored, files.Count - imported - restoredFiles, failedTorrents);
        }
        finally { _gate.Release(); }
    }

    private static EngineTorrent NewRow(string hash, string name, string savePath, string marker)
    {
        var now = DateTime.UtcNow;
        return new EngineTorrent
        {
            Id = Ids.New(), UserId = LocalUser.Id, Hash = hash, Name = name, SavePath = savePath,
            TorrentUrl = marker, Origin = TorrentOrigin.User, Status = EngineTorrentStatus.Parked,
            CreatedAt = now, UpdatedAt = now, LastUsedAt = now,
        };
    }

    private static (string Root, List<string> Paths)? MatchTorrent(Torrent torrent, IReadOnlyList<FileInfo> available, string root)
    {
        foreach (var torrentFile in torrent.Files)
        {
            var relative = torrentFile.Path.Replace('/', Path.DirectorySeparatorChar);
            if (Path.IsPathRooted(relative) || relative.Split(Path.DirectorySeparatorChar).Contains("..")) return null;
            foreach (var candidate in available.Where(f => PathComparer.Equals(f.Name, Path.GetFileName(relative)) && f.Length == torrentFile.Length))
            {
                var folder = candidate.FullName;
                foreach (var _ in relative.Split(Path.DirectorySeparatorChar)) folder = Path.GetDirectoryName(folder)!;
                var paths = torrent.Files.Select(f => Path.GetFullPath(Path.Combine(folder, f.Path.Replace('/', Path.DirectorySeparatorChar)))).ToList();
                if (paths.Zip(torrent.Files).All(pair =>
                    FoldersController.IsWithin(pair.First, root) && !FoldersController.HasLinkBetween(root, pair.First)
                    && File.Exists(pair.First) && !File.GetAttributes(pair.First).HasFlag(FileAttributes.ReparsePoint)
                    && new FileInfo(pair.First).Length == pair.Second.Length)
                    && available.Any(f => paths.Contains(f.FullName, PathComparer)))
                    return (folder, paths);
            }
        }
        return null;
    }
}
