using System.Collections.Immutable;
using System.Text.RegularExpressions;

namespace TorrentFlow.Domain;

/// <summary>Acquisition evidence advertised by a name, never a claim about inspected media tracks.</summary>
public enum AnimeAudioMatch { English, Japanese, Other, Unknown }

public static class AnimeAudioPolicy
{
    public static bool EnglishFirst(WorkSnapshot? work, string? language) => work?.Work.Anime == true &&
        (string.IsNullOrWhiteSpace(language) || language.Trim().ToLowerInvariant() is "auto" or "en" or "eng" or "english");

    public static AnimeAudioMatch Match(Candidate candidate)
    {
        if (candidate.AudioEvidence is { } detail && !detail.Languages.IsDefaultOrEmpty &&
            detail.Hash.Equals(candidate.Release.Id, StringComparison.OrdinalIgnoreCase) &&
            candidate.Observations.Any(o => o.Hash == candidate.Release.Id &&
                o.SourceId == detail.SourceId && o.SourceItemId == detail.SourceItemId))
        {
            if (detail.Languages.Contains("en")) return AnimeAudioMatch.English;
            if (detail.Languages.Contains("und")) return AnimeAudioMatch.Unknown;
            return detail.Languages.All(language => language == "ja")
                ? AnimeAudioMatch.Japanese : AnimeAudioMatch.Other;
        }
        if (candidate.AudioDetailUnavailable) return AnimeAudioMatch.Unknown;
        var claims = candidate.AudioNameClaims;
        if (claims.IsEmpty) return NameClaim(candidate.Release.Parsed);
        return claims.Length == 1 ? claims[0] : AnimeAudioMatch.Unknown;
    }

    public static AnimeAudioMatch NameClaim(ParsedRelease release)
    {
        var text = release.RawName.Replace('_', ' ').Replace('.', ' ');
        if (!string.IsNullOrWhiteSpace(release.Title)) text = text.Replace(release.Title, " ", StringComparison.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(release.Group)) text = text.Replace(release.Group, " ", StringComparison.OrdinalIgnoreCase);
        text = WithoutNonDialogueClaims(text);
        text = Pattern(@"\bJP[- ._]*BD\b").Replace(text, " ");
        // A language inside an audio label or a standalone bracketed tag is a claim.
        // Other words can describe a subtitle, version, source, or episode title.
        var claims = Pattern(
            @"(?:\[\s*(?<languages>" + LanguageList + @")\s*\]|\(\s*(?<languages>" + LanguageList + @")\s*\))|" +
            @"(?<languages>" + LanguageList + @")\s*[-:]?\s*(?:audio|dub(?:bed)?)\b|" +
            @"\b(?:(?:dual|multi)[ -]+audio\s*[:=-]?|audio\s*[:=]|dubbed\s+in)\s*(?<languages>" + LanguageList +
            @")(?=\s*(?:$|[\[\]()\-]|[0-9]{3,4}p\b|(?:flac|aac|opus|dts|ddp?|hevc|x26[45])\b))")
            .Matches(text);
        var languages = claims.SelectMany(match => ReadLanguageTags(match.Groups["languages"].Value))
            .Distinct(StringComparer.Ordinal).ToArray();
        if (languages.Contains("en")) return AnimeAudioMatch.English;
        var multiple = Pattern(@"\b(?:dual|multi)\b").IsMatch(text);
        if (multiple && languages.Length < 2) return AnimeAudioMatch.Unknown;
        if (languages.Any(language => language != "ja")) return AnimeAudioMatch.Other;
        return languages.Contains("ja") ? AnimeAudioMatch.Japanese : AnimeAudioMatch.Unknown;
    }

    private const string LanguageTags =
        @"english|eng|en|japanese|japonais|jpn|jap|jp|ja|french|fran[cç]ais|fra|fre|fr|vf|truefrench|" +
        @"portugu[eê]s|portuguese|por|pt[ -]?br|dublado|german|deutsch|ger|deu|spanish|espa[nñ]ol|spa|esp|castellano|" +
        @"russian|rus|lostfilm|italian|ita|korean|kor|chinese|mandarin|cantonese|hindi|hin|tamil|tam|telugu|tel|" +
        @"polish|pol|dutch|turkish|tur|ukrainian|ukr|arabic|ara|filipino|tagalog";
    private const string LanguageTag = @"\b(?:" + LanguageTags + @")\b";
    private const string LanguageList = LanguageTag + @"(?:[ \t,/;+&-]+" + LanguageTag + @")*";
    private const string Captions = @"\b(?:subs?|subbed|subtitled|subtitles?|softsubs?|hardsubs?|sdh|cc|srt|ass|ssa|vtt|pgs|closed[ -]+captions?)\b";
    private const string Commentary = @"\b(?:commentary|audio description|descriptive audio|described video)\b";
    private const string TrackQualifier = @"(?:flac|aac|ac-?3|e-?ac-?3|ddp?|dts(?:-hd)?|ma|opus|pcm|lpcm|truehd|mp3|" +
        @"stereo|mono|[1-9][. ][01](?:ch)?|audio|dub|track|main|original|native|default|dialogue|only)";
    private const string TrackNote = @"\([^()]*\)|\[[^\[\]]*\]";
    private const string Negation = @"\b(?:no|not|without|excluding|lacks?)\b";
    private const string Uncertainty = @"\b(?:unavailable|unknown|undetermined|unidentified|unspecified|missing|omitted)\b";

    private static string WithoutNonDialogueClaims(string text)
    {
        const string tags = @"(?:" + LanguageTags + "|dual|multi)";
        const string list = tags + @"(?:[ \t,;/+&-]+" + tags + @")*";
        const string delimiters = @"[\s\[\]():_-]*";
        const string nonDialogue = @"(?:" + Captions + "|" + Commentary + ")";
        const string audio = @"(?:[ -]+(?:audio|dub(?:bed)?))?";
        text = Pattern(LanguageList + @"\s+(?:" + TrackQualifier + @"\s+)*" + delimiters +
            @"(?:(?:director|cast|crew)(?:'s)?\s+)?" + Commentary).Replace(text, " ");
        text = Pattern(@"\b" + list + delimiters + @"(?:(?:full|forced|only[ -]+(?:in|for))[ -]+)?" + nonDialogue)
            .Replace(text, " ");
        text = Pattern(nonDialogue + delimiters + @"(?:only[ -]+)?(?:(?:in|for)[ -]+)?" + list + @"\b")
            .Replace(text, " ");
        text = Pattern(Negation + delimiters + @"(?:(?:audio|dub(?:bed)?)(?:\s+in)?" +
            delimiters + @")?" + LanguageList + audio).Replace(text, " ");
        return Pattern(LanguageList + audio + delimiters +
            @"\b(?:unavailable|missing|omitted|no|false|not\s+(?:included|present|available))\b").Replace(text, " ");
    }

    public static bool IsSupplementaryAudio(string value) => Pattern(Commentary).IsMatch(value);

    public static ImmutableArray<string> AudioFieldLanguages(string value)
    {
        var trackList = UnwrapTrack(value);
        var languages = new HashSet<string>(StringComparer.Ordinal);
        var start = 0;
        // Parenthetical notes can contain separators of their own.
        foreach (Match part in Pattern(TrackNote + @"|(?<separator>[,/;+&]|\band\b)").Matches(trackList))
        {
            if (!part.Groups["separator"].Success) continue;
            languages.UnionWith(AudioTrackLanguages(trackList[start..part.Index]));
            start = part.Index + part.Length;
        }
        languages.UnionWith(AudioTrackLanguages(trackList[start..]));
        return [.. languages];
    }

    private static ImmutableArray<string> AudioTrackLanguages(string value)
    {
        var entry = UnwrapTrack(value);
        var notePattern = Pattern(TrackNote);
        var notes = notePattern.Matches(entry).Select(note => note.Value[1..^1]).ToList();
        var core = notePattern.Replace(entry, " ");
        var provenance = Pattern(@"\s+[-–—]\s+").Match(core);
        if (provenance.Success)
        {
            notes.Add(core[(provenance.Index + provenance.Length)..]);
            core = core[..provenance.Index];
        }
        if (IsSupplementaryAudio(core)) return [];
        var track = Pattern(@"^\s*(?:" + TrackQualifier + @"\s+)*(?<language>" + LanguageTag +
            @")(?:\s+" + TrackQualifier + @")*\s*$").Match(WithoutNonDialogueClaims(core));
        if (!track.Success) return ["und"];
        var language = ReadLanguageTags(track.Groups["language"].Value).Single();
        var uncertain = false;
        foreach (var note in notes)
        {
            var named = ReadLanguageTags(note);
            if (IsSupplementaryAudio(note))
            {
                // An unqualified commentary note describes the track it is attached to.
                if (named.IsEmpty || named.Contains(language)) return [];
                continue;
            }
            if ((named.IsEmpty || named.Contains(language)) && Pattern(Negation + "|" + Uncertainty).IsMatch(note))
                return ["und"];
            uncertain |= ReadLanguageTags(WithoutNonDialogueClaims(note)).Any(tag => tag != language);
        }
        return uncertain ? [language, "und"] : [language];
    }

    private static string UnwrapTrack(string value)
    {
        var trimmed = value.Trim();
        var wrapped = Pattern(@"^(?:\[(?<value>[^\[\]]*)\]|\((?<value>[^()]*)\))$").Match(trimmed);
        return wrapped.Success ? wrapped.Groups["value"].Value : trimmed;
    }

    private static ImmutableArray<string> ReadLanguageTags(string text) =>
        [.. Pattern(LanguageTag).Matches(text)
            .Select(match => match.Value.ToLowerInvariant() switch
            {
                "english" or "eng" or "en" => "en",
                "japanese" or "japonais" or "jpn" or "jap" or "jp" or "ja" => "ja",
                "french" or "francais" or "français" or "fra" or "fre" or "fr" or "vf" or "truefrench" => "fr",
                "portuguese" or "português" or "portugués" or "por" or "ptbr" or "pt-br" or "pt br" or "dublado" => "pt",
                var tag => tag,
            }).Distinct(StringComparer.Ordinal)];

    public static bool SearchExhausted(CandidateBatch batch) => batch.Complete && !batch.EarlyStopped &&
        !batch.ProvisionalStopped && !batch.RequestBudgetExhausted && !batch.Queries.IsEmpty &&
        batch.Queries.All(q => q.Result.Outcome == SourceOutcome.Success && q.Result.Complete &&
            q.Result.Diagnostics?.Truncated != true);

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Regex> Patterns = new();
    private static Regex Pattern(string pattern) => Patterns.GetOrAdd(pattern, p => new Regex(p,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)));
}
