using System.Text.Json;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Library.Features.Grabs;

internal sealed record SmartSendTarget(string? Category, string? SavePath);

internal static class SmartSendTargets
{
    private static readonly HashSet<string> ShowKinds = ["tv", "anime", "movies"];

    public static SmartSendTarget Resolve(
        ClientSetting settings,
        ISmartCategorizer? categorizer,
        string name,
        string? mediaType,
        string? source,
        string? searchCategory)
    {
        if (categorizer is null)
        {
            var resolvedCategory = FirstNonEmpty(searchCategory, settings.Category);
            return new(resolvedCategory, ResolveDownloadTarget(settings, resolvedCategory, null));
        }

        var smart = categorizer.Categorize(
            new(name, [], MetadataFrom(mediaType, name), source, searchCategory),
            ParseCategories(settings.Categories));
        var category = smart.Category;
        var separator = (FirstNonEmpty(settings.BaseDownloadPath, settings.SavePath) ?? "").Contains('\\') ? "\\" : "/";
        var savePath = ResolveSmartPath(
            categorizer,
            settings.PathRules == null ? null : ParseRules(settings.PathRules).GetValueOrDefault(category ?? ""),
            smart.Kind,
            "",
            name,
            MetadataFrom(mediaType, name),
            separator);
        if (savePath is null && settings.BaseDownloadPath?.Trim() is { Length: > 0 } baseDir)
        {
            savePath = ResolveSmartPath(
                categorizer,
                baseDir,
                smart.Kind,
                category ?? "",
                name,
                MetadataFrom(mediaType, name),
                baseDir.Contains('\\') ? "\\" : separator);
        }
        savePath ??= ResolveDownloadTarget(settings, category, null);
        return new(category, savePath);
    }

    private static MediaMetadata? MetadataFrom(string? mediaType, string? title)
    {
        var type = (mediaType ?? "").Trim().ToLowerInvariant();
        var name = (title ?? "").Trim();
        if (type is not ("anime" or "movie" or "tv") || name.Length == 0) return null;
        return new() { Source = type == "anime" ? "anilist" : "tmdb", MediaType = type, ExternalId = "", Title = name };
    }

    private static string? ResolveDownloadTarget(ClientSetting settings, string? categoryOverride, string? savePathOverride)
    {
        var category = FirstNonEmpty(categoryOverride, settings.Category);
        var savePath = FirstNonEmpty(savePathOverride, null);
        if (savePath is null && category is not null && ParseRules(settings.PathRules).TryGetValue(category, out var rule))
            savePath = rule;
        if (savePath is null && category is not null && FirstNonEmpty(settings.BaseDownloadPath, null) is { } baseDir)
            savePath = JoinDownloadPath(baseDir, category);
        savePath ??= FirstNonEmpty(settings.SavePath, settings.BaseDownloadPath);
        return savePath;
    }

    private static string JoinDownloadPath(string @base, string category)
    {
        var b = @base.TrimEnd('/', '\\');
        var cat = category.Trim('/', '\\');
        if (b.Length == 0) return cat;
        if (cat.Length == 0) return b;
        var sep = b.Contains('\\') ? '\\' : '/';
        return $"{b}{sep}{cat}";
    }

    private static IReadOnlyList<string> ParseCategories(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<string?>>(json)?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!.Trim()).ToArray() ?? [];
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static Dictionary<string, string> ParseRules(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? [];
            return raw.Where(kv => kv.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(kv.Value.GetString()))
                .ToDictionary(kv => kv.Key, kv => kv.Value.GetString()!);
        }
        catch (JsonException)
        {
            return [];
        }
    }

    private static string? ResolveSmartPath(
        ISmartCategorizer categorizer,
        string? basePath,
        string kind,
        string category,
        string? title,
        MediaMetadata? metadata,
        string sep)
    {
        if (string.IsNullOrWhiteSpace(basePath)) return null;
        var root = basePath.TrimEnd('/', '\\');
        var cat = (category ?? "").Trim('/', '\\');
        if (root.Length == 0) return cat.Length == 0 ? null : cat;
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
