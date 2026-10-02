using System;

namespace TorrentFlow.Data.Entities;

/// <summary>
/// One release's language hint as an index told it before download (docs/release-language.md, "Hints before download"):
/// AnimeTosho's track lists by info hash, or apibay's file list by TPB id. A complete answer is kept for good (a hash's
/// files never change); a miss or an item still being processed is asked again after <see cref="RetryAt"/>, and a miss
/// for a release older than 30 days is kept for good too (no <see cref="RetryAt"/>).
/// </summary>
public partial class ReleaseHint
{
    public string Id { get; set; } = null!;

    /// <summary>animetosho or apibay.</summary>
    public string Source { get; set; } = null!;

    /// <summary>The info hash (animetosho) or the TPB id (apibay).</summary>
    public string Key { get; set; } = null!;

    /// <summary>complete, pending (the index is still processing it) or missing (the index doesn't have it).</summary>
    public string State { get; set; } = null!;

    /// <summary>The files and their tracks (<c>LanguageHintFile</c> JSON) when complete.</summary>
    public string? FilesJson { get; set; }

    /// <summary>Answers in a row that were not complete; each one doubles the wait before the next ask.</summary>
    public int Attempts { get; set; }

    public DateTime FetchedAt { get; set; }

    /// <summary>When to ask again; null for a complete answer or a permanent miss, which are never asked again.</summary>
    public DateTime? RetryAt { get; set; }

    /// <summary>
    /// The host that gave the answer (feed.animetosho.xyz, apibay.org). A miss only holds for that host: when the owner
    /// moves the source to another host, its misses are asked again there. A complete answer holds everywhere.
    /// </summary>
    public string? Host { get; set; }
}
