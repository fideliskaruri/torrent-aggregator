using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Common;

namespace TorrentFlow.Library.Features.Storage;

internal static class StorageFacts
{
    internal const long UnknownIncomingReserve = StorageEstimate.DefaultIncomingReserveBytes;

    /// <summary>
    /// Storage refusal payload for grab/title/request surfaces.
    /// <paramref name="expected"/> is the chosen release only; queued reservations stay in their own field.
    /// </summary>
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
        var incoming = StorageEstimate.FromRelease(expected);
        var estimated = StorageEstimate.IsEstimated(expected);
        var queued = Math.Max(0, reserved);
        // Prefer a message that already separates the figures; rebuild cap copy when the engine only sent a limit.
        var text = limit == "cap"
            ? StorageEstimate.CapMessage(used, settings.MaxStorageBytes ?? 0, incoming, estimated, queued)
            : message;
        return LibraryJson.Object(("limit", limit), ("overridable", limit is "cap" or "reserve"), ("message", text),
            ("settingsHref", "/settings?tab=folders&focus=cap"), ("usedBytes", used), ("capBytes", settings.MaxStorageBytes),
            ("freeBytes", free), ("incomingBytes", incoming), ("incomingEstimated", estimated),
            ("reservedQueuedBytes", queued));
    }
}
