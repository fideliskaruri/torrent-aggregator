using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

public static class LibraryRead
{
    public static string ItemId(string workId) => "library:" + workId;

    public static WatchItemRow OwnedItem(string userId, string workId, IEnumerable<MediaFileRow> files)
    {
        var videos = files.ToArray();
        return new(ItemId(workId), userId, workId, WatchStatus.Planned, false,
            videos.Min(f => f.AddedAt), videos.Max(f => f.LastSeenAt ?? f.AddedAt), 0);
    }

    public static async Task<ImmutableArray<WatchItemRow>> ItemsAsync(string userId,
        ImmutableArray<WatchItemRow> intent, ILibraryRepository inventory, ILibraryPlacement library,
        CancellationToken ct)
    {
        var items = intent.DistinctBy(w => w.WorkId).ToDictionary(w => w.WorkId);
        foreach (var work in (await inventory.MediaAsync(null, ct)).GroupBy(f => f.WorkId))
        {
            if (items.ContainsKey(work.Key)) continue;
            var owned = await library.OwnedAsync(new(work.Key, [], false), ct);
            if (!owned.IsEmpty) items.Add(work.Key, OwnedItem(userId, work.Key, owned.SelectMany(i => i.Videos)));
        }
        return [.. items.Values.OrderByDescending(w => w.UpdatedAt).ThenBy(w => w.Id)];
    }
}
