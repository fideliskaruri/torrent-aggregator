using TorrentFlow.Data.Entities;

namespace TorrentFlow.Engine.Queue;

/// <summary>
/// Why a kept download holds a slot past the cap. Only the owner's "Download now" forces; resume joins the queue.
/// Rows forced before the reason was stored (an old resume) are "legacy" and keep their override until they finish.
/// </summary>
internal static class ForcedReasons
{
    public const string Now = "now";
    public const string Legacy = "legacy";

    public static void MarkForcedNow(this EngineTorrent row, DateTime at)
    {
        row.ForcedAt = at;
        row.ForcedReason = Now;
    }

    public static void ClearForced(this EngineTorrent row)
    {
        row.ForcedAt = null;
        row.ForcedReason = null;
    }
}
