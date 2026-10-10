using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Library.Jellyfin;

namespace TorrentFlow.Library;

public static class LibraryRead
{
    public static async Task<ImmutableDictionary<string, JellyfinTitleState>> WatchAsync(
        JellyfinWatchState reader, JellyfinSettings settings, string? key,
        IEnumerable<WorkSnapshot> works, ILibraryRepository inventory, CancellationToken ct)
    {
        if (settings.ServerUrl is null || string.IsNullOrWhiteSpace(settings.UserId) ||
            string.IsNullOrWhiteSpace(key))
            return ImmutableDictionary<string, JellyfinTitleState>.Empty;
        var files = (await inventory.MediaAsync(null, ct)).ToLookup(f => f.WorkId);
        return await reader.ReadBatchAsync(settings, key,
            works.Select(w => (w, files[w.Work.Id].ToImmutableArray())), ct);
    }

    public static string ItemId(string workId) => "library:" + workId;

    public static WatchItemRow OwnedItem(string userId, string workId, IEnumerable<MediaFileRow> files)
    {
        var videos = files.ToArray();
        return new WatchItemRow
        {
            Id = ItemId(workId),
            UserId = userId,
            WorkId = workId,
            Status = WatchStatus.Planned,
            UpgradeWatch = false,
            CreatedAt = videos.Min(f => f.AddedAt),
            UpdatedAt = videos.Max(f => f.LastSeenAt ?? f.AddedAt),
            Version = 0,
        };
    }

    public static async Task<ImmutableArray<WatchItemRow>> ItemsAsync(string userId,
        ImmutableArray<WatchItemRow> intent, IEnumerable<TargetRow> targets,
        ILibraryRepository inventory, ILibraryPlacement library,
        CancellationToken ct)
    {
        var items = intent.DistinctBy(w => w.WorkId).ToDictionary(w => w.WorkId);
        foreach (var work in targets.Where(t => t.Kind == TargetKind.Acquire &&
                     t.State is not (TargetState.Removed or TargetState.Done) &&
                     (t.Origin is IntentOrigin.Owner or IntentOrigin.Follow ||
                      t.Origin == IntentOrigin.Request && t.CreatedBy == userId))
                 .GroupBy(t => t.WorkId))
        {
            if (items.ContainsKey(work.Key)) continue;
            var rows = work.ToArray();
            items.Add(work.Key, new WatchItemRow
            {
                Id = ItemId(work.Key),
                UserId = userId,
                WorkId = work.Key,
                Status = WatchStatus.Planned,
                UpgradeWatch = false,
                CreatedAt = rows.Min(t => t.CreatedAt),
                UpdatedAt = rows.Max(t => t.UpdatedAt),
                Version = 0,
            });
        }
        foreach (var work in (await inventory.MediaAsync(null, ct)).GroupBy(f => f.WorkId))
        {
            if (items.ContainsKey(work.Key)) continue;
            var owned = await library.OwnedAsync(new(work.Key, [], false), ct);
            if (!owned.IsEmpty) items.Add(work.Key, OwnedItem(userId, work.Key, owned.SelectMany(i => i.Videos)));
        }
        return [.. items.Values.OrderByDescending(w => w.UpdatedAt).ThenBy(w => w.Id)];
    }
}
