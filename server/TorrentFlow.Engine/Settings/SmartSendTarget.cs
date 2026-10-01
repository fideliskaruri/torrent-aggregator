using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;

namespace TorrentFlow.Engine.Settings;

public sealed record SmartSendOptions
{
    public string? Name { get; init; }
    public IReadOnlyList<string>? Tags { get; init; }
    public MediaMetadata? Metadata { get; init; }
    public string? Source { get; init; }
    public string? SearchCategory { get; init; }
    public bool CategoryManual { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
}

public sealed record SmartSendTarget(string? Category, string? SavePath, string Kind, SmartCategory Smart);

/// <summary>resolveSmartSendTarget + resolveSmartPath (smart-target.ts, smart-category.ts).</summary>
public static class SmartSendTargets
{
    private static readonly HashSet<string> ShowKinds = ["tv", "anime", "movies"];

    public static SmartSendTarget Resolve(ClientConfig config, ISmartCategorizer? categorizer, SmartSendOptions options)
    {
        if (categorizer is null)
        {
            var plain = ClientSettingsStore.ResolveDownloadTarget(config, options.Category ?? options.SearchCategory, options.SavePath);
            var plainKind = (plain.Category ?? "other").ToLowerInvariant();
            return new(plain.Category, plain.SavePath, plainKind, new(plainKind, plain.Category ?? "Other",
                options.CategoryManual ? "high" : options.SearchCategory is not null ? "medium" : "low"));
        }

        var name = options.Name ?? "";
        var smart = categorizer.Categorize(new(name, options.Tags ?? [], options.Metadata, options.Source, options.SearchCategory), config.Categories);
        var cat = options.CategoryManual && !string.IsNullOrEmpty(options.Category) ? options.Category : smart.Category;
        var kind = smart.Kind;
        var sepGuess = (FirstNonEmpty(config.BaseDownloadPath, config.PathRules.GetValueOrDefault(cat)) ?? "").Contains('\\') ? "\\" : "/";

        var savePath = string.IsNullOrEmpty(options.SavePath) ? null : options.SavePath;
        if (savePath is null && config.PathRules.GetValueOrDefault(cat)?.Trim() is { Length: > 0 } ruleRoot)
            savePath = ResolveSmartPath(categorizer, ruleRoot, kind, "", name, options.Metadata, ruleRoot.Contains('\\') ? "\\" : sepGuess);
        if (savePath is null && config.BaseDownloadPath?.Trim() is { Length: > 0 } baseDir)
            savePath = ResolveSmartPath(categorizer, baseDir, kind, cat, name, options.Metadata, baseDir.Contains('\\') ? "\\" : sepGuess);
        savePath ??= ClientSettingsStore.ResolveDownloadTarget(config, cat, null).SavePath;

        return new(cat, savePath, kind, smart);
    }

    /// <summary>
    /// The save path of a catalog work (every grab: film, episode, season pack, request, queue, picked release). The show
    /// folder is the catalog title the UI shows and the season is the catalog's own, never read from the torrent's name.
    /// </summary>
    public static DownloadTarget ForWork(ClientConfig config, ISmartCategorizer categorizer, WorkPlacement work)
    {
        var kind = work.Anime ? "anime" : work.Film ? "movies" : "tv";
        var category = categorizer.CategoryLabel(kind, config.Categories);
        var rule = ClientConfig.NullIfBlank(config.PathRules.GetValueOrDefault(category)?.Trim());
        var root = rule ?? ClientConfig.NullIfBlank(config.BaseDownloadPath?.Trim());
        if (root is null) return ClientSettingsStore.ResolveDownloadTarget(config, category, null);
        return new(category, BuildPath(root, rule is null ? category : "", kind, work.Film, MediaFolders.Name(work.Title), work.Year,
            work.Season is int season ? MediaFolders.Season(season) : null, root.Contains('\\') ? "\\" : "/"));
    }

    /// <summary>A send with no catalog work (search page, automation): the show and season are read from the release name.</summary>
    public static string ResolveSmartPath(ISmartCategorizer categorizer, string basePath, string kind, string category,
        string? title, MediaMetadata? metadata, string sep)
    {
        var showTitle = FirstNonEmpty(title, metadata?.Title);
        var show = ShowKinds.Contains(kind) && showTitle is not null ? categorizer.ShowFolder(showTitle, metadata) : null;
        var film = kind == "movies" || kind == "anime" && metadata?.MediaType == "movie";
        var season = !film && !string.IsNullOrEmpty(title) ? categorizer.SeasonFolder(title) : null;
        return BuildPath(basePath, category, kind, film, show, film ? MovieYear(title, metadata) : null, season, sep);
    }

    /// <summary>
    /// The one folder layout: &lt;root&gt;/&lt;category&gt;/&lt;show&gt;/Season NN for series and &lt;root&gt;/&lt;category&gt;/&lt;Title (Year)&gt;
    /// for films. Anime takes "Anime Series" or "Anime Movies" in place of its category folder, under the download root
    /// or under the Anime path rule. An empty category means the root is already the category's own folder.
    /// </summary>
    private static string BuildPath(string root, string category, string kind, bool film, string? show, int? year, string? season, string sep)
    {
        root = (root ?? "").TrimEnd('/', '\\');
        var cat = (category ?? "").Trim('/', '\\');
        if (root.Length == 0) return cat;
        var path = kind == "anime" ? $"{root}{sep}{(film ? MediaFolders.AnimeMovies : MediaFolders.AnimeSeries)}"
            : cat.Length > 0 ? $"{root}{sep}{cat}" : root;
        if (string.IsNullOrEmpty(show)) return path;
        if (film && year is { } y && !show.Contains($"({y})", StringComparison.Ordinal)) show = $"{show} ({y})";
        path = $"{path}{sep}{show}";
        return !film && !string.IsNullOrEmpty(season) ? $"{path}{sep}{season}" : path;
    }
    /// <summary>Prefer catalog year; otherwise the first 19xx/20xx token still present in the release name.</summary>
    internal static int? MovieYear(string? title, MediaMetadata? metadata)
    {
        if (metadata?.Year is int y && y is >= 1870 and <= 2100) return y;
        if (string.IsNullOrWhiteSpace(title)) return null;
        var m = System.Text.RegularExpressions.Regex.Match(title, @"\b((?:19|20)\d{2})\b");
        return m.Success && int.TryParse(m.Groups[1].Value, out var year) && year is >= 1870 and <= 2100 ? year : null;
    }

    private static string? FirstNonEmpty(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
