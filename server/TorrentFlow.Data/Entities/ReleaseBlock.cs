namespace TorrentFlow.Data.Entities;

/// <summary>
/// A release this user doesn't want picked again (<see cref="ReleaseBlocks"/>). Keyed by user and info hash, so the
/// block holds wherever the same torrent turns up. No link to works or downloads: a block outlives both.
/// </summary>
public sealed class ReleaseBlock
{
    public string UserId { get; set; } = null!;
    /// <summary>Lower-case 40-hex info hash.</summary>
    public string Hash { get; set; } = null!;
    /// <summary>The work it was blocked for; empty when the download had no known work.</summary>
    public string WorkKey { get; set; } = null!;
    /// <summary>Same values as <see cref="ReleaseAttempt.Scope"/>: an episode queue key (<c>s00001e00028</c>), <c>season:N</c> or <c>movie</c>.</summary>
    public string Scope { get; set; } = null!;
    /// <summary><see cref="ReleaseBlocks.Replaced"/> or <see cref="ReleaseBlocks.FailedVideoCheck"/>.</summary>
    public string Reason { get; set; } = null!;
    /// <summary>The release name, when known.</summary>
    public string? Title { get; set; }
    /// <summary>The search site it came from, when known.</summary>
    public string? Source { get; set; }
    /// <summary>The info hash that replaced it, for <see cref="ReleaseBlocks.Replaced"/>.</summary>
    public string? ReplacedBy { get; set; }
    /// <summary>What wrote it: <see cref="ReleaseBlocks.FromSwap"/>, <see cref="ReleaseBlocks.FromVideoCheck"/> or <see cref="ReleaseBlocks.FromMigration"/>.</summary>
    public string Origin { get; set; } = null!;
    public DateTime CreatedAt { get; set; }
}
