using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class MetadataService
{
    private async Task AnimeSeasonsAsync(WorkBuilder b, JsonElement requested, bool force, CancellationToken ct)
    {
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(TimeSpan.FromSeconds(12));
        ct = deadline.Token;
        var chain = new List<JsonElement> { requested };
        var seen = new HashSet<string> { requested.Text("id")! };
        var partial = false;
        var head = requested;
        for (var i = 0; i < 16; i++)
        {
            var (neighbours, failed) = await NeighboursAsync(head, "PREQUEL", force, ct);
            if (failed) { partial = true; break; }
            if (neighbours.Any(n => b.RejectedAnimeIds.Contains(n.Text("id")!))) { partial = true; break; }
            if (neighbours.Length == 0) break;
            if (neighbours.Length != 1 || !seen.Add(neighbours[0].Text("id")!)) { partial = true; break; }
            var answer = await AnimeDetailAsync(neighbours[0].Text("id")!, ct, force);
            partial |= !answer.Complete || answer.Stale;
            if (answer.Json?.Obj("data").Obj("Media") is not { ValueKind: JsonValueKind.Object } previous)
            { partial = true; break; }
            if (JsonFacts.Start(previous.Obj("startDate")) > JsonFacts.Start(head.Obj("startDate"))) break;
            chain.Insert(0, previous);
            head = previous;
        }
        head = requested;
        for (var i = 0; i < 16; i++)
        {
            var (neighbours, failed) = await NeighboursAsync(head, "SEQUEL", force, ct);
            if (failed) { partial = true; break; }
            if (neighbours.Any(n => b.RejectedAnimeIds.Contains(n.Text("id")!))) { partial = true; break; }
            if (neighbours.Length == 0) break;
            if (neighbours.Length != 1 || !seen.Add(neighbours[0].Text("id")!)) { partial = true; break; }
            var answer = await AnimeDetailAsync(neighbours[0].Text("id")!, ct, force);
            partial |= !answer.Complete || answer.Stale;
            if (answer.Json?.Obj("data").Obj("Media") is not { ValueKind: JsonValueKind.Object } next)
            { partial = true; break; }
            if (JsonFacts.Start(next.Obj("startDate")) < JsonFacts.Start(head.Obj("startDate"))) break;
            chain.Add(next);
            head = next;
        }
        var listed = b.Episodes.Where(e => e.AbsoluteNumber is not null).ToDictionary(e => e.AbsoluteNumber!.Value);
        var listedSeasons = b.Seasons.ToDictionary(s => s.Number);
        var starts = b.Seasons.Where(s => s.Number > 0).Select(s => b.Episodes.Where(e => e.SeasonId == s.Id)
            .MinBy(e => e.Number)?.AbsoluteNumber).OfType<int>().ToArray();
        var layout = new List<(JsonElement Entry, int Season, int EpisodeStart, int AbsoluteStart, int Count, bool Confirmed)>();
        var absolute = 1;
        var season = 1;
        var episodeStart = 1;
        var offsetKnown = !partial;
        var uncertain = new HashSet<int>();
        foreach (var entry in chain)
        {
            var title = entry.Obj("title").Text("english") ?? entry.Obj("title").Text("romaji") ?? "";
            if (layout.Count > 0)
            {
                var cour = CourMarker().IsMatch(title);
                var marked = SeasonMarker().IsMatch(title);
                var listingStart = starts.Any(s => s > 1 && Math.Abs(s - absolute) <= 2);
                var listedInside = listed.ContainsKey(absolute);
                if (marked || !cour && listingStart)
                {
                    var nearby = starts.Where(s => s > 1 && Math.Abs(s - absolute) <= 2).OrderBy(s => Math.Abs(s - absolute))
                        .Cast<int?>().FirstOrDefault();
                    if (nearby is { } snapped && snapped != absolute)
                    {
                        for (var n = Math.Min(absolute, snapped); n < Math.Max(absolute, snapped); n++) uncertain.Add(n);
                        absolute = snapped;
                    }
                    season++;
                    episodeStart = 1;
                }
                else if (!cour && !listedInside)
                {
                    // An unmarked sequel with no catalog alignment is a different show, not a guessed season.
                    if (layout.All(x => x.Entry.Text("id") != requested.Text("id")))
                    {
                        layout.Clear();
                        absolute = 1;
                        season = 1;
                        episodeStart = 1;
                    }
                    else break;
                }
            }
            var count = entry.Int("episodes");
            var nextEpisode = entry.Obj("nextAiringEpisode").Int("episode");
            var knownCount = count is > 0 and <= 5000 ? count.Value :
                nextEpisode is > 1 and <= 5001 ? nextEpisode.Value : 0;
            layout.Add((entry, season, episodeStart, absolute, knownCount, offsetKnown && knownCount > 0));
            absolute += knownCount;
            episodeStart += knownCount;
            offsetKnown &= entry.Text("status") == "FINISHED" && count is > 0;
        }
        if (layout.Count == 0) return;
        for (var i = 0; i + 1 < layout.Count; i++)
        {
            var item = layout[i];
            layout[i] = (item.Entry, item.Season, item.EpisodeStart, item.AbsoluteStart,
                Math.Min(item.Count, layout[i + 1].AbsoluteStart - item.AbsoluteStart), item.Confirmed);
        }
        var root = layout[0].Entry;
        if (b.Work.WorkKey.StartsWith("anilist:", StringComparison.Ordinal) && root.Text("id") != requested.Text("id"))
        {
            b.Work = b.Work with { WorkKey = "anilist:" + root.Text("id"),
                Year = root.Obj("startDate").Int("year") ?? b.Work.Year };
            b.Names.RemoveAll(n => n.LinkId == b.Links.FirstOrDefault(l => l.Provider == "anilist" &&
                l.ExternalId == requested.Text("id"))?.Id);
            MapAnime(b, root, overlay: true);
        }
        b.Seasons.Clear();
        b.Episodes.Clear();
        var boundaries = layout.Where(x => x.Season > 1 && x.EpisodeStart == 1).Select(x => x.AbsoluteStart)
            .Concat(starts.Where(s => s > 1 && !layout.Skip(1).Any(x => Math.Abs(x.AbsoluteStart - s) <= 2)))
            .Distinct().Order().ToArray();
        (int Season, int Episode) Coordinate(int abs)
        {
            var start = boundaries.Where(s => s <= abs).DefaultIfEmpty(1).Max();
            return (1 + boundaries.Count(s => s <= abs), abs - start + 1);
        }
        foreach (var group in layout.GroupBy(x => x.Season))
            b.Season(Coordinate(group.First().AbsoluteStart).Season, "Season " + group.Key,
                group.All(x => x.Entry.Int("episodes") is > 0) ? group.Sum(x => x.Count) : null,
                group.First().Entry.Text("id"),
                group.All(x => x.Confirmed) && !partial ? MappingStatus.Confirmed : MappingStatus.Provisional);
        foreach (var item in layout)
        {
            var id = item.Entry.Text("id")!;
            var linkId = b.Link("anilist", id);
            var link = b.Links.Single(l => l.Id == linkId);
            b.Links[b.Links.IndexOf(link)] = link with { SeasonId = b.SeasonId(Coordinate(item.AbsoluteStart).Season),
                MappingVersion = map.Version };
            ApplyMap(b, map.Find(new("anilist", id, null)));
            var airings = new Dictionary<int, DateTimeOffset>();
            for (var page = 1; page <= 100; page++)
            {
                ProviderAnswer answer;
                try { answer = await anilist.AiringsAsync(id, page, ct, force); }
                catch (OperationCanceledException) { partial = true; break; }
                if (answer.Json?.Obj("data").Obj("Page") is not { ValueKind: JsonValueKind.Object } schedules)
                { partial = true; break; }
                b.Stale |= answer.Stale;
                foreach (var row in schedules.Obj("airingSchedules").Items())
                    if (row.Int("episode") is { } n && row.Int("airingAt") is { } stamp)
                        airings[n] = DateTimeOffset.FromUnixTimeSeconds(stamp);
                if (schedules.Obj("pageInfo").Obj("hasNextPage").ValueKind != JsonValueKind.True) break;
            }
            for (var n = 1; n <= item.Count; n++)
            {
                var abs = item.AbsoluteStart + n - 1;
                var status = item.Confirmed && !partial && !uncertain.Contains(abs) ? MappingStatus.Confirmed : MappingStatus.Provisional;
                var original = listed.GetValueOrDefault(abs);
                var coordinate = Coordinate(abs);
                if (b.Seasons.All(s => s.Number != coordinate.Season))
                    b.Season(coordinate.Season, listedSeasons.GetValueOrDefault(coordinate.Season)?.Title ??
                        "Season " + coordinate.Season, null, id, status);
                var air = airings.TryGetValue(n, out var stamp) ? stamp : original?.AirAt;
                b.Episode(coordinate.Season, coordinate.Episode, item.Confirmed ? abs : null,
                    "anilist", id + ":" + n, original?.Title, air,
                    airings.ContainsKey(n) ? DatePrecision.Instant : original?.AirPrecision ?? DatePrecision.Unknown,
                    original?.RuntimeMinutes ?? item.Entry.Int("duration") ?? b.Work.RuntimeMinutes, status,
                    original?.Synopsis, original?.StillUrl ?? item.Entry.Text("bannerImage"));
            }
        }
        foreach (var abs in uncertain.Where(listed.ContainsKey))
        {
            var original = listed[abs];
            var coordinate = Coordinate(abs);
            if (b.Episodes.Any(e => e.SeasonId == b.SeasonId(coordinate.Season) && e.Number == coordinate.Episode)) continue;
            b.Episode(coordinate.Season, coordinate.Episode, abs, original.Provider ?? "imdb",
                original.ProviderEpisodeId, original.Title, original.AirAt, original.AirPrecision,
                original.RuntimeMinutes, MappingStatus.Provisional, original.Synopsis, original.StillUrl);
            var row = b.Seasons.FirstOrDefault(s => s.Number == coordinate.Season);
            if (row is not null) b.Seasons[b.Seasons.IndexOf(row)] = row with { MappingStatus = MappingStatus.Provisional };
        }
        b.Complete &= !partial;
        for (var i = 0; i < b.Seasons.Count; i++)
        {
            var row = b.Seasons[i];
            var count = b.Episodes.Count(e => e.SeasonId == row.Id);
            if (row.ExpectedEpisodeCount is not null || listedSeasons.GetValueOrDefault(row.Number)?.ExpectedEpisodeCount is not null)
                b.Seasons[i] = row with { ExpectedEpisodeCount = count };
        }
        if (partial)
            for (var i = 0; i < b.Seasons.Count; i++)
                b.Seasons[i] = b.Seasons[i] with { MappingStatus = MappingStatus.Provisional };
    }

    private static JsonElement[] Neighbours(JsonElement entry, string relation) =>
        entry.Obj("relations").Obj("edges").Items().Where(e => e.Text("relationType") == relation)
            .Select(e => e.Obj("node")).Where(e => e.Text("type") == "ANIME" && e.Text("format") is "TV" or "ONA")
            .DistinctBy(e => e.Text("id")).ToArray();

    private async Task<(JsonElement[] Nodes, bool Failed)> NeighboursAsync(JsonElement entry, string relation, bool force, CancellationToken ct)
    {
        var neighbours = Neighbours(entry, relation);
        if (neighbours.Length > 0) return (neighbours, false);
        var specials = entry.Obj("relations").Obj("edges").Items().Where(e => e.Text("relationType") == relation)
            .Select(e => e.Obj("node")).Where(n => n.Text("type") == "ANIME" && n.Text("format") == "SPECIAL")
            .DistinctBy(n => n.Text("id")).ToArray();
        if (specials.Length != 1) return ([], false);
        var answer = await AnimeDetailAsync(specials[0].Text("id")!, ct, force);
        if (answer.Json?.Obj("data").Obj("Media") is not { ValueKind: JsonValueKind.Object } special)
            return ([], true);
        return (Neighbours(special, relation), !answer.Complete || answer.Stale);
    }

    private async Task<ProviderAnswer> AnimeDetailAsync(string id, CancellationToken ct, bool force)
    {
        try { return await anilist.DetailAsync(id, ct, force); }
        catch (OperationCanceledException)
        {
            return new(null, false, false,
                new("provider_unavailable", "The anime catalog did not complete its season listing. Try again later.", null, false));
        }
    }

    [GeneratedRegex(@"\b(?:part|cour)\s*[2-9]\b", RegexOptions.IgnoreCase)]
    private static partial Regex CourMarker();
    [GeneratedRegex(@"\b(?:[2-9](?:nd|rd|th)\s+season|season\s*[2-9]|final\s+season|II|III|IV)\b", RegexOptions.IgnoreCase)]
    private static partial Regex SeasonMarker();
}
