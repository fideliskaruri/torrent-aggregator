using System.Runtime.InteropServices;

namespace TorrentFlow.Domain;

public static class PhysicalFileAllocation
{
    public static long AllocatedBytes(string path)
    {
        if (!OperatingSystem.IsWindows() || !File.Exists(path)) return 0;
        var low = GetCompressedFileSize(path, out var high);
        return low == uint.MaxValue && Marshal.GetLastPInvokeError() != 0 ? 0 : ((long)high << 32) | low;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetCompressedFileSizeW", SetLastError = true)]
    private static extern uint GetCompressedFileSize(string path, out uint high);
}
