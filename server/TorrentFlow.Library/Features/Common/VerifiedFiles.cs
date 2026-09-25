using System.Text.Json;

namespace TorrentFlow.Library.Features.Common;

/// <summary>One entry of an engine row's verified file list. <see cref="Path"/> is absolute when the row recorded one.</summary>
internal readonly record struct VerifiedFile(string? Path, long Size);

/// <summary>
/// Reads <c>EngineTorrent.VerifiedFilesJson</c> in both shapes: the TS engine stores an absolute <c>path</c>, while the .NET
/// engine stores the torrent-relative <c>path</c> plus the absolute <c>fullPath</c>. Disk checks need the absolute one.
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
            return doc.RootElement.EnumerateArray().Select(f => new VerifiedFile(
                f.ValueKind == JsonValueKind.Object ? Text(f, "fullPath") ?? Text(f, "path") : null,
                f.ValueKind == JsonValueKind.Object && f.TryGetProperty("size", out var size) && size.TryGetInt64(out var bytes) ? bytes : 0)).ToList();
        }
        catch (JsonException) { return null; }
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
