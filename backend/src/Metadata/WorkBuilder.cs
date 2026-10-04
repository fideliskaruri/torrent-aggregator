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
        Work = new WorkRow
        {
            Id = id,
            WorkKey = key,
            Kind = WorkKind.Unknown,
            Format = WorkFormat.Unknown,
            Anime = null,
            Year = null,
            OriginalLanguage = null,
            RuntimeMinutes = null,
            PosterUrl = null,
            BackdropUrl = null,
            Synopsis = null,
            Rating = null,
            RatingSource = null,
            Genres = [],
            TheatricalAt = null,
            DigitalAt = null,
            PhysicalAt = null,
            ReleasePrecision = DatePrecision.Unknown,
            ProviderStatus = null,
            NumberingVersion = null,
            RefreshedAt = null,
            CreatedAt = Now,
            UpdatedAt = Now,
            Version = 0,
        };
    }

    internal string Link(string provider, string id, string? kind = null, string source = "provider",
        string? version = null, int? season = null)
    {
        var existing = Links.FirstOrDefault(l => l.Provider == provider && l.ExternalId == id && l.ProviderKind == kind);
        if (existing is not null) return existing.Id;
        var linkId = ProviderHttp.Id(Work.Id + ":" + provider + ":" + kind + ":" + id);
        Links.Add(new WorkLinkRow
        {
            Id = linkId,
            WorkId = Work.Id,
            Provider = provider,
            ExternalId = id,
            ProviderKind = kind,
            SeasonId = season is { } n ? SeasonId(n) : null,
            Source = source,
            MappingVersion = version,
            Confidence = 1,
            Status = LinkStatus.Verified,
            IsPrimary = Links.Count == 0,
            CreatedAt = Now,
            UpdatedAt = Now,
        });
        return linkId;
    }

    internal void Name(string? value, NameLabel label, string? linkId)
    {
        if (string.IsNullOrWhiteSpace(value)) return;
        value = value.Trim();
        var fold = JsonFacts.Fold(value);
        if (fold.Length == 0 || Names.Any(n => n.NormalizedValue == fold && n.Label == label && n.LinkId == linkId)) return;
        Names.Add(new WorkNameRow
        {
            Id = ProviderHttp.Id(Work.Id + ":" + fold + ":" + label + ":" + linkId),
            WorkId = Work.Id,
            Value = value,
            NormalizedValue = fold,
            Label = label,
            LinkId = linkId,
            Ordinal = Names.Count,
            Authoritative = true,
            RefreshedAt = Now,
        });
    }

    internal string SeasonId(int number) => ProviderHttp.Id(Work.Id + ":season:" + number);

    internal SeasonRow Season(int number, string? title, int? count, string? providerId,
        MappingStatus status = MappingStatus.Confirmed, string? overview = null, string? poster = null)
    {
        var row = new SeasonRow { Id = SeasonId(number), WorkId = Work.Id, Number = number, Title = title, Overview = overview, PosterUrl = poster, MappingStatus = status, ProviderEntryId = providerId, ExpectedEpisodeCount = count, RefreshedAt = Now, CreatedAt = Now, UpdatedAt = Now, Version = 0 };
        Seasons.RemoveAll(s => s.Number == number);
        Seasons.Add(row);
        return row;
    }

    internal void Episode(int season, int number, int? absolute, string provider, string? providerId,
        string? title, DateTimeOffset? air, DatePrecision precision, int? runtime, MappingStatus status,
        string? synopsis = null, string? still = null)
    {
        Episodes.Add(new EpisodeRow
        {
            Id = ProviderHttp.Id(Work.Id + ":episode:" + provider + ":" + (providerId ?? season + ":" + number)),
            SeasonId = SeasonId(season),
            Number = number,
            AbsoluteNumber = absolute,
            Provider = provider,
            ProviderEpisodeId = providerId,
            Title = title,
            Synopsis = synopsis,
            StillUrl = still,
            AirAt = air,
            AirPrecision = air is null ? DatePrecision.Unknown : precision,
            RuntimeMinutes = runtime,
            MappingStatus = status,
            CreatedAt = Now,
            UpdatedAt = Now,
            Version = 0,
        });
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
