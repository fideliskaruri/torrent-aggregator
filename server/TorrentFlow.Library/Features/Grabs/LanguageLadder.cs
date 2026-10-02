using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>
/// The release labels' evidence for the one judge (<see cref="ReleaseLanguage.JudgeRelease"/>): the name and site
/// category, the transfer's own files when it has them (each main video with only its own sidecars), and the header
/// tracks the engine kept for the release (<see cref="TorrentFlow.Data.MediaProbeTracks"/>). The picker and the swap
/// dialog label every release this way.
/// </summary>
internal static class KnownLanguage
{
    /// <param name="files">The transfer's file list; null for a search result.</param>
    /// <param name="header">Torrent file path to the header tracks read from it; null when its header was never read.</param>
    public static LanguageVerdict Judge(LanguageWant want, string? name, string? category, IReadOnlyList<EngineFileInfo>? files,
        IReadOnlyDictionary<string, IReadOnlyList<MediaTrack>>? header)
    {
        IEnumerable<TrackFact>? Tracks(string path) =>
            header?.GetValueOrDefault(path)?.Select(t => TrackFact.From(t, TrackFact.Header));
        if (files is { Count: > 0 })
        {
            var list = files.Select(f => (f.Index, f.Path, f.Length)).ToList();
            var selected = files.All(f => f.Selected) ? null : files.Where(f => f.Selected).Select(f => f.Index).ToHashSet();
            return ReleaseLanguage.JudgeRelease(want, name, category, list, selected, index => Tracks(list.First(f => f.Index == index).Path));
        }
        if (header is not { Count: > 0 }) return ReleaseLanguage.Verdict(want, name, category);
        // A search result has no file list: the files whose header was read stand for it.
        var probed = header.Keys.Select((path, i) => (Index: i, Path: path, Length: 0L)).ToList();
        return ReleaseLanguage.JudgeRelease(want, name, category, probed, probed.Select(f => f.Index).ToHashSet(), index => Tracks(probed[index].Path));
    }
}

/// <summary>
/// Where one release's language puts it in the ladder: the owner's English rule (<see cref="EnglishCheck"/>), then the
/// fit that orders releases of the same verdict, the reason code for the activity counts, the words and the basis.
/// </summary>
internal sealed record LanguageCall(LanguageFit Fit, string? Code, string Label, string Basis, EnglishCheck English)
{
    public EnglishVerdict Verdict => English.Verdict;

    /// <summary>
    /// The reason code an automatic pick records for a release it would not send: the fit's code, else no_english for a
    /// Fail and english_unknown for an Unknown.
    /// </summary>
    public string? ReasonCode => Verdict switch
    {
        EnglishVerdict.Pass => null,
        EnglishVerdict.Fail => Code ?? "no_english",
        _ => Code ?? "english_unknown",
    };


    /// <summary>"English subtitles: Japanese audio, English subtitles (preferred, name)".</summary>
    public string Described => $"{English.Verdict.ToString().ToLowerInvariant()} ({English.Reason}): {Label} ({Fit.ToString().ToLowerInvariant()}, {Basis})";

    public static LanguageCall From(LanguageVerdict verdict) => new(verdict.Fit, verdict.Code, verdict.Label, verdict.Basis, verdict.English);

    /// <summary>The engine refused it: its file list showed no English (<see cref="TorrentFlow.Core.Contracts.Engine.EngineAddResult.Language"/>).</summary>
    public static LanguageCall Refused(string code)
    {
        var label = ReleaseLanguage.ReasonLabel(code);
        label = label.Length == 0 ? label : char.ToUpperInvariant(label[0]) + label[1..];
        return new(LanguageFit.Clash, code, label, "files", new(EnglishVerdict.Fail, label, LanguageConfidence.ExplicitAudio));
    }
}

/// <summary>What one send records on its GrabJob row: the rung that found the release and its language call. A hand pick accepts any language.</summary>
internal sealed record SendContext(string? Rung, LanguageCall? Language, bool Picked = false)
{
    public bool AcceptClash => Picked;

    /// <summary>The GrabJob's language column: "pass (English subtitles): Japanese audio, English subtitles (preferred, name)".</summary>
    public string? Note => Language == null ? null : Picked ? $"picked by hand: {Language.Described}" : Language.Described;

    /// <summary>The note plus what the engine's file-list check found, when it disagreed (<c>files: French audio</c>).</summary>
    public string? NoteWith(string? filesCode) => filesCode == null ? Note
        : $"{(Note == null ? "" : $"{Note}; ")}files: {ReleaseLanguage.ReasonLabel(filesCode)}";

    public static string RungLabel(LadderRung rung) => $"{rung.Kind}: {rung.Query}";
}

/// <summary>
/// What the English rule did to one automatic pick (docs/release-language.md): Pass releases are sent first. Unknown
/// releases are held and sent only when no healthy Pass release (<see cref="HealthySeeders"/> or more seeders) turned
/// up. Fail releases are never sent automatically; when nothing else is left the pick waits for an English release.
/// </summary>
internal sealed class LanguageHold
{
    /// <summary>Live seeders that make a Pass release healthy enough to rule out the Unknown ones.</summary>
    public const int HealthySeeders = 5;

    internal sealed record Held(TorrentResult Release, LanguageCall Call, string Rung, bool Relaxed);

    private readonly List<Held> held = [];
    private readonly HashSet<string> keys = new(StringComparer.Ordinal);
    private readonly HashSet<string> failed = new(StringComparer.Ordinal);

    /// <summary>Candidate keys already held or failed, for <see cref="EpisodeLadder.Select"/>.</summary>
    public ISet<string> Keys => keys;
    private readonly Dictionary<string, int> tried = new(StringComparer.Ordinal);

    /// <summary>A Pass release with enough seeders was tried, so Unknown releases are not sent.</summary>
    public bool HealthyPass => tried.Values.Any(s => s >= HealthySeeders);
    /// <summary>A Pass release was tried and not refused for its language.</summary>
    public bool TriedPass => tried.Count > 0;
    /// <summary>Releases that matched but have no English.</summary>
    public int Failed => failed.Count;
    public int Unknown => held.Count;

    public void Tried(TorrentResult release) => tried[EpisodeLadder.CandidateKey(release)] = release.Seeders;

    /// <summary>The engine's file-list check showed a tried release has no English: it counts as Fail.</summary>
    public void Refused(TorrentResult release)
    {
        var key = EpisodeLadder.CandidateKey(release);
        tried.Remove(key);
        keys.Add(key);
        failed.Add(key);
    }

    /// <summary>Holds an Unknown release, or counts a Fail one.</summary>
    public void Add(TorrentResult release, LanguageCall call, string rung, bool relaxed)
    {
        var key = EpisodeLadder.CandidateKey(release);
        if (!keys.Add(key)) return;
        if (call.Verdict == EnglishVerdict.Fail) failed.Add(key);
        else held.Add(new(release, call, rung, relaxed));
    }

    /// <summary>The Unknown releases to send, best seeded first, or none when a healthy Pass release exists.</summary>
    public IEnumerable<Held> Sendable() => HealthyPass ? [] : held.OrderByDescending(h => h.Release.Seeders).ToList();

    /// <summary>
    /// Asked only when nothing was sent: releases without English turned up, and every English or Unknown one was not
    /// allowed or failed to start. The pick waits for an English release.
    /// </summary>
    public bool WaitingForEnglish => failed.Count > 0;

}
