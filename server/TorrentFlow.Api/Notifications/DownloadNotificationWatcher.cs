using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Grabs;

namespace TorrentFlow.Api.Notifications;

public sealed class DownloadNotificationWatcher(
    ITorrentEngine engine,
    NotificationService notifications,
    IDbContextFactory<TorrentFlowDbContext> factory,
    ILogger<DownloadNotificationWatcher> logger) : BackgroundService
{
    /// <summary>Where download notifications pointed before they named the download they are about.</summary>
    private const string LegacyLink = "/downloads";

    private readonly Channel<(string Kind, string Title, string Hash, string Name)> _events =
        Channel.CreateUnbounded<(string Kind, string Title, string Hash, string Name)>(new UnboundedChannelOptions { SingleReader = true });

    public override Task StartAsync(CancellationToken cancellationToken)
    {
        engine.TorrentCompleted += Completed;
        engine.TorrentFailed += Failed;
        return base.StartAsync(cancellationToken);
    }

    private void Completed(object? sender, EngineTorrentCompletedEventArgs e)
    {
        if (e.Origin == TorrentOrigin.User) _events.Writer.TryWrite((NotificationKind.DownloadCompleted, "Download completed", e.Hash, e.Name));
    }

    private void Failed(object? sender, EngineTorrentFailedEventArgs e)
    {
        if (e.Origin == TorrentOrigin.User) _events.Writer.TryWrite((NotificationKind.DownloadFailed, "Download failed", e.Hash, e.Name));
    }

    /// <summary>
    /// How a notification names a download: "Title (Year)" for a film, "Title S01E02" for an episode. Never the raw
    /// release name, which carries tracker spam and scene tags and is what a push notification would show verbatim.
    /// </summary>
    public static string LabelFor(string releaseName)
    {
        var identity = ReleaseNames.IdentityFor(releaseName);
        var label = identity.IsSeries
            ? ReleaseNames.ParseEpisode(releaseName).Label is { Length: > 0 } episode ? $"{identity.Name} {episode}" : identity.Name
            : identity.Year is { } year ? $"{identity.Name} ({year})" : identity.Name;
        return string.IsNullOrWhiteSpace(label) ? releaseName : label;
    }

    /// <summary>Opens that download on the Downloads page, which says so when it is no longer there.</summary>
    public static string LinkFor(string hash) => $"/downloads?hash={Uri.EscapeDataString(hash.ToLowerInvariant())}";

    /// <summary>Older notifications recorded no hash, so they find their download by its release name.</summary>
    private static string LegacyLinkFor(string releaseName) => $"/downloads?release={Uri.EscapeDataString(releaseName)}";

    /// <summary>
    /// Notifications written before downloads were named and linked carry the raw release name and a bare link to the
    /// list. Rewrite them once, the same way new ones are written, so the feed reads the same whatever its age.
    /// </summary>
    private async Task RelabelLegacyAsync(CancellationToken ct)
    {
        try
        {
            await using var db = await factory.CreateDbContextAsync(ct);
            var legacy = await db.Notifications
                .Where(n => (n.Kind == NotificationKind.DownloadCompleted || n.Kind == NotificationKind.DownloadFailed)
                    && n.Link == LegacyLink && n.Body != null)
                .ToListAsync(ct);
            if (legacy.Count == 0) return;
            foreach (var row in legacy)
            {
                var releaseName = row.Body!;
                row.Body = LabelFor(releaseName);
                row.Link = LegacyLinkFor(releaseName);
            }
            await db.SaveChangesAsync(ct);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "Could not rename older download notifications");
        }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try
        {
            await RelabelLegacyAsync(stoppingToken);
            await foreach (var e in _events.Reader.ReadAllAsync(stoppingToken))
                await notifications.TryPublishAsync(LocalUser.Id, e.Kind, e.Title, LabelFor(e.Name), LinkFor(e.Hash));
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
        finally
        {
            engine.TorrentCompleted -= Completed;
            engine.TorrentFailed -= Failed;
            _events.Writer.TryComplete();
        }
    }
}
