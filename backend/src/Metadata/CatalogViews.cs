using System.Collections.Immutable;

namespace TorrentFlow.Metadata;

public sealed record CatalogGenre(string Id, string Label);

/// <summary>The catalog's supported home views, shared with HTTP validation and chip projection.</summary>
public static class CatalogViews
{
    public static ImmutableArray<CatalogGenre> Genres(string type) => type switch
    {
        "films" => Films,
        "series" => Series,
        "anime" => Anime,
        _ => [],
    };
    public static string Heading(string type, CatalogGenre genre) => (type, genre.Id) switch
    {
        ("films", "thriller") => "Thrillers",
        ("films", "documentary") => "Documentaries",
        _ => genre.Label + " " + type,
    };
    private static readonly ImmutableArray<CatalogGenre> Films =
    [
        new("action", "Action"), new("comedy", "Comedy"), new("drama", "Drama"), new("thriller", "Thrillers"),
        new("horror", "Horror"), new("science-fiction", "Science fiction"), new("crime", "Crime"),
        new("romance", "Romance"), new("family", "Family"), new("documentary", "Documentary"),
    ];
    private static readonly ImmutableArray<CatalogGenre> Series =
    [
        new("drama", "Drama"), new("comedy", "Comedy"), new("crime", "Crime"), new("action-adventure", "Action and adventure"),
        new("sci-fi-fantasy", "Sci-fi and fantasy"), new("mystery", "Mystery"), new("documentary", "Documentary"), new("reality", "Reality"),
    ];
    private static readonly ImmutableArray<CatalogGenre> Anime =
    [
        new("action", "Action"), new("romance", "Romance"), new("fantasy", "Fantasy"), new("comedy", "Comedy"),
        new("slice-of-life", "Slice of life"), new("sci-fi", "Sci-fi"), new("sports", "Sports"), new("mystery", "Mystery"),
    ];
}
