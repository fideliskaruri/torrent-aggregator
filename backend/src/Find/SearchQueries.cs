using System.Collections.Immutable;
using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Find;

public static partial class SearchQueries
{
    public static string Fold(string value)
    {
        var text = value.Replace("&", " and ", StringComparison.Ordinal).Normalize(NormalizationForm.FormKD);
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
        var original = ordered.FirstOrDefault(n => (n.Label is NameLabel.Romaji or NameLabel.Original or NameLabel.Native)
            && !seen.Contains(Fold(n.Value)));
        if (original is not null && seen.Add(Fold(original.Value)))
            yield return (SearchNamePhase.Original, original.Value);
        var synonyms = 0;
        foreach (var name in ordered.Where(n => n.Label == NameLabel.Synonym && n.Authoritative))
            if (seen.Add(Fold(name.Value)))
            {
                yield return (SearchNamePhase.Synonym, name.Value);
                if (++synonyms == 2) break;
            }
    }

    internal static ImmutableArray<string> Build(WorkSnapshot work, TargetScope scope, string name,
        bool includeYear = false)
    {
        var queries = new List<string>();
        var episodes = work.Episodes.Where(e => scope.EpisodeIds.Contains(e.Id)).ToArray();
        if (scope.Film)
        {
            queries.Add(includeYear && work.Work.Year is { } year ? $"{name} {year}" : name);
        }
        else
        {
            if (episodes.Length == 1)
                foreach (var e in episodes)
                {
                    var season = work.Seasons.First(s => s.Id == e.SeasonId);
                    queries.Add($"{name} S{season.Number:00}E{e.Number:00}");
                }
            else queries.Add(name);
            foreach (var season in work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id)).OrderBy(s => s.Number))
                queries.Add($"{name} S{season.Number:00}");
            if (episodes.Length == 1 && work.Work.Anime == true && episodes[0].AbsoluteNumber is { } absolute &&
                episodes[0].MappingStatus == MappingStatus.Confirmed)
                queries.Add($"{name} {absolute:00}");
        }
        var originals = queries.Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        var variants = new List<string>();
        if (!scope.Film)
        {
            var requestedSeasons = work.Seasons.Where(s => episodes.Any(e => e.SeasonId == s.Id))
                .OrderBy(s => s.Number).ToArray();
            foreach (var season in requestedSeasons)
                variants.Add($"{name} Season {season.Number}");
            if (episodes.Length == 1)
            {
                var episode = episodes[0];
                var season = work.Seasons.First(s => s.Id == episode.SeasonId);
                variants.Add($"{name} {season.Number}x{episode.Number:00}");
            }
            else if (episodes.Length is >= 2 and <= 4)
            {
                foreach (var episode in episodes)
                {
                    var season = work.Seasons.First(s => s.Id == episode.SeasonId);
                    variants.Add($"{name} S{season.Number:00}E{episode.Number:00}");
                }
            }
        }
        return [.. originals.Concat(variants).Distinct(StringComparer.OrdinalIgnoreCase)
            .Take(Math.Max(originals.Length, 8))];
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
