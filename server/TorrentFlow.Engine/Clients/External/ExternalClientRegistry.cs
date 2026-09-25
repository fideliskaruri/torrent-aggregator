using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Clients.External;

public sealed class ExternalClientRegistry(QBittorrentClient qbittorrent, TransmissionClient transmission,
    ClientSettingsStore settings, SecretProtector secrets, ITorrentEngine engine,
    IDbContextFactory<TorrentFlowDbContext> dbFactory, StorageBudget storage, ILogger<ExternalClientRegistry> logger)
{
    public IExternalTorrentClient Get(string type) => type switch
    {
        "qbittorrent" => qbittorrent,
        "transmission" => transmission,
        _ => throw new ArgumentException("Invalid external client type", nameof(type)),
    };

    public Task<ClientConfig> GetConfigAsync(CancellationToken ct) => settings.GetConnectionConfigAsync(secrets, ct);

    public static string Label(string type) => type switch { "builtin" => "Built-in", "transmission" => "Transmission", _ => "qBittorrent" };

    public static IEnumerable<string> Sources(ClientConfig config) =>
        new[] { "builtin", config.ClientType, config.ExternalClientType }.OfType<string>().Distinct(StringComparer.Ordinal);

    public Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(ClientConfig config, string owner, CancellationToken ct) =>
        owner == "builtin" ? engine.ListAsync(ct) : Get(owner).ListAsync(config with { ClientType = owner }, ct);

    public async Task<EngineTorrentInfo?> FindAsync(ClientConfig config, string owner, string hash, CancellationToken ct)
    {
        if (!Sources(config).Contains(owner)) return null;
        return (await ListAsync(config, owner, ct)).LastOrDefault(t => t.Hash.Trim().Equals(hash, StringComparison.OrdinalIgnoreCase));
    }

    public async Task<(int Status, string? Message)> CheckDeleteAsync(ClientConfig config, string owner, EngineTorrentInfo torrent, CancellationToken ct)
    {
        var others = await Task.WhenAll(Sources(config).Where(t => t != owner).Select(async type =>
        {
            try { return (Known: true, Torrent: await FindAsync(config, type, torrent.Hash.Trim(), ct)); }
            catch (Exception) when (!ct.IsCancellationRequested) { return (Known: false, Torrent: (EngineTorrentInfo?)null); }
        }));
        if (others.Any(t => !t.Known))
            return (503, "Could not verify whether another configured client still uses these files. Reconnect it or remove only the transfer.");
        if (others.Any(t => t.Torrent is { } other && PathsOverlap(torrent.SavePath, other.SavePath)))
            return (409, "Another torrent client still uses the same files. Remove only this transfer or delete the other copy first.");
        return (200, null);
    }

    public static bool PathsOverlap(string? first, string? second)
    {
        static string? Normalize(string? path) => string.IsNullOrWhiteSpace(path) ? null : path.Trim().Replace('/', '\\').TrimEnd('\\').ToLowerInvariant();
        var a = Normalize(first);
        var b = Normalize(second);
        return a is null || b is null || a == b || a.StartsWith(b + '\\', StringComparison.Ordinal) || b.StartsWith(a + '\\', StringComparison.Ordinal);
    }

    public async Task<int> ConfirmedRemovalAsync(ClientConfig config, string owner, EngineTorrentInfo torrent, CancellationToken ct)
    {
        storage.ResetDirectorySizeCache();
        var pruned = PruneEmptyParents(torrent.SavePath, config.BaseDownloadPath);
        foreach (var other in Sources(config).Where(t => t != owner))
        {
            try { if (await FindAsync(config, other, torrent.Hash.Trim(), ct) is not null) return pruned; }
            catch (Exception) when (!ct.IsCancellationRequested) { return pruned; }
        }
        try
        {
            var hash = torrent.Hash.Trim().ToLowerInvariant();
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            await db.GrabJobs.Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && t.InfoHash.ToLower() == hash).ExecuteDeleteAsync(ct);
            await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.InfoHash != null && t.InfoHash.ToLower() == hash).ExecuteDeleteAsync(ct);
            await db.PlaybackProgresses.Where(t => t.UserId == LocalUser.Id && t.InfoHash.ToLower() == hash).ExecuteDeleteAsync(ct);
            await transaction.CommitAsync(ct);
        }
        catch (Exception ex) when (!ct.IsCancellationRequested)
        {
            logger.LogWarning(ex, "Transfer removed from {Owner} but remembered transfer rows could not be cleared", owner);
        }
        return pruned;
    }

    internal static int PruneEmptyParents(string? path, string? rootPath)
    {
        if (string.IsNullOrWhiteSpace(path) || string.IsNullOrWhiteSpace(rootPath)
            || !Path.IsPathFullyQualified(path) || !Path.IsPathFullyQualified(rootPath)) return 0;
        var removed = 0;
        try
        {
            var root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(rootPath));
            var current = Path.GetFullPath(path);
            var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
            if (!Directory.Exists(current)) current = Path.GetDirectoryName(current)!;
            bool Inside(string value) => value.StartsWith(root + Path.DirectorySeparatorChar, comparison);
            // A remote save path is untrusted local input. Refuse links anywhere in its ancestor chain.
            for (var ancestor = new DirectoryInfo(current); ancestor is not null; ancestor = ancestor.Parent)
                if (ancestor.Exists && ancestor.Attributes.HasFlag(FileAttributes.ReparsePoint)) return 0;
            for (var level = 0; level < 12 && Inside(current); level++)
            {
                var parent = Path.GetDirectoryName(current);
                if (parent is null) break;
                if (Directory.Exists(current))
                {
                    Directory.Delete(current, recursive: false);
                    removed++;
                }
                current = parent;
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or NotSupportedException)
        {
            // Non-empty folders and paths that exist only on the remote machine are expected.
        }
        return removed;
    }
}
