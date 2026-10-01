using System;
using System.Collections.Generic;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Data.Entities;

public partial class Work
{
    public string Id { get; set; } = null!;

    public string WorkKey { get; set; } = null!;

    public string CanonicalTitle { get; set; } = null!;

    public int? Year { get; set; }

    public string MediaType { get; set; } = null!;

    /// <summary>Unlabelled names from before <see cref="NamesJson"/>; kept for rollback, read by nothing.</summary>
    public string? AliasesJson { get; set; }

    /// <summary>Labelled names; read them through <see cref="ReadNames"/>.</summary>
    public string? NamesJson { get; set; }

    /// <summary>Ids at every provider; read them through <see cref="ReadIds"/>.</summary>
    public string? IdsJson { get; set; }

    /// <summary>Movie, Series or Special as the provider tells it; null when unknown. Read through <see cref="IsSeries"/>.</summary>
    public WorkFormat? Format { get; set; }

    /// <summary>ISO 639-1 original language from the provider; null when unknown. Stored only.</summary>
    public string? OriginalLanguage { get; set; }

    /// <summary>
    /// Whether the work's own provider record classes it as anime (<see cref="AnimeIdentity.IsAnime(MediaMetadata?)"/>),
    /// stored at ingest and refresh; null until known. Read through <see cref="IsAnime"/>.
    /// </summary>
    public bool? Anime { get; set; }

    /// <summary>When names, ids, format, language and anime were last taken from the work's own provider; null when never.</summary>
    public DateTime? NamesRefreshedAt { get; set; }

    /// <summary>The anime-lists map version this work was last linked against ("none" without a map); null when never linked.</summary>
    public string? LinksVersion { get; set; }

    public string? Provider { get; set; }

    public string? ProviderId { get; set; }

    public string? PosterUrl { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    /// <summary>Film or series: <see cref="WorkKinds.IsSeries"/>.</summary>
    public bool IsSeries() => WorkKinds.IsSeries(Format, MediaType);

    /// <summary>Anime (the folder only): <see cref="WorkKinds.IsAnime"/>.</summary>
    public bool IsAnime() => WorkKinds.IsAnime(Provider, ProviderId, Anime, MediaType);

    public virtual ICollection<AcquisitionTarget> AcquisitionTargets { get; set; } = new List<AcquisitionTarget>();

    public virtual ICollection<CatalogEntry> CatalogEntries { get; set; } = new List<CatalogEntry>();

    public virtual ICollection<DownloadHistory> DownloadHistories { get; set; } = new List<DownloadHistory>();

    public virtual ICollection<EngineTorrent> EngineTorrents { get; set; } = new List<EngineTorrent>();

    public virtual ICollection<WatchListItem> WatchListItems { get; set; } = new List<WatchListItem>();

    public virtual ICollection<WorkLink> Links { get; set; } = new List<WorkLink>();
}
