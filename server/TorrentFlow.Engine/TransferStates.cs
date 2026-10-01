using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Engine;

/// <summary>
/// The one table from a transfer's raw state (stored row, live built-in client, qBittorrent, Transmission) to the
/// state the UI shows. Every engine reports in this vocabulary so a paused or finished download reads the same
/// whichever client holds it.
/// </summary>
public static class TransferStates
{
    public const string MetaDl = "metaDL";
    public const string Checking = "checkingDL";
    public const string Downloading = "downloading";
    public const string Stalled = "stalledDL";
    public const string Queued = "queued";
    public const string Paused = "paused";
    public const string Downloaded = "downloaded";
    public const string Error = "error";
    public const string MissingFiles = "missingFiles";

    private static readonly Dictionary<string, string> Raw = new(StringComparer.OrdinalIgnoreCase)
    {
        // Built-in client (MonoTorrent snapshot).
        ["complete"] = Downloaded,
        ["error"] = Error,
        ["metaDL"] = MetaDl,
        ["checkingDL"] = Checking,
        ["downloading"] = Downloading,
        ["stalledDL"] = Stalled,
        // qBittorrent (4.x and 5.x names).
        ["forcedMetaDL"] = MetaDl,
        ["forcedDL"] = Downloading,
        ["allocating"] = Checking,
        ["checkingUP"] = Checking,
        ["checkingResumeData"] = Checking,
        ["moving"] = Checking,
        ["queuedDL"] = Queued,
        ["pausedDL"] = Paused,
        ["stoppedDL"] = Paused,
        ["pausedUP"] = Paused,
        ["stoppedUP"] = Paused,
        ["uploading"] = Downloaded,
        ["stalledUP"] = Downloaded,
        ["forcedUP"] = Downloaded,
        ["queuedUP"] = Downloaded,
        ["missingFiles"] = MissingFiles,
        // Already canonical, or the stored "seeding" status.
        ["seeding"] = Downloaded,
        ["queued"] = Queued,
        ["paused"] = Paused,
        ["downloaded"] = Downloaded,
    };

    /// <summary>A raw client state in the UI vocabulary. Unknown states pass through unchanged.</summary>
    public static string FromClient(string? state) =>
        string.IsNullOrWhiteSpace(state) ? MetaDl : Raw.TryGetValue(state.Trim(), out var ui) ? ui : state.Trim();

    /// <summary>Transmission's numeric torrent status in the UI vocabulary.</summary>
    public static string FromTransmission(long code) => code switch
    {
        0 => Paused,
        1 or 2 => Checking,
        3 => Queued,
        4 => Downloading,
        5 or 6 => Downloaded,
        _ => $"status_{code}",
    };

    /// <summary>The UI state of a stored row that is not live in the client.</summary>
    public static string FromStored(EngineTorrent row)
    {
        var status = row.Status.ToLowerInvariant();
        if (status == EngineTorrentStatus.Error) return Error;
        if (TorrentEngineService.IsDownloaded(row)) return Downloaded;
        if (status is EngineTorrentStatus.Paused or EngineTorrentStatus.Parked) return Paused;
        // Waiting for a slot. Distinct from paused: the owner did not stop it, so the UI offers "Download now".
        if (status == EngineTorrentStatus.Queued) return Queued;
        return row.Progress > 0 ? Downloading : MetaDl;
    }
}
