namespace TorrentFlow.Library;

public static class StorageIdentity
{
    public static string MarkerPath(string rootPath) => Path.Combine(rootPath, ".torrentflow-root");

    public static string MarkerContents(string rootId, string volumeSerial) => $"{rootId}\n{volumeSerial}\n";

    public static void WriteMarker(string rootPath, string rootId, string volumeSerial) =>
        File.WriteAllText(MarkerPath(rootPath), MarkerContents(rootId, volumeSerial));

    public static bool MarkerMatches(string rootPath, string rootId, string volumeSerial)
    {
        try { return File.ReadAllText(MarkerPath(rootPath)) == MarkerContents(rootId, volumeSerial); }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException) { return false; }
    }
}
