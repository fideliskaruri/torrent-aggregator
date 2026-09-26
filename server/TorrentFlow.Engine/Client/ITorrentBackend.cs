namespace TorrentFlow.Engine.Client;

/// <summary>
/// What to load into the torrent client. Exactly one of Magnet / TorrentBytes is set. <see cref="FilePaths"/>, by torrent
/// file index, points files that already sit somewhere laid out (a re-add) at those paths; null entries keep the default.
/// </summary>
internal sealed record BackendAddSpec(
    string Hash,
    string? Magnet,
    byte[]? TorrentBytes,
    string SavePath,
    string Purpose,
    TimeSpan? MetadataTimeout,
    bool CreateContainingDirectory = true,
    IReadOnlyList<string?>? FilePaths = null);

internal sealed record BackendFile(int Index, string Path, string FullPath, long Length, bool Selected, double Progress);

internal sealed record BackendSnapshot(
    string Hash,
    string Name,
    double Progress,
    long SizeBytes,
    long DownloadRate,
    long UploadRate,
    int Peers,
    /// <summary>metaDL | checkingDL | downloading | stalledDL | paused | complete | error</summary>
    string State,
    bool HasMetadata,
    string SavePath,
    IReadOnlyList<BackendFile> Files,
    string? Error)
{
    /// <summary>Payload bytes received from peers since the transfer was loaded.</summary>
    public long? BytesReceived { get; init; }

    /// <summary>Base64 of the verified-piece bitfield, MSB first, ceil(pieces / 8) bytes (TS bitfieldBase64).</summary>
    public string? PieceBitfield { get; init; }
}

internal sealed record BackendAddOutcome(bool Ok, string Message, BackendSnapshot? Snapshot = null);

/// <summary>
/// The torrent client seam. The production implementation wraps MonoTorrent; the queue/lifecycle service is
/// tested against a fake so ordering, caps and promotion never need a swarm.
/// </summary>
internal interface ITorrentBackend
{
    Task<BackendAddOutcome> AddAsync(BackendAddSpec spec, CancellationToken ct);
    bool Contains(string hash);
    BackendSnapshot? Get(string hash);
    IReadOnlyList<BackendSnapshot> List();
    /// <summary>Hashes of the loaded transfers, without building snapshots.</summary>
    IReadOnlyCollection<string> LiveHashes();
    Task PauseAsync(string hash);
    Task ResumeAsync(string hash);
    /// <summary>Detaches from the client. Deleting files is the caller's job (it knows the recorded paths).</summary>
    Task RemoveAsync(string hash);
    Task SetSelectedFilesAsync(string hash, IReadOnlySet<int>? selected);
    Task<Stream> OpenStreamAsync(string hash, int fileIndex, CancellationToken ct);
    /// <summary>Raw .torrent metadata once known, so a later rehydrate never needs the network.</summary>
    byte[]? GetMetadata(string hash);

    /// <summary>Verified, file-relative byte ranges (end exclusive) for one live file; empty when unknown.</summary>
    IReadOnlyList<(long Start, long End)> DownloadedRanges(string hash, int fileIndex) => [];

    /// <summary>
    /// Applies a download-window speed cap (bytes/s; null = no window cap). The client combines it with its own base
    /// limits (the stricter wins) and restores the base when both are null.
    /// </summary>
    Task ApplyRateLimitsAsync(long? maxDownloadRate, long? maxUploadRate) => Task.CompletedTask;
}
