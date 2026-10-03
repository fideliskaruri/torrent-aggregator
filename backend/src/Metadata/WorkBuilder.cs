using System.Collections.Immutable;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed class WorkBuilder
{
    internal WorkRow Work;
    internal readonly List<WorkNameRow> Names = [];
    internal readonly List<WorkLinkRow> Links = [];
    internal readonly List<SeasonRow> Seasons = [];
    internal readonly List<EpisodeRow> Episodes = [];
    internal readonly HashSet<string> RejectedAnimeIds = [];
    internal bool Complete = true;
    internal bool Stale;
    internal readonly DateTimeOffset Now = DateTimeOffset.UtcNow;

    internal WorkBuilder(ProviderId identity)
    {
        var id = Guid.CreateVersion7().ToString();
        var key = identity.Provider + ":" + (identity.ProviderKind is { Length: > 0 } kind ? kind + ":" : "") + identity.ExternalId;
        Work = new(id, key, WorkKind.Unknown, WorkFormat.Unknown, null, null, null, null, null, null,
            null, null, null, [], null, null, null, DatePrecision.Unknown, null, null, Now, Now, Now, 0);
    }

    internal string Link(string provider, string id, string? kind = null, string source = "provider",
        string? version = null, int? season = null)
    {
        var existing = Links.FirstOrDefault(l => l.Provider == provider && l.ExternalId == id && l.ProviderKind == kind);
        if (existing is not null) return existing.Id;
        var linkId = ProviderHttp.Id(Work.Id + ":" + provider + ":" + kind + ":" + id);
        Links.Add(new(linkId, Work.Id, provider, id, kind,
            season is { } n ? SeasonId(n) : null, source, version, 1, LinkStatus.Verified,
            Links.Count == 0, Now, Now));
        return linkId;
    }

    internal void Name(string? value, NameLabel label, string? linkId)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        value = value.Trim();
        var fold = JsonFacts.Fold(value);
        if (fold.Length == 0 || Names.Any(n => n.NormalizedValue == fold && n.Label == label && n.LinkId == linkId)) return;
        Names.Add(new(ProviderHttp.Id(Work.Id + ":" + fold + ":" + label + ":" + linkId),
            Work.Id, value, fold, label, linkId, Names.Count, true, Now));
    }

    internal string SeasonId(int number) => ProviderHttp.Id(Work.Id + ":season:" + number);

    internal SeasonRow Season(int number, string? title, int? count, string? providerId,
        MappingStatus status = MappingStatus.Confirmed, string? overview = null, string? poster = null)
    {
        var row = new SeasonRow(SeasonId(number), Work.Id, number, title, overview, poster, status,
            providerId, count, Now, Now, Now, 0);
        Seasons.RemoveAll(s => s.Number == number);
        Seasons.Add(row);
        return row;
    }

    internal void Episode(int season, int number, int? absolute, string provider, string? providerId,
        string? title, DateTimeOffset? air, DatePrecision precision, int? runtime, MappingStatus status,
        string? synopsis = null, string? still = null)
    {
        Episodes.Add(new(ProviderHttp.Id(Work.Id + ":episode:" + provider + ":" +
            (providerId ?? season + ":" + number)), SeasonId(season), number, absolute, provider, providerId,
            title, synopsis, still, air, air is null ? DatePrecision.Unknown : precision, runtime, status, Now, Now, 0));
    }

    internal WorkSnapshot Build()
    {
        var names = Names.OrderBy(n => n.Label switch
        {
            NameLabel.English => 0, NameLabel.Original => 1, NameLabel.Romaji => 2,
            NameLabel.Native => 3, _ => 4,
        }).ThenBy(n => n.Ordinal).Select((n, i) => n with { Ordinal = i }).ToImmutableArray();
        return new(Work, names, [.. Links], [.. Seasons.OrderBy(s => s.Number)],
            [.. Episodes.OrderBy(e => Seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.Number).ThenBy(e => e.Number)]);
    }
}
