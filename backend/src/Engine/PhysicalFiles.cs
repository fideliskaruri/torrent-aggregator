using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
using MonoTorrent;
using MonoTorrent.Client;

namespace TorrentFlow.Engine;

internal static class PhysicalFiles
{
    internal static long AllocatedBytes(string path)
    {
        if (!OperatingSystem.IsWindows() || !File.Exists(path)) return 0;
        var low = GetCompressedFileSize(path, out var high);
        return low == uint.MaxValue && Marshal.GetLastPInvokeError() != 0 ? 0 : ((long)high << 32) | low;
    }

    internal static void PrepareBoundaries(TorrentManager manager)
    {
        if (!OperatingSystem.IsWindows() || !manager.HasMetadata) return;
        var spans = manager.Files.Where(f => f.Priority != Priority.DoNotDownload)
            .Select(f => (Start: f.StartPieceIndex, End: f.EndPieceIndex)).ToArray();
        foreach (var file in manager.Files.Where(f => f.Priority == Priority.DoNotDownload && f.Length > 0))
        {
            if (!spans.Any(s => s.Start <= file.EndPieceIndex && file.StartPieceIndex <= s.End) || File.Exists(file.FullPath)) continue;
            Directory.CreateDirectory(Path.GetDirectoryName(file.FullPath)!);
            using var stream = new FileStream(file.FullPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.ReadWrite);
            if (!DeviceIoControl(stream.SafeFileHandle, 0x000900C4, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero))
                throw new IOException("The filesystem cannot create sparse skipped-file boundaries.");
        }
    }

    internal static void PrepareProbeFiles(TorrentManager manager)
    {
        if (!OperatingSystem.IsWindows()) return;
        foreach (var file in manager.Files.Where(f => f.Priority != Priority.DoNotDownload))
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file.FullPath)!);
            using var stream = new FileStream(file.FullPath, FileMode.OpenOrCreate, FileAccess.ReadWrite, FileShare.ReadWrite);
            if (!DeviceIoControl(stream.SafeFileHandle, 0x000900C4, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero))
                throw new IOException("The filesystem cannot create sparse engine probe files.");
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetCompressedFileSizeW", SetLastError = true)]
    private static extern uint GetCompressedFileSize(string path, out uint high);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint code, IntPtr input, uint inputSize,
        IntPtr output, uint outputSize, out uint returned, IntPtr overlapped);
}
