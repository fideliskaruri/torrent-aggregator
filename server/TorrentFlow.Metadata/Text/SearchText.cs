using System.Globalization;
using System.Text;
using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Text;

/// <summary>Port of src/lib/search/query-variants.ts.</summary>
public static partial class QueryVariants
{
    [GeneratedRegex(@"[\s\u00a0\u200b-\u200d\ufeff]+")] private static partial Regex Ws();
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"^(?:18|19|20|21)\d{2}$")] private static partial Regex YearToken();
    [GeneratedRegex(@"^(?:s|e|ep|season|episode)\d{1,3}$")] private static partial Regex NumberedSe();
    [GeneratedRegex(@"^\d{1,3}$")] private static partial Regex SmallNumber();
    [GeneratedRegex(@"\(\s*(?:19|20)\d{2}\s*\)")] private static partial Regex ParenYear();
    [GeneratedRegex(@"\s+[-–—]\s*")] private static partial Regex DashSplit();
    [GeneratedRegex(@"[-–—]+$")] private static partial Regex TrailingDash();
    [GeneratedRegex(@"[^\p{L}\p{N}\s]")] private static partial Regex NonAlnumSpace();
    [GeneratedRegex(@"^[\p{L}\p{N}]+$")] private static partial Regex AllAlnum();

    private static readonly HashSet<string> Qualifiers = ["anime", "episode", "episodes", "film", "movie", "season", "series", "show", "tv"];
    private static readonly HashSet<string> Articles = ["a", "an", "the"];

    public static string Canonicalize(string raw) => Ws().Replace(TextUtil.CompatibilityFold(raw ?? "", false), " ").Trim().ToLowerInvariant();

    public static string Display(string raw) => Ws().Replace(TextUtil.CompatibilityFold(raw ?? "", false), " ").Trim();

    public static string SearchIntentQuery(string raw)
    {
        var normalized = Spaces(NonAlnum().Replace(Canonicalize(raw), " ").Trim());
        var tokens = normalized.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var kept = new List<string>();
        var years = new List<string>();
        for (var i = 0; i < tokens.Length; i++)
        {
            var token = tokens[i];
            if (YearToken().IsMatch(token)) { years.Add(token); continue; }
            if (NumberedSe().IsMatch(token) || Qualifiers.Contains(token))
            {
                if ((token == "season" || token == "episode") && i + 1 < tokens.Length && SmallNumber().IsMatch(tokens[i + 1])) i++;
                continue;
            }
            kept.Add(token);
        }
        if (kept.Any(t => !Articles.Contains(t))) return string.Join(' ', kept);
        if (years.Count > 0) return years[0];
        var joined = string.Join(' ', kept);
        return joined.Length > 0 ? joined : normalized;
    }

    public static List<string> SearchTitleVariants(string title)
    {
        var raw = (title ?? "").Trim();
        var output = new List<string>();
        if (raw.Length == 0) return output;
        void Add(string value)
        {
            var v = Spaces(value).Trim();
            if (v.Length < 2) return;
            if (output.Any(x => string.Equals(x, v, StringComparison.OrdinalIgnoreCase))) return;
            output.Add(v);
        }
        Add(raw);
        var noYear = Spaces(ParenYear().Replace(raw, " ")).Trim();
        Add(noYear);
        var dashHead = TrailingDash().Replace(DashSplit().Split(noYear)[0], "").Trim();
        Add(dashHead);
        foreach (var b in new[] { dashHead, noYear })
        {
            Add(b.Replace(":", " "));
            Add(b.Replace(":", ""));
            var alnum = Spaces(NonAlnumSpace().Replace(Regex.Replace(b, "[:._]", " "), " ")).Trim();
            Add(alnum);
            Add(Regex.Replace(alnum, @"\s+", ""));
        }
        return output.Take(6).ToList();
    }

    public static List<string> SearchDiscoveryVariants(string title)
    {
        var variants = SearchTitleVariants(title);
        var intent = SearchIntentQuery((title ?? "").Trim());
        if (intent.Length > 0 && !variants.Any(v => string.Equals(v, intent, StringComparison.OrdinalIgnoreCase))) variants.Add(intent);
        if (AllAlnum().IsMatch(intent) && intent.Length >= 6)
        {
            var prefix = TextUtil.TakeCodePoints(intent, 4);
            if (!variants.Any(v => string.Equals(v, prefix, StringComparison.OrdinalIgnoreCase))) variants.Add(prefix);
        }
        if (variants.Count == 0) return [];
        var result = new List<string> { variants[0] };
        result.AddRange(variants.Skip(1).TakeLast(2));
        return result;
    }

    private static string Spaces(string s) => Regex.Replace(s, @"\s+", " ");
}

/// <summary>Port of src/lib/search/relevance.ts.</summary>
public static partial class Relevance
{
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"^(?:the|a|an) ")] private static partial Regex LeadingArticle();

    private const int MinFuzzyLength = 5, MaxFuzzyQueryLength = 64, MaxFuzzyCandidateLength = 96;

    public static string NormalizeForMatch(string value)
    {
        var d = TextUtil.CompatibilityFold(value ?? "", true);
        var sb = new StringBuilder(d.Length);
        foreach (var ch in d)
        {
            var cat = CharUnicodeInfo.GetUnicodeCategory(ch);
            if (cat is UnicodeCategory.NonSpacingMark or UnicodeCategory.SpacingCombiningMark or UnicodeCategory.EnclosingMark) continue;
            sb.Append(ch);
        }
        return Regex.Replace(NonAlnum().Replace(sb.ToString().ToLowerInvariant(), " ").Trim(), @"\s+", " ");
    }

    private static string Compact(string value) => NormalizeForMatch(value).Replace(" ", "");

    public static int? BoundedDamerauLevenshtein(string left, string right, int maxDistance)
    {
        var a = TextUtil.CodePoints(left);
        var b = TextUtil.CodePoints(right);
        if (Math.Abs(a.Length - b.Length) > maxDistance) return null;
        var rows = new Dictionary<int, int>[a.Length + 1];
        for (var i = 0; i <= a.Length; i++) rows[i] = new();
        rows[0][0] = 0;
        for (var j = 1; j <= Math.Min(b.Length, maxDistance); j++) rows[0][j] = j;
        const int Inf = int.MaxValue / 2;
        int Get(Dictionary<int, int> r, int k) => r.TryGetValue(k, out var v) ? v : Inf;
        for (var i = 1; i <= a.Length; i++)
        {
            var row = rows[i];
            var start = Math.Max(1, i - maxDistance);
            var end = Math.Min(b.Length, i + maxDistance);
            if (start == 1 && i <= maxDistance) row[0] = i;
            for (var j = start; j <= end; j++)
            {
                var same = a[i - 1] == b[j - 1];
                var distance = Math.Min(Math.Min(Get(rows[i - 1], j) + 1, Get(row, j - 1) + 1), Get(rows[i - 1], j - 1) + (same ? 0 : 1));
                if (i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1])
                    distance = Math.Min(distance, Get(rows[i - 2], j - 2) + 1);
                if (distance <= maxDistance) row[j] = distance;
            }
        }
        return rows[a.Length].TryGetValue(b.Length, out var result) ? result : null;
    }

    private static int? FuzzyDistance(string query, string name)
    {
        var q = Compact(query);
        var n = Compact(name);
        var ql = TextUtil.CodePoints(q).Length;
        var nl = TextUtil.CodePoints(n).Length;
        if (ql < MinFuzzyLength || nl < MinFuzzyLength || ql > MaxFuzzyQueryLength || nl > MaxFuzzyCandidateLength) return null;
        var max = Math.Min(2, Math.Max(1, ql / 6));
        return BoundedDamerauLevenshtein(q, n, max);
    }

    public static int QueryRelevanceTier(string query, string name)
    {
        var q = QueryVariants.SearchIntentQuery(query);
        if (q.Length == 0) return 6;
        var n = NormalizeForMatch(name);
        var qCompact = Compact(q);
        var nCompact = Compact(name);
        var qBare = LeadingArticle().Replace(q, "");
        var nBare = LeadingArticle().Replace(n, "");
        var nBareCompact = Compact(nBare);
        var qBareCompact = Compact(qBare);
        var nInitials = string.Concat(nBare.Split(' ', StringSplitOptions.RemoveEmptyEntries).Select(t => TextUtil.TakeCodePoints(t, 1)));
        if (n == q || nBare == qBare) return 0;
        if (n.StartsWith(q, StringComparison.Ordinal) || nBare.StartsWith(qBare, StringComparison.Ordinal) || nCompact == qCompact ||
            nBareCompact == qBareCompact || nCompact.StartsWith(qCompact, StringComparison.Ordinal) ||
            nBareCompact.StartsWith(qBareCompact, StringComparison.Ordinal) || (qBareCompact.Length >= 2 && nInitials == qBareCompact))
            return 1;
        if (Regex.IsMatch(n, $"(?:^| ){Regex.Escape(q)}(?: |$)")) return 2;
        if (n.Contains(q, StringComparison.Ordinal)) return 3;
        var tokens = qBare.Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (tokens.Length > 0 && tokens.All(t => n.Contains(t, StringComparison.Ordinal))) return 4;
        if (FuzzyDistance(q, name) != null) return 5;
        return 6;
    }

    public static int BestTier(string query, IEnumerable<string?> names)
    {
        var best = 6;
        foreach (var name in names)
        {
            if (string.IsNullOrWhiteSpace(name)) continue;
            best = Math.Min(best, QueryRelevanceTier(query, name));
            if (best == 0) break;
        }
        return best;
    }

    public static bool HasRelevantTitle(string query, IEnumerable<string?> names) => BestTier(query, names) < 6;

    /// <summary>Port of rankTitleHitsByRelevance (components/search/title-search.ts).</summary>
    public static List<T> RankTitleHits<T>(IReadOnlyList<T> hits, string query, Func<T, string> title, Func<T, IEnumerable<string>?> aliases)
    {
        if (string.IsNullOrWhiteSpace(query)) return [.. hits];
        return hits
            .Select((hit, index) => (hit, index,
                exact: BestTier(query, [title(hit)]) == 0,
                tier: BestTier(query, new[] { title(hit) }.Concat(aliases(hit) ?? []))))
            .OrderByDescending(x => x.exact).ThenBy(x => x.tier).ThenBy(x => x.index)
            .Select(x => x.hit).ToList();
    }

    /// <summary>Port of interleaveByProviderRank: deterministic FNV-1a rotation per rank round.</summary>
    public static List<T> InterleaveByProviderRank<T>(IReadOnlyList<IReadOnlyList<T>> groups, string query)
    {
        var output = new List<T>();
        var maxLength = groups.Count == 0 ? 0 : groups.Max(g => g.Count);
        unchecked
        {
            var hash = (int)2166136261u;
            var cps = TextUtil.CodePoints(query.Trim().ToLowerInvariant());
            foreach (var cp in cps)
            {
                hash ^= cp;
                hash *= 16777619;
            }
            // Before the first XOR, JS keeps the unsigned literal as a double.
            double hashValue = cps.Length == 0 ? 2166136261d : hash;
            for (var rank = 0; rank < maxLength; rank++)
            {
                var round = groups.Where(g => rank < g.Count && g[rank] is not null).Select(g => g[rank]).ToList();
                if (round.Count == 0) continue;
                // JS: Math.abs(hash + rank) evaluated in double precision.
                var offset = (int)(Math.Abs(hashValue + rank) % round.Count);
                for (var i = 0; i < round.Count; i++) output.Add(round[(offset + i) % round.Count]);
            }
        }
        return output;
    }
}

public static class TextUtil
{
    /// <summary>JS String.prototype.normalize("NFKD"/"NFKC"); callers strip the combining marks themselves when folding accents.</summary>
    public static string CompatibilityFold(string value, bool stripAccents) =>
        value.Normalize(stripAccents ? NormalizationForm.FormKD : NormalizationForm.FormKC);

    public static int[] CodePoints(string s)
    {
        var list = new List<int>(s.Length);
        foreach (var rune in s.EnumerateRunes()) list.Add(rune.Value);
        return [.. list];
    }

    public static string TakeCodePoints(string s, int count)
    {
        var sb = new StringBuilder();
        foreach (var rune in s.EnumerateRunes())
        {
            if (count-- <= 0) break;
            sb.Append(rune.ToString());
        }
        return sb.ToString();
    }

    /// <summary>JS encodeURIComponent.</summary>
    public static string EncodeUriComponent(string value) => Uri.EscapeDataString(value)
        .Replace("%21", "!").Replace("%27", "'").Replace("%28", "(").Replace("%29", ")").Replace("%2A", "*");

    /// <summary>URLSearchParams (application/x-www-form-urlencoded) encoding.</summary>
    public static string FormEncode(string value)
    {
        var sb = new StringBuilder();
        foreach (var b in Encoding.UTF8.GetBytes(value))
        {
            var c = (char)b;
            if (c is >= 'a' and <= 'z' or >= 'A' and <= 'Z' or >= '0' and <= '9' or '*' or '-' or '.' or '_') sb.Append(c);
            else if (c == ' ') sb.Append('+');
            else sb.Append('%').Append(b.ToString("X2"));
        }
        return sb.ToString();
    }

    public static string BuildQuery(IEnumerable<(string Key, string Value)> pairs) =>
        string.Join('&', pairs.Select(p => $"{FormEncode(p.Key)}={FormEncode(p.Value)}"));
}

