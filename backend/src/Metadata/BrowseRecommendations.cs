using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Browse
{
    private static bool NeedsHomeRelease(WorkSnapshot work) =>
        work.Work.Kind == WorkKind.Film && work.Work.TheatricalAt >= DateTimeOffset.UtcNow.AddDays(-180) &&
        work.Work.TheatricalAt <= DateTimeOffset.UtcNow &&
        work.Links.Any(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");

    private async Task<WorkSnapshot> HomeReleaseAsync(WorkSnapshot work, CancellationToken ct)
    {
        if (!NeedsHomeRelease(work)) return work;
        var link = work.Links.First(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");
        ProviderAnswer detail;
        var background = ProviderHttp.Background.Value;
        try
        {
            ProviderHttp.Background.Value = true;
            detail = await tmdb.DetailAsync(link.ExternalId, WorkKind.Film, ct, false);
        }
        finally { ProviderHttp.Background.Value = background; }
        return detail.Json is { ValueKind: JsonValueKind.Object } json ? ApplyHomeRelease(work, json) : work;
    }

    private static WorkSnapshot ApplyHomeRelease(WorkSnapshot work, JsonElement json)
    {
        var now = DateTimeOffset.UtcNow;
        var link = work.Links.First(l => l.Status == LinkStatus.Verified && l.Provider == "tmdb");
        var b = new WorkBuilder(new("tmdb", link.ExternalId, "movie")) { Work = work.Work };
        b.Names.AddRange(work.Names); b.Links.AddRange(work.Links);
        Catalog.MapTmdb(b, json, WorkKind.Film);
        var releases = json.Obj("release_dates").Obj("results").Items()
            .SelectMany(country => country.Obj("release_dates").Items()).ToArray();
        var checkedEvidence = releases.Any(r => r.Int("type") is >= 1 and <= 6 &&
            JsonFacts.Date(r.Text("release_date")) is not null);
        var theatrical = Catalog.EarliestRelease(json, [1, 2, 3]);
        var home = new[] { b.Work.DigitalAt, b.Work.PhysicalAt }.OfType<DateTimeOffset>().Order()
            .Cast<DateTimeOffset?>().FirstOrDefault();
        var primary = work.PremiereAt ?? work.Work.TheatricalAt;
        var today = new DateTimeOffset(now.UtcDateTime.Date, TimeSpan.Zero);
        var inCinemas = checkedEvidence
            ? primary <= today && theatrical <= today && primary >= today.AddDays(-180) &&
                theatrical >= today.AddDays(-180) && (home is null || home > today)
            : primary <= today && primary >= today.AddDays(-21);
        return b.Build() with { PremiereAt = work.PremiereAt, InTheatricalWindow = inCinemas };
    }

    private async Task<BrowseRail?> HomeRecommendationsAsync(WorkSnapshot seed, BrowseRail[] rails, CancellationToken ct)
    {
        var title = seed.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ?? seed.Names.First().Value;
        var pool = rails.Where(r => r.Id is "films-popular" or "series-popular" or "anime-trending")
            .SelectMany(r => r.Works).ToArray();
        var onScreen = rails.Where(r => r.Id is "films-popular" or "series-popular" or "anime-trending")
            .SelectMany(r => r.Works.Take(24)).Select(w => w.Work.WorkKey).ToHashSet();
        var rows = new List<WorkSnapshot>();
        if (await tmdb.EnabledAsync(ct))
        {
            var search = await tmdb.SearchAsync(title, seed.Work.Kind, null, ct);
            var id = search.Json?.Obj("results").Items().FirstOrDefault().Text("id");
            if (id is not null)
                rows.AddRange(await TmdbRecommendationsAsync(id, seed.Work.Kind, ct));
        }
        if (rows.Count == 0)
        {
            var seedIndex = Array.FindIndex(pool, w => w.Work.Id == seed.Work.Id);
            rows.AddRange(pool.Where(w => w.Work.Kind == seed.Work.Kind && w.Work.Id != seed.Work.Id)
                .OrderBy(w => onScreen.Contains(w.Work.WorkKey))
                .ThenBy(w => seedIndex < 0 ? 0 : Math.Abs(Array.IndexOf(pool, w) - seedIndex)));
        }
        var stored = await Catalog.PersistListingsAsync(dbs, rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl) &&
            SearchText.Normalize(w.Names.First().Value) != SearchText.Normalize(title))
            .OrderBy(w => onScreen.Contains(w.Work.WorkKey)).Take(24), ct);
        return stored.IsEmpty ? null : new("because", "Because you're watching " + title, stored);
    }

    private async Task<List<WorkSnapshot>> TmdbRecommendationsAsync(string id, WorkKind kind, CancellationToken ct)
    {
        var answer = await tmdb.GetAsync("/" + JsonFacts.Kind(kind) + "/" + id + "/recommendations",
            "", ct, ttl: TimeSpan.FromDays(1));
        return (answer.Json?.Obj("results").Items() ?? []).Select(media =>
        {
            var b = new WorkBuilder(new("tmdb", media.Text("id")!, JsonFacts.Kind(kind)));
            Catalog.MapTmdb(b, media, kind);
            b.Work = b.Work with { RefreshedAt = null };
            return b.Build();
        }).ToList();
    }

    internal async Task<MetadataExtras?> ExtrasAsync(MetadataQuery query, int? season, CancellationToken cancellationToken, Func<MetadataQuery, CancellationToken, Task<MetadataResult>> resolve, Func<ImmutableArray<string>, CancellationToken, Task<BrowseRail?>> recommend)
    {
        var result = await resolve(query, cancellationToken);
        if (result.Work is not { } work) return null;
        work = await HomeReleaseAsync(work, cancellationToken);
        var primary = work.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified);
        int? votes = null;
        string? certification = null;
        WorkSnapshot? partOf = null;
        var recommendations = await recommend([work.Work.Id], cancellationToken);
        ImmutableArray<WorkSnapshot> similar = recommendations is null ? [] :
            [.. recommendations.Works.Take(12)];
        if (primary?.Provider == "tmdb")
        {
            var detail = await tmdb.DetailAsync(primary.ExternalId, work.Work.Kind, cancellationToken, false);
            votes = detail.Json?.Int("vote_count");
            certification = detail.Json?.Obj("release_dates").Obj("results").Items()
                .Where(c => c.Text("iso_3166_1") == "US").SelectMany(c => c.Obj("release_dates").Items())
                .Select(c => c.Text("certification")).FirstOrDefault(c => !string.IsNullOrWhiteSpace(c));
            if (detail.Json?.Obj("belongs_to_collection") is { ValueKind: JsonValueKind.Object } collection)
            {
                var collectionId = collection.Text("id");
                if (collectionId is not null)
                {
                    var b = new WorkBuilder(new("tmdbcollection", collectionId, null));
                    var link = b.Link("tmdbcollection", collectionId);
                    b.Name(collection.Text("name"), NameLabel.English, link);
                    b.Work = b.Work with { PosterUrl = JsonFacts.Image(collection.Text("poster_path"), "w500"),
                        BackdropUrl = JsonFacts.Image(collection.Text("backdrop_path"), "w1280") };
                    partOf = b.Build();
                }
            }
        }
        var now = DateTimeOffset.UtcNow;
        var home = new[] { work.Work.DigitalAt, work.Work.PhysicalAt }.OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();
        var theatrical = InCinemas(work, now);
        return new(work, season is { } number ? work.Seasons.FirstOrDefault(s => s.Number == number)?.Id : null,
            similar, partOf, votes, certification, result.Complete, theatrical, home > now ? home : null, now);
    }

    public async Task<BrowseRail?> RecommendAsync(ImmutableArray<string> seedWorkIds, CancellationToken cancellationToken)
    {
        var rows = new List<WorkSnapshot>();
        foreach (var id in seedWorkIds.Take(3))
        {
            var seed = await Catalog.SnapshotAsync(dbs, id, cancellationToken);
            if (seed is null) continue;
            var link = seed.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified);
            if (seed.Work.Anime != true && link is not null && await tmdb.EnabledAsync(cancellationToken))
            {
                rows.AddRange(await TmdbRecommendationsAsync(link.ExternalId, seed.Work.Kind, cancellationToken));
            }
            else if (seed.Links.FirstOrDefault(l => l.Provider == "anilist" && l.Status == LinkStatus.Verified) is { } anime)
            {
                var answer = await anilist.RecommendationsAsync(anime.ExternalId, cancellationToken);
                foreach (var media in (answer.Json?.Obj("data").Obj("Media").Obj("recommendations").Obj("nodes").Items() ?? [])
                    .Select(n => n.Obj("mediaRecommendation")).Where(n => n.ValueKind == JsonValueKind.Object))
                {
                    var b = new WorkBuilder(new("anilist", media.Text("id")!, null));
                    Catalog.MapAnime(b, media);
                    b.Work = b.Work with { RefreshedAt = null };
                    rows.Add(b.Build());
                }
            }
            else
            {
                var browse = await BrowseAsync(new(seed.Work.Anime == true ? "anime" :
                    seed.Work.Kind == WorkKind.Series ? "series" : "films", null, null),
                    cancellationToken);
                rows.AddRange(browse.Rails.SelectMany(r => r.Works).Where(w => !seedWorkIds.Contains(w.Work.Id))
                    .OrderByDescending(w => w.Work.Genres.Intersect(seed.Work.Genres).Count()).Take(20));
            }
        }
        var stored = (await Catalog.PersistListingsAsync(dbs, rows.Where(w => !string.IsNullOrWhiteSpace(w.Work.PosterUrl))
            .DistinctBy(w => w.Work.WorkKey), cancellationToken))
            .Where(w => !seedWorkIds.Contains(w.Work.Id)).Take(20).ToImmutableArray();
        var first = seedWorkIds.IsEmpty ? null : await Catalog.SnapshotAsync(dbs, seedWorkIds[0], cancellationToken);
        var title = first?.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ?? first?.Names.FirstOrDefault()?.Value;
        return stored.IsEmpty ? null : new("because", "Because you're watching " + title, stored);
    }

    private static string GenreQuery(string type, string genre) => "with_genres=" + GenreId(genre) +
        "&sort_by=popularity.desc&vote_count.gte=" + (type == "films" ? "300" : "100") +
        (type == "series" ? "&without_genres=10763|10767|10766&without_keywords=210024" : "") + "&include_adult=false";

    private static string GenreName(string genre) => genre.Replace('-', ' ') switch
    {
        "science fiction" or "sci fi" or "sci fi fantasy" => "Sci-Fi", "slice of life" => "Slice of Life",
        "action adventure" => "Action",
        "reality" => "Reality-TV",
        var value => System.Globalization.CultureInfo.InvariantCulture.TextInfo.ToTitleCase(value),
    };
    private static bool InCinemas(WorkSnapshot snapshot, DateTimeOffset now)
    {
        if (snapshot.InTheatricalWindow is { } window) return window;
        var work = snapshot.Work;
        var home = new[] { work.DigitalAt, work.PhysicalAt }.OfType<DateTimeOffset>().Order().Cast<DateTimeOffset?>().FirstOrDefault();
        return work.Kind == WorkKind.Film && work.TheatricalAt <= now &&
            (home is { } at ? at > now : work.TheatricalAt > now.AddDays(-21));
    }
    private static int GenreId(string genre) => genre switch
    {
        "action" => 28, "comedy" => 35, "drama" => 18, "thriller" => 53, "horror" => 27,
        "science-fiction" or "sci-fi" => 878, "crime" => 80, "romance" => 10749, "family" => 10751,
        "documentary" => 99, "mystery" => 9648, "action-adventure" => 10759, "sci-fi-fantasy" => 10765,
        "reality" => 10764, _ => 0,
    };
}
