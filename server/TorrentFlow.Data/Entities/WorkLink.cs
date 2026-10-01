using System;

namespace TorrentFlow.Data.Entities;

/// <summary>
/// One crosswalk row: this work is <see cref="ExternalId"/> at <see cref="Provider"/> (tmdb, anilist, mal, imdb, tvdb,
/// anidb), with where that claim came from. Written only through <see cref="WorkLinks"/>.
/// </summary>
public partial class WorkLink
{
    public string Id { get; set; } = null!;

    public string WorkId { get; set; } = null!;

    public string Provider { get; set; } = null!;

    public string ExternalId { get; set; } = null!;

    /// <summary>movie or tv, when the provider tells them apart (TMDB).</summary>
    public string? MediaType { get; set; }

    /// <summary>The season of a series this record is, when one series maps to several records (Bleach and its sequels).</summary>
    public int? Season { get; set; }

    /// <summary>provider (the record reports it about itself), fribb, title-search or owner.</summary>
    public string Source { get; set; } = null!;

    /// <summary>The anime-lists map version the link came from or was last checked against.</summary>
    public string? MappingVersion { get; set; }

    public double Confidence { get; set; }

    /// <summary>Provider-reported and map links are verified; a title-search suggestion never is.</summary>
    public bool Verified { get; set; }

    /// <summary>The owner unlinked it: never added again, never read for ids or names.</summary>
    public bool Rejected { get; set; }

    /// <summary>The linked record's labelled names (<c>WorkNames</c> JSON), when fetched.</summary>
    public string? NamesJson { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public virtual Work Work { get; set; } = null!;
}
