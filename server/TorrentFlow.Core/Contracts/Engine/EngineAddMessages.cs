namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>formatAddTorrentMessage (clients/messages.ts): the owner-facing copy every sendToClient caller shows.</summary>
public static class EngineAddMessages
{
    public static string Format(EngineAddResult result)
    {
        if (!result.Ok || result.Details is not { } details) return result.Message;
        var pct = Math.Clamp((int)Math.Round(double.IsFinite(details.Pct) ? details.Pct : 0, MidpointRounding.AwayFromZero), 0, 100);
        if (details.Action == EngineAddDetails.AlreadyComplete) return $"Already complete ({pct}%)";
        var peers = Math.Max(0, details.Peers);
        var suffix = $"{pct}% · {peers} {(peers == 1 ? "peer" : "peers")}";
        return details.Action == EngineAddDetails.AlreadyDownloading ? $"Download already in progress ({suffix})" : $"Download started ({suffix})";
    }

    public static EngineAddResult WithFormattedMessage(EngineAddResult result) => result with { Message = Format(result) };
}
