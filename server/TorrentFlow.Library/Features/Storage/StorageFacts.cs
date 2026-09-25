using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Storage;

internal static class StorageFacts
{
    internal const long UnknownIncomingReserve = 2L * 1024 * 1024 * 1024;
    public static object Refusal(ClientSetting settings, string limit, string message, long? expected, long reserved)
    {
        var root = settings.BaseDownloadPath ?? settings.SavePath;
        long used = 0;
        long? free = null;
        if (!string.IsNullOrWhiteSpace(root))
        {
            try
            {
                free = new DriveInfo(Path.GetPathRoot(Path.GetFullPath(root))!).AvailableFreeSpace;
                var options = new EnumerationOptions { RecurseSubdirectories = true, IgnoreInaccessible = false,
                    AttributesToSkip = FileAttributes.ReparsePoint };
                foreach (var file in new DirectoryInfo(root).EnumerateFiles("*", options).Take(200000))
                    used += file.Length;
            }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
            catch (ArgumentException) { }
        }
        var incoming = expected is > 0 ? expected.Value : UnknownIncomingReserve;
        return LibraryJson.Object(("limit", limit), ("overridable", limit is "cap" or "reserve"), ("message", message),
            ("settingsHref", "/settings?tab=folders&focus=cap"), ("usedBytes", used), ("capBytes", settings.MaxStorageBytes),
            ("freeBytes", free), ("incomingBytes", incoming + Math.Max(0, reserved)), ("incomingEstimated", expected is not > 0));
    }
}
