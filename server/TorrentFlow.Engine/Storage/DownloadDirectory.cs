namespace TorrentFlow.Engine.Storage;

internal static class DownloadDirectory
{
    public static string? Prepare(string path)
    {
        try
        {
            Directory.CreateDirectory(path);
            // Existing directories can be readable but not writable. Never probe by opening a payload file.
            using var probe = new FileStream(Path.Combine(path, $".torrentflow-write-{Guid.NewGuid():N}"),
                FileMode.CreateNew, FileAccess.Write, FileShare.None, 1, FileOptions.DeleteOnClose);
            probe.WriteByte(0);
            probe.Flush(flushToDisk: true);
            return null;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or NotSupportedException or ArgumentException
            or System.Security.SecurityException)
        {
            return "Cannot write to the download folder. Choose a writable savePath or grant TorrentFlow write access to it.";
        }
    }
}
