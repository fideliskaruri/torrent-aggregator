using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Client;

/// <summary>The most one header probe may spend. Hitting any limit ends that file (or the probe) unchecked.</summary>
/// <param name="Timeout">The whole probe, waiting for a probe slot included.</param>
/// <param name="MaxBytesPerFile">Payload received from peers while one file is read.</param>
/// <param name="MaxFiles">Files read per probe; extra indices are ignored.</param>
/// <param name="MaxReadsPerFile">Range reads per file (<see cref="MediaTrackBudget.MaxReads"/>).</param>
internal sealed record HeaderProbeBudget(TimeSpan Timeout, long MaxBytesPerFile, int MaxFiles, int MaxReadsPerFile)
{
    public static HeaderProbeBudget Default { get; } = new(TimeSpan.FromSeconds(45), 32L << 20, 3, 12);
}

/// <param name="BytesDownloaded">Payload received from peers while this file was read.</param>
internal sealed record HeaderProbeFile(int Index, string Path, long Length, MediaTrackScan Scan, long BytesDownloaded, TimeSpan Elapsed);

/// <summary>
/// What the header probe found. <see cref="Files"/> holds one scan per file that was read, each with its own unchecked
/// reason; <see cref="Unchecked"/> is the first reason any file (or the probe as a whole) went unchecked, null when every
/// requested file's tracks were read. An unchecked probe never refuses a release.
/// </summary>
internal sealed record HeaderProbeResult(string? Hash, IReadOnlyList<HeaderProbeFile> Files, string? Unchecked, long BytesDownloaded, TimeSpan Elapsed)
{
    public const string Timeout = "timeout";
    public const string NoPeers = "no peers";
    public const string ByteBudget = MediaTracks.ByteBudget;
    public const string MetadataUnavailable = "metadata unavailable";
    public const string NoSuchFile = "no such file";
    public const string PiecesTooLarge = "pieces too large";
    public const string InUse = "already loaded";
    public const string Cancelled = MediaTracks.Cancelled;
    public const string Failed = "probe failed";
    public const string NotSupported = "not supported";

    public bool Checked => Unchecked is null;

    public static HeaderProbeResult Skipped(string? hash, string reason, TimeSpan elapsed = default) => new(hash, [], reason, 0, elapsed);
}

/// <summary>
/// Header probe results kept in the MediaProbe table (unique per hash and torrent file path, shape in
/// <see cref="MediaProbeTracks"/>), so a release whose header was read is never fetched for it again. Only checked
/// scans are kept: an unchecked one may work next time.
/// </summary>
internal static class HeaderProbeCache
{
    public static async Task<MediaTrackScan?> FindAsync(TorrentFlowDbContext db, string hash, string path, CancellationToken ct)
    {
        var row = await db.MediaProbes.AsNoTracking()
            .FirstOrDefaultAsync(p => p.InfoHash == hash && p.FilePath == path && p.ProbeVersion == MediaProbeTracks.Version, ct);
        return MediaProbeTracks.Read(row) is { } tracks ? new MediaTrackScan(row!.Container ?? "unknown", tracks, null, 0, 0) : null;
    }

    public static async Task SaveAsync(TorrentFlowDbContext db, string hash, HeaderProbeFile file, DateTime now, CancellationToken ct)
    {
        if (file.Scan.Unchecked is not null) return;
        var row = await db.MediaProbes.FirstOrDefaultAsync(p => p.InfoHash == hash && p.FilePath == file.Path, ct);
        if (row is null) db.MediaProbes.Add(row = new MediaProbe { Id = Ids.New(), InfoHash = hash, FilePath = file.Path });
        row.Container = file.Scan.Container;
        row.StreamsJson = MediaProbeTracks.Write(file.Scan.Tracks);
        row.ProbeVersion = MediaProbeTracks.Version;
        row.ProbedAt = now;
        row.UpdatedAt = now;
        await db.SaveChangesAsync(ct);
    }
}
