using System.Collections.Concurrent;

namespace TorrentFlow.Library;

public interface IStorageStatus
{
    bool IsOnline(string rootPath);
    string Label(string rootPath);
}

public sealed class StorageStatus : IStorageStatus
{
    private static readonly TimeSpan CacheDuration = TimeSpan.FromSeconds(2);
    private readonly ConcurrentDictionary<string, (DateTimeOffset CheckedAt, bool Online)> cache =
        new(StringComparer.OrdinalIgnoreCase);

    public bool IsOnline(string rootPath)
    {
        try
        {
            var now = DateTimeOffset.UtcNow;
            if (cache.TryGetValue(rootPath, out var cached) && now - cached.CheckedAt < CacheDuration)
                return cached.Online;
            var online = Directory.Exists(rootPath);
            cache[rootPath] = (now, online);
            return online;
        }
        catch
        {
            cache[rootPath] = (DateTimeOffset.UtcNow, false);
            return false;
        }
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
}
