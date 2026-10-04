using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Browse
{
    private async Task<(BrowseRail? Rail, bool Stale)> RailAsync(RailSpec spec, string? genre, CancellationToken ct,
        Lazy<Dictionary<string, Task<ProviderAnswer[]>>>? anime, MetadataSettings configured, bool hasTmdb,
        bool replenish = false)
    {
        var cacheId = ProviderHttp.Id("rail:" + spec.Id);
        var feed = ProviderHttp.Id(spec.TmdbPath + "|" + spec.Query + "|" + spec.AnimeSort + "|" + spec.Seasonal + "|" + genre + "|legacy-listings-v6");
        MetadataCacheRow? previous;
        await using (var db = await dbs.CreateDbContextAsync(ct))
            previous = await db.MetadataCaches.AsNoTracking().SingleOrDefaultAsync(c => c.Id == cacheId, ct);
        var preferred = spec.Type == "anime" ? "anilist" : hasTmdb ? "tmdb" : "cinemeta";
        if (!replenish && previous is not null && previous.ExpiresAt > DateTimeOffset.UtcNow && previous.Payload.Text("feed") == feed &&
            previous.Provider == preferred && previous.Complete && previous.Payload.Obj("entries") is { ValueKind: JsonValueKind.Array } entries &&
            entries.GetArrayLength() > 0)
            return (await ReadRailAsync(previous, spec.Title, ct), false);
        if (spec.Type == "anime" && !configured.EnabledProviders.Contains("anilist") ||
            spec.Type != "anime" && !hasTmdb && (spec.CineCatalog.Length == 0 || !configured.EnabledProviders.Contains("cinemeta")))
            return (null, false);
        var candidates = new List<WorkSnapshot>();
        if (replenish && previous is not null && await ReadRailAsync(previous, spec.Title, ct) is { } priorRail)
            candidates.AddRange(priorRail.Works);
        string? provider = null;
        var failed = false;
        if (spec.Type == "anime" && configured.EnabledProviders.Contains("anilist"))
        {
            var fetched = await AnimeRailAsync(spec, anime!, ct);
            candidates.AddRange(fetched.Works);
            provider = fetched.Provider;
            failed = fetched.Failed;
        }
        else
        {
            var kind = spec.Type == "series" ? WorkKind.Series : WorkKind.Film;
            if (hasTmdb)
            {
                var fetched = await TmdbRailAsync(spec, kind, ct, replenish);
                candidates.AddRange(fetched.Works);
                failed = fetched.Failed;
                provider = fetched.Provider;
            }
            if (spec.CineCatalog.Length > 0 && configured.EnabledProviders.Contains("cinemeta") &&
                (!hasTmdb || candidates.Count == 0 && previous is null))
            {
                var fetched = await CinemetaRailAsync(spec, genre, kind, ct);
                candidates.AddRange(fetched.Works);
                failed = fetched.Failed;
                provider = fetched.Provider;
            }
        }
        if (failed && previous is not null) return (await ReadRailAsync(previous, spec.Title, ct), true);
        if (failed || candidates.Count == 0) return (null, true);
        var stored = candidates.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))
            .DistinctBy(w => w.Work.WorkKey).Take(96).ToArray();
        var now = DateTimeOffset.UtcNow;
        var payload = JsonSerializer.SerializeToElement(new { spec.Id, spec.Title, feed, projection = "native-names-v1",
            entries = stored.Select(w => new ListingEntry(w.Work, w.Names.Select(n => new ListingName(
                n.Value, n.NormalizedValue, n.Label, n.LinkId is null ? null :
                    Array.FindIndex(w.Links.ToArray(), l => l.Id == n.LinkId))).ToArray(),
                w.Links.ToArray(), w.Seasons, w.Episodes, w.PremiereAt, w.ProviderFormat)).ToArray() }, ListingJson);
        var expires = new DateTimeOffset(DateTime.Now.Date.AddDays(1)).ToUniversalTime();
        var cache = new MetadataCacheRow { Id = cacheId, Kind = CacheKind.BrowseRail, CacheKey = "rail:" + spec.Id, Payload = payload, FetchedAt = now, ExpiresAt = expires, Etag = null, LastModified = null, Complete = true, Provider = provider };
        await using (var db = await dbs.CreateDbContextAsync(ct))
        {
            if (previous is null) db.Add(cache);
            else db.Update(cache);
            try { await db.SaveChangesAsync(ct); }
            catch (DbUpdateException ex) when (ProviderHttp.Conflict(ex)) { }
        }
        return (new(spec.Id, spec.Title, [.. stored]), false);
    }

    private async Task<RailCandidates> AnimeRailAsync(RailSpec spec,
        Lazy<Dictionary<string, Task<ProviderAnswer[]>>> anime, CancellationToken ct)
    {
        var answers = (await anime.Value[spec.Id]).Take(1).ToArray();
        var works = new List<WorkSnapshot>();
        foreach (var media in answers.SelectMany(answer => answer.Json?.Items() ?? []))
        {
            var b = new WorkBuilder(new("anilist", media.Text("id")!, null));
            Catalog.MapAnime(b, media);
            b.Work = b.Work with { RefreshedAt = null };
            works.Add(b.Build() with { PremiereAt = JsonFacts.Start(media.Obj("startDate")), ProviderFormat = media.Text("format") });
        }
        return new(works, answers.Any(answer => !answer.Complete || answer.Stale), "anilist");
    }

    private async Task<RailCandidates> TmdbRailAsync(RailSpec spec, WorkKind kind, CancellationToken ct, bool replenish)
    {
        var dateFilter = spec.Id == "films-new" ? "&release_date.gte=" + DateTime.Now.AddDays(-90).ToString("yyyy-MM-dd") +
            "&release_date.lte=" + DateTime.Now.ToString("yyyy-MM-dd") :
            spec.Id == "series-new" ? "&first_air_date.gte=" + DateTime.Now.AddDays(-180).ToString("yyyy-MM-dd") +
            "&first_air_date.lte=" + DateTime.Now.ToString("yyyy-MM-dd") : "";
        ProviderAnswer[] answers;
        if (replenish)
            answers = await Task.WhenAll(Enumerable.Range(4, 2).Select(page =>
                tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=" + page, ct, ttl: TimeSpan.FromDays(1))));
        else
        {
            var first = await tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=1", ct, ttl: TimeSpan.FromDays(1));
            var rest = await Task.WhenAll(Enumerable.Range(2, 2).Select(page =>
                tmdb.GetAsync(spec.TmdbPath, (spec.Query ?? "") + dateFilter + "&page=" + page, ct, ttl: TimeSpan.FromDays(1))));
            answers = [first, .. rest];
        }
        var works = answers.SelectMany(answer => answer.Json?.Obj("results").Items() ?? [])
            .DistinctBy(media => media.Text("id")).Select(media =>
            {
                var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind)));
                Catalog.MapTmdb(b, media, kind);
                b.Work = b.Work with { RefreshedAt = null };
                return b.Build() with { PremiereAt = JsonFacts.Date(media.Text(kind == WorkKind.Film ? "release_date" : "first_air_date")) };
            }).ToList();
        return new(works, answers.Any(answer => !answer.Complete || answer.Stale), "tmdb");
    }

    private async Task<RailCandidates> CinemetaRailAsync(RailSpec spec, string? genre, WorkKind kind, CancellationToken ct)
    {
        var answers = await Task.WhenAll(Enumerable.Range(0, 2).Select(page =>
        {
            var parameters = new List<string>();
            if (genre is not null) parameters.Add("genre=" + Uri.EscapeDataString(GenreName(genre)));
            else if (spec.CineCatalog == "year") parameters.Add("genre=" + DateTime.Now.Year);
            if (page > 0) parameters.Add("skip=" + page * 50);
            var path = "/catalog/" + CinemetaClient.Kind(kind) + "/" + spec.CineCatalog +
                (parameters.Count == 0 ? "" : "/" + string.Join('&', parameters)) + ".json";
            return cinemeta.GetAsync(path, ct, ttl: TimeSpan.FromDays(1));
        }));
        var works = answers.SelectMany(answer => answer.Json?.Obj("metas").Items() ?? []).Select(media =>
        {
            var b = new WorkBuilder(new("cinemeta", media.Text("id")!, CinemetaClient.Kind(kind)));
            Catalog.MapCinemeta(b, media, kind);
            b.Work = b.Work with { RefreshedAt = null, Anime = false };
            return b.Build() with { PremiereAt = JsonFacts.Date(media.Text("released")) };
        }).ToList();
        return new(works, answers.Any(answer => !answer.Complete || answer.Stale), "cinemeta");
    }

    private async Task<BrowseRail?> ReadRailAsync(MetadataCacheRow row, string title, CancellationToken ct)
    {
        if (row.Payload.Text("projection") == "native-names-v1")
        {
            var entries = row.Payload.Obj("entries").Deserialize<ListingEntry[]>(ListingJson)!;
            return new(row.Payload.Text("id")!, title, [.. entries.Select(e =>
                new WorkSnapshot(e.Work, [.. e.Names.Select((n, i) => new WorkNameRow { Id = ProviderHttp.Id(e.Work.Id + ":" + n.NormalizedValue + ":" + n.Label + ":" +
                        (n.Link is { } index && index >= 0 ? e.Links[index].Id : "")), WorkId = e.Work.Id, Value = n.Value, NormalizedValue = n.NormalizedValue, Label = n.Label, LinkId = n.Link is { } link && link >= 0 ? e.Links[link].Id : null, Ordinal = i, Authoritative = true, RefreshedAt = e.Work.CreatedAt })],
                    [.. e.Links], e.Seasons, e.Episodes)
                    { PremiereAt = e.PremiereAt, ProviderFormat = e.ProviderFormat })
                .Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))]);
        }
        if (row.Payload.Obj("entries").ValueKind == JsonValueKind.Array)
            return new(row.Payload.Text("id")!, title,
                [.. row.Payload.Obj("entries").Deserialize<WorkSnapshot[]>(JsonSerializerOptions.Web)!
                    .Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))]);
        var works = new List<WorkSnapshot>();
        foreach (var id in row.Payload.Obj("workIds").Strings())
            if (await Catalog.SnapshotAsync(dbs, id, ct) is { } work && !string.IsNullOrWhiteSpace(work.Work.PosterUrl)) works.Add(work);
        return new(row.Payload.Text("id")!, title, [.. works]);
    }

    private static (string[] Check, string[] Claim) RailKeys(WorkSnapshot work)
    {
        var link = work.Links.First(l => l.IsPrimary);
        var exact = new[] { "id:" + link.Provider + ":" + work.Work.Kind + ":" + link.ExternalId,
            "key:" + work.Work.WorkKey };
        var title = SearchText.Compact(work.Names.First().Value);
        if (work.Work.Kind == WorkKind.Series)
            return ([.. exact, "series:" + title], [.. exact, "series:" + title]);
        var yearless = "film:" + title + ":";
        return work.Work.Year is { } year
            ? ([.. exact, yearless + year, yearless], [.. exact, yearless + year, yearless + "*"])
            : ([.. exact, yearless, yearless + "*"], [.. exact, yearless]);
    }

}
