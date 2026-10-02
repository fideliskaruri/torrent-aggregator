using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>What a subtitle track is for (docs/release-language.md, "Track roles"). Only a full track carries the dialogue.
/// Commentary also marks an audio track named for a commentary or an audio description: it makes no language claim.</summary>
public enum SubtitleRole { Unknown, Full, SignsSongs, Forced, Commentary }

/// <summary>
/// One audio or subtitle track as the judge sees it, kept through the verdict: read from the file's own header, from an
/// indexer's track list (AnimeTosho) or from a sidecar file.
/// </summary>
/// <param name="Language">ISO 639-1 (<see cref="LanguageTag.Normalize"/>). For an und or missing tag, the language the
/// track's name gives ("English", "Eng", 英語, Inglés), else null.</param>
/// <param name="Source"><see cref="Header"/>, <see cref="Indexer"/> or <see cref="File"/>.</param>
/// <param name="Role">For subtitles: from the name, then the forced flag (<see cref="ReleaseLanguage.Role"/>); the name
/// beats the flag.</param>
/// <param name="ForcedHint">Flagged forced, but counted as full: its name says nothing about signs or forced and no other
/// track of its language carries the dialogue, so the flag was only a display hint (SubsPlease flags its one English
/// track forced). A Pass that rests on such tracks alone is slightly less sure than a header fact.</param>
public sealed record TrackFact(MediaTrackKind Kind, string? Language, string? Name, bool Forced, bool Default, string Source, SubtitleRole Role,
    bool ForcedHint = false)
{
    public const string Header = "header";
    public const string Indexer = "indexer";
    public const string File = "file";

    /// <summary>A track that can carry the dialogue: full (by its name, or flagged forced but read as a display hint), or
    /// no name and not forced. Signs, songs, forced and commentary tracks can't.</summary>
    public bool Dialogue => Kind == MediaTrackKind.Subtitle && Role is SubtitleRole.Full or SubtitleRole.Unknown;

    /// <summary>English subtitles under the owner's rule: an English track that carries the dialogue.</summary>
    public bool EnglishSubtitles => Dialogue && Language == "en";

    /// <summary>One track as its header or an indexer lists it. A forced flag on a track whose name says nothing about its
    /// role is settled against the other tracks of its video in <see cref="ReleaseLanguage.WithTracks"/>.</summary>
    public static TrackFact From(MediaTrack track, string source)
    {
        var name = string.IsNullOrWhiteSpace(track.Name) ? null : track.Name.Trim();
        var role = track.Kind == MediaTrackKind.Subtitle ? ReleaseLanguage.Role(name, track.Forced)
            : ReleaseLanguage.IsCommentary(name) ? SubtitleRole.Commentary : SubtitleRole.Unknown;
        return new(track.Kind, track.Language ?? ReleaseLanguage.NameLanguage(name), name, track.Forced, track.Default, source, role);
    }
}

public static partial class ReleaseLanguage
{
    /// <summary>
    /// A subtitle track's role from its name, then its forced flag: the name beats the flag. A name saying commentary or
    /// audio description ("Commentary", "Director's Commentary", "English (Audio Description)") makes it Commentary: never
    /// the dialogue. A name saying forced
    /// ("Forced", "English (Forced)", "Foreign parts only") makes it Forced. A name saying dialogue, full or captions
    /// ("Dialogue", "Full Subtitles", "English [CC]", "SDH") makes it Full; one saying signs or songs ("Signs", "Signs &amp;
    /// Songs", "S&amp;S", "English[Signs]", "Lyrics") makes it SignsSongs. Otherwise the forced flag makes it Forced, and
    /// <see cref="WithTracks"/> turns that into Full when no other track of its language carries the dialogue (the flag was a
    /// display hint). Any other name (plain "English", a source or group such as Erai-raws' "CR") is Full, and no name at
    /// all is Unknown. MP4 tx3g tracks have no forced flag, so their name decides.
    /// </summary>
    public static SubtitleRole Role(string? name, bool forced)
    {
        if (!string.IsNullOrWhiteSpace(name))
        {
            if (CommentaryName().IsMatch(name)) return SubtitleRole.Commentary;
            if (ForcedName().IsMatch(name)) return SubtitleRole.Forced;
            if (FullName().IsMatch(name)) return SubtitleRole.Full;
            if (SignsName().IsMatch(name)) return SubtitleRole.SignsSongs;
        }
        if (forced) return SubtitleRole.Forced;
        return string.IsNullOrWhiteSpace(name) ? SubtitleRole.Unknown : SubtitleRole.Full;
    }

    /// <summary>
    /// The forced flag only tells a signs or forced track apart from a track of the same language that carries the
    /// dialogue (two tracks named "English", one forced: the forced one is signs). With no such track beside it, a track
    /// flagged forced whose name says nothing about signs or forced is the full one: players show forced tracks by
    /// default, so some groups flag their only English track forced (SubsPlease). It counts as full, marked
    /// <see cref="TrackFact.ForcedHint"/>. The video's sidecar files count as tracks beside it.
    /// </summary>
    private static List<TrackFact> SettleForcedFlags(IReadOnlyList<TrackFact> tracks, IReadOnlyList<TrackFact> beside)
    {
        var all = beside.Concat(tracks).ToList();
        return tracks.Select(t => t.Kind == MediaTrackKind.Subtitle && t.Role == SubtitleRole.Forced && t.Forced &&
            !(t.Name is { } name && ForcedName().IsMatch(name)) &&
            !all.Any(other => other.Kind == MediaTrackKind.Subtitle && other.Language == t.Language && other.Dialogue)
                ? t with { Role = SubtitleRole.Full, ForcedHint = true }
                : t).ToList();
    }

    /// <summary>The language a track's name gives: "English", "Eng", 英語, "Inglés", "Anglais", "Englisch", "Spanish
    /// (Latin American) / Español"; null when the name names none ("Signs", "CR").</summary>
    public static string? NameLanguage(string? name)
    {
        if (string.IsNullOrWhiteSpace(name)) return null;
        var text = name.Trim();
        foreach (Match match in Word().Matches(text))
        {
            var upper = match.Value.ToUpperInvariant();
            if (EnglishNames.Contains(upper)) return "en";
            if (Words.TryGetValue(upper, out var word)) return word;
            if (Codes.TryGetValue(upper, out var code) && !Risky.Contains(upper)) return code;
        }
        if (EnglishScripts.Any(s => text.Contains(s, StringComparison.OrdinalIgnoreCase))) return "en";
        if (text.Contains("日本語")) return "ja";
        if (text.Contains("中文") || ChineseText.Any(text.Contains)) return "zh";
        return text.Length == 2 && TwoLetter.TryGetValue(text.ToUpperInvariant(), out var two) ? two : null;
    }

    /// <summary>
    /// Adds tracks read from the file itself (the header probe) or from an indexer's list, the strongest evidence there
    /// is. Only a track that carries the dialogue is a subtitle language: a "Signs" or "Forced" English track is kept as a
    /// fact but never counts as English subtitles, while a lone track flagged forced and named for its language does
    /// (<see cref="SettleForcedFlags"/>). Once a file's subtitle tracks are listed, each with a language, they replace what
    /// the name, the site category or a group says about subtitles (burned-in subtitles excepted). A dialogue track with
    /// no language keeps the subtitles open.
    /// </summary>
    public static LanguageFacts WithTracks(LanguageFacts facts, IEnumerable<TrackFact>? tracks)
    {
        var list = SettleForcedFlags(tracks?.Where(t => t.Kind != MediaTrackKind.Video).ToList() ?? [], facts.Tracks);
        var header = tracks?.Any(t => t.Source == TrackFact.Header) == true;
        if (list.Count == 0 && !header) return facts;
        var audio = facts.Audio.ToDictionary(c => c.Language, StringComparer.Ordinal);
        var subtitles = new Dictionary<string, LanguageClaim>(StringComparer.Ordinal);
        var listed = header || list.Any(t => t.Kind == MediaTrackKind.Subtitle && t.Source == TrackFact.Indexer);
        var untagged = facts.UntaggedSubtitles;
        foreach (var track in list)
        {
            var basis = track.Source == TrackFact.File ? "files" : track.Source;
            if (track.Kind == MediaTrackKind.Subtitle)
            {
                if (!track.Dialogue) continue;
                if (track.Language is null) untagged = true;
                else subtitles[track.Language] = new(track.Language, LanguageConfidence.HeaderFact, basis);
            }
            else if (track.Kind == MediaTrackKind.Audio && track.Language is not null && track.Role != SubtitleRole.Commentary)
                audio[track.Language] = new(track.Language, LanguageConfidence.HeaderFact, basis);
        }
        var keepNamed = !listed || untagged || facts.HardSubbed;
        foreach (var claim in facts.Subtitles)
            if ((keepNamed || claim.Basis is "files" or "header" or "indexer") && !subtitles.ContainsKey(claim.Language))
                subtitles[claim.Language] = claim;
        return facts with
        {
            Audio = audio.Values.OrderByDescending(Strength).ToArray(),
            Subtitles = subtitles.Values.OrderByDescending(Strength).ToArray(),
            Tracks = [.. facts.Tracks, .. list],
            HeaderRead = facts.HeaderRead || header,
            SubtitlesListed = facts.SubtitlesListed || listed,
            UntaggedSubtitles = untagged
        };
    }

    /// <summary>
    /// A release's verdict from its file list: each main video (<see cref="VideoSidecars.MainVideos"/>: the selected
    /// ones, or the largest and any at least half its size) is judged by <see cref="Verdict"/> with its own sidecars
    /// (<see cref="VideoSidecars.Of"/>) and, when known, its own tracks. The worst one counts. No video: the name's verdict.
    /// </summary>
    public static LanguageVerdict JudgeRelease(LanguageWant want, string? name, string? sourceCategory,
        IReadOnlyList<(int Index, string Path, long Length)> files, IReadOnlySet<int>? selected = null,
        Func<int, IEnumerable<TrackFact>?>? tracks = null)
    {
        var main = VideoSidecars.MainVideos(files, selected);
        if (main.Count == 0) return Verdict(want, name, sourceCategory);
        return main.Select(video => Verdict(want, name, sourceCategory, VideoSidecars.Paths(video, files), tracks?.Invoke(video.Index)))
            .MaxBy(v => (v.English.Verdict, v.Fit, v.Refusable))!;
    }

    /// <summary>A sidecar subtitle file as a track: its language suffix, and its role from the words after the base name
    /// (<c>.commentary.</c>, <c>.forced.</c>, <c>.signs.</c>, <c>.sdh.</c>, <c>English (Forced).srt</c>). An audio file named
    /// for a commentary or an audio description is Commentary too.</summary>
    private static TrackFact SidecarTrack(string stem, MediaTrackKind kind)
    {
        var segments = stem.Split('.');
        var tail = segments.Length == 1 ? stem : string.Join(' ', segments.Skip(Math.Max(1, segments.Length - 3)));
        var forced = ForcedName().IsMatch(tail);
        var role = CommentaryName().IsMatch(tail) ? SubtitleRole.Commentary
            : kind != MediaTrackKind.Subtitle ? SubtitleRole.Unknown
            : forced ? SubtitleRole.Forced
            : FullName().IsMatch(tail) ? SubtitleRole.Full
            : SignsName().IsMatch(tail) ? SubtitleRole.SignsSongs
            : SubtitleRole.Unknown;
        return new(kind, FileLanguage(stem), role == SubtitleRole.Unknown ? null : tail, forced, false, TrackFact.File, role);
    }

    /// <summary>A track name meaning a commentary, a director's commentary or an audio description
    /// (<see cref="SubtitleRole.Commentary"/>).</summary>
    public static bool IsCommentary(string? name) => !string.IsNullOrWhiteSpace(name) && CommentaryName().IsMatch(name);

    /// <summary>The English subtitle tracks that don't carry the dialogue, in words: "English signs and songs only",
    /// "English forced subtitles only", "English commentary subtitles only".</summary>
    private static string? PartialEnglish(LanguageFacts f)
    {
        var roles = f.Tracks.Where(t => t.Kind == MediaTrackKind.Subtitle && t.Language == "en" && !t.Dialogue).Select(t => t.Role).ToHashSet();
        if (roles.Count == 0) return null;
        if (roles.Count == 1 && roles.Contains(SubtitleRole.SignsSongs)) return "English signs and songs only";
        var words = new List<string>();
        if (roles.Contains(SubtitleRole.SignsSongs)) words.Add("signs");
        if (roles.Contains(SubtitleRole.Forced)) words.Add("forced");
        if (roles.Contains(SubtitleRole.Commentary)) words.Add("commentary");
        return $"English {Join(words)} subtitles only";
    }

    /// <summary>English subtitles that rest only on tracks flagged forced and read as a display hint
    /// (<see cref="TrackFact.ForcedHint"/>) are slightly less sure than a header fact: as sure as an explicit name marker.</summary>
    private static LanguageConfidence SubtitleEvidence(LanguageFacts f, LanguageConfidence evidence)
    {
        var english = f.Tracks.Where(t => t.EnglishSubtitles).ToList();
        return english.Count > 0 && english.All(t => t.ForcedHint) && evidence > LanguageConfidence.ExplicitSubs
            ? LanguageConfidence.ExplicitSubs : evidence;
    }

    /// <summary>English as other languages write it, for track names.</summary>
    private static readonly HashSet<string> EnglishNames = new(StringComparer.Ordinal)
    {
        "ENGLISH", "ENG", "INGLÉS", "INGLES", "INGLESE", "INGLÊS", "ANGLAIS", "ENGLISCH", "ENGELS", "ENGELSK", "ENGLANTI",
        "ANGIELSKI", "ANGOL", "INGILIZCE", "İNGILIZCE", "İNGİLİZCE", "INGGRIS", "АНГЛИЙСКИЙ", "АНГЛІЙСЬКА", "ΑΓΓΛΙΚΆ", "ΑΓΓΛΙΚΑ",
        "ANGLICKY", "ANGLICKÝ", "ANGLIČTINA", "ENGLEZĂ", "ENGLEZA",
    };

    private static readonly string[] EnglishScripts = ["英語", "英语", "英文", "영어", "אנגלית", "الإنجليزية", "อังกฤษ", "Tiếng Anh"];

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:forced|foreign[\s_-]*(?:parts?|only|dialogue|language)|non[\s_-]*english[\s_-]*parts?)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ForcedName();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:commentar(?:y|ies)|audio[\s_-]*descri(?:ption|bed|ptive)|descriptive[\s_-]*(?:audio|video)|described[\s_-]*video)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex CommentaryName();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:dialog(?:ue)?s?|full|cc|sdh|closed[\s_-]*captions?|captions?|hearing[\s_-]*impaired)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FullName();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:signs?|songs?|lyrics|karaoke|s\s*[&+]\s*s|op\s*[/&+]\s*ed)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex SignsName();
}
