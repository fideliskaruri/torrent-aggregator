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
    private const string AccentedSource = "\u00C0\u00C1\u00C2\u00C3\u00C4\u00C5\u00C7\u00C8\u00C9\u00CA\u00CB\u00CC\u00CD\u00CE\u00CF\u00D1\u00D2\u00D3\u00D4\u00D5\u00D6\u00D9\u00DA\u00DB\u00DC\u00DD\u00E0\u00E1\u00E2\u00E3\u00E4\u00E5\u00E7\u00E8\u00E9\u00EA\u00EB\u00EC\u00ED\u00EE\u00EF\u00F1\u00F2\u00F3\u00F4\u00F5\u00F6\u00F9\u00FA\u00FB\u00FC\u00FD\u00FF\u0100\u0101\u0102\u0103\u0104\u0105\u0106\u0107\u0108\u0109\u010A\u010B\u010C\u010D\u010E\u010F\u0112\u0113\u0114\u0115\u0116\u0117\u0118\u0119\u011A\u011B\u011C\u011D\u011E\u011F\u0120\u0121\u0122\u0123\u0124\u0125\u0128\u0129\u012A\u012B\u012C\u012D\u012E\u012F\u0130\u0134\u0135\u0136\u0137\u0139\u013A\u013B\u013C\u013D\u013E\u0143\u0144\u0145\u0146\u0147\u0148\u014C\u014D\u014E\u014F\u0150\u0151\u0154\u0155\u0156\u0157\u0158\u0159\u015A\u015B\u015C\u015D\u015E\u015F\u0160\u0161\u0162\u0163\u0164\u0165\u0168\u0169\u016A\u016B\u016C\u016D\u016E\u016F\u0170\u0171\u0172\u0173\u0174\u0175\u0176\u0177\u0178\u0179\u017A\u017B\u017C\u017D\u017E\u017F\u01A0\u01A1\u01AF\u01B0\u01CD\u01CE\u01CF\u01D0\u01D1\u01D2\u01D3\u01D4\u01D5\u01D6\u01D7\u01D8\u01D9\u01DA\u01DB\u01DC\u01DE\u01DF\u01E0\u01E1\u01E6\u01E7\u01E8\u01E9\u01EA\u01EB\u01EC\u01ED\u01F0\u01F4\u01F5\u01F8\u01F9\u01FA\u01FB\u0200\u0201\u0202\u0203\u0204\u0205\u0206\u0207\u0208\u0209\u020A\u020B\u020C\u020D\u020E\u020F\u0210\u0211\u0212\u0213\u0214\u0215\u0216\u0217\u0218\u0219\u021A\u021B\u021E\u021F\u0226\u0227\u0228\u0229\u022A\u022B\u022C\u022D\u022E\u022F\u0230\u0231\u0232\u0233";
    private const string AccentedBase = "AAAAAACEEEEIIIINOOOOOUUUUYaaaaaaceeeeiiiinooooouuuuyyAaAaAaCcCcCcCcDdEeEeEeEeEeGgGgGgGgHhIiIiIiIiIJjKkLlLlLlNnNnNnOoOoOoRrRrRrSsSsSsSsTtTtUuUuUuUuUuUuWwYyYZzZzZzsOoUuAaIiOoUuUuUuUuUuAaAaGgKkOoOojGgNnAaAaAaEeEeIiIiOoOoRrRrUuUuSsTtHhAaEeOoOoOoOoYy";
    private static readonly Dictionary<char, char> AccentFold = AccentedSource.Zip(AccentedBase).ToDictionary(p => p.First, p => p.Second);

    /// <summary>
    /// String.Normalize(FormKC/FormKD) is effectively a no-op under InvariantGlobalization (set in Directory.Build.props), so
    /// the compatibility folds the TS code relies on are applied explicitly: fullwidth ASCII (U+FF01–FF5E), the ideographic
    /// space, and — for decomposition — Latin letters with diacritics mapped to their base letter.
    /// </summary>
    public static string CompatibilityFold(string value, bool stripAccents)
    {
        var s = value.Normalize(stripAccents ? NormalizationForm.FormKD : NormalizationForm.FormKC);
        var sb = new StringBuilder(s.Length);
        foreach (var c in s)
        {
            if (c is >= '\uFF01' and <= '\uFF5E') sb.Append((char)(c - 0xFEE0));
            else if (c == '\u3000') sb.Append(' ');
            else if (stripAccents && AccentFold.TryGetValue(c, out var b)) sb.Append(b);
            else sb.Append(c);
        }
        return sb.ToString();
    }
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

