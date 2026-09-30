using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using Microsoft.Win32.SafeHandles;

namespace TorrentFlow.Engine.Client;

/// <summary>Marks an NTFS file sparse, so setting its length does not allocate the unwritten ranges.</summary>
[SupportedOSPlatform("windows")]
internal static class SparseFile
{
    private const uint FsctlSetSparse = 0x000900C4;

    public static bool Mark(SafeFileHandle handle) =>
        DeviceIoControl(handle, FsctlSetSparse, IntPtr.Zero, 0, IntPtr.Zero, 0, out _, IntPtr.Zero);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeviceIoControl(SafeFileHandle device, uint code, IntPtr input, uint inputSize, IntPtr output, uint outputSize,
        out uint returned, IntPtr overlapped);
}
