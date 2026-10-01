using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Core.Text;

namespace TorrentFlow.Core.Contracts.Metadata;

/// <summary>What a name of a work is. English and Romaji are searched first; Native is for matching only.</summary>
[JsonConverter(typeof(JsonStringEnumConverter<WorkNameKind>))]
public enum WorkNameKind { English, Romaji, Synonym, Native, Original }

/// <summary>One labelled name of a work.</summary>
public sealed record WorkName(string Text, WorkNameKind Kind);

/// <summary>A work's ids at each provider that knows it.</summary>
public sealed record WorkIds(int? Tmdb = null, int? AniList = null, int? Mal = null, string? Imdb = null)
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };

    [JsonIgnore]
    public bool IsEmpty => Tmdb == null && AniList == null && Mal == null && Imdb == null;

    /// <summary>These ids, with any gap filled from <paramref name="other"/>.</summary>
    public WorkIds Merge(WorkIds? other) => other == null ? this
        : new(Tmdb ?? other.Tmdb, AniList ?? other.AniList, Mal ?? other.Mal, Imdb ?? other.Imdb);

    /// <summary>The id a work's single provider claim carries (a Cinemeta id is an IMDb id).</summary>
    public static WorkIds From(string? provider, string? providerId)
    {
        var id = providerId?.Trim();
        if (string.IsNullOrEmpty(id)) return new();
        int? Number() => int.TryParse(id, NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) && n > 0 ? n : null;
        return provider?.Trim().ToLowerInvariant() switch
        {
            "tmdb" => new(Tmdb: Number()),
            "anilist" => new(AniList: Number()),
            "mal" or "myanimelist" => new(Mal: Number()),
            "cinemeta" or "imdb" when id.StartsWith("tt", StringComparison.OrdinalIgnoreCase) => new(Imdb: id),
            _ => new()
        };
    }

    public string? ToJson() => IsEmpty ? null : JsonSerializer.Serialize(this, Json);

    public static WorkIds? FromJson(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<WorkIds>(json, Json); }
        catch (JsonException) { return null; }
    }
}

/// <summary>
/// The one owner of a work's names: ordered, labelled, unique (case-insensitive). Releases are searched by
/// <see cref="SearchNames"/> and recognised by <see cref="MatchNames"/>; script detection lives here only.
/// </summary>
public sealed class WorkNames
{
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public static readonly WorkNames Empty = new([]);

    public IReadOnlyList<WorkName> All { get; }

    private WorkNames(IReadOnlyList<WorkName> all) => All = all;

    /// <summary>The names in order; a later copy of an earlier name (ignoring case) is dropped, as are blanks.</summary>
    public static WorkNames Of(IEnumerable<WorkName?>? names)
    {
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<WorkName>();
        foreach (var name in names ?? [])
        {
            var text = name?.Text?.Trim();
            if (string.IsNullOrEmpty(text) || !seen.Add(text)) continue;
            list.Add(name! with { Text = text });
        }
        return new(list);
    }

    /// <summary>
    /// Names known only as a title and unlabelled aliases (rows saved before names were labelled): the title is English,
    /// a CJK/kana/hangul alias is Native, another Latin alias is a Synonym (an AniList one listed before its native name
    /// is the Romaji), and any other script is Original.
    /// </summary>
    public static WorkNames Legacy(string? title, IEnumerable<string?>? aliases, string? provider = null)
    {
        var names = new List<WorkName>();
        if (!string.IsNullOrWhiteSpace(title)) names.Add(new(title, IsNative(title) ? WorkNameKind.Native : WorkNameKind.English));
        var anilist = string.Equals(provider, "anilist", StringComparison.OrdinalIgnoreCase);
        var nativeSeen = false;
        var romajiSeen = false;
        foreach (var alias in aliases ?? [])
        {
            if (string.IsNullOrWhiteSpace(alias) || string.Equals(alias.Trim(), title?.Trim(), StringComparison.OrdinalIgnoreCase)) continue;
            var kind = Classify(alias);
            if (kind == WorkNameKind.Native) nativeSeen = true;
            else if (kind == WorkNameKind.Synonym && anilist && !nativeSeen && !romajiSeen) { kind = WorkNameKind.Romaji; romajiSeen = true; }
            names.Add(new(alias, kind));
        }
        return Of(names);
    }

    /// <summary>A provider record's names: its labelled names when it has them, else its title and aliases.</summary>
    public static WorkNames Of(MediaMetadata metadata) =>
        metadata.Names is { Count: > 0 } labelled ? Of(labelled) : Legacy(metadata.Title, metadata.Aliases, metadata.Source);

    /// <summary>A stored work's names (<c>Work.NamesJson</c>), or just its title when it has none.</summary>
    public static WorkNames Read(string? json, string? title)
    {
        if (!string.IsNullOrWhiteSpace(json))
        {
            try
            {
                if (JsonSerializer.Deserialize<List<WorkName>>(json, Json) is { Count: > 0 } stored) return Of(stored);
            }
            catch (JsonException) { }
        }
        return Legacy(title, null);
    }

    public string? ToJson() => All.Count == 0 ? null : JsonSerializer.Serialize(All, Json);

    public bool Has(WorkNameKind kind) => All.Any(n => n.Kind == kind);

    /// <summary>
    /// These names first (authoritative), then every other name of <paramref name="older"/> not already here. An older
    /// English, Romaji or Original label that the newer list does not repeat is kept as a Synonym.
    /// </summary>
    public WorkNames Merge(WorkNames? older) => older == null ? this
        : Of(All.Concat(older.All.Select(n => n.Kind is WorkNameKind.English or WorkNameKind.Romaji or WorkNameKind.Original
            ? n with { Kind = IsNative(n.Text) ? WorkNameKind.Native : WorkNameKind.Synonym } : n)));

    /// <summary>These names plus unlabelled extras (classified by script).</summary>
    public WorkNames With(IEnumerable<string?>? extras) =>
        Of(All.Concat((extras ?? []).Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => new WorkName(x!, Classify(x!)))));

    /// <summary>Every name, native script included, in stored order: what identifies a release as this work.</summary>
    public IReadOnlyList<string> MatchNames() => All.Select(n => n.Text).ToList();

    /// <summary>Every name except <paramref name="title"/> (the work's own title is searched and matched on its own).</summary>
    public IReadOnlyList<string> Others(string? title) =>
        All.Select(n => n.Text).Where(n => !string.Equals(n, title?.Trim(), StringComparison.OrdinalIgnoreCase)).ToList();

    /// <summary>
    /// The names to search, in order, unique by normalized text. Anime: English, then Romaji, then Latin-script
    /// synonyms. Anything else: English, then the original title when it is in Latin script. Native script is never
    /// searched; when nothing else qualifies, the first Latin-script name is.
    /// </summary>
    public IReadOnlyList<string> SearchNames(bool isAnime)
    {
        IEnumerable<WorkName> ordered = isAnime
            ? All.Where(n => n.Kind == WorkNameKind.English)
                .Concat(All.Where(n => n.Kind == WorkNameKind.Romaji))
                .Concat(All.Where(n => n.Kind == WorkNameKind.Synonym && IsLatin(n.Text)))
            : All.Where(n => n.Kind == WorkNameKind.English)
                .Concat(All.Where(n => n.Kind == WorkNameKind.Original && IsLatin(n.Text)));
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var output = ordered.Where(n => seen.Add(Normalize(n.Text))).Select(n => n.Text).ToList();
        if (output.Count == 0 && All.FirstOrDefault(n => IsLatin(n.Text)) is { } fallback) output.Add(fallback.Text);
        return output;
    }

    /// <summary>The comparison form of a name (the work-key slug).</summary>
    public static string Normalize(string text) => WorkKeySlug.Slugify(text);

    /// <summary>Script of an unlabelled name: CJK/kana/hangul is Native, Latin is a Synonym, any other script is Original.</summary>
    public static WorkNameKind Classify(string text) =>
        IsNative(text) ? WorkNameKind.Native : IsLatin(text) ? WorkNameKind.Synonym : WorkNameKind.Original;

    /// <summary>Whether the name has any Han, kana or hangul character.</summary>
    public static bool IsNative(string? text) => text != null && text.Any(c => c is
        >= '\u3040' and <= '\u30FF' or >= '\u31F0' and <= '\u31FF' or >= '\u3400' and <= '\u4DBF' or >= '\u4E00' and <= '\u9FFF'
        or >= '\uF900' and <= '\uFAFF' or >= '\uFF66' and <= '\uFF9F' or >= '\uAC00' and <= '\uD7AF' or >= '\u1100' and <= '\u11FF'
        or >= '\u3130' and <= '\u318F');

    /// <summary>Whether every letter of the name is Latin script (a name of digits and punctuation counts too).</summary>
    public static bool IsLatin(string? text) => !string.IsNullOrWhiteSpace(text) && text.All(c => !char.IsLetter(c)
        || c <= '\u024F' || c is >= '\u1E00' and <= '\u1EFF' or >= '\u2C60' and <= '\u2C7F' or >= '\uA720' and <= '\uA7FF'
        or >= '\uFF21' and <= '\uFF3A' or >= '\uFF41' and <= '\uFF5A');
}
