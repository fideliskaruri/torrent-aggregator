using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed record SearchCandidate(WorkSnapshot Work, double Popularity, bool Animated = false,
    string? Format = null, DateTimeOffset? ReleasedAt = null, bool Stored = false)
{
    internal string Provider => Work.Links.First(l => l.IsPrimary).Provider;
    internal string Title => Work.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value
        ?? Work.Names.First().Value;
    internal IEnumerable<string> Names => Work.Names.Select(n => n.Value);
    internal Dictionary<string, string> Ids => Work.Links
        .Where(l => l.Status == LinkStatus.Verified && l.Source != "fribb" && l.SeasonId is null)
        .DistinctBy(l => l.Provider == "cinemeta" ? "imdb" : l.Provider)
        .ToDictionary(l => l.Provider == "cinemeta" ? "imdb" : l.Provider, l => l.ExternalId);
}

/// <summary>Legacy title-match, popularity and catalog-card merge rules; no provider or Store I/O.</summary>
internal static class SearchRanking
{
    internal static double PositionPrior(int index) => Math.Max(0.1, 0.45 - 0.03 * index);
    internal static double AnimePopularity(int? users) =>
        users is > 0 ? Math.Clamp((Math.Log10(users.Value) - 2) / 4, 0, 1) : 0.2;
    internal static double TvmazeWeight(int? weight) =>
        weight is >= 0 ? 0.9 * Math.Pow(Math.Min(weight.Value, 100) / 100.0, 2) : 0.2;

    internal static List<SearchCandidate> Rank(IReadOnlyList<SearchCandidate> rows, string query,
        IReadOnlyDictionary<string, int> imdbRanks, DateTimeOffset now)
    {
        var tiers = rows.Select(r => SearchText.BestTier(query, r.Names)).ToArray();
        var typoMode = tiers.All(t => t > 3);
        var years = SearchText.Years(query);
        var scored = rows.Select((r, index) =>
        {
            var matches = tiers[index] < 6;
            var popularity = r.Ids.TryGetValue("imdb", out var id) && imdbRanks.TryGetValue(id, out var rank)
                ? Math.Clamp((6.3 - Math.Log10(Math.Max(1, rank))) / 4.3, 0, 1) : r.Popularity;
            var score = (matches ? SearchText.MatchScore(query, r.Names, typoMode) : -10) + popularity;
            if (r.Format == "MUSIC") score -= 0.4;
            if (r.Work.Work.ProviderStatus == "NOT_YET_RELEASED" || r.ReleasedAt > now ||
                r.Work.Work.Year > now.Year) score -= 0.3;
            if (years.Contains(r.Work.Work.Year ?? 0) || SearchText.Normalize(r.Title).Split(' ')
                .Any(t => int.TryParse(t, out var year) && years.Contains(year))) score += 0.6;
            return (Row: r, Index: index, Score: score, Matches: matches);
        }).OrderByDescending(r => r.Score).ThenBy(r => r.Index);
        var result = new List<SearchCandidate>();
        foreach (var (row, _, _, matches) in scored)
        {
            var slot = result.FindIndex(other => SameWork(row, other, rows));
            if (slot < 0)
            {
                if (matches) result.Add(row);
                continue;
            }
            var card = result[slot];
            var prefer = row.Stored != card.Stored ? row.Stored :
                card.Provider != "anilist" && (row.Provider == "anilist"
                    ? card.Animated || row.Work.Work.Kind == WorkKind.Film && card.Work.Work.Kind == WorkKind.Film
                    : IdentityRank(row.Provider) < IdentityRank(card.Provider));
            result[slot] = prefer ? Absorb(row, card) : Absorb(card, row);
        }
        return result;
    }

    private static int IdentityRank(string provider) => provider switch
    {
        "tvmaze" => 1, "tmdb" => 2, "cinemeta" or "imdb" => 3, "itunes" => 4, _ => 5,
    };
    private static bool SameWork(SearchCandidate a, SearchCandidate b, IReadOnlyList<SearchCandidate> rows)
    {
        if (a.Work.Work.Kind != b.Work.Work.Kind) return false;
        var left = a.Ids;
        var right = b.Ids;
        if (left.Any(p => right.TryGetValue(p.Key, out var value) && value != p.Value)) return false;
        if (a.Work.Work.WorkKey == b.Work.Work.WorkKey) return true;
        if (left.Any(p => right.TryGetValue(p.Key, out var value) && value == p.Value)) return true;
        if (a.Work.Work.Kind == WorkKind.Series && left.Keys.Intersect(right.Keys).Any()) return false;
        if (a.Work.Work.Year is { } y && b.Work.Work.Year is { } z && Math.Abs(y - z) > 1) return false;
        if (a.Work.Work.Kind == WorkKind.Series)
            return (a.Provider == "anilist" && b.Animated || b.Provider == "anilist" && a.Animated ||
                a.Provider != b.Provider) &&
                a.Names.Any(n => b.Names.Any(m => SearchText.Compact(n) == SearchText.Compact(m)));
        if (a.Provider == b.Provider || a.Work.Work.Year is null || b.Work.Work.Year is null) return false;
        if (a.Work.Work.Year != b.Work.Work.Year) return false;
        return a.Names.Select(FilmName).Any(n => b.Names.Select(FilmName)
            .Any(m => n == m || a.Work.Work.Year == b.Work.Work.Year && n.Length >= 5 &&
                SearchText.Distance(n, m, 1) is not null));
    }
    private static string FilmName(string title)
    {
        var name = SearchText.Compact(title);
        foreach (var suffix in new[] { "themovie", "movie" })
            if (name.Length > suffix.Length + 3 && name.EndsWith(suffix, StringComparison.Ordinal))
                return name[..^suffix.Length];
        return name;
    }
    private static SearchCandidate Absorb(SearchCandidate card, SearchCandidate other) => card with
    {
        Work = card.Work with
        {
            Work = card.Work.Work with
            {
                PosterUrl = card.Work.Work.PosterUrl ?? other.Work.Work.PosterUrl,
                Synopsis = card.Work.Work.Synopsis ?? other.Work.Work.Synopsis,
            },
            Names = [.. card.Work.Names, .. other.Work.Names.Where(n => !card.Work.Names.Any(m =>
                string.Equals(n.Value, m.Value, StringComparison.OrdinalIgnoreCase)))
                .Select(n => n with { Label = NameLabel.Synonym })],
            Links = [.. card.Work.Links, .. other.Work.Links.Where(l => !card.Work.Links.Any(m =>
                m.Provider == l.Provider)).Select(l => l with { IsPrimary = false })],
        },
    };
}

internal static class SearchText
{
    internal static string Canonical(string value) => Regex.Replace(
        value.Normalize(NormalizationForm.FormKC), @"[\s\u00a0\u200b-\u200d\ufeff]+", " ").Trim().ToLowerInvariant();
    internal static string Normalize(string value)
    {
        var text = new StringBuilder();
        foreach (var c in value.Normalize(NormalizationForm.FormKD))
            if (CharUnicodeInfo.GetUnicodeCategory(c) is not (UnicodeCategory.NonSpacingMark or
                UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark)) text.Append(c);
        return Regex.Replace(Regex.Replace(text.ToString().ToLowerInvariant(), @"[^\p{L}\p{N}]+", " ").Trim(), @"\s+", " ");
    }
    internal static string Compact(string value) => Normalize(value).Replace(" ", "");
    private static string Bare(string value) => Regex.Replace(Normalize(value), @"^(?:the|a|an) ", "");
    private static bool Year(string token) => Regex.IsMatch(token, @"^(?:18|19|20|21)\d{2}$");
    private static string Intent(string query)
    {
        var tokens = Normalize(Canonical(query)).Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var kept = new List<string>();
        var years = new List<string>();
        for (var i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i];
            if (Year(token)) { years.Add(token); continue; }
            if (Regex.IsMatch(token, @"^(?:s|e|ep|season|episode)\d{1,3}$") ||
                token is "anime" or "episode" or "episodes" or "film" or "movie" or "season" or "series" or "show" or "tv")
            {
                if (token is "season" or "episode" && i + 1 < tokens.Length &&
                    Regex.IsMatch(tokens[i + 1], @"^\d{1,3}$")) i++;
                continue;
            }
            kept.Add(token);
        }
        if (kept.Any(t => t is not ("a" or "an" or "the"))) return string.Join(' ', kept);
        return years.FirstOrDefault() ?? (kept.Count > 0 ? string.Join(' ', kept) : Normalize(query));
    }
    internal static int[] Years(string query) => Year(Intent(query)) ? [] :
        Normalize(Canonical(query)).Split(' ').Where(Year).Select(int.Parse).Distinct().ToArray();
    internal static int Tier(string query, string name)
    {
        var q = Intent(query);
        if (q.Length == 0) return 6;
        var n = Normalize(name);
        var qb = Bare(q);
        var nb = Bare(n);
        var qc = Compact(q);
        var nc = Compact(n);
        var qbc = Compact(qb);
        var nbc = Compact(nb);
        if (n == q || nb == qb) return 0;
        if (n.StartsWith(q, StringComparison.Ordinal) || nb.StartsWith(qb, StringComparison.Ordinal) ||
            nc == qc || nbc == qbc || nc.StartsWith(qc, StringComparison.Ordinal) ||
            nbc.StartsWith(qbc, StringComparison.Ordinal) ||
            qbc.Length >= 2 && string.Concat(nb.Split(' ').Where(t => t.Length > 0)
                .Select(t => t.EnumerateRunes().First().ToString())) == qbc) return 1;
        if (Regex.IsMatch(n, $"(?:^| ){Regex.Escape(q)}(?: |$)")) return 2;
        if (n.Contains(q, StringComparison.Ordinal)) return 3;
        if (qb.Split(' ', StringSplitOptions.RemoveEmptyEntries) is { Length: > 0 } tokens &&
            tokens.All(t => n.Contains(t, StringComparison.Ordinal))) return 4;
        var ql = qc.EnumerateRunes().Count();
        var nl = nc.EnumerateRunes().Count();
        return ql is >= 5 and <= 64 && nl is >= 5 and <= 96 &&
            Distance(qc, nc, Math.Min(2, Math.Max(1, ql / 6))) is not null ? 5 : 6;
    }
    internal static int BestTier(string query, IEnumerable<string> names) => names.Select(n => Tier(query, n)).DefaultIfEmpty(6).Min();
    internal static double MatchScore(string query, IEnumerable<string> names, bool typoMode) => names.Select(name =>
    {
        var tier = Tier(query, name);
        var length = Compact(Bare(name)).EnumerateRunes().Count();
        var coverage = length == 0 ? 0 : Math.Min(1, (double)Compact(Bare(Intent(query))).EnumerateRunes().Count() / length);
        return tier switch
        {
            0 => 1.0, 1 => 0.7 + 0.3 * coverage, 2 => 0.5 + 0.3 * coverage,
            3 => 0.4 + 0.2 * coverage, 4 => 0.3 + 0.2 * coverage, 5 => typoMode ? 0.75 : 0.3, _ => 0,
        };
    }).DefaultIfEmpty(0).Max();
    internal static int? Distance(string left, string right, int maximum)
    {
        var a = left.EnumerateRunes().ToArray();
        var b = right.EnumerateRunes().ToArray();
        if (Math.Abs(a.Length - b.Length) > maximum) return null;
        var matrix = new int[a.Length + 1, b.Length + 1];
        for (var i = 0; i <= a.Length; i++) matrix[i, 0] = i;
        for (var j = 0; j <= b.Length; j++) matrix[0, j] = j;
        for (var i = 1; i <= a.Length; i++)
            for (var j = 1; j <= b.Length; j++)
            {
                matrix[i, j] = Math.Min(Math.Min(matrix[i - 1, j] + 1, matrix[i, j - 1] + 1),
                    matrix[i - 1, j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1));
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1])
                    matrix[i, j] = Math.Min(matrix[i, j], matrix[i - 2, j - 2] + 1);
            }
        return matrix[a.Length, b.Length] <= maximum ? matrix[a.Length, b.Length] : null;
    }
    internal static List<T> Interleave<T>(IReadOnlyList<IReadOnlyList<T>> groups, string query)
    {
        var output = new List<T>();
        unchecked
        {
            var hash = (int)2166136261u;
            foreach (var rune in query.Trim().ToLowerInvariant().EnumerateRunes()) { hash ^= rune.Value; hash *= 16777619; }
            double value = query.Trim().Length == 0 ? 2166136261d : hash;
            for (var rank = 0; rank < groups.Select(g => g.Count).DefaultIfEmpty(0).Max(); rank++)
            {
                var round = groups.Where(g => rank < g.Count).Select(g => g[rank]).ToList();
                if (round.Count == 0) continue;
                var offset = (int)(Math.Abs(value + rank) % round.Count);
                for (var i = 0; i < round.Count; i++) output.Add(round[(offset + i) % round.Count]);
            }
        }
        return output;
    }
}
