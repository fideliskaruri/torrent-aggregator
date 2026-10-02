namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// The built-in torrent engine. Implemented by TorrentFlow.Engine; consumed by Library (grabs, automation)
/// and the API host. All hashes are lowercase hex v1 info hashes.
/// </summary>
public interface ITorrentEngine
{
    /// <summary>
    /// Adds (or dedupes) a transfer. Downloads go through the chronological download queue unless
    /// <see cref="EngineAddRequest.Forced"/> is set.
    /// </summary>
    Task<EngineAddResult> AddAsync(EngineAddRequest request, CancellationToken ct = default);

    /// <summary>
    /// Fetches a release's file list (the same metadata path and cache <see cref="AddAsync"/> uses) without creating
    /// a transfer, so a later add of the same release never fetches it twice.
    /// </summary>
    Task<EngineInspectResult> InspectAsync(EngineInspectRequest request, CancellationToken ct = default) =>
        Task.FromResult(EngineInspectResult.Failed(null, "no_metadata"));

    Task<EngineAddResult> SwapAsync(string hash, EngineReleaseSwap request, CancellationToken ct = default) =>
        Task.FromResult(new EngineAddResult(false, "Release swapping is not supported by this engine."));

    Task<IReadOnlyList<EngineTorrentInfo>> ListAsync(CancellationToken ct = default);

    Task<EngineTorrentInfo?> GetAsync(string infoHash, CancellationToken ct = default);

    Task<EngineActionResult> PauseAsync(string infoHash, CancellationToken ct = default);

    Task<EngineActionResult> ResumeAsync(string infoHash, CancellationToken ct = default);

    /// <summary>
    /// Removes a transfer and returns at once: it never lists again, and with <paramref name="deleteFiles"/> its files
    /// are deleted in the background moments later (a restart in between still finishes the delete).
    /// </summary>
    Task<EngineActionResult> RemoveAsync(string infoHash, bool deleteFiles, CancellationToken ct = default);

    /// <summary>
    /// Removes several transfers as one delete, so a folder they share only with each other (a season) goes too.
    /// </summary>
    async Task<IReadOnlyList<(string Hash, EngineActionResult Result)>> RemoveManyAsync(
        IReadOnlyCollection<string> infoHashes, bool deleteFiles, CancellationToken ct = default)
    {
        var results = new List<(string, EngineActionResult)>();
        foreach (var hash in infoHashes) results.Add((hash, await RemoveAsync(hash, deleteFiles, ct)));
        return results;
    }

    /// <summary>
    /// Removes a transfer with its files only if it is unfinished and <paramref name="owned"/> still says it is the
    /// caller's, checked right before the delete (under the hash lock in the built-in engine). A finished, parked or
    /// downloaded transfer is never removed. Used by cleanups that undo what an automatic run started.
    /// </summary>
    async Task<EngineActionResult> RemoveUnfinishedAsync(string infoHash, Func<CancellationToken, Task<bool>> owned, CancellationToken ct = default)
    {
        if (await GetAsync(infoHash, ct) is not { } info) return new EngineActionResult(false, "Not found");
        if (info.Progress >= 0.9999 || info.State == "downloaded")
            return new EngineActionResult(false, "It finished, so it stays.");
        if (!await owned(ct)) return new EngineActionResult(false, "Something else still wants it, so it stays.");
        return await RemoveAsync(infoHash, true, ct);
    }

    /// <summary>Starts a queued (or paused) kept download now, past the active-download cap.</summary>
    Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default);

    /// <summary>Selects which files transfer. Indices refer to <see cref="EngineTorrentInfo.Files"/>.</summary>
    Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default);

    /// <summary>Bytes reserved by queued kept downloads that have not written anything yet.</summary>
    Task<long> QueuedReservedBytesAsync(CancellationToken ct = default);

    /// <summary>The owner keeps a held transfer (docs/english-gates-plan.md): its files are promoted into the library.</summary>
    Task<EngineActionResult> KeepAsync(string infoHash, CancellationToken ct = default) =>
        Task.FromResult(new EngineActionResult(false, "This download isn't waiting for you."));

    /// <summary>The owner turns a held transfer down: its staged files are deleted, the release is blocked, and the finder picks again.</summary>
    Task<EngineActionResult> FindAnotherAsync(string infoHash, CancellationToken ct = default) =>
        Task.FromResult(new EngineActionResult(false, "This download isn't waiting for you."));

    /// <summary>
    /// Moves a finished transfer's files to the folder its work places it in now (a show or season folder that changed
    /// inside the same library), as one rename per file that never overwrites. Only a transfer the client has let go
    /// of (parked) moves; anything else is left where it is and says why.
    /// </summary>
    Task<EngineRelocation> RelocateAsync(string infoHash, WorkPlacement placement, CancellationToken ct = default) =>
        Task.FromResult(new EngineRelocation(false, EngineRelocation.NotSupported, null, null));

    /// <summary>
    /// Whether a transfer's files are gone from disk, read fresh under the transfer's lock so a move of its files
    /// (<see cref="RelocateAsync"/>) is never mistaken for a loss: true when the transfer is gone, false while a move is
    /// under way or waits to be settled at the next start, else true only when every file it kept is confirmed missing
    /// (<see cref="VerifiedFiles.AllMissing"/>). An engine that cannot tell says true, the answer its row gave before.
    /// </summary>
    Task<bool> FilesMissingAsync(string infoHash, CancellationToken ct = default) => Task.FromResult(true);

    /// <summary>Raised once per transfer when it completes and its files are verified on disk.</summary>
    event EventHandler<EngineTorrentCompletedEventArgs>? TorrentCompleted;
    /// <summary>Raised when a transfer enters a failed state.</summary>
    event EventHandler<EngineTorrentFailedEventArgs>? TorrentFailed { add { } remove { } }
}

public sealed class EngineTorrentFailedEventArgs(string hash, string name, string origin) : EventArgs
{
    public string Hash { get; } = hash;
    public string Name { get; } = name;
    public string Origin { get; } = origin;
}

/// <summary>Every download is kept; requests still name the purpose so older callers keep compiling.</summary>
public static class TorrentPurpose
{
    public const string Keep = "keep";
}

/// <summary>EngineTorrent.origin values.</summary>
public static class TorrentOrigin
{
    public const string User = "user";
}

/// <summary>
/// Priority lanes of the kept-download queue. A queued row in a higher lane starts before any lower-lane row;
/// nothing running is ever preempted. Persisted as <see cref="Rank"/> (0 = highest).
/// </summary>
public static class TorrentLane
{
    /// <summary>The owner pressed Download (title page, search, Downloads).</summary>
    public const string Owner = "owner";
    /// <summary>Someone asked the owner for it (requests feature).</summary>
    public const string Request = "request";
    /// <summary>Watchlist monitoring and auto-rules.</summary>
    public const string Automation = "automation";

    public static readonly string[] All = [Owner, Request, Automation];

    /// <summary>Queue sort rank; null is the owner, and an unrecognised name sorts last rather than jumping the queue.</summary>
    public static int Rank(string? lane) => lane?.Trim().ToLowerInvariant() switch
    {
        null or Owner => 0,
        Request => 1,
        _ => 2,
    };

    public static string FromRank(int rank) => rank switch
    {
        1 => Request,
        2 => Automation,
        _ => Owner,
    };
}

/// <summary>Why a queued kept download is not transferring yet (one per row, most important first).</summary>
public static class QueueWaitReason
{
    /// <summary>Download hours are configured and none is open now.</summary>
    public const string OutsideWindow = "outside-window";
    /// <summary>A higher-priority lane is waiting ahead of this row.</summary>
    public const string LowerLane = "lower-lane";
    /// <summary>Every downloads-at-once slot is taken.</summary>
    public const string QueueFull = "queue-full";
}

/// <summary>
/// What <see cref="ITorrentEngine.RelocateAsync"/> did. <see cref="Moved"/> with the old and new folder; otherwise
/// <see cref="Problem"/> says why the files stayed (null: already in place).
/// </summary>
public sealed record EngineRelocation(bool Moved, string? Problem, string? From, string? To)
{
    public const string NotSupported = "not_supported";
    public const string NotFound = "not_found";
    /// <summary>Still in the client (seeding), not finished, or an earlier move of its files is not settled yet: tried again later.</summary>
    public const string NotParked = "not_parked";
    /// <summary>Not a show or season folder change inside one library under the download root: never moved.</summary>
    public const string OutsideLibrary = "outside_library";
    public const string Clash = "clash";
    public const string MoveFailed = "move_failed";
    public string? Detail { get; init; }
}

/// <summary>EngineTorrent.status values written by the engine.</summary>
public static class EngineTorrentStatus
{
    public const string Downloading = "downloading";
    /// <summary>A kept download admitted but deliberately not loaded into the client (zero RAM).</summary>
    public const string Queued = "queued";
    public const string Paused = "paused";
    /// <summary>Completed, verified, and detached from the client while the files stay on disk.</summary>
    public const string Parked = "parked";
    public const string Error = "error";
    public const string Removed = "removed";
    /// <summary>The client lost the files on disk.</summary>
    public const string MissingFiles = "missingFiles";

    /// <summary>
    /// The one answer to "is this transfer still good for its episode or film": on its way or on disk. Failed, removed
    /// and lost-files transfers are not, so a retry may replace them.
    /// </summary>
    public static bool IsHealthy(string? status) =>
        !string.IsNullOrEmpty(status) && status.ToLowerInvariant() is not ("error" or "removed" or "missingfiles");
}

public sealed record EngineAddRequest
{
    public string? Magnet { get; init; }
    public string? TorrentUrl { get; init; }
    /// <summary>Raw .torrent bytes, when the caller already has them.</summary>
    public byte[]? TorrentBytes { get; init; }
    /// <summary>40-char hex or 32-char base32 info hash; turned into a magnet with public trackers.</summary>
    public string? InfoHash { get; init; }
    public string? Name { get; init; }
    public required string Purpose { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
    /// <summary>Smart-target hints (resolveSmartSendTarget) used when no SavePath is given.</summary>
    public string? SearchCategory { get; init; }
    /// <summary>The search site's own category for the release (nyaa "Anime - English-translated"), read by the language check.</summary>
    public string? SourceCategory { get; init; }
    /// <summary>The audio and subtitle language check for this release (docs/release-language.md); null skips it.</summary>
    public EngineLanguageCheck? Language { get; init; }
    public TorrentFlow.Core.Contracts.Metadata.MediaMetadata? Metadata { get; init; }
    public string? Source { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
    /// <summary>The catalog work being fetched; when set (and no SavePath), its folder comes from the catalog, not <see cref="Name"/>.</summary>
    public WorkPlacement? Placement { get; init; }
    /// <summary>Trust <see cref="Category"/> as the owner's manual choice instead of the smart label.</summary>
    public bool CategoryManual { get; init; }
    /// <summary>Sortable episode position ("s00001e00002").</summary>
    public string? QueueKey { get; init; }
    public string? WorkId { get; init; }
    /// <summary>Known release size, reserved against the storage budget while queued.</summary>
    public long? ExpectedSizeBytes { get; init; }
    /// <summary>The owner pressed Download now: start past the cap. Never set by automation.</summary>
    public bool Forced { get; init; }
    /// <summary>The owner saw an overridable storage refusal (cap/reserve) and chose to proceed. Never bypasses wont-fit or setup.</summary>
    public bool OverrideStorageCap { get; init; }
    /// <summary>Queue lane (<see cref="TorrentLane"/>); null is the owner's lane. Automation must pass Automation.</summary>
    public string? Lane { get; init; }
    /// <summary>Resolve magnet metadata before admitting an automatically selected release, including queued downloads.</summary>
    public bool RequireMetadata { get; init; }
    /// <summary>
    /// Torrent file indexes to download (a season pack fallback). Null downloads every file. Persisted and applied
    /// before the first piece is requested; requires metadata (<see cref="RequireMetadata"/>).
    /// </summary>
    public IReadOnlyList<int>? SelectedFiles { get; init; }
    /// <summary>Who chose the release (<see cref="EngineProvenance"/>). Every finder path is automatic; only the owner's own picks are hand.</summary>
    public string Provenance { get; init; } = EngineProvenance.Automatic;
}

/// <summary>What the sender wants to hear and what the release name already said (docs/release-language.md).</summary>
/// <param name="NameFit">The name's fit, logged beside the file list's.</param>
/// <param name="AcceptClash">A hand pick: never refuse, stop or block it for language, only record it.</param>
public sealed record EngineLanguageCheck(LanguageWant Want, LanguageFit? NameFit, string? NameLabel, bool AcceptClash);

/// <summary>Reads a release's file list without admitting a transfer (season pack verification).</summary>
public sealed record EngineInspectRequest(string? Magnet, string? TorrentUrl, string? InfoHash, string? Name);

/// <param name="Failure">no_metadata | hash_mismatch | no_source when the file list could not be read.</param>
public sealed record EngineInspectResult(string? Hash, long PieceLength, IReadOnlyList<EngineInspectFile> Files, string? Failure = null)
{
    public bool Ok => Failure == null && Hash != null;
    public static EngineInspectResult Failed(string? hash, string failure) => new(hash, 0, [], failure);
}

/// <param name="Offset">Byte offset of the file inside the torrent's concatenated payload.</param>
public sealed record EngineInspectFile(int Index, string Path, long Length, long Offset);

/// <param name="UseBlocked">
/// The owner picked this release by hand with "Use it anyway" although it is blocked: the swap may take a release
/// already tried for this download, and lifts its block in the same commit.
/// </param>
/// <param name="ByHand">The owner chose this release in the list (provenance hand); Find the best one for me is automatic.</param>
public sealed record EngineReleaseSwap(string WorkKey, string Scope, string Hash, string Name, string? Magnet,
    long? SizeBytes, string? Source = null, bool UseBlocked = false, bool ByHand = false);

public sealed record EngineAddResult(bool Ok, string Message, EngineAddDetails? Details = null, string? Hash = null)
{
    public string? InvalidField { get; init; }
    /// <summary>Set when a storage limit refused the add: setup | inventory | cap | reserve | wont-fit.</summary>
    public string? StorageLimit { get; init; }
    /// <summary>
    /// Set when the release itself is unusable, so another release should be tried: dangerous (a program file) |
    /// no_video (no video, or archives only) | fake (an earlier download of it was not a real video file) |
    /// audio_language (its file list shows audio in a language the owner doesn't want; <see cref="Language"/> says which).
    /// </summary>
    public string? Unusable { get; init; }
    /// <summary>The language reason code with <c>Unusable = "audio_language"</c>: audio_fr, subs_zh (<see cref="ReleaseLanguage.ReasonLabel"/>).</summary>
    public string? Language { get; init; }
    /// <summary>This add admitted a transfer that wasn't there (or had been removed or failed), rather than finding one already kept.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool Fresh { get; init; }
}

/// <summary>Mirrors the TypeScript AddTorrentDetails "builtin-transfer" variant.</summary>
public sealed record EngineAddDetails(string Action, double Pct, int Peers, int? QueuePosition = null)
{
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Performance", "CA1822:Mark members as static",
        Justification = "This instance property is part of the serialized HTTP contract.")]
    public string Type => "builtin-transfer";

    public const string Started = "started";
    public const string AlreadyDownloading = "already_downloading";
    public const string AlreadyComplete = "already_complete";
    public const string Queued = "queued";
}

public sealed record EngineActionResult(bool Ok, string Message);

/// <summary>A transfer as the UI sees it; serialises to the Next.js ClientTorrent shape.</summary>
public sealed record EngineTorrentInfo
{
    public required string Hash { get; init; }
    public required string Name { get; init; }
    /// <summary>0..1.</summary>
    public double Progress { get; init; }
    public long SizeBytes { get; init; }
    public long Dlspeed { get; init; }
    public long Upspeed { get; init; }
    /// <summary>downloaded | downloading | stalledDL | metaDL | checkingDL | paused | queued | error | finishing (the gate is
    /// running or the files are moving into the library) | held (the owner decides: Keep or Find another)</summary>
    public required string State { get; init; }
    public long? Eta { get; init; }
    public int? Peers { get; init; }
    public int? Seeders { get; init; }
    public TransferHealth? Health { get; init; }
    public string? Error { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
    /// <summary>kept | unknown</summary>
    public string? RetentionState { get; init; }
    public int? QueuePosition { get; init; }
    /// <summary>owner | request | automation (<see cref="TorrentLane"/>).</summary>
    public string? Lane { get; init; }
    /// <summary>Set only while queued: <see cref="QueueWaitReason"/>.</summary>
    public string? WaitReason { get; init; }
    public string? WorkId { get; init; }
    public string? QueueKey { get; init; }
    /// <summary>True when the row holds a slot past the cap (ForcedAt is set). Distinct from queue position.</summary>
    public bool Forced { get; init; }
    /// <summary>Why <see cref="Forced"/>: "now" (the owner pressed Download now) or "legacy" (forced before reasons were stored).</summary>
    public string? ForcedReason { get; init; }
    /// <summary>True after the engine verified the payload on disk (parked/complete). Survives restart without a live client.</summary>
    public bool Verified { get; init; }
    public IReadOnlyList<EngineFileInfo>? Files { get; init; }
    /// <summary>"English not confirmed" when the check after add could not confirm English audio or subtitles; else null.</summary>
    public string? LanguageNote { get; init; }
    /// <summary>While <see cref="State"/> is held: why the promotion gate wants the owner to decide (Keep or Find another).</summary>
    public string? HeldReason { get; init; }
    /// <summary>Who chose the release: automatic or hand (<see cref="EngineProvenance"/>).</summary>
    public string? Provenance { get; init; }
    /// <summary>Shareable magnet built server-side: the transfer's own trackers plus the public list (never for private torrents).</summary>
    public string? Magnet { get; init; }
    /// <summary>A completed local file imported without torrent metadata; it has no shareable magnet.</summary>
    public bool Imported { get; init; }
    /// <summary>When the transfer was added, UTC; null when the client does not say. Always written, as null too.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.Never)]
    public DateTime? AddedAt { get; init; }
    /// <summary>A finished built-in download with a kept file gone from disk (deleted or moved outside TorrentFlow).</summary>
    public bool FilesMissing { get; init; }
    /// <summary>Payload bytes received from peers this session (live transfers only). Not part of the UI shape.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public long? BytesReceived { get; init; }

    /// <summary>Downloaded the one way the engine counts it: promoted into the library (EngineTorrent.IsDownloaded).</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsDownloaded => State == "downloaded";
}

public sealed record EngineFileInfo(int Index, string Path, long Length, bool Selected, double Progress, string? FullPath = null);

public sealed class EngineTorrentCompletedEventArgs(string hash, string name, string? savePath, string origin) : EventArgs
{
    public string Hash { get; } = hash;
    public string Name { get; } = name;
    public string? SavePath { get; } = savePath;
    public string Origin { get; } = origin;
}
