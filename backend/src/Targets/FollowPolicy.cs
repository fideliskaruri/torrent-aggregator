using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public static class FollowPolicy
{
    public static (string? Start, DateTimeOffset Since) Configure(FollowRow? prior,
        string? fromEpisodeId, bool changeStart, string? mode, DateTimeOffset now)
    {
        mode ??= changeStart && fromEpisodeId is not null ? "ongoing" :
            prior is null ? fromEpisodeId is null ? "new" : "ongoing" : null;
        if (mode == "new")
            return (null, prior is { NewEpisodesSince: var since } && since > DateTimeOffset.UnixEpoch ? since : now);
        return (changeStart ? fromEpisodeId : prior?.FromEpisodeId,
            mode == "ongoing" ? DateTimeOffset.UnixEpoch : prior!.NewEpisodesSince);
    }
}
