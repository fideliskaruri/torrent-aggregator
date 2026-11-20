using System.Text.RegularExpressions;

namespace TorrentFlow.Domain;

/// <summary>Acquisition evidence advertised by a name, never a claim about inspected media tracks.</summary>
public static class AnimeAudioPolicy
{
    public static bool EnglishFirst(WorkSnapshot? work, string? language) => work?.Work.Anime == true &&
        (string.IsNullOrWhiteSpace(language) || language.Trim().ToLowerInvariant() is "auto" or "en" or "eng" or "english");

    // 0: explicitly English; 1: advertised dual/multi without conflicting language evidence;
    // 2: unknown (including sub-only labels); 3: explicitly Japanese; -1: another language.
    public static int Rank(ParsedRelease release)
    {
        var text = release.RawName.Replace('_', ' ').Replace('.', ' ');
        if (!string.IsNullOrWhiteSpace(release.Title)) text = text.Replace(release.Title, " ", StringComparison.OrdinalIgnoreCase);
        if (!string.IsNullOrWhiteSpace(release.Group)) text = text.Replace(release.Group, " ", StringComparison.OrdinalIgnoreCase);
        text = Match(@"\b(?:en|eng|english|ja|jp|jpn|japanese|dual|multi)(?:[- ._]+(?:en|eng|english|ja|jp|jpn|japanese))*[\s\[\]():_-]*(?:subs?|subbed|subtitles?|softsubs?|hardsubs?)\b").Replace(text, " ");
        text = Match(@"\b(?:subs?|subtitles?)\s*[:=-]?\s*(?:en|eng|english|multi)\b").Replace(text, " ");
        text = Match(@"\bJP[- ._]*BD\b").Replace(text, " ");
        if (Match(@"\b(?:en|eng|english)\b").IsMatch(text)) return 0;
        if (Match(@"\b(?:french|fra|fre|german|ger|deu|spanish|spa|russian|rus|hindi|hin|tamil|tam|telugu|tel|italian|ita|korean|kor|chinese|mandarin|cantonese|portuguese|por|ptbr|dublado)\b").IsMatch(text)) return -1;
        if (Match(@"\b(?:dual|multi)(?:[- ._]*audio)?\b").IsMatch(text)) return 1;
        if (Match(@"\b(?:ja|jp|jpn|japanese|raw|raws)\b").IsMatch(text)) return 3;
        return release.ClearlyForeign || release.Foreign == ForeignStatus.Yes ? -1 : 2;
    }

    public static bool SearchExhausted(CandidateBatch batch) => batch.Complete && !batch.EarlyStopped &&
        !batch.ProvisionalStopped && !batch.RequestBudgetExhausted && !batch.Queries.IsEmpty &&
        batch.Queries.All(q => q.Result.Outcome == SourceOutcome.Success && q.Result.Complete &&
            q.Result.Diagnostics?.Truncated != true);

    private static readonly System.Collections.Concurrent.ConcurrentDictionary<string, Regex> Patterns = new();
    private static Regex Match(string pattern) => Patterns.GetOrAdd(pattern, p => new Regex(p,
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromMilliseconds(100)));
}
