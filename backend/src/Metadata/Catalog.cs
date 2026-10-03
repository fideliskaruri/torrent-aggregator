using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    public async Task<CatalogResult> SearchAsync(CatalogQuery query, CancellationToken cancellationToken)
    {
        var term = JsonFacts.Term(query.Query);
        if (term.Length is < 1 or > 200 || JsonFacts.Fold(term).Length == 0) return new([], false, false, []);
        var settings = await store.SettingsAsync(cancellationToken);
        await map.LoadAsync(cancellationToken);
        map.RefreshInBackground();
        var tasks = new List<Task<(string Provider, ProviderAnswer Answer, WorkSnapshot[] Works)>>();
        var kinds = query.Category switch
        {
            "films" or "movie" => new[] { WorkKind.Film },
            "series" or "tv" => [WorkKind.Series],
            "anime" => [],
            _ => [WorkKind.Film, WorkKind.Series],
        };
        if (settings.EnabledProviders.Contains("tmdb") && await tmdb.EnabledAsync(cancellationToken))
            foreach (var kind in kinds) tasks.Add(SearchTmdb(kind));
        if (settings.EnabledProviders.Contains("cinemeta"))
        {
            foreach (var kind in kinds) tasks.Add(SearchCinemeta(kind));
            if (kinds.Length > 0) tasks.Add(SearchImdb());
        }
        if (settings.EnabledProviders.Contains("anilist"))
            tasks.Add(SearchAnime());
        if (settings.EnabledProviders.Contains("tvmaze") && kinds.Contains(WorkKind.Series))
            tasks.Add(SearchTvmaze());
        if (settings.EnabledProviders.Contains("itunes") && kinds.Contains(WorkKind.Film))
            tasks.Add(SearchItunes());
        var answered = await Task.WhenAll(tasks);
        var anyFresh = answered.Any(a => a.Answer.Complete && !a.Answer.Stale);
        var partial = answered.Any(a => !a.Answer.Complete);
        var failed = answered.Where(a => !a.Answer.Complete).Select(a => a.Provider).Distinct().ToImmutableArray();
        var rows = answered.Where(a => anyFresh ? !a.Answer.Stale : true).SelectMany(a => a.Works)
            .Where(w => query.Category != "anime" || w.Work.Anime == true)
            .Where(w => kinds.Length == 0 || kinds.Contains(w.Work.Kind)).ToArray();
        if (!rows.Any(w => Relevance(JsonFacts.Fold(term), w) >= 0.6))
        {
            var candidates = rows.Where(w => w.Links.Any(l => l.Provider == "imdb")).Take(3).ToArray();
            var names = await Task.WhenAll(candidates.Select(w => cinemeta.NamesAsync(
                w.Links.First(l => l.Provider == "imdb").ExternalId, cancellationToken)));
            for (var i = 0; i < candidates.Length; i++)
            {
                if (names[i].Json?.Obj("data").Obj("title") is not { ValueKind: JsonValueKind.Object } details) continue;
                var old = candidates[i];
                var b = new WorkBuilder(new("imdb", old.Links.First(l => l.Provider == "imdb").ExternalId,
                    JsonFacts.Kind(old.Work.Kind))) { Work = old.Work };
                b.Links.AddRange(old.Links);
                b.Names.AddRange(old.Names);
                var link = old.Links.First(l => l.Provider == "imdb").Id;
                b.Name(details.Obj("originalTitleText").Text("text"), NameLabel.Original, link);
                foreach (var aka in details.Obj("akas").Obj("edges").Items())
                    b.Name(aka.Obj("node").Text("text"), NameLabel.Synonym, link);
                rows[Array.IndexOf(rows, old)] = b.Build();
            }
        }
        var existing = await store.AllAsync<WorkLinkRow>(null, cancellationToken);
        var seen = new HashSet<string>();
        var works = new List<WorkSnapshot>();
        foreach (var row in rows.OrderByDescending(w => Relevance(JsonFacts.Fold(term), w)))
        {
            var keys = row.Links.Where(l => l.Status == LinkStatus.Verified)
                .Select(l => l.Provider + ":" + l.ProviderKind + ":" + l.ExternalId).ToArray();
            if (keys.Any(seen.Contains)) continue;
            foreach (var key in keys) seen.Add(key);
            var old = existing.FirstOrDefault(l => l.Status == LinkStatus.Verified && row.Links.Any(p =>
                p.Provider == l.Provider && p.ExternalId == l.ExternalId && p.ProviderKind == l.ProviderKind));
            var stored = old is null ? null : await store.SnapshotAsync(old.WorkId, cancellationToken);
            works.Add(stored?.Work.Kind == row.Work.Kind ? stored : row);
        }
        return new([.. works.Take(Math.Clamp(query.Limit, 1, 100))], partial, !anyFresh && rows.Length > 0, failed);

        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchTmdb(WorkKind kind)
        {
            var answer = await tmdb.SearchAsync(term, kind, null, cancellationToken);
            var results = answer.Json?.Obj("results").Items() ?? [];
            var mapped = results.Where(e => e.Obj("adult").ValueKind != JsonValueKind.True).Select(e =>
            {
                var b = new WorkBuilder(new("tmdb", e.Text("id")!, JsonFacts.Kind(kind)));
                MapTmdb(b, e, kind);
                ApplyMap(b, map.Find(new("tmdb", e.Text("id")!, JsonFacts.Kind(kind))));
                b.Work = b.Work with { RefreshedAt = null };
                return b.Build();
            }).ToArray();
            return ("tmdb", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchCinemeta(WorkKind kind)
        {
            var answer = await cinemeta.SearchAsync(term, kind, cancellationToken);
            var mapped = (answer.Json?.Obj("metas").Items() ?? []).Where(e => e.Text("id") is { } id && ImdbId().IsMatch(id))
                .Select(e =>
                {
                    var b = new WorkBuilder(new("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind)));
                    MapCinemeta(b, e, kind);
                    ApplyMap(b, map.Find(new("imdb", e.Text("id")!, null)));
                    b.Work = b.Work with { RefreshedAt = null };
                    return b.Build();
                }).ToArray();
            return ("cinemeta", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchImdb()
        {
            var answer = await cinemeta.SuggestAsync(term, cancellationToken);
            var mapped = (answer.Json?.Obj("d").Items() ?? []).Where(e => e.Text("id") is { } id && ImdbId().IsMatch(id) &&
                e.Text("qid") is "movie" or "short" or "tvMovie" or "video" or "tvSeries" or "tvMiniSeries").Select(e =>
            {
                var kind = e.Text("qid") is "tvSeries" or "tvMiniSeries" ? WorkKind.Series : WorkKind.Film;
                var b = new WorkBuilder(new("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind)));
                var link = b.Link("imdb", e.Text("id")!);
                b.Link("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind));
                b.Name(e.Text("l"), NameLabel.English, link);
                b.Work = b.Work with { Kind = kind, Format = kind == WorkKind.Film ? WorkFormat.Movie : WorkFormat.Series,
                    Year = e.Int("y"), PosterUrl = e.Obj("i").Text("imageUrl"), RefreshedAt = null };
                return b.Build();
            }).ToArray();
            return ("imdb", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchAnime()
        {
            var answer = await anilist.SearchAsync(term, 30, cancellationToken);
            var mapped = (answer.Json?.Obj("data").Obj("Page").Obj("media").Items() ?? []).Select(e =>
            {
                var b = new WorkBuilder(new("anilist", e.Text("id")!, null));
                MapAnime(b, e);
                b.Work = b.Work with { RefreshedAt = null };
                return b.Build();
            }).ToArray();
            return ("anilist", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchTvmaze()
        {
            var answer = await cinemeta.TvmazeAsync("/search/shows?q=" + Uri.EscapeDataString(term), cancellationToken);
            return ("tvmaze", answer, (answer.Json?.Items() ?? []).Select(e => e.Obj("show")).Select(e =>
            {
                var b = new WorkBuilder(new("tvmaze", e.Text("id")!, null));
                MapTvmaze(b, e, e.Text("id")!);
                b.Work = b.Work with { RefreshedAt = null };
                return b.Build();
            }).ToArray());
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchItunes()
        {
            var answer = await cinemeta.ItunesAsync(term, cancellationToken);
            return ("itunes", answer, (answer.Json?.Obj("results").Items() ?? []).Select(e =>
            {
                var b = new WorkBuilder(new("itunes", e.Text("trackId")!, null));
                MapItunes(b, e);
                b.Work = b.Work with { RefreshedAt = null };
                return b.Build();
            }).ToArray());
        }
    }

    private static double Relevance(string folded, WorkSnapshot work) => work.Names.Select(n =>
    {
        var candidate = n.NormalizedValue;
        if (candidate == folded) return 1.0;
        if (candidate.Contains(folded, StringComparison.Ordinal)) return 0.8;
        if (folded.Contains(candidate, StringComparison.Ordinal)) return 0.65;
        var previous = Enumerable.Range(0, candidate.Length + 1).ToArray();
        for (var i = 1; i <= folded.Length; i++)
        {
            var current = new int[candidate.Length + 1];
            current[0] = i;
            for (var j = 1; j <= candidate.Length; j++)
                current[j] = Math.Min(Math.Min(previous[j] + 1, current[j - 1] + 1),
                    previous[j - 1] + (folded[i - 1] == candidate[j - 1] ? 0 : 1));
            previous = current;
        }
        return 1 - (double)previous[^1] / Math.Max(candidate.Length, folded.Length);
    }).DefaultIfEmpty(0).Max();
}
