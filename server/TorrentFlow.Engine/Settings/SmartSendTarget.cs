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
        // Anime libraries sit flat beside the others; a manual non-anime category lays out as that category.
        var anime = kind == "anime" && string.Equals(cat, categorizer.CategoryLabel("anime", config.Categories), StringComparison.OrdinalIgnoreCase);
        if (kind == "anime" && !anime) kind = string.Equals(cat, categorizer.CategoryLabel("movies", config.Categories), StringComparison.OrdinalIgnoreCase) ? "movies" : "tv";
        if (savePath is null && anime && MediaFolders.AnimeRoot(config.BaseDownloadPath, config.PathRules.GetValueOrDefault(cat)) is { } animeRoot)
            savePath = ResolveSmartPath(categorizer, animeRoot, kind, "", name, options.Metadata, animeRoot.Contains('\\') ? "\\" : sepGuess);
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
        var root = work.Anime ? MediaFolders.AnimeRoot(config.BaseDownloadPath, rule) : rule ?? ClientConfig.NullIfBlank(config.BaseDownloadPath?.Trim());
        if (root is null) return ClientSettingsStore.ResolveDownloadTarget(config, category, null);
        return new(category, MediaFolders.Path(root, work.Anime || rule is not null ? "" : category, kind, work.Film, MediaFolders.Name(work.Title), work.Year,
            work.Season is int season ? MediaFolders.Season(season) : null, root.Contains('\\') ? "\\" : "/"));
    }

    /// <summary>A send with no catalog work (search page, automation): the show and season are read from the release name.</summary>
    public static string ResolveSmartPath(ISmartCategorizer categorizer, string basePath, string kind, string category,
        string? title, MediaMetadata? metadata, string sep)
    {
        var showTitle = FirstNonEmpty(title, metadata?.Title);
        var show = ShowKinds.Contains(kind) && showTitle is not null ? categorizer.ShowFolder(showTitle, metadata) : null;
        var film = kind == "movies" || kind == "anime" && categorizer.IsFilm(title ?? "", metadata);
        var season = !film && !string.IsNullOrEmpty(title) ? categorizer.SeasonFolder(title) : null;
        return MediaFolders.Path(basePath, category, kind, film, show, film ? MediaFolders.FilmYear(title, metadata?.Year) : null, season, sep);
    }
    private static string? FirstNonEmpty(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
