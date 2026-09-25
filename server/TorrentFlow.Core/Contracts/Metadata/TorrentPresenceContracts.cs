namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>getBuiltinTorrentPresenceForAvailability (src/lib/clients/builtin-engine.ts): is a torrent loaded in the live engine?</summary>
public enum TorrentPresence
{
    /// <summary>The engine is not running or still loading; the caller cannot say.</summary>
    Unknown,
    Present,
    Absent,
}

/// <summary>
/// Live-engine presence for browse availability. The Metadata module registers a default that always answers
/// <see cref="TorrentPresence.Unknown"/> (the TS answer when the engine client is not constructed); the Engine
/// module can replace it with a real probe of its in-process handles.
/// </summary>
public interface ITorrentPresenceProbe
{
    TorrentPresence Presence(string userId, string infoHash);
}
