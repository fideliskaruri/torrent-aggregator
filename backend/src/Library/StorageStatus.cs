namespace TorrentFlow.Library;

public sealed record StoragePathStatus(bool Online, long? FreeBytes, DateTimeOffset CheckedAt);

public interface IStorageStatus
{
    bool IsOnline(string rootPath);
    string Label(string rootPath);
    StoragePathStatus Status(string rootPath);
    void Update(string rootPath, bool online, long? freeBytes);
}

public sealed class StorageStatus : IStorageStatus
{
    private readonly Dictionary<string, StoragePathStatus> states = new(StringComparer.OrdinalIgnoreCase);
    private readonly object gate = new();

    public bool IsOnline(string rootPath) => Status(rootPath).Online;

    public StoragePathStatus Status(string rootPath)
    {
        lock (gate)
            if (states.TryGetValue(Key(rootPath), out var status)) return status;
        // Before the watcher's first pass, answer from the disk so startup never treats every drive as unplugged.
        bool exists;
        try { exists = Directory.Exists(rootPath); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { exists = false; }
        return new(exists, null, DateTimeOffset.MinValue);
    }

    public void Update(string rootPath, bool online, long? freeBytes)
    {
        lock (gate) states[Key(rootPath)] = new(online, online ? freeBytes : null, DateTimeOffset.UtcNow);
    }

    public string Label(string rootPath)
    {
        try
        {
            var root = Path.GetPathRoot(rootPath);
            return root is { Length: 3 } && char.IsLetter(root[0]) && root[1] == ':' &&
                (root[2] == Path.DirectorySeparatorChar || root[2] == Path.AltDirectorySeparatorChar)
                ? root.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                : rootPath;
        }
        catch
        {
            return rootPath;
        }
    }

    private static string Key(string path)
    {
        try { return Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
        catch { return path; }
    }
}
