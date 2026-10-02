namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// The completion states of a transfer whose payload is in (docs/english-gates-plan.md section 1). Payload is written to a
/// stage folder; nothing counts as downloaded until its files are promoted into the library through the gate.
/// </summary>
public static class EnginePromotion
{
    /// <summary>Every wanted byte is verified in the stage folder; the gate has not run yet.</summary>
    public const string Completed = "completed";
    /// <summary>The gate is deciding, or the promotion is moving the files. A restart resumes it.</summary>
    public const string Checking = "checking";
    /// <summary>The kept files are in the library folder. The only state that counts as downloaded.</summary>
    public const string Promoted = "promoted";
    /// <summary>The gate wants the owner to decide: files stay in the stage folder; Keep promotes, Find another rejects.</summary>
    public const string Held = "held";
    /// <summary>The gate said no: the stage files are deleted, the release blocked and the finder picks again.</summary>
    public const string Rejected = "rejected";

    /// <summary>The row state the UI shows while the gate runs or the files move.</summary>
    public const string FinishingState = "finishing";
    /// <summary>The row state the UI shows while the owner decides (Keep or Find another).</summary>
    public const string HeldState = "held";
}

/// <summary>Who chose a transfer's release. Persisted on every engine row; the gate treats the two differently (P2).</summary>
public static class EngineProvenance
{
    /// <summary>The finder chose it: grab ladder, hunter, wanted queue, requests, season downloads, Find the best one.</summary>
    public const string Automatic = "automatic";
    /// <summary>The owner chose it: the release picker, a manual send, a specific release in Find another source.</summary>
    public const string Hand = "hand";

    public static string Of(bool byHand) => byHand ? Hand : Automatic;
}

/// <summary>
/// The promotion gate seam. The engine calls it once per finished transfer, before any file reaches the library, with the
/// transfer, its kept files in the stage folder and its provenance. P1 always promotes; P2 plugs the English check in here.
/// Implementations must not move or delete files (the engine does) and should finish quickly: the engine persists the
/// Checking state first, so a restart calls the gate again for the same transfer.
/// </summary>
public interface IPromotionGate
{
    Task<PromotionDecision> DecideAsync(PromotionCandidate candidate, CancellationToken ct);
}

/// <param name="StageRoot">Where the files are now: the stage folder, or the final path for a legacy row.</param>
/// <param name="FinalPath">The library folder the files are promoted into.</param>
/// <param name="Files">The kept files (the selected ones for a season pack), with their full paths in <paramref name="StageRoot"/>.</param>
/// <param name="Provenance"><see cref="EngineProvenance"/>.</param>
/// <param name="LanguageCheckJson">The English check state kept with the row (<see cref="EngineLanguageState"/>), or null.</param>
public sealed record PromotionCandidate(string Hash, string Name, string? WorkId, string? QueueKey, string Provenance,
    string StageRoot, string FinalPath, IReadOnlyList<PromotionFile> Files, string? LanguageCheckJson);

/// <param name="Path">The file's path inside the torrent.</param>
public sealed record PromotionFile(string Path, string FullPath, long Size);

/// <summary>What the gate decided: promote it, hold it for the owner (with a reason), or reject it (with a reason).</summary>
/// <param name="Code">For a reject, the release block reason (ReleaseBlocks, for example no_english); null blocks it as rejected.</param>
public sealed record PromotionDecision(string Outcome, string? Reason = null, string? Code = null)
{
    public const string PromoteOutcome = "promote";
    public const string HoldOutcome = "hold";
    public const string RejectOutcome = "reject";

    public static readonly PromotionDecision Promote = new(PromoteOutcome);
    public static PromotionDecision Hold(string reason) => new(HoldOutcome, reason);
    public static PromotionDecision Reject(string reason, string? code = null) => new(RejectOutcome, reason, code);
}

/// <summary>The P1 gate: every finished transfer is promoted.</summary>
public sealed class PromoteEverythingGate : IPromotionGate
{
    public static readonly PromoteEverythingGate Instance = new();

    public Task<PromotionDecision> DecideAsync(PromotionCandidate candidate, CancellationToken ct) => Task.FromResult(PromotionDecision.Promote);
}
