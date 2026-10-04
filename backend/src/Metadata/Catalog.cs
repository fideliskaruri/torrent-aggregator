using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    public async Task<CatalogResult> SearchAsync(CatalogQuery query, CancellationToken cancellationToken)
    {
        var term = SearchText.Canonical(query.Query);
        if (term.Length is < 1 or > 200 || JsonFacts.Fold(term).Length == 0) return new([], false, false, []);
        var settings = await ProviderHttp.SettingsAsync(dbs, cancellationToken);
        var signals = new ConcurrentDictionary<string, SearchCandidate>();
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
        if (settings.EnabledProviders.Contains("anilist") && query.Category is "all" or "anime")
            tasks.Add(SearchAnime());
        if (settings.EnabledProviders.Contains("tvmaze") && kinds.Contains(WorkKind.Series))
            tasks.Add(SearchTvmaze());
        if (settings.EnabledProviders.Contains("itunes") && kinds.Contains(WorkKind.Film))
            tasks.Add(SearchItunes());
        var answered = await Task.WhenAll(tasks);
        var anyFresh = answered.Any(a => a.Answer.Complete && !a.Answer.Stale);
        var partial = answered.Any(a => !a.Answer.Complete);
        var failed = answered.Where(a => !a.Answer.Complete).Select(a => a.Provider).Distinct().ToImmutableArray();
        var rows = answered.SelectMany(a => a.Works)
            .Where(w => query.Category != "anime" || w.Work.Anime == true)
            .Where(w => kinds.Length == 0 || kinds.Contains(w.Work.Kind)).ToArray();
        if (!rows.Any(w => SearchText.BestTier(term, w.Names.Select(n => n.Value)) < 5))
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
        var existing = await LinksAsync(cancellationToken);
        var rankedCandidates = new List<SearchCandidate>();
        foreach (var row in rows)
        {
            var old = existing.Where(l => l.Status == LinkStatus.Verified && l.SeasonId is null &&
                row.Links.Any(p => p.Source != "fribb" && p.Provider == l.Provider &&
                    p.ExternalId == l.ExternalId && p.ProviderKind == l.ProviderKind))
                .OrderByDescending(l => l.IsPrimary).FirstOrDefault();
            var stored = old is null ? null : await SnapshotAsync(old.WorkId, cancellationToken);
            var signal = signals[row.Work.Id] with { Work = row };
            if (stored?.Work.Kind == row.Work.Kind && (row.Work.Year is null || stored.Work.Year is null ||
                Math.Abs(row.Work.Year.Value - stored.Work.Year.Value) <= 1))
                signal = signal with
                {
                    Work = row with { Work = row.Work with { Id = stored.Work.Id, WorkKey = stored.Work.WorkKey,
                        PosterUrl = stored.Work.PosterUrl ?? row.Work.PosterUrl } },
                    Stored = true,
                };
            rankedCandidates.Add(signal);
        }
        var ranks = answered.FirstOrDefault(a => a.Provider == "imdb").Answer?.Json?.Obj("d").Items()
            .Where(e => e.Text("id") is not null && e.Int("rank") is > 0)
            .DistinctBy(e => e.Text("id")).ToDictionary(e => e.Text("id")!, e => e.Int("rank")!.Value)
            ?? new Dictionary<string, int>();
        var categories = query.Category == "all" ? new[] { "movies", "series", "anime" } : new[] { query.Category };
        var groups = categories.Select(category => (IReadOnlyList<SearchCandidate>)rankedCandidates.Where(r =>
            category == "anime" ? r.Provider == "anilist" : category is "movies" or "films"
                ? r.Work.Work.Kind == WorkKind.Film && r.Provider != "anilist"
                : r.Work.Work.Kind == WorkKind.Series && r.Provider != "anilist").ToArray()).ToArray();
        var merged = SearchText.Interleave(groups, term);
        var ranked = SearchRanking.Rank(merged, term, ranks, DateTimeOffset.UtcNow);
        return new([.. ranked.Take(Math.Clamp(query.Limit, 1, 100)).Select(r => r.Work)], partial,
            answered.Any(a => a.Answer.Stale) && rows.Length > 0, failed);

        WorkSnapshot Candidate(WorkBuilder builder, double popularity, bool animated = false,
            string? format = null, DateTimeOffset? released = null)
        {
            var work = builder.Build() with { ProviderFormat = format };
            signals[work.Work.Id] = new(work, popularity, animated, format, released);
            return work;
        }

        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchTmdb(WorkKind kind)
        {
            var answer = await tmdb.SearchAsync(term, kind, null, cancellationToken);
            var results = answer.Json?.Obj("results").Items() ?? [];
            var mapped = results.Where(e => e.Obj("adult").ValueKind != JsonValueKind.True).Select((e, index) =>
            {
                var b = new WorkBuilder(new("tmdb", e.Text("id")!, JsonFacts.Kind(kind)));
                MapTmdb(b, e, kind);
                b.Work = b.Work with { RefreshedAt = null };
                return Candidate(b, SearchRanking.PositionPrior(index), released:
                    JsonFacts.Date(e.Text(kind == WorkKind.Film ? "release_date" : "first_air_date")));
            }).ToArray();
            if (mapped.FirstOrDefault() is { } top && SearchText.BestTier(term, top.Names.Select(n => n.Value)) >= 5)
            {
                var id = top.Links.First(l => l.IsPrimary).ExternalId;
                var names = await tmdb.GetAsync("/" + JsonFacts.Kind(kind) + "/" + id + "/alternative_titles",
                    "", cancellationToken);
                var b = new WorkBuilder(new("tmdb", id, JsonFacts.Kind(kind))) { Work = top.Work };
                b.Links.AddRange(top.Links);
                b.Names.AddRange(top.Names);
                foreach (var name in names.Json?.Obj(kind == WorkKind.Film ? "titles" : "results").Items() ?? [])
                    b.Name(name.Text("title"), NameLabel.Synonym, top.Links.First(l => l.IsPrimary).Id);
                mapped[0] = b.Build();
            }
            return ("tmdb", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchCinemeta(WorkKind kind)
        {
            var suggestionTask = cinemeta.SuggestAsync(term, cancellationToken);
            var answer = await cinemeta.SearchAsync(term, kind, cancellationToken);
            var mapped = (answer.Json?.Obj("metas").Items() ?? []).Where(e => e.Text("id") is { } id && ImdbId().IsMatch(id))
                .Select((e, index) =>
                {
                    var b = new WorkBuilder(new("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind)));
                    MapCinemeta(b, e, kind);
                    b.Work = b.Work with { RefreshedAt = null };
                    return Candidate(b, SearchRanking.PositionPrior(index));
                }).ToArray();
            var suggestion = await suggestionTask;
            var suggested = (suggestion.Json?.Obj("d").Items() ?? []).Where(e => e.Text("id") is { } id &&
                ImdbId().IsMatch(id) && (kind == WorkKind.Series
                    ? e.Text("qid") is "tvSeries" or "tvMiniSeries"
                    : e.Text("qid") is "movie" or "short" or "tvMovie" or "video")).Select(e =>
            {
                var b = new WorkBuilder(new("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind)));
                var link = b.Link("imdb", e.Text("id")!);
                b.Link("cinemeta", e.Text("id")!, CinemetaClient.Kind(kind));
                b.Name(e.Text("l"), NameLabel.English, link);
                b.Work = b.Work with { Kind = kind, Format = kind == WorkKind.Film ? WorkFormat.Movie : WorkFormat.Series,
                    Year = e.Int("y"), PosterUrl = e.Obj("i").Text("imageUrl"), RefreshedAt = null };
                return Candidate(b, 0.2);
            }).ToArray();
            var hasExact = mapped.Any(w => JsonFacts.Fold(w.Names.First().Value) == JsonFacts.Fold(term));
            for (var i = 0; i < mapped.Length; i++)
            {
                var row = mapped[i];
                var imdb = row.Links.First(l => l.Provider == "imdb").ExternalId;
                var other = suggested.FirstOrDefault(w => w.Links.Any(l => l.Provider == "imdb" && l.ExternalId == imdb));
                if (other is null) continue;
                var title = other.Names.First().Value;
                var names = row.Names;
                if (JsonFacts.Fold(row.Names.First().Value) != JsonFacts.Fold(term) &&
                    JsonFacts.Fold(row.Names.First().Value) != JsonFacts.Fold(title))
                    names = [other.Names.First(), .. names.Select(n => n with { Label = NameLabel.Synonym })];
                mapped[i] = row with { Names = names, Work = row.Work with
                {
                    Year = other.Work.Year ?? row.Work.Year,
                    TheatricalAt = other.Work.Year is not null && other.Work.Year != row.Work.Year ? null : row.Work.TheatricalAt,
                }};
            }
            var extras = suggested.Where((w, index) => !mapped.Any(r => r.Links.Any(l => l.Provider == "imdb" &&
                w.Links.Any(p => p.Provider == "imdb" && p.ExternalId == l.ExternalId))) &&
                (JsonFacts.Fold(w.Names.First().Value) == JsonFacts.Fold(term) || index == 0 && !hasExact));
            var combined = extras.Concat(mapped).Take(Math.Clamp(query.Limit, 1, 100)).ToArray();
            for (var i = 0; i < combined.Length; i++)
                signals[combined[i].Work.Id] = signals[combined[i].Work.Id] with
                {
                    Work = combined[i], Popularity = SearchRanking.PositionPrior(i),
                };
            if (suggested.FirstOrDefault() is { } top && SearchText.BestTier(term, top.Names.Select(n => n.Value)) >= 5)
            {
                var id = top.Links.First(l => l.Provider == "imdb").ExternalId;
                var names = await cinemeta.NamesAsync(id, cancellationToken);
                var index = Array.FindIndex(combined, r => r.Links.Any(l => l.Provider == "imdb" && l.ExternalId == id));
                if (index >= 0 && names.Json?.Obj("data").Obj("title") is { ValueKind: JsonValueKind.Object } detail)
                {
                    var row = combined[index];
                    var b = new WorkBuilder(new("imdb", id, JsonFacts.Kind(kind))) { Work = row.Work };
                    b.Names.AddRange(row.Names); b.Links.AddRange(row.Links);
                    b.Name(detail.Obj("originalTitleText").Text("text"), NameLabel.Original, row.Links.First().Id);
                    foreach (var aka in detail.Obj("akas").Obj("edges").Items())
                        b.Name(aka.Obj("node").Text("text"), NameLabel.Synonym, row.Links.First().Id);
                    combined[index] = b.Build();
                }
            }
            return ("cinemeta", answer, combined);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchImdb()
        {
            var answer = await cinemeta.SuggestAsync(term, cancellationToken);
            return ("imdb", answer, []);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchAnime()
        {
            var answer = await anilist.SearchAsync(term, 30, cancellationToken);
            var mapped = (answer.Json?.Obj("data").Obj("Page").Obj("media").Items() ?? []).Select(e =>
            {
                var b = new WorkBuilder(new("anilist", e.Text("id")!, null));
                MapAnime(b, e);
                b.Work = b.Work with { RefreshedAt = null };
                return Candidate(b, SearchRanking.AnimePopularity(e.Int("popularity")),
                    format: e.Text("format"), released: JsonFacts.Start(e.Obj("startDate")));
            }).ToArray();
            return ("anilist", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchTvmaze()
        {
            var answer = await cinemeta.TvmazeAsync("/search/shows?q=" + Uri.EscapeDataString(term), cancellationToken);
            var mapped = (answer.Json?.Items() ?? []).Select(e => e.Obj("show")).Select(e =>
            {
                var b = new WorkBuilder(new("tvmaze", e.Text("id")!, null));
                MapTvmaze(b, e, e.Text("id")!);
                b.Work = b.Work with { RefreshedAt = null };
                return Candidate(b, SearchRanking.TvmazeWeight(e.Int("weight")), e.Text("type") == "Animation",
                    released: JsonFacts.Date(e.Text("premiered")));
            }).ToArray();
            if (mapped.FirstOrDefault() is { } top && SearchText.BestTier(term, top.Names.Select(n => n.Value)) == 6)
            {
                var id = top.Links.First(l => l.IsPrimary).ExternalId;
                var names = await cinemeta.TvmazeAsync("/shows/" + id + "/akas", cancellationToken);
                var b = new WorkBuilder(new("tvmaze", id, null)) { Work = top.Work };
                b.Links.AddRange(top.Links);
                b.Names.AddRange(top.Names);
                foreach (var name in names.Json?.Items() ?? [])
                    b.Name(name.Text("name"), NameLabel.Synonym, top.Links.First(l => l.IsPrimary).Id);
                mapped[0] = b.Build();
            }
            return ("tvmaze", answer, mapped);
        }
        async Task<(string, ProviderAnswer, WorkSnapshot[])> SearchItunes()
        {
            var answer = await cinemeta.ItunesAsync(term, cancellationToken);
            return ("itunes", answer, (answer.Json?.Obj("results").Items() ?? []).Select((e, index) =>
            {
                var b = new WorkBuilder(new("itunes", e.Text("trackId")!, null));
                MapItunes(b, e);
                b.Work = b.Work with { RefreshedAt = null };
                return Candidate(b, SearchRanking.PositionPrior(index));
            }).ToArray());
        }
    }

}
