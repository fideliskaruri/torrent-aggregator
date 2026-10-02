using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>
/// The tracks the engine's header probe read from a release's file, kept in the MediaProbe table (one row per hash and
/// torrent file path). The engine writes them; the picker and the swap dialog read them back, so a release whose header
/// was read is judged on its own tracks everywhere (docs/release-language.md).
/// </summary>
public static class MediaProbeTracks
{
    /// <summary>The row shape the header probe writes; rows of another version are not read back as header tracks.</summary>
    public const int Version = 1;
    private const string Source = "header";
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { Converters = { new JsonStringEnumConverter() } };

    public static string Write(IReadOnlyList<MediaTrack> tracks) => JsonSerializer.Serialize(new Stored(Source, tracks), Json);

    /// <summary>The header tracks a row holds; null for another kind of row or one that can't be read.</summary>
    public static IReadOnlyList<MediaTrack>? Read(MediaProbe? row)
    {
        if (row is not { ProbeVersion: Version, StreamsJson: { Length: > 0 } json }) return null;
        try { return JsonSerializer.Deserialize<Stored>(json, Json) is { Source: Source, Tracks: { } tracks } ? tracks : null; }
        catch (JsonException) { return null; }
    }

    /// <summary>Every header read kept for these releases: hash, then torrent file path, then its tracks.</summary>
    public static async Task<Dictionary<string, Dictionary<string, IReadOnlyList<MediaTrack>>>> ForAsync(TorrentFlowDbContext db,
        IEnumerable<string> hashes, CancellationToken ct)
    {
        var wanted = hashes.Where(h => !string.IsNullOrWhiteSpace(h)).Select(h => h.ToLowerInvariant()).Distinct().ToList();
        var found = new Dictionary<string, Dictionary<string, IReadOnlyList<MediaTrack>>>(StringComparer.OrdinalIgnoreCase);
        if (wanted.Count == 0) return found;
        var rows = await db.MediaProbes.AsNoTracking().Where(p => wanted.Contains(p.InfoHash) && p.ProbeVersion == Version).ToListAsync(ct);
        foreach (var row in rows)
            if (Read(row) is { } tracks)
            {
                if (!found.TryGetValue(row.InfoHash, out var files))
                    found[row.InfoHash] = files = new(StringComparer.Ordinal);
                files[row.FilePath] = tracks;
            }
        return found;
    }

    private sealed record Stored(string Source, IReadOnlyList<MediaTrack> Tracks);
}
