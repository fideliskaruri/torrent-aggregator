using System.Text.Json;

namespace TorrentFlow.Engine.Layout;

internal sealed class CompletedLayoutManifestStore
{
    /// <summary>
    /// <paramref name="Indexed"/> holds each torrent file's path by file index (null for a discarded file); older entries
    /// lack it. <paramref name="Downloading"/> marks paths placed at add time, before every file exists.
    /// </summary>
    private sealed record Entry(string Hash, string SavePath, string[] Files, string?[]? Indexed = null, bool Downloading = false);

    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web);
    private readonly string _path;
    private readonly object _gate = new();
    private Dictionary<string, Entry> _entries = new(StringComparer.OrdinalIgnoreCase);

    public CompletedLayoutManifestStore(string path)
    {
        _path = path;
        Load();
    }

    private string Key(string hash, string savePath) => $"{hash.ToLowerInvariant()}|{Path.GetFullPath(savePath)}";

    private void Load()
    {
        try
        {
            if (!File.Exists(_path))
            {
                _entries = new(StringComparer.OrdinalIgnoreCase);
                return;
            }
            var json = File.ReadAllText(_path);
            var parsed = JsonSerializer.Deserialize<List<Entry>>(json, JsonOptions) ?? [];
            _entries = parsed
                .Where(e => !string.IsNullOrWhiteSpace(e.Hash) && !string.IsNullOrWhiteSpace(e.SavePath) && e.Files.Length > 0)
                .ToDictionary(e => Key(e.Hash, e.SavePath), e => e, StringComparer.OrdinalIgnoreCase);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            _entries = new(StringComparer.OrdinalIgnoreCase);
        }
    }

    /// <summary>Best effort: a manifest that fails to persist only costs a re-download on a later re-add.</summary>
    private void Save()
    {
        var tmp = _path + "." + Environment.ProcessId + ".tmp";
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(_path)!);
            var json = JsonSerializer.Serialize(_entries.Values.OrderBy(e => e.Hash, StringComparer.OrdinalIgnoreCase).ToList(), JsonOptions);
            File.WriteAllText(tmp, json);
            File.Move(tmp, _path, overwrite: true);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            try { File.Delete(tmp); } catch (Exception cleanup) when (cleanup is IOException or UnauthorizedAccessException) { }
        }
    }

    /// <summary>Records where each file of a laid-out torrent lives, by torrent file index (null for a discarded file).</summary>
    public void Remember(string hash, string? savePath, IReadOnlyList<string?> indexed) => Record(hash, savePath, indexed, downloading: false);

    /// <summary>Records where a download writes each file when it does not use its release folder.</summary>
    public void Place(string hash, string? savePath, IReadOnlyList<string?> indexed) => Record(hash, savePath, indexed, downloading: true);

    /// <summary>The paths recorded by <see cref="Place"/> for a download still in progress, else null.</summary>
    public string?[]? PlacedPaths(string hash, string? savePath)
    {
        if (string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(savePath)) return null;
        lock (_gate)
            return _entries.TryGetValue(Key(hash, savePath), out var entry) && entry.Downloading && entry.Indexed is { Length: > 0 } indexed
                ? indexed.ToArray() : null;
    }

    private void Record(string hash, string? savePath, IReadOnlyList<string?> indexed, bool downloading)
    {
        if (string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(savePath)) return;
        var fullPath = Path.GetFullPath(savePath.Trim());
        var paths = indexed.Select(f => string.IsNullOrWhiteSpace(f) ? null : Path.GetFullPath(f.Trim())).ToArray();
        var record = paths.Where(f => f is not null).Select(f => f!).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
        if (record.Length == 0) return;
        lock (_gate)
        {
            _entries[Key(hash, fullPath)] = new Entry(hash.ToLowerInvariant(), fullPath, record, paths, downloading);
            Save();
        }
    }

    /// <summary>
    /// The recorded per-file paths of a laid-out torrent when every recorded file is still on disk, else null. A re-add
    /// points the client at these so it re-checks the files where they are instead of downloading them again.
    /// </summary>
    public string?[]? IndexedPaths(string hash, string? savePath)
    {
        if (string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(savePath)) return null;
        lock (_gate)
        {
            if (!_entries.TryGetValue(Key(hash, savePath), out var entry) || entry.Indexed is not { Length: > 0 } indexed) return null;
            return indexed.All(p => p is null || File.Exists(p)) ? indexed.ToArray() : null;
        }
    }

    public void Forget(string hash, string? savePath = null)
    {
        if (string.IsNullOrWhiteSpace(hash)) return;
        lock (_gate)
        {
            var keys = _entries.Keys.Where(k => k.StartsWith(hash.ToLowerInvariant() + "|", StringComparison.OrdinalIgnoreCase)).ToList();
            if (savePath is not null)
            {
                var key = Key(hash, savePath);
                keys = [key];
            }
            var changed = false;
            foreach (var key in keys)
                changed |= _entries.Remove(key);
            if (changed) Save();
        }
    }

    public bool CanReuseFlatLayout(string hash, string? savePath, out IReadOnlyList<string> files)
    {
        files = [];
        if (string.IsNullOrWhiteSpace(hash) || string.IsNullOrWhiteSpace(savePath)) return false;
        lock (_gate)
        {
            // An indexed entry may hold files moved aside or kept nested, so its flat torrent paths can belong to a neighbour.
            if (!_entries.TryGetValue(Key(hash, savePath), out var entry) || entry.Indexed is not null) return false;
            var existing = new List<string>();
            foreach (var file in entry.Files)
            {
                if (!File.Exists(file)) return false;
                existing.Add(file);
            }
            files = existing;
            return existing.Count > 0;
        }
    }
}
