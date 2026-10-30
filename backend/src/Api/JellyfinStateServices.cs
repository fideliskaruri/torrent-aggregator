using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal sealed class JellyfinOwnedStateReader(IDbContextFactory<TorrentFlowDbContext> dbFactory,
    JellyfinWatchState adapter, string dataDirectory) : IJellyfinOwnedStateReader
{
    public async Task<JellyfinTitleState?> ReadAsync(WorkSnapshot work, ImmutableArray<MediaFileRow> files,
        CancellationToken ct)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.Settings.AsNoTracking().SingleAsync(setting => setting.Id == "jellyfin", ct);
            var settings = SettingsCatalog.Read<JellyfinSettings>(row);
            return await adapter.ReadAsync(settings, SecretFiles.Read(dataDirectory, settings.Credential),
                work, files, ct);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or ArgumentException)
        {
            return null;
        }
    }
}

internal sealed class JellyfinPlaybackGuard(IDbContextFactory<TorrentFlowDbContext> dbFactory,
    JellyfinClient client, string dataDirectory) : IJellyfinPlaybackGuard
{
    private static readonly TimeSpan ReadDeadline = TimeSpan.FromMilliseconds(1500);

    public async Task<JellyfinPlaybackRead> ReadAsync(CancellationToken ct)
    {
        try
        {
            await using var db = await dbFactory.CreateDbContextAsync(ct);
            var row = await db.Settings.AsNoTracking().SingleAsync(setting => setting.Id == "jellyfin", ct);
            var settings = SettingsCatalog.Read<JellyfinSettings>(row);
            if (settings.ServerUrl is null || settings.Credential is null)
                return new(JellyfinPlaybackReadStatus.NotConfigured, []);

            var token = SecretFiles.Read(dataDirectory, settings.Credential);
            if (string.IsNullOrWhiteSpace(token))
                return new(JellyfinPlaybackReadStatus.Unavailable, []);

            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(ReadDeadline);
            var currentUser = await client.GetCurrentUser(settings.ServerUrl, token, timeout.Token);
            currentUser ??= settings.UserId is null ? null :
                await client.GetUser(settings.ServerUrl, token, settings.UserId, timeout.Token);
            if (currentUser is null)
                return new(JellyfinPlaybackReadStatus.Unavailable, []);
            if (!currentUser.IsAdmin)
                return new(JellyfinPlaybackReadStatus.NotAdmin, []);

            var sessions = await client.GetSessions(settings.ServerUrl, token, 600, timeout.Token);
            var roots = await db.StorageRoots.AsNoTracking().Select(root => root.Path).ToArrayAsync(timeout.Token);
            var mapper = new JellyfinPathMapper(settings.PathMappings);
            var playing = sessions.Select(session => session.NowPlayingItem?.Path)
                .Where(path => !string.IsNullOrWhiteSpace(path))
                .Select(path => mapper.ToLocal(path!))
                .Where(path => path is not null && roots.Any(root => IsUnderRoot(path, root)))
                .Cast<string>()
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .ToImmutableArray();
            return new(JellyfinPlaybackReadStatus.Available, playing);
        }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested)
        {
            return new(JellyfinPlaybackReadStatus.Unavailable, []);
        }
        catch (Exception ex) when (ex is JellyfinException or JsonException or ArgumentException or IOException or UnauthorizedAccessException)
        {
            return new(JellyfinPlaybackReadStatus.Unavailable, []);
        }
    }

    private static bool IsUnderRoot(string path, string root)
    {
        var localPath = Normalize(path);
        var localRoot = Normalize(root);
        return localPath.Equals(localRoot, StringComparison.OrdinalIgnoreCase) ||
            localPath.StartsWith(localRoot.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase);
    }

    private static string Normalize(string path) =>
        path.Replace('\\', '/').TrimEnd('/');
}
