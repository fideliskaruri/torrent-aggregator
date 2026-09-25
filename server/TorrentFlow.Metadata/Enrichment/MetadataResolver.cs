using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Caching;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Enrichment;

/// <summary>Title helpers from src/lib/metadata/clean-torrent-title.ts and src/lib/utils.ts normalizeTitle.</summary>
public static partial class TitleCleaning
{
    [GeneratedRegex(@"[\[\(].*?[\]\)]")] private static partial Regex Bracketed();
    [GeneratedRegex(@"\b(S\d{1,2}\s*-\s*S?\d{1,2}|S\d{1,2}E\d{1,3}(?:\s*-\s*E?\d{1,3})?|S\d{1,2}|E\d{1,3}|EP?\s*\d{1,3}|Season\s*\d+|Complete|Batch)\b", RegexOptions.IgnoreCase)] private static partial Regex Structure();
    [GeneratedRegex(@"\b(1080p|720p|480p|2160p|4K|UHD|HDR10?\+?|DV|HEVC|x265|x264|H\.?26[45]|AV1|WEB-?DL|WEBRip|BluRay|BDRip|BRRip|DVDRip|HDTV|REMUX|PROPER|REPACK|FINAL|INTERNAL|LIMITED|AAC\d?|FLAC|DTS(?:-HD)?|DDP?\d?(?:\.\d)?|EAC3|AC3|Atmos|TrueHD|\d+bit|Dual|Multi|Sub|Dub|NF|AMZN|DSNP|HULU|HMAX|ATVP|iP|CR)\b", RegexOptions.IgnoreCase)] private static partial Regex Quality();
    [GeneratedRegex(@"[._\-–—|]+")] private static partial Regex Separators();
    [GeneratedRegex(@"[\[\](){}【】]")] private static partial Regex Brackets();
    [GeneratedRegex(@"\b(s\d{1,2}e\d{1,3}|ep?\s*\d{1,3}|season\s*\d+)\b", RegexOptions.IgnoreCase)] private static partial Regex NormStructure();
    [GeneratedRegex(@"\b(1080p|720p|480p|2160p|4k|hevc|x265|x264|web-?dl|webrip|bluray|bdrip|hdtv|aac|flac|10bit|dual|multi|sub|dub|vostfr|raw)\b", RegexOptions.IgnoreCase)] private static partial Regex NormQuality();

    public static string CleanTorrentTitle(string title)
    {
        var t = Bracketed().Replace(title ?? "", " ");
        t = Structure().Replace(t, " ");
        t = Quality().Replace(t, " ");
        t = Separators().Replace(t, " ");
        return Regex.Replace(t, @"\s+", " ").Trim();
    }

    public static string NormalizeTitle(string title)
    {
        var t = Brackets().Replace((title ?? "").ToLowerInvariant(), " ");
        t = NormStructure().Replace(t, " ");
        t = NormQuality().Replace(t, " ");
        t = Separators().Replace(t, " ");
        return Regex.Replace(t, @"\s+", " ").Trim();
    }
}

/// <summary>Identity checks from src/lib/metadata/enrich.ts.</summary>
public static partial class MetadataIdentity
{
    [GeneratedRegex(@"^(?:season|series|episode|episodes|part|cour|\d+(?:st|nd|rd|th))$")] private static partial Regex StopToken();
    [GeneratedRegex(@"\b((?:19|20)\d{2})\b")] private static partial Regex Year();
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonAlnum();

    public static readonly IReadOnlyDictionary<string, string[]> ExpectedMediaTypes = new Dictionary<string, string[]>
    {
        ["anime"] = ["anime", "tv", "movie"],
        ["tv"] = ["tv", "anime"],
        ["movies"] = ["movie", "anime"],
        ["movie"] = ["movie", "anime"],
    };

    public static List<string> Names(MediaMetadata m) =>
        new[] { m.Title }.Concat(m.Aliases ?? []).Select(n => n?.Trim()).Where(n => !string.IsNullOrEmpty(n)).Distinct(StringComparer.Ordinal).ToList()!;

    private static string[] IdentityTokens(string value) =>
        TitleCleaning.NormalizeTitle(value).Split(' ').Where(t => t.Length > 1 && !StopToken().IsMatch(t)).ToArray();

    public static bool NameCompatible(string subject, string catalogName)
    {
        static string Comparable(string v) => Regex.Replace(NonAlnum().Replace(TitleCleaning.NormalizeTitle(v), " "), @"\s+", " ").Trim();
        var s = Comparable(subject);
        var c = Comparable(catalogName);
        if (s.Length == 0 || c.Length == 0) return false;
        if (s == c || s.Contains(c, StringComparison.Ordinal) || c.Contains(s, StringComparison.Ordinal)) return true;
        var subjectTokens = IdentityTokens(s).ToHashSet(StringComparer.Ordinal);
        var catalogTokens = IdentityTokens(c);
        if (catalogTokens.Length == 0) return false;
        var matches = catalogTokens.Count(subjectTokens.Contains);
        return matches >= 2 && (double)matches / catalogTokens.Length >= 0.8;
    }

    private static int? ExplicitQualifierYear(string value, List<string> names)
    {
        var titleNumbers = names.SelectMany(n => Year().Matches(n).Select(m => int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture))).ToHashSet();
        foreach (Match m in Year().Matches(value))
        {
            var y = int.Parse(m.Groups[1].Value, CultureInfo.InvariantCulture);
            if (!titleNumbers.Contains(y)) return y;
        }
        return null;
    }

    public static bool Compatible(string rawTitle, MediaMetadata metadata, string? query = null, string? category = null)
    {
        query ??= rawTitle;
        if (!string.IsNullOrEmpty(category) && ExpectedMediaTypes.TryGetValue(category, out var expected) && !expected.Contains(metadata.MediaType)) return false;
        var names = Names(metadata);
        var queryYear = ExplicitQualifierYear(query, names);
        if (queryYear != null && metadata.Year != null && queryYear != metadata.Year) return false;
        var releaseYear = ExplicitQualifierYear(rawTitle, names);
        if (metadata.MediaType == "movie" && releaseYear != null && metadata.Year != null && releaseYear != metadata.Year) return false;
        var releaseSubject = TitleCleaning.CleanTorrentTitle(rawTitle);
        if (!names.Any(n => NameCompatible(releaseSubject, n))) return false;
        var querySubject = TitleCleaning.CleanTorrentTitle(query);
        return querySubject.Length == 0 || names.Any(n => NameCompatible(querySubject, n));
    }

    public static double ScoreMatch(string query, string candidateTitle)
    {
        var q = TitleCleaning.NormalizeTitle(query);
        var c = TitleCleaning.NormalizeTitle(candidateTitle);
        if (q.Length == 0 || c.Length == 0) return 0;
        if (q == c) return 100;
        if (c.Contains(q, StringComparison.Ordinal) || q.Contains(c, StringComparison.Ordinal)) return 80;
        var qTokens = q.Split(' ').Where(t => t.Length > 1).ToArray();
        var hits = qTokens.Count(t => c.Contains(t, StringComparison.Ordinal));
        return (double)hits / Math.Max(qTokens.Length, 1) * 70;
    }

    public static int MediaTypePenalty(string? category, string mediaType) =>
        string.IsNullOrEmpty(category) || !ExpectedMediaTypes.TryGetValue(category, out var expected) || expected.Contains(mediaType) ? 0 : 25;

    public static List<string> TitleCandidates(string cleaned)
    {
        var output = new List<string>();
        void Push(string s)
        {
            var v = s.Trim();
            if (v.Length > 1 && !output.Contains(v)) output.Add(v);
        }
        Push(cleaned);
        var words = Regex.Split(cleaned, @"\s+");
        var firstNoisy = Array.FindIndex(words, w => w.Any(char.IsAsciiDigit));
        if (firstNoisy > 0) Push(string.Join(' ', words[..firstNoisy]));
        if (words.Length > 3) Push(string.Join(' ', words[..3]));
        if (words.Length > 2) Push(string.Join(' ', words[..2]));
        return output;
    }
}

/// <summary>Port of resolveMetadata / enrichResultsWithMetadata (search-latency version) plus CachedMetadata persistence (cache.ts).</summary>
public sealed partial class MetadataResolver : IMetadataResolver
{
    private static readonly TimeSpan MemoryTtl = TimeSpan.FromMinutes(30);
    private static readonly TimeSpan MissTtl = TimeSpan.FromMinutes(3);
    private static readonly TimeSpan DbTtl = TimeSpan.FromDays(7);

    [GeneratedRegex(@"\b(anime|subbed|dubbed|bd\s*box|ova|ona)\b", RegexOptions.IgnoreCase)] private static partial Regex AnimeCue();

    private readonly TmdbClient _tmdb;
    private readonly AniListClient _anilist;
    private readonly ArtworkResolver _artwork;
    private readonly IDbContextFactory<TorrentFlowDbContext>? _db;
    private readonly TimeProvider _time;
    private readonly ILogger<MetadataResolver>? _logger;
    private readonly BoundedTtlCache<MediaMetadata?> _memory;
    private readonly SingleFlight<MediaMetadata?> _inFlight = new();

    public MetadataResolver(TmdbClient tmdb, AniListClient anilist, ArtworkResolver artwork, IDbContextFactory<TorrentFlowDbContext>? db, TimeProvider time,
        ILogger<MetadataResolver>? logger = null)
    {
        _tmdb = tmdb;
        _anilist = anilist;
        _artwork = artwork;
        _db = db;
        _time = time;
        _logger = logger;
        _memory = new(1000, time);
    }

    public Task<MediaMetadata?> GetAniListByIdAsync(string id, CancellationToken cancellationToken = default) => _anilist.GetByIdAsync(id, cancellationToken);

    public Task<MediaMetadata?> GetTmdbByIdAsync(string mediaType, string id, CancellationToken cancellationToken = default) =>
        mediaType is "movie" or "tv" ? _tmdb.GetByIdAsync(mediaType, id, cancellationToken) : Task.FromResult<MediaMetadata?>(null);

    public async Task<MediaMetadata?> ResolveMetadataAsync(string rawTitle, string? category, CancellationToken cancellationToken = default)
    {
        var cleaned = TitleCleaning.CleanTorrentTitle(rawTitle);
        if (cleaned.Length == 0) return null;
        var key = $"{(string.IsNullOrEmpty(category) ? "all" : category)}:{cleaned.ToLowerInvariant()}";
        if (_memory.TryGet(key, out var cached)) return cached;
        return await _inFlight.RunAsync(key, () => ResolveUncachedAsync(rawTitle, cleaned, category, key)).WaitAsync(cancellationToken).ConfigureAwait(false);
    }

    private async Task<MediaMetadata?> ResolveUncachedAsync(string rawTitle, string cleaned, string? category, string key)
    {
        var preferAnime = category == "anime" || AnimeCue().IsMatch(rawTitle);
        MediaMetadata? best = null;
        double bestScore = 0;
        foreach (var candidate in MetadataIdentity.TitleCandidates(cleaned))
        {
            var hit = await LookupOnceAsync(candidate, category, preferAnime).ConfigureAwait(false);
            if (hit.Score > bestScore)
            {
                bestScore = hit.Score;
                best = hit.Best;
            }
            if (bestScore >= 55) break;
        }
        var matched = bestScore >= 40 ? best : null;
        var result = matched != null ? await WithArtworkAsync(matched).ConfigureAwait(false) : null;
        _memory.Set(key, result, result != null ? MemoryTtl : MissTtl);
        if (result != null) _ = PersistAsync(result);
        return result;
    }

    internal async Task<MediaMetadata> WithArtworkAsync(MediaMetadata meta)
    {
        if (meta.PosterUrl != null && meta.BackdropUrl != null) return meta;
        var art = await _artwork.ResolveAsync(new ArtworkQuery(meta.Title, meta.Year, meta.MediaType)).ConfigureAwait(false);
        if (art.PosterUrl == null && art.BackdropUrl == null) return meta;
        return meta with { PosterUrl = meta.PosterUrl ?? art.PosterUrl, BackdropUrl = meta.BackdropUrl ?? art.BackdropUrl };
    }

    private async Task<(MediaMetadata? Best, double Score)> LookupOnceAsync(string cleaned, string? category, bool preferAnime)
    {
        MediaMetadata? best = null;
        double bestScore = 0;
        double Score(MediaMetadata hit) => MetadataIdentity.Names(hit).Select(n => MetadataIdentity.ScoreMatch(cleaned, n)).DefaultIfEmpty(double.NegativeInfinity).Max()
            - MetadataIdentity.MediaTypePenalty(category, hit.MediaType);
        try
        {
            if (preferAnime || category == "all" || string.IsNullOrEmpty(category))
            {
                foreach (var hit in await _anilist.SearchAsync(cleaned, 5).ConfigureAwait(false))
                {
                    if (!MetadataIdentity.Compatible(cleaned, hit, cleaned, category)) continue;
                    var s = Score(hit);
                    if (s > bestScore) { bestScore = s; best = hit; }
                }
            }
        }
        catch (Exception e) { _logger?.LogDebug(e, "AniList lookup failed"); }

        if (!preferAnime || bestScore < 55)
        {
            try
            {
                foreach (var hit in await _tmdb.SearchAsync(cleaned, 5).ConfigureAwait(false))
                {
                    if (!MetadataIdentity.Compatible(cleaned, hit, cleaned, category)) continue;
                    var s = Score(hit);
                    var adjusted = preferAnime && hit.MediaType != "anime" ? s - 5 : s;
                    if (adjusted > bestScore || (!preferAnime && adjusted == bestScore)) { bestScore = adjusted; best = hit; }
                }
            }
            catch (Exception e) { _logger?.LogDebug(e, "TMDB lookup failed"); }
        }
        return (best, bestScore);
    }

    public async Task<IReadOnlyList<MediaMetadata?>> EnrichAsync(IReadOnlyList<MetadataEnrichmentInput> inputs, string query, string? category,
        MediaMetadata? primary = null, CancellationToken cancellationToken = default)
    {
        if (inputs.Count == 0) return [];
        primary ??= await ResolveMetadataAsync(query, category, cancellationToken).ConfigureAwait(false);
        var uniqueTitles = inputs.Take(16).Select(r => TitleCleaning.CleanTorrentTitle(r.Title)).Where(t => t.Length > 0).Distinct(StringComparer.Ordinal).Take(6).ToList();
        var titleMeta = new Dictionary<string, MediaMetadata?>(StringComparer.Ordinal);
        var resolved = await Task.WhenAll(uniqueTitles.Select(async t =>
        {
            var meta = await ResolveMetadataAsync(t, category, cancellationToken).ConfigureAwait(false);
            if (meta == null && primary != null && MetadataIdentity.Compatible(t, primary, query, category)) meta = primary;
            return (t, meta);
        })).ConfigureAwait(false);
        foreach (var (t, meta) in resolved) titleMeta[t] = meta;

        return inputs.Select(r =>
        {
            var meta = titleMeta.GetValueOrDefault(TitleCleaning.CleanTorrentTitle(r.Title));
            if (meta != null && !MetadataIdentity.Compatible(r.Title, meta, query, category)) meta = null;
            if (meta == null && primary != null && MetadataIdentity.Compatible(r.Title, primary, query, category)) meta = primary;
            return meta;
        }).ToList();
    }

    public static string CacheKey(string source, string mediaType, string externalId) => $"{source}:{mediaType}:{externalId}";

    private static readonly JsonSerializerOptions RawJson = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull };

    internal async Task PersistAsync(MediaMetadata meta)
    {
        if (_db == null) return;
        try
        {
            await using var db = await _db.CreateDbContextAsync().ConfigureAwait(false);
            var key = CacheKey(meta.Source, meta.MediaType, meta.ExternalId);
            var now = _time.GetUtcNow().UtcDateTime;
            var row = await db.CachedMetadata.FirstOrDefaultAsync(r => r.CacheKey == key).ConfigureAwait(false);
            if (row == null)
            {
                row = new CachedMetadatum
                {
                    Id = Ids.New(), CacheKey = key, Source = meta.Source, MediaType = meta.MediaType, ExternalId = meta.ExternalId, CreatedAt = now,
                };
                db.CachedMetadata.Add(row);
            }
            row.Title = meta.Title;
            row.PosterUrl = meta.PosterUrl;
            row.BackdropUrl = meta.BackdropUrl;
            row.Synopsis = meta.Synopsis;
            row.Rating = meta.Rating;
            row.Year = meta.Year;
            row.ReleaseDate = ParseDay(meta.ReleaseDate);
            row.Genres = JsonSerializer.Serialize(meta.Genres ?? []);
            row.RawJson = JsonSerializer.Serialize(meta, RawJson);
            row.ExpiresAt = now + DbTtl;
            row.UpdatedAt = now;
            await db.SaveChangesAsync().ConfigureAwait(false);
        }
        catch (Exception e)
        {
            _logger?.LogDebug(e, "CachedMetadata upsert failed");
        }
    }

    /// <summary>Port of getCachedMetadata: expired rows are deleted and treated as a miss.</summary>
    public async Task<MediaMetadata?> GetCachedAsync(string cacheKey, CancellationToken ct = default)
    {
        if (_db == null) return null;
        try
        {
            await using var db = await _db.CreateDbContextAsync(ct).ConfigureAwait(false);
            var row = await db.CachedMetadata.FirstOrDefaultAsync(r => r.CacheKey == cacheKey, ct).ConfigureAwait(false);
            if (row == null) return null;
            if (row.ExpiresAt < _time.GetUtcNow().UtcDateTime)
            {
                db.CachedMetadata.Remove(row);
                await db.SaveChangesAsync(ct).ConfigureAwait(false);
                return null;
            }
            return new MediaMetadata
            {
                Source = row.Source, MediaType = row.MediaType, ExternalId = row.ExternalId, Title = row.Title, PosterUrl = row.PosterUrl,
                BackdropUrl = row.BackdropUrl, Synopsis = row.Synopsis, Rating = row.Rating, Year = row.Year,
                ReleaseDate = row.ReleaseDate?.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
                Genres = string.IsNullOrEmpty(row.Genres) ? [] : JsonSerializer.Deserialize<List<string>>(row.Genres) ?? [],
            };
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger?.LogDebug(e, "CachedMetadata read failed");
            return null;
        }
    }

    private static DateTime? ParseDay(string? value)
    {
        if (string.IsNullOrEmpty(value)) return null;
        var day = value.Trim();
        if (day.Length > 10) day = day[..10];
        return DateTime.TryParseExact(day, "yyyy-MM-dd", CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out var d)
            ? DateTime.SpecifyKind(d, DateTimeKind.Utc) : null;
    }
}
