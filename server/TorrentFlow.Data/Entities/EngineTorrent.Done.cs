using System.Linq.Expressions;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Data.Entities;

public partial class EngineTorrent
{
    /// <summary>
    /// The one done-ness predicate (docs/english-gates-plan.md section 1): the payload was verified and its files were
    /// promoted into the library. Open, notifications, title states, wanted and request "downloaded", and Library ready all
    /// read this, in queries through <see cref="Downloaded"/>.
    /// </summary>
    public static readonly Expression<Func<EngineTorrent, bool>> Downloaded =
        r => r.VerifiedAt != null && r.Progress >= 0.9999 && r.Promotion == EnginePromotion.Promoted;

    private static readonly Func<EngineTorrent, bool> DownloadedCheck = Downloaded.Compile();

    /// <inheritdoc cref="Downloaded"/>
    public static bool IsDownloaded(EngineTorrent row) => DownloadedCheck(row);

    /// <summary>The payload is verified but not promoted yet: the gate is running, or it waits for the owner.</summary>
    public static bool IsFinishing(EngineTorrent row) =>
        row.VerifiedAt != null && row.Promotion is EnginePromotion.Completed or EnginePromotion.Checking or EnginePromotion.Held;

    /// <summary>Where this transfer's files are now: its stage folder until promoted, else its save path.</summary>
    public static string? PayloadRoot(EngineTorrent row) =>
        row.StagePath is { Length: > 0 } stage && row.Promotion != EnginePromotion.Promoted ? stage : row.SavePath;
}
