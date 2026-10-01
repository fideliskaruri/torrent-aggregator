using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>Where one release's language puts it in the ladder: the fit, the reason code for the activity counts, and the words.</summary>
internal sealed record LanguageCall(LanguageFit Fit, string? Code, string Label)
{
    public bool HeldBack => Fit is LanguageFit.Backup or LanguageFit.Clash;
}

/// <summary>
/// What one send records on its GrabJob row: the rung that found the release and its language call. A fallback send
/// (the last-resort pass) and a hand pick accept a language clash.
/// </summary>
/// <param name="Missing">What the fallback stands in for, "no Japanese release found".</param>
internal sealed record SendContext(string? Rung, LanguageCall? Language, bool Fallback = false, string? Missing = null, bool Picked = false)
{
    public bool AcceptClash => Fallback || Picked;

    /// <summary>The GrabJob's language column: the label, or "fallback: French audio, no Japanese release found".</summary>
    public string? Note => Language == null ? null
        : Fallback ? $"fallback: {Language.Label}{(Missing == null ? "" : $", {Missing}")}"
        : Picked ? $"picked by hand: {Language.Label}" : Language.Label;

    public static string RungLabel(LadderRung rung) => $"{rung.Kind}: {rung.Query}";
}

/// <summary>
/// The backups and clashes the normal pass held back (docs/release-language.md). They are sent only after every rung is
/// exhausted with no working send: backups first, then clashes, each in the order the ladder found them. A release the
/// engine refused for its language joins the clashes after the ones judged by name.
/// </summary>
internal sealed class LanguageHold
{
    internal sealed record Held(TorrentResult Release, LanguageCall Call, string Rung, bool Relaxed, bool Confirmed);

    private readonly List<Held> held = [];
    private readonly HashSet<string> keys = new(StringComparer.Ordinal);

    /// <summary>Candidate keys already held, for <see cref="EpisodeLadder.Select"/>.</summary>
    public ISet<string> Keys => keys;
    public int Count => held.Count;

    public void Add(TorrentResult release, LanguageCall call, string rung, bool relaxed, bool confirmed = false)
    {
        if (keys.Add(EpisodeLadder.CandidateKey(release)) || confirmed)
            held.Add(new(release, call, rung, relaxed, confirmed));
    }

    public IEnumerable<Held> Ordered() =>
        held.OrderBy(h => h.Call.Fit == LanguageFit.Backup && !h.Confirmed ? 0 : 1).ThenBy(h => h.Confirmed ? 1 : 0).ToList();
}
