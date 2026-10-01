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

    /// <summary>Starts a queued (or paused) kept download now, past the active-download cap.</summary>
    Task<EngineActionResult> ForceAsync(string infoHash, CancellationToken ct = default);

    /// <summary>Selects which files transfer. Indices refer to <see cref="EngineTorrentInfo.Files"/>.</summary>
    Task<EngineActionResult> SelectFilesAsync(string infoHash, IReadOnlyCollection<int> fileIndices, CancellationToken ct = default);

    /// <summary>Bytes reserved by queued kept downloads that have not written anything yet.</summary>
    Task<long> QueuedReservedBytesAsync(CancellationToken ct = default);

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
    public TorrentFlow.Core.Contracts.Metadata.MediaMetadata? Metadata { get; init; }
    public string? Source { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
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
}

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

public sealed record EngineReleaseSwap(string WorkKey, string Scope, string Hash, string Name, string? Magnet,
    long? SizeBytes, string? Source = null);

public sealed record EngineAddResult(bool Ok, string Message, EngineAddDetails? Details = null, string? Hash = null)
{
    public string? InvalidField { get; init; }
    /// <summary>Set when a storage limit refused the add: setup | inventory | cap | reserve | wont-fit.</summary>
    public string? StorageLimit { get; init; }
    /// <summary>
    /// Set when the release itself is unusable, so another release should be tried: dangerous (a program file) |
    /// no_video (no video, or archives only) | fake (an earlier download of it was not a real video file).
    /// </summary>
    public string? Unusable { get; init; }
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
    /// <summary>downloaded | downloading | stalledDL | metaDL | checkingDL | paused | queued | error</summary>
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
    /// <summary>True when the owner pressed Download now (ForcedAt is set). Distinct from queue position.</summary>
    public bool Forced { get; init; }
    /// <summary>True after the engine verified the payload on disk (parked/complete). Survives restart without a live client.</summary>
    public bool Verified { get; init; }
    public IReadOnlyList<EngineFileInfo>? Files { get; init; }
    /// <summary>Shareable magnet built server-side: the transfer's own trackers plus the public list (never for private torrents).</summary>
    public string? Magnet { get; init; }
    /// <summary>A completed local file imported without torrent metadata; it has no shareable magnet.</summary>
    public bool Imported { get; init; }
    /// <summary>Payload bytes received from peers this session (live transfers only). Not part of the UI shape.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public long? BytesReceived { get; init; }
}

public sealed record EngineFileInfo(int Index, string Path, long Length, bool Selected, double Progress, string? FullPath = null);

public sealed class EngineTorrentCompletedEventArgs(string hash, string name, string? savePath, string origin) : EventArgs
{
    public string Hash { get; } = hash;
    public string Name { get; } = name;
    public string? SavePath { get; } = savePath;
    public string Origin { get; } = origin;
}
