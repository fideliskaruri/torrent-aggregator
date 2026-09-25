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

    /// <summary>&lt;base&gt;/&lt;category&gt;/&lt;show&gt;/Season NN; an empty category means base is already the category root.</summary>
    public static string ResolveSmartPath(ISmartCategorizer categorizer, string basePath, string kind, string category,
        string? title, MediaMetadata? metadata, string sep)
    {
        var root = (basePath ?? "").TrimEnd('/', '\\');
        var cat = (category ?? "").Trim('/', '\\');
        if (root.Length == 0) return cat;
        var path = cat.Length > 0 ? $"{root}{sep}{cat}" : root;

        var showTitle = FirstNonEmpty(title, metadata?.Title);
        if (ShowKinds.Contains(kind) && showTitle is not null && categorizer.ShowFolder(showTitle, metadata) is { Length: > 0 } show)
        {
            path = $"{path}{sep}{show}";
            if (kind is "tv" or "anime" && !string.IsNullOrEmpty(title) && categorizer.SeasonFolder(title) is { Length: > 0 } season)
                path = $"{path}{sep}{season}";
        }
        return path;
    }

    private static string? FirstNonEmpty(params string?[] values) => values.FirstOrDefault(v => !string.IsNullOrEmpty(v));
}
