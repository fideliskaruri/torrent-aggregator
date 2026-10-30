using System.Collections.Immutable;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Library.Jellyfin;

public sealed class JellyfinPathMapper
{
    private readonly ImmutableArray<JellyfinPathMapping> mappings;

    public JellyfinPathMapper(IEnumerable<JellyfinPathMapping>? mappings)
    {
        this.mappings = [.. (mappings ?? []).Where(mapping =>
            !string.IsNullOrWhiteSpace(mapping.From) && !string.IsNullOrWhiteSpace(mapping.To))
            .OrderByDescending(mapping => Normalize(mapping.From).Length)];
    }

    public string? ToJellyfin(string localPath) => Map(localPath, reverse: false);
    public string? ToLocal(string jellyfinPath) => Map(jellyfinPath, reverse: true);
    public static bool PathsEqual(string first, string second) =>
        string.Equals(Normalize(first), Normalize(second), StringComparison.OrdinalIgnoreCase);

    private string? Map(string path, bool reverse)
    {
        if (string.IsNullOrWhiteSpace(path)) return null;
        if (mappings.IsEmpty) return path;
        foreach (var mapping in mappings)
        {
            var source = reverse ? mapping.To : mapping.From;
            var destination = reverse ? mapping.From : mapping.To;
            if (!TrySuffix(path, source, out var suffix)) continue;
            var destinationSeparator = Separator(destination);
            var tail = suffix.TrimStart('\\', '/').Replace('\\', destinationSeparator).Replace('/', destinationSeparator);
            var prefix = destination.TrimEnd('\\', '/');
            return tail.Length == 0 ? destination : prefix + destinationSeparator + tail;
        }

        // With mappings set, an unmapped path is not reachable from the other side (Jellyfin may be on another PC).
        return null;
    }

    private static bool TrySuffix(string path, string prefix, out string suffix)
    {
        var normalizedPath = Normalize(path);
        var normalizedPrefix = Normalize(prefix);
        const StringComparison comparison = StringComparison.OrdinalIgnoreCase;
        if (normalizedPath.Equals(normalizedPrefix, comparison))
        {
            suffix = "";
            return true;
        }
        var boundaryPrefix = normalizedPrefix.EndsWith('/') ? normalizedPrefix : normalizedPrefix + "/";
        if (normalizedPath.StartsWith(boundaryPrefix, comparison))
        {
            suffix = normalizedPath[normalizedPrefix.Length..];
            return true;
        }
        suffix = "";
        return false;
    }

    private static string Normalize(string path)
    {
        var normalized = Regex.Replace(path.Replace('\\', '/'), "/+", "/");
        return normalized.Length > 1 ? normalized.TrimEnd('/') : normalized;
    }

    private static char Separator(string path) => path.Contains('\\') && !path.Contains('/') ? '\\' : '/';
}
