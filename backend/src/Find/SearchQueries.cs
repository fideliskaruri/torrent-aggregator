using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

internal static partial class SearchQueries
{
    internal static string Fold(string value)
    {
        var text = value.Normalize(NormalizationForm.FormKD);
        var result = new StringBuilder();
        foreach (var rune in text.EnumerateRunes())
        {
            if (Rune.GetUnicodeCategory(rune) == UnicodeCategory.NonSpacingMark) continue;
            result.Append(Rune.IsLetterOrDigit(rune) ? Rune.ToLowerInvariant(rune).ToString() : " ");
        }
        return Spaces().Replace(result.ToString(), " ").Trim();
    }

    internal static IEnumerable<(SearchNamePhase Phase, string Name)> Names(WorkSnapshot work)
    {
        var ordered = work.Names.OrderBy(n => n.Ordinal).ToArray();
        var english = ordered.FirstOrDefault(n => n.Label == NameLabel.English) ?? ordered.FirstOrDefault();
        if (english is null) yield break;
        var seen = new HashSet<string>(StringComparer.Ordinal) { Fold(english.Value) };
        yield return (SearchNamePhase.English, english.Value);
        foreach (var name in ordered.Where(n => n.Label is NameLabel.Romaji or NameLabel.Original or NameLabel.Native))
            if (seen.Add(Fold(name.Value))) yield return (SearchNamePhase.Original, name.Value);
        foreach (var name in ordered.Where(n => n.Label == NameLabel.Synonym && n.Authoritative))
            if (seen.Add(Fold(name.Value))) yield return (SearchNamePhase.Synonym, name.Value);
    }

    internal static ImmutableArray<string> Build(WorkSnapshot work, TargetScope scope, string name,
        bool gaps = false, ISet<string>? covered = null)
    {
        var queries = new List<string>();
        if (scope.Film)
        {
            queries.Add(work.Work.Year is { } year ? $"{name} {year}" : name);
            queries.Add(name);
        }
        else
        {
            var episodes = work.Episodes.Where(e => scope.EpisodeIds.Contains(e.Id)).ToArray();
            foreach (var season in work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id)).OrderBy(s => s.Number))
                queries.Add($"{name} S{season.Number:00}");
            queries.Add(name);
            // Gap queries reuse source flights; never fan out a whole season once per episode.
            if (episodes.Length == 1 || gaps)
                foreach (var e in episodes.Where(e => covered?.Contains(e.Id) != true))
                {
                    var season = work.Seasons.First(s => s.Id == e.SeasonId);
                    queries.Add($"{name} S{season.Number:00}E{e.Number:00}");
                    if (work.Work.Anime == true && e.AbsoluteNumber is { } absolute &&
                        e.MappingStatus == MappingStatus.Confirmed)
                        queries.Add($"{name} {absolute:00}");
                }
        }
        return [.. queries.Distinct(StringComparer.OrdinalIgnoreCase)];
    }

    internal static IEnumerable<string> IdentityNames(WorkSnapshot work)
    {
        foreach (var name in work.Names)
        {
            yield return Fold(name.Value);
            // Only provider-delimited subtitles may shorten a title, never arbitrary substring matching.
            var split = name.Value.IndexOf(':');
            if (split > 0 && Fold(name.Value[..split]).Length >= 4) yield return Fold(name.Value[..split]);
        }
    }

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex Spaces();
}
