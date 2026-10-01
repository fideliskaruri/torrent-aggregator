using System.Text.RegularExpressions;

namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>formatAddTorrentMessage (clients/messages.ts): the owner-facing copy every sendToClient caller shows.</summary>
public static partial class EngineAddMessages
{
    public static string Format(EngineAddResult result)
    {
        if (!result.Ok || result.Details is not { } details) return result.Message;
        var pct = Math.Clamp((int)Math.Round(double.IsFinite(details.Pct) ? details.Pct : 0, MidpointRounding.AwayFromZero), 0, 100);
        if (details.Action == EngineAddDetails.AlreadyComplete) return $"Already complete ({pct}%)";
        // A queued add keeps the engine's own "Queued, #n in line" copy; "Download started" would be untrue.
        if (details.Action == EngineAddDetails.Queued) return result.Message;
        var peers = Math.Max(0, details.Peers);
        var suffix = $"{pct}% · {peers} {(peers == 1 ? "peer" : "peers")}";
        return details.Action == EngineAddDetails.AlreadyDownloading ? $"Download already in progress ({suffix})" : $"Download started ({suffix})";
    }

    public static EngineAddResult WithFormattedMessage(EngineAddResult result) => result with { Message = Format(result) };

    /// <summary>
    /// What the download log keeps of an add. <see cref="Format"/> also gives the progress, peers or queue
    /// place, which hold only at the moment of the add; a log entry is read long after.
    /// </summary>
    public static string Outcome(EngineAddResult result)
    {
        if (!result.Ok) return result.Message;
        // Relayed from an add made elsewhere (an auto-rule's episode grab), only the formatted copy is left.
        if (result.Details is not { } details) return WithoutMomentOfAdd(result.Message);
        return details.Action switch
        {
            EngineAddDetails.AlreadyComplete => "Already complete",
            EngineAddDetails.AlreadyDownloading => "Download already in progress",
            EngineAddDetails.Queued => "Queued",
            _ => "Download started",
        };
    }

    /// <summary>A logged message reduced to its <see cref="Outcome"/>: entries logged before it hold the <see cref="Format"/> copy.</summary>
    public static string? LoggedOutcome(string? message) => message is null ? null : WithoutMomentOfAdd(message);

    private static string WithoutMomentOfAdd(string message) => MomentOfAdd().Replace(message, "${outcome}");

    // Entries logged before the copy dropped its em dash read "Queued — #n in line".
    [GeneratedRegex(@"(?<outcome>Download started|Download already in progress) \(\d+% · \d+ peers?\)|(?<outcome>Already complete) \(\d+%\)|(?<outcome>Queued)(?:,| —) #\d+ in line")]
    private static partial Regex MomentOfAdd();
}
