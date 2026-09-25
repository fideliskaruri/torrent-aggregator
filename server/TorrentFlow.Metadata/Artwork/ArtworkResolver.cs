using System.Globalization;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using Microsoft.Extensions.Options;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Text;

namespace TorrentFlow.Metadata.Artwork;

public sealed record ArtworkQuery(string Title, int? Year, string? MediaType);

public sealed record ArtworkResult(
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? PosterUrl,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? BackdropUrl)
{
    public static readonly ArtworkResult None = new(null, null);
}

public sealed record TmdbRef(int Id, string MediaType);

public sealed record ArtCandidate(string Title, int? Year, string? PosterUrl, string? BackdropUrl, string Kind, double Popularity, string Provider, int? TmdbId = null);

public sealed record NormalizedArtworkQuery(string Title, int? Year, string? MediaType);

/// <summary>Port of src/lib/metadata/artwork.ts (pure matching helpers).</summary>
public static partial class ArtworkMatching
{
    [GeneratedRegex(@"[^a-z0-9]+")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"^(the|a|an)\s+")] private static partial Regex LeadingArticle();
    [GeneratedRegex(@"\b(1080p|720p|480p|2160p|4k|uhd|hdr10?\+?|hevc|x26[45]|h\.?26[45]|av1|web-?dl|webrip|bluray|bdrip|brrip|dvdrip|hdtv|remux|proper|repack|multi|dual|subbed|dubbed|complete|batch)\b", RegexOptions.IgnoreCase)] private static partial Regex ReleaseNoise();
    [GeneratedRegex(@"\b(s\d{1,2}\s*-\s*s?\d{1,2}|s\d{1,2}e\d{1,3}(?:\s*-\s*e?\d{1,3})?|s\d{1,2}|e\d{1,3}|ep\s*\d{1,3}|season\s*\d+|part\s+\d+\s*$)\b", RegexOptions.IgnoreCase)] private static partial Regex SeasonEpisode();
    [GeneratedRegex(@"[(\[](\d{4})[)\]]")] private static partial Regex BracketYear();
    [GeneratedRegex(@"[(\[][^)\]]*[)\]]")] private static partial Regex Bracketed();
    [GeneratedRegex(@"[._\-\u2013\u2014|]+")] private static partial Regex Separators();
    [GeneratedRegex(@"^(.*\S)\s+(\d{4})$")] private static partial Regex TrailingYear();
    [GeneratedRegex(@"^([^:\u2013\u2014]+?)(?::|\s[-\u2013\u2014]\s)(.+)$")] private static partial Regex Subtitle();
    [GeneratedRegex(@"^[ivx]+$")] private static partial Regex Roman();

    private static readonly HashSet<string> InstalmentHeads = ["part", "parts", "chapter", "chapters", "vol", "volume", "book", "season", "episode", "act", "cycle", "phase", "round"];
    private static readonly HashSet<string> NumberWords = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
    private static readonly HashSet<string> PhraseContinuations = ["in", "on", "of", "at", "to", "from", "for", "with", "and", "or", "the", "a", "an", "into", "onto", "vs", "versus"];
    private static readonly string[] CompanionPrefixes = ["making", "behind the scenes", "documentary", "real story", "true story", "untold story", "inside story", "story of", "recap", "recaps", "extras", "bonus", "featurette", "featurettes", "special features"];

    public const int TierExact = 100, TierArticle = 72, TierSubtitle = 80, MinAccept = 60;

    public static string NormalizeTitleForMatch(string input)
    {
        var d = TextUtil.CompatibilityFold(input ?? "", true);
        var sb = new StringBuilder(d.Length);
        foreach (var ch in d) if (ch is < '\u0300' or > '\u036f') sb.Append(ch);
        var s = sb.ToString().ToLowerInvariant().Replace("&", " and ");
        s = Regex.Replace(s, "['\u2018\u2019`]", "");
        return Regex.Replace(NonAlnum().Replace(s, " "), @"\s+", " ").Trim();
    }

    private static string StripArticle(string normalized)
    {
        var stripped = LeadingArticle().Replace(normalized, "");
        return stripped.Length > 0 ? stripped : normalized;
    }

    private static string[] ComparableTokens(string title)
    {
        var t = StripArticle(NormalizeTitleForMatch(title));
        return t.Length > 0 ? t.Split(' ') : [];
    }

    public static bool PlausibleYear(int value) => value >= 1900 && value <= DateTime.UtcNow.Year + 5;

    public static (string Title, int? Year) CleanQueryTitle(string raw)
    {
        int? year = null;
        var by = BracketYear().Match(raw);
        if (by.Success && PlausibleYear(int.Parse(by.Groups[1].Value, CultureInfo.InvariantCulture))) year = int.Parse(by.Groups[1].Value, CultureInfo.InvariantCulture);
        var title = Bracketed().Replace(raw, " ");
        title = SeasonEpisode().Replace(title, " ");
        title = ReleaseNoise().Replace(title, " ");
        title = Regex.Replace(Separators().Replace(title, " "), @"\s+", " ").Trim();
        var trailing = TrailingYear().Match(title);
        if (trailing.Success && PlausibleYear(int.Parse(trailing.Groups[2].Value, CultureInfo.InvariantCulture)))
        {
            var head = trailing.Groups[1].Value.Trim();
            if (head.Length > 0 && NormalizeTitleForMatch(head).Length > 0)
            {
                title = head;
                year ??= int.Parse(trailing.Groups[2].Value, CultureInfo.InvariantCulture);
            }
        }
        title = DropTrailingListNoise(raw, title);
        return (title.Trim(), year);
    }

    private static string DropTrailingListNoise(string raw, string title)
    {
        var after = Math.Max(raw.LastIndexOf(']'), raw.LastIndexOf(')'));
        if (after < 0) return title;
        if (!Regex.IsMatch(raw[(after + 1)..], @"^\s*\d{1,4}\s*$")) return title;
        var stripped = Regex.Replace(title, @"\s+\d{1,4}$", "").Trim();
        return stripped.Length == 0 || NormalizeTitleForMatch(stripped).Length == 0 ? title : stripped;
    }

    private static bool IsInstalmentExtra(string[] extra)
    {
        if (extra.Length == 0) return false;
        if (InstalmentHeads.Contains(extra[0])) return true;
        if (extra.Length <= 2 && extra.All(t => Regex.IsMatch(t, @"^\d+$") || Roman().IsMatch(t) || NumberWords.Contains(t))) return true;
        return extra[0] == "final" || (extra[0] == "the" && extra.Length > 1 && extra[1] == "final");
    }

    private static bool IsCompanionExtra(string[] extra)
    {
        var significant = extra.Length > 0 && extra[0] is "the" or "a" or "an" ? extra[1..] : extra;
        if (significant.Length == 0) return false;
        var phrase = string.Join(' ', significant);
        return CompanionPrefixes.Any(p => phrase == p || phrase.StartsWith(p + " ", StringComparison.Ordinal));
    }

    private static bool IsDifferentWorkExtra(string[] extra) => IsInstalmentExtra(extra) || IsCompanionExtra(extra);

    private static double Dice(string[] a, string[] b)
    {
        if (a.Length == 0 || b.Length == 0) return 0;
        var pool = b.ToList();
        var hits = 0;
        foreach (var token in a)
        {
            var idx = pool.IndexOf(token);
            if (idx >= 0) { hits++; pool.RemoveAt(idx); }
        }
        return 2.0 * hits / (a.Length + b.Length);
    }

    public static double MatchTier(string queryTitle, string candidateTitle)
    {
        var qRaw = NormalizeTitleForMatch(queryTitle);
        var cRaw = NormalizeTitleForMatch(candidateTitle);
        if (qRaw.Length == 0 || cRaw.Length == 0) return 0;
        if (qRaw == cRaw) return TierExact;
        var q = StripArticle(qRaw);
        var c = StripArticle(cRaw);
        if (q == c) return TierArticle;
        var qTokens = q.Split(' ');
        var cTokens = c.Split(' ');
        var split = Subtitle().Match(candidateTitle);
        if (split.Success && split.Groups[1].Value.Trim().Length > 0 && split.Groups[2].Value.Trim().Length > 0 &&
            StripArticle(NormalizeTitleForMatch(split.Groups[1].Value.Trim())) == q)
        {
            return IsDifferentWorkExtra(ComparableTokens(split.Groups[2].Value.Trim())) ? 0 : TierSubtitle;
        }
        if (qTokens.Length > cTokens.Length && cTokens.Select((t, i) => qTokens[i] == t).All(x => x))
        {
            var extra = qTokens[cTokens.Length..];
            if (IsDifferentWorkExtra(extra)) return 0;
            return extra.Length <= 3 && !PhraseContinuations.Contains(extra[0]) ? TierSubtitle : 0;
        }
        return Dice(qTokens, cTokens) * 70;
    }

    private static int YearAdjustment(int? queryYear, ArtCandidate candidate)
    {
        if (queryYear is not { } qy || qy == 0) return 0;
        if (candidate.Year == null) return candidate.Kind == "movie" ? -5 : -3;
        var diff = candidate.Year.Value - qy;
        var abs = Math.Abs(diff);
        if (candidate.Kind == "movie") return abs == 0 ? 25 : abs == 1 ? 8 : -45;
        if (abs == 0) return 15;
        if (abs == 1) return 6;
        return diff >= 2 ? -45 : 0;
    }

    public static ArtCandidate? ChooseBest(NormalizedArtworkQuery query, IEnumerable<ArtCandidate> candidates, bool requireArt = true)
    {
        ArtCandidate? best = null;
        double bestScore = 0;
        foreach (var candidate in candidates)
        {
            if (requireArt && candidate.PosterUrl == null && candidate.BackdropUrl == null) continue;
            var tier = MatchTier(query.Title, candidate.Title);
            if (tier <= 0) continue;
            var s = tier + YearAdjustment(query.Year, candidate);
            if (s < MinAccept) continue;
            if (s > bestScore || (s == bestScore && best != null && candidate.Popularity > best.Popularity))
            {
                bestScore = s;
                best = candidate;
            }
        }
        return best;
    }

    public static NormalizedArtworkQuery? Normalize(ArtworkQuery q)
    {
        if (q?.Title == null) return null;
        var cleaned = CleanQueryTitle(q.Title);
        if (NormalizeTitleForMatch(cleaned.Title).Length == 0) return null;
        var year = q.Year ?? cleaned.Year;
        return new(cleaned.Title, year is { } y && y != 0 && PlausibleYear(y) ? y : null, q.MediaType);
    }

    public static string CacheKey(NormalizedArtworkQuery q) =>
        $"{q.MediaType ?? "any"}|{StripArticle(NormalizeTitleForMatch(q.Title))}|{(q.Year?.ToString(CultureInfo.InvariantCulture) ?? "-")}";

    /// <summary>Port of artworkKey (src/lib/metadata/release-art.ts).</summary>
    public static string ArtworkKey(string title, int? year)
    {
        var slug = Regex.Replace(Regex.Replace(title.ToLowerInvariant(), "[^a-z0-9]+", "-"), "^-|-$", "");
        return $"{slug}:{(year?.ToString(CultureInfo.InvariantCulture) ?? "")}";
    }
}

/// <summary>Port of resolveArtwork / resolveTmdbRef / resolveArtworkBatch with bounded positive/negative cache and in-flight coalescing.</summary>
public sealed class ArtworkResolver
{
    private const int BatchConcurrency = 6;
    private static readonly TimeSpan PositiveTtl = TimeSpan.FromHours(24);
    private static readonly TimeSpan NegativeTtl = TimeSpan.FromMinutes(15);

    private sealed record Resolved(ArtworkResult Artwork, TmdbRef? Ref, bool RefKnown);

    private readonly TmdbClient _tmdb;
    private readonly AniListClient _anilist;
    private readonly KeylessClients _keyless;
    private readonly IOptions<MetadataOptions> _options;
    private readonly BoundedTtlCache<Resolved> _cache;
    private readonly SingleFlight<Resolved> _inFlight = new();
    private readonly SingleFlight<TmdbRef?> _refInFlight = new();

    public ArtworkResolver(TmdbClient tmdb, AniListClient anilist, KeylessClients keyless, IOptions<MetadataOptions> options, TimeProvider time)
    {
        _tmdb = tmdb;
        _anilist = anilist;
        _keyless = keyless;
        _options = options;
        _cache = new(2000, time);
    }

    private int TimeoutMs => _options.Value.ArtworkTimeoutMs > 0 ? _options.Value.ArtworkTimeoutMs : 5000;

    public void Reset() => _cache.Clear();

    private void Write(string key, Resolved value)
    {
        var found = value.Artwork.PosterUrl != null || value.Artwork.BackdropUrl != null || value.Ref != null;
        _cache.Set(key, value, found ? PositiveTtl : NegativeTtl);
    }

    private async Task<T> Guarded<T>(Func<CancellationToken, Task<T>> work, T fallback)
    {
        using var cts = new CancellationTokenSource(TimeSpan.FromMilliseconds(TimeoutMs));
        try
        {
            var task = work(cts.Token);
            var done = await Task.WhenAny(task, Task.Delay(Timeout.Infinite, cts.Token)).ConfigureAwait(false);
            return done == task ? await task.ConfigureAwait(false) : fallback;
        }
        catch
        {
            return fallback;
        }
    }

    private Func<NormalizedArtworkQuery, CancellationToken, Task<List<ArtCandidate>>> TmdbProvider(string scope) => async (q, ct) =>
    {
        if (!_tmdb.HasKey) return [];
        var hits = await _tmdb.SearchCandidatesAsync(scope, q.Title, scope == "multi" ? null : q.Year, timeoutMs: TimeoutMs, ct: ct).ConfigureAwait(false);
        var scoped = hits.Select(FromTmdb).ToList();
        if (q.Year != null && scope != "multi" && ArtworkMatching.ChooseBest(q, scoped) == null)
        {
            var retry = await _tmdb.SearchCandidatesAsync(scope, q.Title, timeoutMs: TimeoutMs, ct: ct).ConfigureAwait(false);
            scoped.AddRange(retry.Select(FromTmdb));
        }
        return scoped;
    };

    private static ArtCandidate FromTmdb(TmdbCandidate hit) => new(hit.Title, hit.Year, hit.PosterUrl, hit.BackdropUrl, hit.MediaType, hit.Popularity, "tmdb", hit.Id);

    private async Task<List<ArtCandidate>> AniListProvider(NormalizedArtworkQuery q, CancellationToken ct)
    {
        var hits = await _anilist.SearchAsync(q.Title, 6, ct).ConfigureAwait(false);
        return hits.Select((h, i) => new ArtCandidate(h.Title, h.Year, h.PosterUrl, h.BackdropUrl, "anime", hits.Count - i, "anilist")).ToList();
    }

    private async Task<List<ArtCandidate>> TvmazeProvider(NormalizedArtworkQuery q, CancellationToken ct) =>
        (await _keyless.SearchTvmazeAsync(q.Title, timeoutMs: TimeoutMs, ct: ct).ConfigureAwait(false))
        .Select(h => new ArtCandidate(h.Title, h.Year, h.PosterUrl, null, "tv", h.Score, "tvmaze")).ToList();

    private async Task<List<ArtCandidate>> ItunesProvider(NormalizedArtworkQuery q, CancellationToken ct)
    {
        var hits = await _keyless.SearchItunesAsync(q.Title, timeoutMs: TimeoutMs, ct: ct).ConfigureAwait(false);
        return hits.Select((h, i) => new ArtCandidate(h.Title, h.Year, h.PosterUrl, null, "movie", hits.Count - i, "itunes")).ToList();
    }

    private IEnumerable<Func<NormalizedArtworkQuery, CancellationToken, Task<List<ArtCandidate>>>> Chain(string? mediaType) => mediaType switch
    {
        "anime" => [AniListProvider, TmdbProvider("multi"), TvmazeProvider],
        "movie" => [TmdbProvider("movie"), ItunesProvider],
        "tv" => [TmdbProvider("tv"), TvmazeProvider],
        _ => [TmdbProvider("multi"), ItunesProvider, TvmazeProvider],
    };

    private static TmdbRef? RefOf(ArtCandidate? c) => c?.TmdbId is { } id ? new TmdbRef(id, c.Kind == "tv" ? "tv" : "movie") : null;

    public async Task<ArtworkResult> ResolveAsync(ArtworkQuery q)
    {
        try
        {
            var query = ArtworkMatching.Normalize(q);
            if (query == null) return ArtworkResult.None;
            var key = ArtworkMatching.CacheKey(query);
            if (_cache.TryGet(key, out var cached)) return cached.Artwork;
            var value = await _inFlight.RunAsync(key, async () =>
            {
                var resolved = await LookupAsync(query).ConfigureAwait(false);
                Write(key, resolved);
                return resolved;
            }).ConfigureAwait(false);
            return value.Artwork;
        }
        catch
        {
            return ArtworkResult.None;
        }
    }

    public async Task<TmdbRef?> ResolveTmdbRefAsync(ArtworkQuery q)
    {
        try
        {
            var query = ArtworkMatching.Normalize(q);
            if (query == null || !_tmdb.HasKey) return null;
            var key = ArtworkMatching.CacheKey(query);
            if (_cache.TryGet(key, out var cached) && cached.RefKnown) return cached.Ref;
            return await _refInFlight.RunAsync(key, async () =>
            {
                var scope = query.MediaType == "movie" ? "movie" : query.MediaType == "tv" ? "tv" : "multi";
                var candidates = await Guarded(ct => TmdbProvider(scope)(query, ct), new List<ArtCandidate>()).ConfigureAwait(false);
                var reference = RefOf(ArtworkMatching.ChooseBest(query, candidates, requireArt: false));
                var art = _cache.TryGet(key, out var entry) ? entry.Artwork : ArtworkResult.None;
                Write(key, new Resolved(art, reference, true));
                return reference;
            }).ConfigureAwait(false);
        }
        catch
        {
            return null;
        }
    }

    public async Task<IReadOnlyList<ArtworkResult>> ResolveBatchAsync(IReadOnlyList<ArtworkQuery> queries)
    {
        if (queries.Count == 0) return [];
        var output = new ArtworkResult[queries.Count];
        Array.Fill(output, ArtworkResult.None);
        await Parallel.ForEachAsync(Enumerable.Range(0, queries.Count), new ParallelOptions { MaxDegreeOfParallelism = BatchConcurrency },
            async (i, _) => output[i] = await ResolveAsync(queries[i]).ConfigureAwait(false)).ConfigureAwait(false);
        return output;
    }

    private async Task<Resolved> LookupAsync(NormalizedArtworkQuery query)
    {
        foreach (var provider in Chain(query.MediaType))
        {
            var candidates = await Guarded(ct => provider(query, ct), new List<ArtCandidate>()).ConfigureAwait(false);
            var best = ArtworkMatching.ChooseBest(query, candidates);
            if (best == null) continue;
            var backdrop = best.BackdropUrl;
            var reference = RefOf(best);
            if (backdrop == null && best.Provider == "anilist" && _tmdb.HasKey)
            {
                var extra = await Guarded(async ct =>
                {
                    var hits = await _tmdb.SearchCandidatesAsync("multi", query.Title, timeoutMs: TimeoutMs, ct: ct).ConfigureAwait(false);
                    return ArtworkMatching.ChooseBest(query, hits.Select(FromTmdb));
                }, null).ConfigureAwait(false);
                backdrop = extra?.BackdropUrl;
                if (extra != null) reference = RefOf(extra);
            }
            // TS stores `ref` as known only when a TMDB candidate was involved; undefined otherwise.
            return new Resolved(new ArtworkResult(best.PosterUrl, backdrop), reference, true);
        }
        return new Resolved(ArtworkResult.None, null, false);
    }
}


