using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>How sure one language claim is, weakest first. A header fact outranks anything a name or a file list says.</summary>
public enum LanguageConfidence { None, GroupHeuristic, ProviderCategory, ExplicitSubs, ExplicitAudio, HeaderFact }

/// <summary>What is known about English subtitles. Untagged or "und" subtitles are Unknown, never English.</summary>
public enum SubtitleState { Unknown, KnownEnglish, KnownNonEnglish, Mixed }

/// <param name="Language">ISO 639-1 code (<see cref="LanguageTag.Normalize"/>), "other" for a non-English language the source
/// doesn't name, or the flag's own word (dual, multi, none) on a flag.</param>
/// <param name="Basis">Where it came from: name, category, files, header or group.</param>
public sealed record LanguageClaim(string Language, LanguageConfidence Confidence, string Basis);

/// <summary>What a release name, its provider category and its file names say about audio and subtitles (docs/release-language.md).</summary>
public sealed record LanguageFacts
{
    public static readonly LanguageFacts Empty = new();
    /// <summary>Audio languages, the strongest claim per language, strongest first.</summary>
    public IReadOnlyList<LanguageClaim> Audio { get; init; } = [];
    public IReadOnlyList<LanguageClaim> Subtitles { get; init; } = [];
    /// <summary>A dub the name announces ("English Dub"), in the dub's language. Only the header confirms it.</summary>
    public LanguageClaim? Dub { get; init; }
    /// <summary>The original audio plus English ("Dual Audio", "2A", an external English audio file).</summary>
    public LanguageClaim? DualAudio { get; init; }
    /// <summary>Several audio tracks with the default unknown ("MULTi", "German DL", a list of audio languages).</summary>
    public LanguageClaim? MultiAudio { get; init; }
    /// <summary>No subtitles ("RAW", nyaa "Anime - Raw").</summary>
    public LanguageClaim? Raw { get; init; }
    /// <summary>"English", "[ENG]" or 英語 alone: audio or subtitles, the name doesn't say which.</summary>
    public LanguageClaim? AmbiguousEnglish { get; init; }
    /// <summary>Subtitles burned into the picture (内嵌, Baha, "Hardsub", "HC", "hardcoded subs"). No track list shows them,
    /// so the name's subtitle claims survive the header (<see cref="ReleaseLanguage.WithTracks"/>).</summary>
    public bool HardSubbed { get; init; }
    /// <summary>The header probe read the file's own track list (<see cref="ReleaseLanguage.WithTracks"/>).</summary>
    public bool HeaderRead { get; init; }
    /// <summary>The file's subtitle tracks were listed, by its header or an indexer: names no longer speak for them.</summary>
    public bool SubtitlesListed { get; init; }
    /// <summary>A subtitle track that may carry the dialogue has no language tag and no telling name: it may be English.</summary>
    public bool UntaggedSubtitles { get; init; }
    /// <summary>Every track and sidecar file read for this video, with its language, name, flags, source and role.</summary>
    public IReadOnlyList<TrackFact> Tracks { get; init; } = [];

    public bool HasAudio(string language) => Audio.Any(c => c.Language == language);
    public LanguageClaim? StrongestAudio => Audio.Count > 0 ? Audio[0] : null;

    public SubtitleState SubtitleState
    {
        get
        {
            var english = Subtitles.Where(c => c.Language == "en").Select(c => c.Confidence).DefaultIfEmpty().Max();
            var foreign = Subtitles.Where(c => c.Language != "en").Select(c => c.Confidence).DefaultIfEmpty().Max();
            if (english == LanguageConfidence.None && foreign == LanguageConfidence.None)
                return Raw != null ? SubtitleState.KnownNonEnglish : SubtitleState.Unknown;
            if (foreign == LanguageConfidence.None) return SubtitleState.KnownEnglish;
            if (english == LanguageConfidence.None) return SubtitleState.KnownNonEnglish;
            return english >= foreign ? SubtitleState.KnownEnglish : SubtitleState.Mixed;
        }
    }
}

/// <summary>What the owner wants to hear.</summary>
/// <param name="Preference">auto, english or any (<see cref="ReleaseLanguage.NormalizePreference"/>).</param>
/// <param name="OriginalLanguage">The title's original language (TMDB original_language); null when the catalog doesn't know it.</param>
public sealed record LanguageWant(string Preference, bool Anime, string? OriginalLanguage)
{
    public static LanguageWant For(string? preference, string? mediaType, string? originalLanguage)
    {
        var anime = string.Equals(mediaType, "anime", StringComparison.OrdinalIgnoreCase);
        return new(ReleaseLanguage.NormalizePreference(preference) ?? ReleaseLanguage.Auto, anime,
            anime ? "ja" : LanguageTag.Normalize(originalLanguage));
    }
}

/// <summary>Does a release carry English audio or English subtitles? Best first, so it sorts.</summary>
public enum EnglishVerdict { Pass, Unknown, Fail }

/// <summary>One release under the owner's rule (docs/release-language.md, "The English rule").</summary>
/// <param name="Reason">Plain words: "English subtitles", "French subtitles only", "English not stated".</param>
/// <param name="Evidence">How sure the deciding fact is; a Pass below <see cref="LanguageConfidence.ExplicitSubs"/> is worth a header check.</param>
public sealed record EnglishCheck(EnglishVerdict Verdict, string Reason, LanguageConfidence Evidence)
{
    public static readonly EnglishCheck NotStated = new(EnglishVerdict.Unknown, "English not stated", LanguageConfidence.None);
    /// <summary>A Pass on a name marker, a sidecar file or the header, not on a group or site category alone.</summary>
    public bool Confirmed => Verdict == EnglishVerdict.Pass && Evidence >= LanguageConfidence.ExplicitSubs;
}

/// <summary>One release's language call under a want.</summary>
/// <param name="Code">The reason code for held and refused releases (audio_fr, subs_zh, no_subs, dub, multi); null when it fits.</param>
/// <param name="Label">Plain words for the owner: "French audio", "Japanese audio, English subtitles".</param>
/// <param name="Basis">What decided it: name, category, files, header, group or none.</param>
/// <param name="Confidence">high (header or explicit audio), medium (explicit subtitles or provider category) or low.</param>
/// <param name="Refusable">A clash on high-confidence evidence (explicit audio in the file list, or the header): the engine may refuse it.</param>
public sealed record LanguageVerdict(LanguageFit Fit, string? Code, string Label, string Basis, string Confidence, bool Refusable,
    LanguageFacts Facts)
{
    /// <summary>The owner's rule: English audio or English subtitles (<see cref="ReleaseLanguage.EnglishRule"/>).</summary>
    public EnglishCheck English { get; init; } = EnglishCheck.NotStated;

    public IReadOnlyList<string> Audio => Facts.Audio.Select(c => c.Language).ToArray();
    public IReadOnlyList<string> Subtitles => Facts.Subtitles.Select(c => c.Language).ToArray();
    public SubtitleState SubtitleState => Facts.SubtitleState;
}

/// <summary>
/// The one language rule (docs/release-language.md). <see cref="Detect"/> reads a release name, its provider category and
/// its file names into <see cref="LanguageFacts"/> with a confidence per claim; <see cref="Judge"/> places those facts
/// under the owner's want as Preferred, Neutral, Backup or Clash. Names only order releases; only a clash on explicit
/// audio in the file list or on a header fact may refuse one. Untagged is neutral, never English.
/// </summary>
public static partial class ReleaseLanguage
{
    public const string Auto = "auto";
    public const string English = "english";
    public const string Any = "any";

    /// <summary>auto, english or any; empty means auto; null for anything else.</summary>
    public static string? NormalizePreference(string? value) =>
        string.IsNullOrWhiteSpace(value) ? Auto : value.Trim().ToLowerInvariant() switch
        {
            Auto => Auto,
            English => English,
            Any => Any,
            _ => null
        };

    /// <summary>
    /// The one judge (docs/release-language.md): a release name and site category, one video with its own sidecar files
    /// (<paramref name="files"/>: the video's path and <see cref="VideoSidecars.Of"/>, never another video's files) and the
    /// tracks read from that video (header or indexer), under the owner's want. <see cref="Detect"/>, then
    /// <see cref="WithTracks"/>, then <see cref="Judge(LanguageWant, LanguageFacts)"/>. The engine's file-list and header
    /// checks, the season pack check, the picker, the swap dialog and the search order all come through here.
    /// </summary>
    public static LanguageVerdict Verdict(LanguageWant want, string? name, string? sourceCategory = null, IEnumerable<string>? files = null,
        IEnumerable<TrackFact>? tracks = null) =>
        Judge(want, WithTracks(Detect(name, sourceCategory, files), tracks));

    /// <summary>Reads the release name, the provider's own category (nyaa "Anime - English-translated") and, when known, its file paths.</summary>
    public static LanguageFacts Detect(string? name, string? sourceCategory = null, IEnumerable<string>? files = null)
    {
        var into = new Collector();
        if (!string.IsNullOrWhiteSpace(name)) ReadName(name, "name", into);
        ReadCategory(sourceCategory, into);
        if (files != null)
            foreach (var path in files)
                if (!string.IsNullOrWhiteSpace(path)) ReadFile(path, into);
        return into.Build();
    }

    /// <summary>A subtitle or audio file that can go with a video (<see cref="VideoSidecars"/>).</summary>
    public static bool IsSidecar(string path) => Extension(path) is { } extension &&
        (SubtitleExtensions.Contains(extension) || AudioExtensions.Contains(extension));

    /// <summary>The one order for releases under a want: the English rule first (Pass, Unknown, Fail), then the fit.</summary>
    public static int Order(LanguageVerdict verdict) => (int)verdict.English.Verdict * 10 + (int)verdict.Fit;

    /// <summary>"audio_fr" gives "French audio", "subs_zh" "Chinese subtitles only", "no_subs" "raw, no subtitles".</summary>
    public static string ReasonLabel(string code) => code switch
    {
        "no_english" => "no English audio or subtitles",
        "english_unknown" => "English not stated",
        "dub" => "English dub",
        "multi" => "several audio tracks",
        "no_subs" => "raw, no subtitles",
        "subs_other" => "non-English subtitles only",
        _ when code.StartsWith("audio_", StringComparison.Ordinal) => $"{LanguageName(code[6..])} audio",
        _ when code.StartsWith("subs_", StringComparison.Ordinal) => $"{LanguageName(code[5..])} subtitles only",
        _ => code
    };

    /// <summary>True for a language reason code (<see cref="ReasonLabel"/>).</summary>
    public static bool IsReason(string? code) => code is "dub" or "multi" or "no_subs" or "no_english" or "english_unknown" ||

        code?.StartsWith("audio_", StringComparison.Ordinal) == true || code?.StartsWith("subs_", StringComparison.Ordinal) == true;

    public static string LanguageName(string? code) => code == null ? "unknown" : code == "other" ? "non-English"
        : Names.TryGetValue(code, out var name) ? name : code;

    // ---------------------------------------------------------------- judging

    /// <summary>Places the facts under the want (the decision table in docs/release-language.md).</summary>
    public static LanguageVerdict Judge(LanguageWant want, LanguageFacts facts)
    {
        var preference = NormalizePreference(want.Preference) ?? Auto;
        facts = WithDualAudio(facts, want.Anime);
        var verdict = preference == Any ? Make(LanguageFit.Neutral, null, Describe(facts), facts, Decider(facts))
            : want.Anime ? JudgeAnime(preference, facts) : JudgeOther(preference, LanguageTag.Normalize(want.OriginalLanguage), facts);
        return verdict with { English = EnglishRule(want, facts) };
    }

    /// <summary>"Dual Audio" names its languages for anime: Japanese and English. Elsewhere it at least carries English.</summary>
    private static LanguageFacts WithDualAudio(LanguageFacts f, bool anime)
    {
        if (f.DualAudio is not { } dual) return f;
        var audio = f.Audio.ToList();
        var add = anime ? new[] { "ja", "en" } : ["en"];
        foreach (var language in add)
            if (audio.All(c => c.Language != language)) audio.Add(new(language, dual.Confidence, dual.Basis));
        return audio.Count == f.Audio.Count ? f : f with { Audio = audio.OrderByDescending(Strength).ToArray() };
    }

    /// <summary>
    /// The owner's rule (docs/release-language.md, "The English rule"): Pass when the release has English audio or English
    /// subtitles, Fail when it shows it has neither (a raw, foreign subtitles only, a foreign dub, a header without English,
    /// or listed subtitles whose only English is signs, songs or forced), Unknown otherwise. An untagged release of a
    /// title made in English passes: its audio is the original. English subtitles are only a track that carries the
    /// dialogue (<see cref="TrackFact.EnglishSubtitles"/>), never one named "Signs" or "Forced". A forced flag alone is not
    /// enough to rule a track out: the name beats the flag (<see cref="Role"/>).
    /// </summary>
    public static EnglishCheck EnglishRule(LanguageWant want, LanguageFacts f)
    {
        if ((NormalizePreference(want.Preference) ?? Auto) == Any) return new(EnglishVerdict.Pass, "Any language is fine", LanguageConfidence.None);
        var headerAudio = f.Audio.Where(c => c.Basis == "header").ToList();
        var headerTold = f.HeaderRead && headerAudio.Count > 0;
        var englishAudio = f.Audio.FirstOrDefault(c => c.Language == "en") ?? (f.Dub?.Language == "en" ? f.Dub : null);
        // Once the header listed the audio tracks, a name's English audio claim no longer counts.
        if (englishAudio != null && (!headerTold || englishAudio.Basis is "header" or "files"))
            return new(EnglishVerdict.Pass, f.Dub?.Language == "en" && englishAudio.Basis != "header" ? "English dub" : "English audio", englishAudio.Confidence);
        var englishSubs = f.Subtitles.FirstOrDefault(c => c.Language == "en");
        var subs = f.SubtitleState;
        var partial = PartialEnglish(f);
        // The header read every track: no English audio, no English subtitle track, and none left untagged. Only a sidecar
        // file, an explicit name marker on burned-in subtitles, or the file's own tracks still count for English subtitles.
        if (headerTold && !f.UntaggedSubtitles && (englishSubs == null || englishSubs.Basis is not ("header" or "indexer" or "files") &&
                !(f.HardSubbed && englishSubs.Confidence >= LanguageConfidence.ExplicitSubs)))
            return new(EnglishVerdict.Fail, $"The file has {Join(headerAudio.Select(c => LanguageName(c.Language)))} audio and " +
                (partial ?? "no English subtitles"), LanguageConfidence.HeaderFact);
        if (subs == SubtitleState.KnownEnglish && englishSubs != null)
            return new(EnglishVerdict.Pass, "English subtitles", SubtitleEvidence(f, englishSubs.Confidence));
        if (f.AmbiguousEnglish != null && subs != SubtitleState.KnownNonEnglish)
            return new(EnglishVerdict.Pass, "English audio or subtitles", f.AmbiguousEnglish.Confidence);
        var original = want.Anime ? "ja" : LanguageTag.Normalize(want.OriginalLanguage);
        var several = f.MultiAudio != null || f.DualAudio != null || f.Audio.Count >= 2;
        var foreign = f.Audio.Where(c => c.Language != original).ToList();
        var (_, subsName, subsClaim) = ForeignSubs(f);
        // A dub in a third language and nothing else: Russian MVO, a French dub.
        if (foreign.Count > 0 && !several)
            return new(EnglishVerdict.Fail, $"{LanguageName(foreign[0].Language)} audio", foreign[0].Confidence);
        // A title made in English carries English audio unless the name says otherwise (VOSTFR on an English film is English audio).
        // Any other known original language leaves it Unknown. An unknown one keeps the old heuristic: untagged counts as English.
        if (!want.Anime && original is null or "en")
            return new(EnglishVerdict.Pass, original == "en" ? "English original" : "Language not stated", LanguageConfidence.None);

        if (several && subs != SubtitleState.KnownNonEnglish)
            return new(EnglishVerdict.Unknown, "Several audio tracks, English not stated", (f.MultiAudio ?? f.StrongestAudio)?.Confidence ?? LanguageConfidence.None);
        if (f.Raw != null && subs != SubtitleState.KnownEnglish) return new(EnglishVerdict.Fail, "Raw, no subtitles", f.Raw.Confidence);
        if (subs == SubtitleState.KnownNonEnglish)
            return new(EnglishVerdict.Fail, $"{char.ToUpperInvariant(subsName[0])}{subsName[1..]} subtitles only", subsClaim?.Confidence ?? LanguageConfidence.None);
        if (subs == SubtitleState.Mixed)
            return new(EnglishVerdict.Unknown, $"{subsName} subtitles, maybe English too", subsClaim?.Confidence ?? LanguageConfidence.None);
        // Every subtitle track is listed (an indexer, or a header without audio tags) and the only English ones are signs or forced.
        if (partial != null && f.SubtitlesListed && !f.UntaggedSubtitles)
            return new(EnglishVerdict.Fail, char.ToUpperInvariant(partial[0]) + partial[1..], LanguageConfidence.HeaderFact);
        return EnglishCheck.NotStated;
    }

    private static LanguageVerdict JudgeAnime(string preference, LanguageFacts f)
    {
        var ja = f.HasAudio("ja");
        var en = f.HasAudio("en");
        var foreign = f.Audio.Where(c => c.Language is not ("ja" or "en")).ToList();
        var several = f.MultiAudio != null || f.DualAudio != null || f.Audio.Count >= 2;
        var dual = f.DualAudio != null || ja && en;
        var subs = f.SubtitleState;
        var (subsCode, subsName, subsClaim) = ForeignSubs(f);
        var englishSubs = f.Subtitles.FirstOrDefault(c => c.Language == "en");

        // A third language and nothing else: the wrong audio (a French or Chinese dub).
        if (foreign.Count > 0 && !several && !ja && !en)
            return Make(LanguageFit.Clash, $"audio_{foreign[0].Language}", $"{LanguageName(foreign[0].Language)} audio", f, foreign[0]);
        if (preference == English)
        {
            if (en)
            {
                var englishDub = f.Dub?.Language == "en" ? f.Dub : null;
                var label = dual ? "Japanese and English audio" : englishDub != null ? "English dub" : "English audio";
                return Make(LanguageFit.Preferred, null, label, f, englishDub ?? f.DualAudio ?? f.Audio.First(c => c.Language == "en"));
            }
            if (f.DualAudio != null)
                return Make(LanguageFit.Preferred, null, "Japanese and English audio", f, f.DualAudio);
            if (several)
                return subs == SubtitleState.KnownNonEnglish
                    ? Make(LanguageFit.Clash, subsCode, $"Several audio tracks, {subsName} subtitles", f, subsClaim)
                    : Make(LanguageFit.Backup, "multi", SeveralLabel(foreign), f, f.MultiAudio ?? foreign.FirstOrDefault());
            if (f.Raw != null && subs != SubtitleState.KnownEnglish)
                return Make(LanguageFit.Clash, "no_subs", "Raw, no subtitles", f, f.Raw);
            return subs switch
            {
                SubtitleState.KnownEnglish => Make(LanguageFit.Backup, "audio_ja", "Japanese audio, English subtitles", f, englishSubs),
                SubtitleState.KnownNonEnglish => Make(LanguageFit.Clash, subsCode, $"{subsName} subtitles only", f, subsClaim),
                SubtitleState.Mixed => Make(LanguageFit.Neutral, null, $"{subsName} subtitles, maybe English too", f, subsClaim),
                _ => Make(LanguageFit.Neutral, null, UnstatedLabel(f, ja), f, f.AmbiguousEnglish)
            };
        }
        // auto: Japanese audio with English subtitles first; the English dub is the backup.
        if (en && !ja && f.DualAudio == null && f.MultiAudio == null)
            return Make(LanguageFit.Backup, "dub", f.Dub?.Language == "en" ? "English dub" : "English audio", f,
                f.Dub?.Language == "en" ? f.Dub : f.Audio.First(c => c.Language == "en"));
        if (dual)
            return subs switch
            {
                SubtitleState.KnownEnglish => Make(LanguageFit.Preferred, null, "Japanese and English audio, English subtitles", f, englishSubs),
                SubtitleState.KnownNonEnglish => Make(LanguageFit.Backup, subsCode, $"Japanese and English audio, {subsName} subtitles", f, subsClaim),
                _ => Make(LanguageFit.Neutral, null, "Japanese and English audio", f, f.DualAudio ?? f.StrongestAudio)
            };
        if (several)
            return subs switch
            {
                SubtitleState.KnownEnglish => Make(LanguageFit.Neutral, null, "Several audio tracks, English subtitles", f, englishSubs),
                SubtitleState.KnownNonEnglish => Make(LanguageFit.Clash, subsCode, $"Several audio tracks, {subsName} subtitles", f, subsClaim),
                _ => Make(LanguageFit.Backup, "multi", SeveralLabel(foreign), f, f.MultiAudio ?? foreign.FirstOrDefault())
            };
        if (f.Raw != null && subs != SubtitleState.KnownEnglish)
            return Make(LanguageFit.Clash, "no_subs", "Raw, no subtitles", f, f.Raw);
        return subs switch
        {
            SubtitleState.KnownEnglish => Make(LanguageFit.Preferred, null, ja ? "Japanese audio, English subtitles" : "English subtitles", f, englishSubs),
            SubtitleState.KnownNonEnglish => Make(LanguageFit.Clash, subsCode, $"{subsName} subtitles only", f, subsClaim),
            SubtitleState.Mixed => Make(LanguageFit.Neutral, null, $"{subsName} subtitles, maybe English too", f, subsClaim),
            _ => Make(LanguageFit.Neutral, null, UnstatedLabel(f, ja), f, f.AmbiguousEnglish ?? f.StrongestAudio)
        };
    }

    private static LanguageVerdict JudgeOther(string preference, string? original, LanguageFacts f)
    {
        var englishClaim = f.Audio.FirstOrDefault(c => c.Language == "en");
        var englishLikely = englishClaim != null || f.AmbiguousEnglish != null && original is null or "en";
        var originalClaim = original is null or "en" ? null : f.Audio.FirstOrDefault(c => c.Language == original);
        var foreign = f.Audio.Where(c => c.Language != "en" && c.Language != original).ToList();
        var several = f.MultiAudio != null || f.DualAudio != null || f.Audio.Count >= 2;
        var subs = f.SubtitleState;
        var (subsCode, subsName, subsClaim) = ForeignSubs(f);

        if (foreign.Count > 0 && !several && !englishLikely && originalClaim == null)
            return Make(LanguageFit.Clash, $"audio_{foreign[0].Language}", $"{LanguageName(foreign[0].Language)} audio", f, foreign[0]);
        if (several)
            return Make(LanguageFit.Backup, "multi", f.Audio.Count >= 2 ? $"{Join(f.Audio.Select(c => LanguageName(c.Language)))} audio" : "Several audio tracks",
                f, f.MultiAudio ?? f.DualAudio ?? f.StrongestAudio);
        if (englishLikely)
        {
            if (subs == SubtitleState.KnownNonEnglish)
                return Make(LanguageFit.Backup, subsCode, $"English audio, {subsName} subtitles", f, subsClaim);
            return englishClaim != null
                ? Make(LanguageFit.Preferred, null, f.Dub?.Language == "en" ? "English dub" : "English audio", f, englishClaim)
                : Make(LanguageFit.Neutral, null, "English", f, f.AmbiguousEnglish);
        }
        if (originalClaim != null)
        {
            var name = LanguageName(original);
            var withSubs = subs == SubtitleState.KnownEnglish ? ", English subtitles" : "";
            return preference == English && subs != SubtitleState.KnownEnglish
                ? Make(LanguageFit.Clash, $"audio_{original}", $"{name} audio", f, originalClaim)
                : Make(LanguageFit.Backup, $"audio_{original}", $"{name} audio, the original language{withSubs}", f, originalClaim);
        }
        if (f.Raw != null && subs != SubtitleState.KnownEnglish)
            return original is null or "en"
                ? Make(LanguageFit.Neutral, null, "No subtitles", f, f.Raw)
                : Make(LanguageFit.Clash, "no_subs", "Raw, no subtitles", f, f.Raw);
        return subs switch
        {
            SubtitleState.KnownNonEnglish => original is null or "en"
                ? Make(LanguageFit.Backup, subsCode, $"{subsName} subtitles", f, subsClaim)
                : Make(LanguageFit.Clash, subsCode, $"{subsName} subtitles only", f, subsClaim),
            SubtitleState.KnownEnglish => Make(LanguageFit.Neutral, null, "English subtitles", f, f.Subtitles.FirstOrDefault(c => c.Language == "en")),
            SubtitleState.Mixed => Make(LanguageFit.Neutral, null, $"{subsName} subtitles, maybe English too", f, subsClaim),
            _ => Make(LanguageFit.Neutral, null, f.AmbiguousEnglish != null ? "English, audio or subtitles not clear" : "Language not stated",
                f, f.AmbiguousEnglish)
        };
    }

    private static LanguageVerdict Make(LanguageFit fit, string? code, string label, LanguageFacts facts, LanguageClaim? decider)
    {
        var confidence = decider?.Confidence ?? LanguageConfidence.None;
        var level = confidence >= LanguageConfidence.ExplicitAudio ? "high"
            : confidence >= LanguageConfidence.ProviderCategory ? "medium" : "low";
        // Only explicit audio in the file list or a header fact may refuse; a name, a category or a group only orders.
        var refusable = fit == LanguageFit.Clash && decider != null && confidence >= LanguageConfidence.ExplicitAudio &&
            decider.Basis is "files" or "header" && facts.Audio.Contains(decider);
        return new(fit, code, label, decider?.Basis ?? "none", level, refusable, facts);
    }

    private static LanguageClaim? Decider(LanguageFacts f) =>
        f.Audio.Concat(f.Subtitles).Concat(new[] { f.Dub, f.DualAudio, f.MultiAudio, f.Raw, f.AmbiguousEnglish }.OfType<LanguageClaim>())
            .OrderByDescending(Strength).FirstOrDefault();

    /// <summary>The strongest non-English subtitle language: its reason code, its name and its claim.</summary>
    private static (string Code, string Name, LanguageClaim? Claim) ForeignSubs(LanguageFacts f)
    {
        var claim = f.Subtitles.Where(c => c.Language != "en").OrderByDescending(c => c.Language == "other" ? 0 : 1).ThenByDescending(Strength)
            .FirstOrDefault();
        if (claim == null) return f.Raw != null ? ("no_subs", "no", f.Raw) : ("subs_other", "non-English", null);
        return ($"subs_{claim.Language}", LanguageName(claim.Language), claim);
    }

    private static string SeveralLabel(List<LanguageClaim> foreign) =>
        foreign.Count > 0 ? $"Several audio tracks, likely {LanguageName(foreign[0].Language)}" : "Several audio tracks";

    private static string UnstatedLabel(LanguageFacts f, bool japanese) =>
        f.AmbiguousEnglish != null ? "English, audio or subtitles not clear" : japanese ? "Japanese audio" : "Language not stated";

    /// <summary>The facts in plain words, for the "any" preference where nothing is judged.</summary>
    private static string Describe(LanguageFacts f)
    {
        var parts = new List<string>();
        if (f.Audio.Count == 2) parts.Add($"{Join(f.Audio.Select(c => LanguageName(c.Language)))} audio");
        else if (f.Audio.Count > 2 || f.MultiAudio != null) parts.Add("several audio tracks");
        else if (f.DualAudio != null) parts.Add("dual audio");
        else if (f.Dub != null) parts.Add($"{LanguageName(f.Dub.Language)} dub");
        else if (f.Audio.Count == 1) parts.Add($"{LanguageName(f.Audio[0].Language)} audio");
        var subs = f.SubtitleState;
        if (f.Raw != null && subs != SubtitleState.KnownEnglish) parts.Add("no subtitles");
        else if (subs == SubtitleState.KnownEnglish) parts.Add("English subtitles");
        else if (subs != SubtitleState.Unknown) parts.Add($"{ForeignSubs(f).Name} subtitles");
        if (parts.Count == 0) return f.AmbiguousEnglish != null ? "English, audio or subtitles not clear" : "Language not stated";
        var text = string.Join(", ", parts);
        return char.ToUpperInvariant(text[0]) + text[1..];
    }

    private static string Join(IEnumerable<string> names)
    {
        var list = names.Distinct().ToList();
        return list.Count <= 1 ? string.Concat(list) : $"{string.Join(", ", list.Take(list.Count - 1))} and {list[^1]}";
    }

    private static int Strength(LanguageClaim c) => (int)c.Confidence * 10 + c.Basis switch
    {
        "header" or "indexer" => 5,
        "files" => 4,
        "name" => 3,
        "category" => 2,
        "group" => 1,
        _ => 0
    };

    // ---------------------------------------------------------------- reading

    private sealed class Collector
    {
        private readonly Dictionary<string, LanguageClaim> audio = new(StringComparer.Ordinal);
        private readonly Dictionary<string, LanguageClaim> subtitles = new(StringComparer.Ordinal);
        public readonly List<TrackFact> Tracks = [];
        public LanguageClaim? Dub, Dual, Multi, Raw, Ambiguous;
        public bool HardSubbed;

        public void Audio(string language, LanguageConfidence confidence, string basis) => Keep(audio, new(language, confidence, basis));
        public void Subtitle(string language, LanguageConfidence confidence, string basis) => Keep(subtitles, new(language, confidence, basis));

        private static void Keep(Dictionary<string, LanguageClaim> claims, LanguageClaim claim)
        {
            if (!claims.TryGetValue(claim.Language, out var known) || Strength(claim) > Strength(known)) claims[claim.Language] = claim;
        }

        public static LanguageClaim Pick(LanguageClaim? known, LanguageClaim claim) => known == null || Strength(claim) > Strength(known) ? claim : known;

        public LanguageFacts Build() => new()
        {
            Audio = audio.Values.OrderByDescending(Strength).ToArray(),
            Subtitles = subtitles.Values.OrderByDescending(Strength).ToArray(),
            Dub = Dub,
            DualAudio = Dual,
            MultiAudio = Multi,
            Raw = Raw,
            AmbiguousEnglish = Ambiguous,
            HardSubbed = HardSubbed,
            Tracks = Tracks.ToArray()
        };
    }

    /// <summary>nyaa categories: 1_2 English-translated, 1_3 Non-English-translated, 1_4 Raw (4_x for live action).</summary>
    private static void ReadCategory(string? category, Collector into)
    {
        if (string.IsNullOrWhiteSpace(category)) return;
        var text = category.Trim().ToLowerInvariant();
        const LanguageConfidence level = LanguageConfidence.ProviderCategory;
        // "non-english-translated" contains "english-translated", so it is checked first.
        if (text is "1_3" or "4_3" || text.Contains("non-english-translated") || text.Contains("non-english translated"))
            into.Subtitle("other", level, "category");
        else if (text is "1_2" or "4_1" || text.Contains("english-translated") || text.Contains("english translated"))
            into.Subtitle("en", level, "category");
        else if (text is "1_4" or "4_4" || (text.Contains("anime") || text.Contains("live action")) && RawWord().IsMatch(text))
            into.Raw = Collector.Pick(into.Raw, new("none", level, "category"));
    }

    private static void ReadFile(string path, Collector into)
    {
        var normalized = path.Replace('\\', '/').Trim();
        var slash = normalized.LastIndexOf('/');
        var file = normalized[(slash + 1)..];
        var dot = file.LastIndexOf('.');
        var stem = dot > 0 ? file[..dot] : file;
        var extension = Extension(normalized);
        if (extension != null && SubtitleExtensions.Contains(extension))
        {
            // An untagged subtitle file says nothing: Unknown, never English. A signs, songs or forced one is kept as a
            // fact but never counts as that language's subtitles (".en.forced.srt").
            var track = SidecarTrack(stem, MediaTrackKind.Subtitle);
            into.Tracks.Add(track);
            if (track.Dialogue && track.Language is { } language) into.Subtitle(language, LanguageConfidence.ExplicitSubs, "files");
            return;
        }
        if (extension != null && AudioExtensions.Contains(extension))
        {
            var track = SidecarTrack(stem, MediaTrackKind.Audio);
            into.Tracks.Add(track);
            // A commentary or audio description track is not the film's audio in that language.
            if (track.Language is not { } language || track.Role == SubtitleRole.Commentary) return;
            into.Audio(language, LanguageConfidence.ExplicitAudio, "files");
            // An external audio track sits beside the video's own, so the release has at least two.
            var flag = new LanguageClaim(language == "en" ? "dual" : "multi", LanguageConfidence.ExplicitAudio, "files");
            if (language == "en") into.Dual = Collector.Pick(into.Dual, flag);
            else into.Multi = Collector.Pick(into.Multi, flag);
            return;
        }
        if (!MediaFileRules.IsVideo(normalized)) return;
        ReadName(stem, "files", into);
        if (slash > 0)
        {
            var folder = normalized[..slash];
            var parent = folder[(folder.LastIndexOf('/') + 1)..];
            if (parent.Length > 0) ReadName(parent, "files", into);
        }
    }

    /// <summary>The language suffix of a subtitle or audio file: "Show - 05.eng.ass", ".pt-BR.srt", ".chs.ass", "2_English.srt".</summary>
    private static string? FileLanguage(string stem)
    {
        var segments = stem.Split('.', StringSplitOptions.TrimEntries);
        if (segments.Length == 1) return SegmentLanguage(segments[0]);
        for (var i = segments.Length - 1; i >= 1 && i >= segments.Length - 3; i--)
        {
            var lower = segments[i].ToLowerInvariant();
            if (lower.Length == 0 || SubtitleNoise.Contains(lower)) continue;
            // "Movie.en.hi.srt": hi is hearing impaired after a language, Hindi otherwise.
            if (lower == "hi" && i >= 2 && SegmentLanguage(segments[i - 1]) != null) continue;
            return SegmentLanguage(segments[i]);
        }
        return null;
    }

    private static string? SegmentLanguage(string segment)
    {
        var lower = segment.Trim().ToLowerInvariant();
        if (lower.Length == 0) return null;
        if (ChineseSubtitleCodes.Contains(lower)) return "zh";
        if (lower.Length == 2 && TwoLetter.TryGetValue(lower.ToUpperInvariant(), out var two)) return two;
        if (lower.Length == 3 && Codes.TryGetValue(lower.ToUpperInvariant(), out var three)) return three;
        if (lower.Contains('-') && lower.Length <= 12 && !lower.Contains(' ') && LanguageTag.Normalize(lower) is { } tag) return tag;
        var words = Word().Matches(segment).Select(m => m.Value).ToList();
        if (words.Count is > 0 and <= 3)
            for (var i = words.Count - 1; i >= 0; i--)
            {
                var upper = words[i].ToUpperInvariant();
                if (Words.TryGetValue(upper, out var word)) return word;
                if (Codes.TryGetValue(upper, out var code)) return code;
                if (Markers.TryGetValue(upper, out var marker) && marker.Mark == Mark.Subs) return marker.Language;
                if (ChineseSubtitleCodes.Contains(words[i].ToLowerInvariant())) return "zh";
            }
        if (ChineseText.Any(segment.Contains)) return "zh";
        if (segment.Contains('英')) return "en";
        return null;
    }

    private static string? Extension(string path)
    {
        var name = path.Replace('\\', '/');
        name = name[(name.LastIndexOf('/') + 1)..];
        var dot = name.LastIndexOf('.');
        return dot > 0 && dot < name.Length - 1 ? name[(dot + 1)..].ToLowerInvariant() : null;
    }

    private enum GroupKind { EnglishSubs, ChineseSubs, Raw, French }

    private static void ReadName(string text, string basis, Collector into)
    {
        ReadCjk(text, basis, into);
        var scan = text.ToCharArray();
        var french = false;
        foreach (var (pattern, kind) in Groups)
            foreach (Match match in pattern.Matches(text))
            {
                Array.Fill(scan, ' ', match.Index, match.Length);
                const LanguageConfidence level = LanguageConfidence.GroupHeuristic;
                switch (kind)
                {
                    case GroupKind.EnglishSubs: into.Subtitle("en", level, "group"); break;
                    case GroupKind.ChineseSubs: into.Subtitle("zh", level, "group"); break;
                    case GroupKind.Raw: into.Raw = Collector.Pick(into.Raw, new("none", level, "group")); break;
                    case GroupKind.French: french = true; break;
                }
            }
        var blanked = new string(scan);
        // A leading bracket names the group ("[SubsPlease]") unless it holds release info ("[BDRip 1080p ENG-AC3]").
        if (LeadingBracket().Match(blanked) is { Success: true } lead && !Anchor().IsMatch(lead.Value))
            Array.Fill(scan, ' ', lead.Index, lead.Length);
        var cyrillic = Cyrillic().IsMatch(text);
        Walk(MergeHardSubs(Tokenize(new string(scan))), basis, into, cyrillic ? "ru" : "en");
        // Russian trackers: "Dub + Original + Sub" carries the original audio next to the Russian dub.
        if (cyrillic && into.Dub?.Language == "ru" && OriginalTrack().IsMatch(text))
            into.Multi = Collector.Pick(into.Multi, new("multi", LanguageConfidence.GroupHeuristic, basis));
        // French release groups: MULTi means French default audio, otherwise French subtitles (docs/release-language.md).
        if (french)
        {
            if (into.Multi != null || into.Dual != null) into.Audio("fr", LanguageConfidence.GroupHeuristic, "group");
            else into.Subtitle("fr", LanguageConfidence.GroupHeuristic, "group");
        }
    }

    private static void ReadCjk(string text, string basis, Collector into)
    {
        if (!Cjk().IsMatch(text)) return;
        var dub = false;
        if (EnglishDubText.Any(text.Contains))
        {
            into.Audio("en", LanguageConfidence.ExplicitAudio, basis);
            into.Dub = Collector.Pick(into.Dub, new("en", LanguageConfidence.ExplicitAudio, basis));
            dub = true;
        }
        if (ChineseAudioText.Any(text.Contains)) into.Audio("zh", LanguageConfidence.ExplicitAudio, basis);
        if (ChineseEnglishAudioText.Any(text.Contains))
        {
            into.Audio("zh", LanguageConfidence.ExplicitAudio, basis);
            into.Audio("en", LanguageConfidence.ExplicitAudio, basis);
            into.Multi = Collector.Pick(into.Multi, new("multi", LanguageConfidence.ExplicitAudio, basis));
        }
        if (JapaneseAudioText.Any(text.Contains)) into.Audio("ja", LanguageConfidence.ExplicitAudio, basis);
        var englishSubs = EnglishSubtitleText.Any(text.Contains);
        if (englishSubs) into.Subtitle("en", LanguageConfidence.ExplicitSubs, basis);
        if (ChineseSubtitleText.Any(text.Contains) || ChineseBracket().IsMatch(text)) into.Subtitle("zh", LanguageConfidence.ExplicitSubs, basis);
        if (text.Contains("内嵌") || text.Contains("內嵌")) into.HardSubbed = true;
        if (!dub && !englishSubs && (text.Contains("英語") || text.Contains("英语")))
            into.Ambiguous = Collector.Pick(into.Ambiguous, new("en", LanguageConfidence.ExplicitSubs, basis));
    }

    private readonly record struct Token(string Text, string Upper, int Start, int End, bool Bracketed, bool Tail, string Before, string After);

    /// <summary>Letter and digit runs, each with the separators around it, whether it sits in brackets, and whether it
    /// comes after the title (from the first year, episode, resolution or season marker on).</summary>
    private static List<Token> Tokenize(string text)
    {
        var depth = new int[text.Length];
        var level = 0;
        for (var i = 0; i < text.Length; i++)
        {
            if (text[i] is '[' or '(' or '【' or '{' or '「') level++;
            else if (text[i] is ']' or ')' or '】' or '}' or '」') level = Math.Max(0, level - 1);
            depth[i] = level;
        }
        var anchor = Anchor().Match(text);
        var tail = anchor.Success ? anchor.Index : 0;
        var matches = Word().Matches(text);
        var tokens = new List<Token>(matches.Count);
        for (var i = 0; i < matches.Count; i++)
        {
            var m = matches[i];
            var start = i == 0 ? 0 : matches[i - 1].Index + matches[i - 1].Length;
            var end = i + 1 < matches.Count ? matches[i + 1].Index : text.Length;
            tokens.Add(new(m.Value, m.Value.ToUpperInvariant(), m.Index, m.Index + m.Length, depth[m.Index] > 0, m.Index >= tail,
                text[start..m.Index], text[(m.Index + m.Length)..end]));
        }
        return tokens;
    }

    /// <summary>"hardcoded subs", "Hard Sub" and "hard-subbed" read as one hard-sub word, so the language beside them stays a
    /// subtitle claim ("English hardcoded subs").</summary>
    private static List<Token> MergeHardSubs(List<Token> tokens)
    {
        for (var i = tokens.Count - 2; i >= 0; i--)
            if (tokens[i].Upper is "HARD" or "HARDCODED" or "HARDCODE" && tokens[i + 1].Start - tokens[i].End <= 3 && IsSubWord(tokens[i + 1].Upper))
            {
                tokens[i] = tokens[i] with { Text = tokens[i].Text + tokens[i + 1].Text, Upper = "HARDSUB", End = tokens[i + 1].End, After = tokens[i + 1].After };
                tokens.RemoveAt(i + 1);
            }
        return tokens;
    }

    private static void Walk(List<Token> tokens, string basis, Collector into, string bare = "en")
    {
        const LanguageConfidence audio = LanguageConfidence.ExplicitAudio, subs = LanguageConfidence.ExplicitSubs;
        bool Adjacent(int a, int b) => a >= 0 && b < tokens.Count && b == a + 1 && tokens[b].Start - tokens[a].End <= 3;
        string? At(int i) => i >= 0 && i < tokens.Count ? tokens[i].Upper : null;
        string? Next(int i) => Adjacent(i, i + 1) ? tokens[i + 1].Upper : null;
        string? Previous(int i) => Adjacent(i - 1, i) ? tokens[i - 1].Upper : null;
        // An ordinary capitalised word ("Connection"), as in an episode title, not release info ("TS", "1080p", "DL").
        bool TitleWord(int j) => Adjacent(j - 1, j) && tokens[j].Text.All(char.IsLetter) && char.IsUpper(tokens[j].Text[0])
            && tokens[j].Text.Skip(1).Any(char.IsLower) && !IsContextWord(tokens[j].Upper) && !Words.ContainsKey(tokens[j].Upper);

        // A multi-subtitle release ("Multi-Subs", "Multiple Subtitle", "MSubs", "Dual.Multi") carries English.
        // Hard-sub words ("English Hardsub", "HARDSUBS", "HC", "hardcoded subs") mark burned-in subtitles: the language
        // beside them stays a subtitle claim, and no track list can show them (WithTracks keeps it).
        var multiSubs = false;
        for (var i = 0; i < tokens.Count; i++)
        {
            var u = tokens[i].Upper;
            if (u is "MULTISUB" or "MULTISUBS" or "MSUB" or "MSUBS" or "MULTISUBTITLE" or "MULTISUBTITLES"
                || u is "MULTI" or "MULTIPLE" && IsSubWord(Next(i))
                || u == "MULTI" && Previous(i) is "DUAL" or "2A")
                multiSubs = true;
            if ((tokens[i].Tail || tokens[i].Bracketed) && (IsHardSubWord(u) || u == "HC")) into.HardSubbed = true;
        }
        if (multiSubs) into.Subtitle("en", subs, basis);

        var run = new List<(int Index, string Language, bool Word)>();
        var runEnd = -1;
        void Dual() => into.Dual = Collector.Pick(into.Dual, new("dual", audio, basis));
        void Close(int at, bool audioOnly = false)
        {
            if (run.Count == 0) return;
            var after = Adjacent(runEnd, at) ? At(at) : null;
            var before = Previous(run[0].Index);
            var several = run.Select(r => r.Language).Distinct().Count() >= 2;
            var kind = audioOnly ? several ? "multi" : "audio"
                : after == "DL" ? "multi"
                : IsDubWord(after) || IsAudioWord(after) || IsCodecWord(after) ? "audio"
                : IsSubWord(after) ? "subs"
                : IsSubWord(before) || before is "MULTISUB" or "MULTISUBS" or "MSUB" or "MSUBS" ? "subs"
                : IsDubWord(before) || IsAudioWord(before) || IsCodecWord(before) ? "audio"
                : multiSubs && run.All(r => !r.Word) ? "subs"
                : several ? "multi"
                : run[0].Language == "en" ? "ambiguous"
                : "audio";
            foreach (var (_, language, _) in run)
                switch (kind)
                {
                    case "subs": into.Subtitle(language, subs, basis); break;
                    case "ambiguous": into.Ambiguous = Collector.Pick(into.Ambiguous, new("en", subs, basis)); break;
                    default: into.Audio(language, audio, basis); break;
                }
            if (kind == "multi") into.Multi = Collector.Pick(into.Multi, new("multi", audio, basis));
            run.Clear();
            runEnd = -1;
        }

        for (var i = 0; i < tokens.Count; i++)
        {
            var t = tokens[i];
            var u = t.Upper;
            var live = t.Tail || t.Bracketed;
            // A region inside a language list (POR-BR, SPA-LA, es-419) keeps the list going.
            if (run.Count > 0 && runEnd == i - 1 && t.Before is "-" or "_" && Regions.Contains(u)) { runEnd = i; continue; }
            if (Markers.TryGetValue(u, out var marker) && (live || marker.Anywhere))
            {
                Close(i);
                switch (marker.Mark)
                {
                    case Mark.Subs: into.Subtitle(marker.Language, subs, basis); break;
                    case Mark.Audio: into.Audio(marker.Language, audio, basis); break;
                    case Mark.HardSubs: into.Subtitle(marker.Language, subs, basis); into.HardSubbed = true; break;
                    case Mark.Dub:
                        into.Audio(marker.Language, audio, basis);
                        into.Dub = Collector.Pick(into.Dub, new(marker.Language, audio, basis));
                        break;
                }
                continue;
            }
            if (!live) { Close(i); continue; }
            switch (u)
            {
                case "MULTI":
                    Close(i);
                    if (IsSubWord(Next(i))) { i++; continue; }
                    if (Previous(i) is "DUAL" or "2A") continue;
                    into.Multi = Collector.Pick(into.Multi, new("multi", audio, basis));
                    if (IsAudioWord(Next(i))) i++;
                    continue;
                case "MULTIPLE" or "MULTISUB" or "MULTISUBS" or "MSUB" or "MSUBS":
                    Close(i);
                    if (u == "MULTIPLE" && IsSubWord(Next(i))) i++;
                    continue;
                case "DUAL":
                    Close(i);
                    if (Next(i) is "AUDIO" or "AUD" or "LANG" or "LANGUAGE" or "AUDIOS") { Dual(); i++; }
                    else if (t.Tail) Dual();
                    continue;
                case "2A":
                    Close(i);
                    if (t.Tail) Dual();
                    continue;
                case "SUBDUB":
                    Close(i);
                    Dual();
                    continue;
                case "RAW" or "RAWS":
                    Close(i);
                    // "Something-Raws" is a group name, not a raw release.
                    if (t.Before == "-" && i > 0 && tokens[i - 1].End == t.Start - 1) continue;
                    into.Raw = Collector.Pick(into.Raw, new("none", subs, basis));
                    continue;
                case "GB":
                    Close(i);
                    if (t.Bracketed && (t.Before.EndsWith('[') || t.Before.EndsWith('_') || t.Before.EndsWith('&') || t.After.StartsWith('_')))
                        into.Subtitle("zh", subs, basis);
                    continue;
            }
            if (IsSubWord(u))
            {
                if (IsDubWord(Next(i)) && t.After.Trim() is "&" or "+" or "/" or "-")
                {
                    Close(i);
                    Dual();
                    i++;
                    continue;
                }
                if (run.Count > 0 && Adjacent(runEnd, i))
                {
                    // "FLAC.JPN.Subs.Ita.Eng": codes before "Subs" with its own list after it are the audio languages.
                    var listFollows = run.All(r => !r.Word) && Adjacent(i, i + 1) && Lookup(tokens[i + 1], relaxed: true, inList: true) is not null;
                    if (!listFollows) { Close(i); continue; }
                    Close(i, audioOnly: true);
                }
                Close(i);
                // "Sub ITA", "Subs: English", "Subtitles FR".
                var found = false;
                for (var j = i + 1; j < tokens.Count && Adjacent(j - 1, j); j++)
                {
                    if (found && tokens[j].Before is "-" or "_" && Regions.Contains(tokens[j].Upper)) { i = j; continue; }
                    if (Lookup(tokens[j], relaxed: true, inList: true) is not { } named) break;
                    into.Subtitle(named.Language, subs, basis);
                    found = true;
                    i = j;
                }
                // A bare "Sub" or "Subbed" most often means English subtitles (Russian in a Cyrillic name), but only weakly.
                if (!found) into.Subtitle(bare, LanguageConfidence.GroupHeuristic, basis);
                continue;
            }
            if (IsDubWord(u))
            {
                string dubbed;
                var guessed = false;
                if (run.Count > 0 && Adjacent(runEnd, i)) { dubbed = run[^1].Language; Close(i); }
                else
                {
                    Close(i);
                    if (Adjacent(i, i + 1) && Lookup(tokens[i + 1], relaxed: true, inList: true) is { } named) { dubbed = named.Language; i++; }
                    // "Uzbek Dubbed": a language-shaped word we do not know is some other dub, never English.
                    else if (Previous(i) is { } before && ForeignDubWord(before)) { dubbed = "other"; guessed = true; }
                    else { dubbed = bare; guessed = bare != "en"; }
                }
                // A bare "Dub" in a Cyrillic name is a Russian dub, but only as a guess from the script.
                var level = guessed ? LanguageConfidence.GroupHeuristic : audio;
                into.Audio(dubbed, level, basis);
                into.Dub = Collector.Pick(into.Dub, new(dubbed, level, basis));
                continue;
            }
            if (IsAudioWord(u) || u == "DL") { Close(i); continue; }
            var relaxed = IsContextWord(Next(i)) || IsContextWord(Previous(i));
            var inList = run.Count > 0 && Adjacent(runEnd, i);
            if (Lookup(t, relaxed, inList || multiSubs, loose: !TitleWord(i + 1)) is { } language)
            {
                if (!inList) Close(i);
                run.Add((i, language.Language, language.Word));
                runEnd = i;
                continue;
            }
            Close(i);
        }
        Close(tokens.Count);
    }

    /// <summary>A language word or code. Full words count after the title, in brackets, next to sub/dub/audio words or in a list;
    /// codes only when written as scene codes (ENG, iTA), or next to those words. Codes that are also common words need more.
    /// <paramref name="loose"/>: the next word is not an ordinary title word, so a "Spanish" after the year is release info,
    /// while "The French Connection" after an episode number stays an episode title.</summary>
    private static (string Language, bool Word)? Lookup(Token t, bool relaxed, bool inList, bool loose = false)
    {
        var u = t.Upper;
        var shaped = t.Text == u || t.Text.Replace('i', 'I') == u;
        var alone = t.Bracketed && t.Before.EndsWith('[') || t.Before.EndsWith('(');
        if (Words.TryGetValue(u, out var word))
            return shaped && (t.Tail || t.Bracketed) || t.Bracketed || relaxed || inList || loose && t.Tail ? (word, true) : null;
        if (Codes.TryGetValue(u, out var code))
        {
            if (!(shaped || relaxed || alone)) return null;
            if (Risky.Contains(u) && !(t.Bracketed || relaxed || inList)) return null;
            return t.Tail || t.Bracketed || relaxed ? (code, false) : null;
        }
        return relaxed && TwoLetter.TryGetValue(u, out var two) ? (two, false) : null;
    }

    private static bool IsSubWord(string? u) => u is "SUB" or "SUBS" or "SUBBED" or "SUBTITLE" or "SUBTITLES" or "SUBTITLED" or "SOFTSUB"
        or "SOFTSUBS" or "SUBTITULADO" or "SUBTITULOS" or "LEGENDAS" or "LEGENDA" or "SOTTOTITOLI" || IsHardSubWord(u);

    /// <summary>Burned-in subtitles: "Hardsub", "HARDSUBS", "HardSubbed", and "hardcoded subs" once merged (<see cref="MergeHardSubs"/>).</summary>
    private static bool IsHardSubWord(string? u) => u is "HARDSUB" or "HARDSUBS" or "HARDSUBBED";

    private static bool IsDubWord(string? u) => u is "DUB" or "DUBS" or "DUBBED" or "DUBBING" or "DOPPIATO";

    private static bool ForeignDubWord(string u) => u.Length >= 4 && u.All(char.IsLetter) && !NotLanguages.Contains(u)
        && (u.EndsWith("IAN", StringComparison.Ordinal) || u.EndsWith("ISH", StringComparison.Ordinal) || u.EndsWith("ESE", StringComparison.Ordinal)
            || u.EndsWith("EK", StringComparison.Ordinal) || u.EndsWith("AKH", StringComparison.Ordinal) || u.EndsWith("IC", StringComparison.Ordinal));

    private static readonly HashSet<string> NotLanguages = new(StringComparer.Ordinal) { "CHRISTIAN", "CLASSIC", "MUSIC", "COMIC", "ANIMATED", "FANDUB" };

    private static bool IsAudioWord(string? u) => u is "AUDIO" or "AUD" or "AUDIOS";

    /// <summary>An audio codec right after a language code makes it the audio language ("JPN AAC2.0", "ENG-AC3").</summary>
    private static bool IsCodecWord(string? u) => u is not null && (u.StartsWith("AAC", StringComparison.Ordinal)
        || u.StartsWith("DDP", StringComparison.Ordinal) || u.StartsWith("DTS", StringComparison.Ordinal)
        || u is "AC3" or "EAC3" or "DD" or "DD5" or "DD2" or "FLAC" or "OPUS" or "TRUEHD" or "ATMOS" or "MP3" or "LPCM");

    private static bool IsContextWord(string? u) => IsSubWord(u) || IsDubWord(u) || IsAudioWord(u) || u is "DL" or "MULTISUB" or "MULTISUBS" or "MSUB" or "MSUBS";

    private enum Mark { Subs, Audio, Dub, HardSubs }

    /// <summary>Marker tokens. <c>Anywhere</c> markers are never title words; the rest count only after the title or in brackets.</summary>
    private static readonly Dictionary<string, (Mark Mark, string Language, bool Anywhere)> Markers = new(StringComparer.Ordinal)
    {
        ["VOSTFR"] = (Mark.Subs, "fr", true), ["SUBFRENCH"] = (Mark.Subs, "fr", true), ["VOST"] = (Mark.Subs, "fr", false),
        ["SUBFR"] = (Mark.Subs, "fr", true), ["STFR"] = (Mark.Subs, "fr", false), ["VOSE"] = (Mark.Subs, "es", false),
        ["LEGENDADO"] = (Mark.Subs, "pt", true), ["TRUEFRENCH"] = (Mark.Audio, "fr", true), ["VFF"] = (Mark.Audio, "fr", true),
        ["VFI"] = (Mark.Audio, "fr", true), ["VFQ"] = (Mark.Audio, "fr", true), ["VF2"] = (Mark.Audio, "fr", true),
        ["VF"] = (Mark.Audio, "fr", false), ["VOF"] = (Mark.Audio, "fr", false), ["DUBLADO"] = (Mark.Dub, "pt", true),
        ["ENGDUB"] = (Mark.Dub, "en", true), ["FUNIDUB"] = (Mark.Dub, "en", true), ["ESUB"] = (Mark.Subs, "en", true),
        ["ESUBS"] = (Mark.Subs, "en", true), ["ENGSUB"] = (Mark.Subs, "en", true), ["ENGSUBS"] = (Mark.Subs, "en", true),
        ["NLSUB"] = (Mark.Subs, "nl", true), ["NLSUBS"] = (Mark.Subs, "nl", true), ["GERSUB"] = (Mark.Subs, "de", true),
        ["GERSUBS"] = (Mark.Subs, "de", true), ["BIG5"] = (Mark.Subs, "zh", false), ["CHS"] = (Mark.Subs, "zh", false),
        ["CHT"] = (Mark.Subs, "zh", false), ["JPSC"] = (Mark.Subs, "zh", false), ["JPTC"] = (Mark.Subs, "zh", false),
        ["BAHA"] = (Mark.HardSubs, "zh", false), ["BAHAMUT"] = (Mark.HardSubs, "zh", false),
        // Russian voice-over kinds: multi-voice, two-voice and author's voice-over.
        ["MVO"] = (Mark.Audio, "ru", false), ["DVO"] = (Mark.Audio, "ru", false), ["AVO"] = (Mark.Audio, "ru", false),
    };

    private static readonly Dictionary<string, string> Words = new(StringComparer.Ordinal)
    {
        ["ENGLISH"] = "en", ["JAPANESE"] = "ja", ["FRENCH"] = "fr", ["FRANCAIS"] = "fr", ["FRANÇAIS"] = "fr", ["GERMAN"] = "de",
        ["DEUTSCH"] = "de", ["ITALIAN"] = "it", ["ITALIANO"] = "it", ["SPANISH"] = "es", ["CASTELLANO"] = "es", ["ESPANOL"] = "es",
        ["ESPAÑOL"] = "es", ["LATINO"] = "es", ["PORTUGUESE"] = "pt", ["PORTUGUES"] = "pt", ["PORTUGUÊS"] = "pt", ["BRAZILIAN"] = "pt",
        ["RUSSIAN"] = "ru", ["CHINESE"] = "zh", ["MANDARIN"] = "zh", ["CANTONESE"] = "zh", ["KOREAN"] = "ko", ["HINDI"] = "hi",
        ["TAMIL"] = "ta", ["TELUGU"] = "te", ["MALAYALAM"] = "ml", ["KANNADA"] = "kn", ["BENGALI"] = "bn", ["MARATHI"] = "mr",
        ["PUNJABI"] = "pa", ["ARABIC"] = "ar", ["THAI"] = "th", ["VIETNAMESE"] = "vi", ["INDONESIAN"] = "id", ["MALAY"] = "ms",
        ["POLISH"] = "pl", ["POLSKI"] = "pl", ["TURKISH"] = "tr", ["DUTCH"] = "nl", ["FLEMISH"] = "nl", ["SWEDISH"] = "sv",
        ["DANISH"] = "da", ["NORWEGIAN"] = "no", ["FINNISH"] = "fi", ["CZECH"] = "cs", ["HUNGARIAN"] = "hu", ["GREEK"] = "el",
        ["HEBREW"] = "he", ["UKRAINIAN"] = "uk", ["ROMANIAN"] = "ro", ["FILIPINO"] = "tl", ["TAGALOG"] = "tl", ["PERSIAN"] = "fa",
        ["URDU"] = "ur", ["FARSI"] = "fa", ["CATALAN"] = "ca", ["BULGARIAN"] = "bg", ["CROATIAN"] = "hr", ["SERBIAN"] = "sr",
        ["SLOVENIAN"] = "sl", ["SLOVAK"] = "sk", ["LITHUANIAN"] = "lt", ["LATVIAN"] = "lv", ["ESTONIAN"] = "et", ["ICELANDIC"] = "is",
        ["UZBEK"] = "uz", ["KAZAKH"] = "kk", ["GEORGIAN"] = "ka", ["ARMENIAN"] = "hy", ["AZERBAIJANI"] = "az", ["AZERI"] = "az",
        ["TAJIK"] = "tg", ["KYRGYZ"] = "ky", ["TURKMEN"] = "tk", ["MONGOLIAN"] = "mn", ["BELARUSIAN"] = "be", ["ALBANIAN"] = "sq",
        ["MACEDONIAN"] = "mk", ["BOSNIAN"] = "bs", ["PASHTO"] = "ps", ["KURDISH"] = "ku", ["NEPALI"] = "ne", ["SINHALA"] = "si",
        ["GUJARATI"] = "gu", ["ODIA"] = "or", ["BHOJPURI"] = "bho", ["BURMESE"] = "my", ["KHMER"] = "km", ["SWAHILI"] = "sw",
        ["AMHARIC"] = "am",
    };

    private static readonly Dictionary<string, string> Codes = new(StringComparer.Ordinal)
    {
        ["ENG"] = "en", ["JPN"] = "ja", ["JAP"] = "ja", ["FRE"] = "fr", ["FRA"] = "fr", ["GER"] = "de", ["DEU"] = "de", ["ITA"] = "it",
        ["SPA"] = "es", ["ESP"] = "es", ["LAT"] = "es", ["POR"] = "pt", ["PTBR"] = "pt", ["RUS"] = "ru", ["CHI"] = "zh", ["ZHO"] = "zh",
        ["KOR"] = "ko", ["HIN"] = "hi", ["TAM"] = "ta", ["TEL"] = "te", ["MAL"] = "ml", ["BEN"] = "bn", ["ARA"] = "ar", ["THA"] = "th",
        ["VIE"] = "vi", ["IND"] = "id", ["MAY"] = "ms", ["MSA"] = "ms", ["POL"] = "pl", ["TUR"] = "tr", ["DUT"] = "nl", ["NLD"] = "nl",
        ["SWE"] = "sv", ["DAN"] = "da", ["NOR"] = "no", ["FIN"] = "fi", ["CZE"] = "cs", ["CES"] = "cs", ["HUN"] = "hu", ["GRE"] = "el",
        ["ELL"] = "el", ["HEB"] = "he", ["UKR"] = "uk", ["RUM"] = "ro", ["RON"] = "ro", ["PER"] = "fa", ["FAS"] = "fa", ["FIL"] = "tl",
        ["URD"] = "ur", ["CAT"] = "ca", ["BUL"] = "bg", ["HRV"] = "hr", ["SRP"] = "sr", ["SLV"] = "sl", ["SLO"] = "sk", ["SLK"] = "sk",
        ["LIT"] = "lt", ["LAV"] = "lv", ["EST"] = "et", ["ICE"] = "is", ["ISL"] = "is", ["CZ"] = "cs",
    };

    /// <summary>Codes that are also everyday words or title words: only in brackets, next to sub/dub/audio words, or in a list.</summary>
    private static readonly HashSet<string> Risky = new(StringComparer.Ordinal)
    {
        "LAT", "CHI", "TAM", "TEL", "MAL", "BEN", "ARA", "THA", "VIE", "IND", "MAY", "POL", "TUR", "DUT", "NLD", "SWE", "DAN", "NOR",
        "FIN", "CZE", "HUN", "GRE", "HEB", "UKR", "RUM", "PER", "FIL", "URD", "CAT", "BUL", "HRV", "SRP", "SLV", "SLO", "LIT", "LAV",
        "EST", "ICE", "ISL", "CES", "ELL", "RON", "FAS", "MSA", "ZHO", "SLK",
    };

    /// <summary>Two-letter codes, only next to sub/dub/audio words ("Sub FR", "Dubbing PL") and as file suffixes (".en.srt").</summary>
    private static readonly Dictionary<string, string> TwoLetter = new(StringComparer.Ordinal)
    {
        ["EN"] = "en", ["JA"] = "ja", ["JP"] = "ja", ["FR"] = "fr", ["DE"] = "de", ["IT"] = "it", ["ES"] = "es", ["PT"] = "pt",
        ["RU"] = "ru", ["ZH"] = "zh", ["KO"] = "ko", ["NL"] = "nl", ["PL"] = "pl", ["AR"] = "ar", ["TR"] = "tr", ["SV"] = "sv",
        ["HI"] = "hi", ["ID"] = "id", ["VI"] = "vi", ["TH"] = "th", ["MS"] = "ms", ["DA"] = "da", ["NO"] = "no", ["FI"] = "fi",
        ["CS"] = "cs", ["HU"] = "hu", ["EL"] = "el", ["HE"] = "he", ["UK"] = "uk", ["RO"] = "ro", ["TL"] = "tl", ["FA"] = "fa",
    };

    private static readonly HashSet<string> Regions = new(StringComparer.Ordinal) { "BR", "LA", "LAT", "LATAM", "US", "UK", "419", "MX", "EU", "CA", "AU" };

    private static readonly HashSet<string> SubtitleExtensions = new(StringComparer.Ordinal) { "ass", "ssa", "srt", "sup", "vtt", "sub", "idx" };
    private static readonly HashSet<string> AudioExtensions = new(StringComparer.Ordinal)
        { "mka", "ac3", "eac3", "dts", "aac", "flac", "opus", "m4a", "mp3", "thd" };
    private static readonly HashSet<string> SubtitleNoise = new(StringComparer.Ordinal)
        { "forced", "sdh", "cc", "default", "full", "signs", "songs", "sign", "song", "dialogue", "dialog", "commentary", "ass", "srt" };
    private static readonly HashSet<string> ChineseSubtitleCodes = new(StringComparer.Ordinal)
        { "chs", "cht", "sc", "tc", "gb", "big5", "jpsc", "jptc", "chs_jp", "cht_jp", "zh-hans", "zh-hant" };

    private static readonly string[] ChineseSubtitleText =
        ["简繁", "繁简", "简日", "繁日", "简体", "簡體", "繁體", "繁体", "简中", "繁中", "中字", "字幕", "双语", "雙語", "内封", "內封", "内嵌", "內嵌"];
    private static readonly string[] ChineseText = ["简", "繁", "中文", "簡"];
    private static readonly string[] ChineseAudioText = ["国语", "國語", "普通话", "普通話", "国配", "國配", "中配", "台配", "粤语", "粵語", "粤配", "粵配"];
    private static readonly string[] ChineseEnglishAudioText = ["国英", "國英"];
    private static readonly string[] JapaneseAudioText = ["日语", "日語", "日配"];
    private static readonly string[] EnglishDubText = ["英配", "英语配音", "英語配音"];
    private static readonly string[] EnglishSubtitleText = ["英字", "英文字幕", "中英", "简英", "繁英", "英中"];

    private static readonly (Regex Pattern, GroupKind Kind)[] Groups =
    [
        (EnglishGroups(), GroupKind.EnglishSubs),
        (EnglishShortGroups(), GroupKind.EnglishSubs),
        (FrenchGroups(), GroupKind.French),
        (RawGroups(), GroupKind.Raw),
        (ChineseGroups(), GroupKind.ChineseSubs),
        (AniGroup(), GroupKind.ChineseSubs),
    ];

    private static readonly Dictionary<string, string> Names = new(StringComparer.Ordinal)
    {
        ["en"] = "English", ["ja"] = "Japanese", ["fr"] = "French", ["de"] = "German", ["it"] = "Italian", ["es"] = "Spanish",
        ["pt"] = "Portuguese", ["ru"] = "Russian", ["zh"] = "Chinese", ["ko"] = "Korean", ["hi"] = "Hindi", ["ta"] = "Tamil",
        ["te"] = "Telugu", ["ml"] = "Malayalam", ["kn"] = "Kannada", ["bn"] = "Bengali", ["mr"] = "Marathi", ["pa"] = "Punjabi",
        ["ar"] = "Arabic", ["th"] = "Thai", ["vi"] = "Vietnamese", ["id"] = "Indonesian", ["ms"] = "Malay", ["pl"] = "Polish",
        ["tr"] = "Turkish", ["nl"] = "Dutch", ["sv"] = "Swedish", ["da"] = "Danish", ["no"] = "Norwegian", ["fi"] = "Finnish",
        ["cs"] = "Czech", ["hu"] = "Hungarian", ["el"] = "Greek", ["he"] = "Hebrew", ["uk"] = "Ukrainian", ["ro"] = "Romanian",
        ["tl"] = "Filipino", ["fa"] = "Persian", ["ur"] = "Urdu", ["ca"] = "Catalan", ["bg"] = "Bulgarian", ["hr"] = "Croatian",
        ["sr"] = "Serbian", ["sl"] = "Slovenian", ["sk"] = "Slovak", ["lt"] = "Lithuanian", ["lv"] = "Latvian", ["et"] = "Estonian",
        ["is"] = "Icelandic", ["uz"] = "Uzbek", ["kk"] = "Kazakh", ["ka"] = "Georgian", ["hy"] = "Armenian", ["az"] = "Azerbaijani",
        ["tg"] = "Tajik", ["ky"] = "Kyrgyz", ["tk"] = "Turkmen", ["mn"] = "Mongolian", ["be"] = "Belarusian", ["sq"] = "Albanian",
        ["mk"] = "Macedonian", ["bs"] = "Bosnian", ["ps"] = "Pashto", ["ku"] = "Kurdish", ["ne"] = "Nepali", ["si"] = "Sinhala",
        ["gu"] = "Gujarati", ["or"] = "Odia", ["bho"] = "Bhojpuri", ["my"] = "Burmese", ["km"] = "Khmer", ["sw"] = "Swahili",
        ["am"] = "Amharic",
    };

    [GeneratedRegex(@"[\p{L}\p{N}]+", RegexOptions.CultureInvariant)]
    private static partial Regex Word();

    /// <summary>Where the title ends: the first year, SxxEyy, Exx, resolution, "- 05", Episode/Season, "[05]" or 第5话.</summary>
    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:(?:19|20)\d{2}|S\d{1,2}(?:E\d{1,4})?|EP?\d{1,4}|\d{3,4}[pi]|\d{1,2}x\d{2,3})(?![\p{L}\p{N}])|\s-\s?\d{1,4}(?!\d)|(?<![\p{L}\p{N}])(?:Episode|Season|Saison|Temporada|Vol)(?![\p{L}\p{N}])|\[\d{1,4}(?:v\d)?\]|第\s*\d+",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Anchor();

    [GeneratedRegex(@"^\s*(?:\[[^\]]*\]|【[^】]*】)", RegexOptions.CultureInvariant)]
    private static partial Regex LeadingBracket();

    [GeneratedRegex(@"\p{IsCyrillic}", RegexOptions.CultureInvariant)]
    private static partial Regex Cyrillic();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:Original|Оригинал)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex OriginalTrack();

    [GeneratedRegex(@"[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]", RegexOptions.CultureInvariant)]
    private static partial Regex Cjk();

    [GeneratedRegex(@"[\[【](?:简|繁|簡)[\]】]", RegexOptions.CultureInvariant)]
    private static partial Regex ChineseBracket();

    [GeneratedRegex(@"\braws?\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RawWord();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:SubsPlease|SubsPlus\+?|HorribleSubs|Erai-raws|ToonsHub|VARYG|Yameii)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EnglishGroups();

    [GeneratedRegex(@"[\[(](?:ASW|Judas|EMBER|DKB)[\])]|(?<=-)(?:ASW|Judas|EMBER|DKB)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex EnglishShortGroups();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:Tsundere-Raws|T3KASHi)(?![\p{L}\p{N}])|[\[(]KAF(?:-TEAM)?[\])]|(?<=-)KAF(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex FrenchGroups();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:Ohys-Raws|Leopard-Raws|Moozzi2|Beatrice-Raws)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex RawGroups();

    [GeneratedRegex(@"(?<![\p{L}\p{N}])(?:NC-Raws|Lilith-Raws|Skymoon-Raws|LoliHouse)(?![\p{L}\p{N}])",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex ChineseGroups();

    [GeneratedRegex(@"[\[(]ANi[\])]", RegexOptions.CultureInvariant)]
    private static partial Regex AniGroup();
}
