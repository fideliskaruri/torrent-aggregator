using System.Text.Json;

namespace TorrentFlow.Library.Features.Common;

/// <summary>
/// One entry of an engine row's verified file list. <see cref="Path"/> is the absolute on-disk location, or null when the
/// row records none (a duplicate the content layout discarded). <see cref="Name"/> is the file name, known either way.
/// </summary>
internal readonly record struct VerifiedFile(string? Path, string? Name, long Size);

/// <summary>
/// Reads <c>EngineTorrent.VerifiedFilesJson</c> in both shapes: the TS engine stores an absolute <c>path</c>, while the .NET
/// engine stores the torrent-relative <c>path</c> plus the absolute <c>fullPath</c>. The content layout rewrites
/// <c>fullPath</c> to the moved location and nulls it for discarded junk, keeping the original <c>path</c>. Like the engine,
/// the location is <c>fullPath</c>, else <c>path</c> only when it is rooted.
/// </summary>
internal static class VerifiedFiles
{
    /// <summary>The recorded files, or null when the JSON is malformed.</summary>
    public static IReadOnlyList<VerifiedFile>? Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.ValueKind != JsonValueKind.Array) return null;
            return doc.RootElement.EnumerateArray().Select(Entry).ToList();
        }
        catch (JsonException) { return null; }
    }

    private static VerifiedFile Entry(JsonElement file)
    {
        if (file.ValueKind != JsonValueKind.Object) return default;
        var full = Text(file, "fullPath");
        var path = Text(file, "path");
        var location = full ?? (path != null && System.IO.Path.IsPathRooted(path) ? path : null);
        var name = (full ?? path)?.Split(['\\', '/']).LastOrDefault(part => part.Length > 0);
        var size = file.TryGetProperty("size", out var value) && value.TryGetInt64(out var bytes) ? bytes : 0;
        return new(location, name, size);
    }

    private static string? Text(JsonElement file, string name) =>
        file.TryGetProperty(name, out var value) && value.ValueKind == JsonValueKind.String && value.GetString() is { Length: > 0 } text ? text : null;

    /// <summary>True only when the file system says the path is gone; permission or I/O trouble is not proof of absence.</summary>
    public static bool ConfirmedMissing(string path)
    {
        try { _ = File.GetAttributes(path); return false; }
        catch (FileNotFoundException) { return true; }
        catch (DirectoryNotFoundException) { return true; }
        catch (IOException) { return false; }
        catch (UnauthorizedAccessException) { return false; }
        catch (ArgumentException) { return false; }
    }
}
