using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed partial class Catalog
{
    private async Task<WorkSnapshot> WithPremiereAsync(WorkSnapshot work, CancellationToken ct)
    {
        DateTimeOffset? premiere = null;
        var anime = work.Work.Anime == true ? work.Links.Where(l => l.Provider == "anilist" &&
            l.Status == LinkStatus.Verified).OrderBy(l =>
                work.Seasons.FirstOrDefault(s => s.Id == l.SeasonId)?.Number ?? int.MaxValue).FirstOrDefault() : null;
        if (anime is not null)
        {
            var answer = await anilist.DetailAsync(anime.ExternalId, ct);
            if (answer.Json?.Obj("data").Obj("Media") is { ValueKind: JsonValueKind.Object } media)
                premiere = JsonFacts.Start(media.Obj("startDate"));
        }
        else if (work.Links.FirstOrDefault(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified) is { } link &&
            work.Work.Kind == WorkKind.Series)
        {
            var answer = await tmdb.DetailAsync(link.ExternalId, work.Work.Kind, ct, false);
            premiere = JsonFacts.Date(answer.Json?.Text("first_air_date"));
        }
        return work with { PremiereAt = premiere };
    }

    private static bool CurrentPresentation(WorkSnapshot work) =>
        work.Work.Anime == true ? work.Work.RatingSource == "anilist" :
        !work.Links.Any(l => l.Provider == "tmdb" && l.Status == LinkStatus.Verified) ||
            work.Work.RatingSource == "tmdb" && work.Episodes.All(e =>
                e.Provider == "tmdb" || e.MappingStatus == MappingStatus.Unavailable);
}
