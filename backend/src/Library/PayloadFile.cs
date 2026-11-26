using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Win32.SafeHandles;
using TorrentFlow.Domain;

namespace TorrentFlow.Library;

// Holds the verified Windows file object, denying replacement/writers until publication or deletion commits.
// OS file caching is retained; this is an ownership guard, not another payload cache.
public sealed class PayloadFile : IDisposable
{
    public FileStream Stream { get; }
    public string Identity { get; }
    public string Path { get; private set; }
    private readonly Dictionary<string, SafeFileHandle> directories = new(StringComparer.OrdinalIgnoreCase);

    public PayloadFile(string path)
    {
        Path = System.IO.Path.GetFullPath(path);
        LibraryPaths.NoLinks(Path);
        if (OperatingSystem.IsWindows())
        {
            HoldParents(Path);
            var handle = CreateFileW(Path, 0x80000000u | 0x00010000u, 1, IntPtr.Zero, 3, 0x08200000, IntPtr.Zero);
            if (handle.IsInvalid) { var error = Marshal.GetLastWin32Error(); handle.Dispose(); ReleaseParents(); throw Error("Open", error); }
            try
            {
                if (!GetFileInformationByHandle(handle, out var info)) throw Error("Identity", Marshal.GetLastWin32Error());
                if ((info.Attributes & (0x400u | 0x10u)) != 0) throw new IOException("A payload must be a regular file, not a link or directory.");
                Identity = $"win:{info.Volume:X8}:{info.IndexHigh:X8}{info.IndexLow:X8}:{info.CreationHigh:X8}{info.CreationLow:X8}";
                Stream = new FileStream(handle, FileAccess.Read, 1, false);
            }
            catch { handle.Dispose(); ReleaseParents(); throw; }
        }
        else
        {
            Stream = new FileStream(Path, FileMode.Open, FileAccess.Read, FileShare.Read);
            // This fallback deliberately cannot authenticate an interrupted rename on non-Windows.
            Identity = "session:" + Guid.NewGuid().ToString("N");
        }
    }

    public async Task<string> DigestAsync(CancellationToken ct)
    {
        Stream.Position = 0;
        using var observed = DeletionMeasurement.Time("sha");
        DeletionMeasurement.Add("shaCalls");
        DeletionMeasurement.Add("shaBytes", Stream.Length);
        var buffer = System.Buffers.ArrayPool<byte>.Shared.Rent(1024 * 1024);
        try
        {
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            int count;
            while ((count = await Stream.ReadAsync(buffer, ct)) > 0) digest.AppendData(buffer, 0, count);
            return Convert.ToHexString(digest.GetHashAndReset());
        }
        finally { System.Buffers.ArrayPool<byte>.Shared.Return(buffer); }
    }

    public void MoveTo(string destination)
    {
        destination = System.IO.Path.GetFullPath(destination);
        LibraryPaths.NoLinks(destination);
        if (LibraryPaths.PhysicalKey(Path) == LibraryPaths.PhysicalKey(destination)) return;
        if (OperatingSystem.IsWindows())
        {
            HoldParents(destination);
            var name = Encoding.Unicode.GetBytes(destination);
            var nameOffset = IntPtr.Size == 8 ? 20 : 12;
            var buffer = Marshal.AllocHGlobal(nameOffset + name.Length + 2);
            try
            {
                Marshal.Copy(new byte[nameOffset + name.Length + 2], 0, buffer, nameOffset + name.Length + 2);
                Marshal.WriteInt32(buffer, IntPtr.Size == 8 ? 16 : 8, name.Length);
                Marshal.Copy(name, 0, buffer + nameOffset, name.Length);
                if (!SetFileInformationByHandle(Stream.SafeFileHandle, 3, buffer, (uint)(nameOffset + name.Length + 2)))
                    throw Error("Rename", Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        else File.Move(Path, destination, false);
        Path = destination;
    }

    public void Delete()
    {
        if (OperatingSystem.IsWindows())
        {
            var buffer = Marshal.AllocHGlobal(1);
            try
            {
                Marshal.WriteByte(buffer, 1);
                if (!SetFileInformationByHandle(Stream.SafeFileHandle, 4, buffer, 1)) throw Error("Delete", Marshal.GetLastWin32Error());
            }
            finally { Marshal.FreeHGlobal(buffer); }
        }
        else File.Delete(Path);
    }

    private void HoldParents(string file)
    {
        try
        {
            for (var parent = System.IO.Path.GetDirectoryName(file); parent is not null;
                parent = System.IO.Path.GetDirectoryName(parent))
            {
                if (directories.ContainsKey(parent)) continue;
                var handle = CreateFileW(parent, 0x80, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
                if (handle.IsInvalid) { var code = Marshal.GetLastWin32Error(); handle.Dispose(); throw Error("Guard directory", code); }
                directories.Add(parent, handle);
                if (!GetFileInformationByHandle(handle, out var info) || (info.Attributes & 0x400) != 0)
                    throw new IOException("The payload directory cannot be a link.");
            }
        }
        catch { ReleaseParents(); throw; }
    }
    private void ReleaseParents() { foreach (var handle in directories.Values) handle.Dispose(); directories.Clear(); }
    public void Dispose() { Stream.Dispose(); ReleaseParents(); }
    private static IOException Error(string operation, int code) => new($"{operation} payload failed: {new Win32Exception(code).Message} (Win32 {code}).", unchecked((int)(0x80070000u | (uint)code)));

    [StructLayout(LayoutKind.Sequential)]
    private struct FileInfoNative
    {
        public uint Attributes, CreationLow, CreationHigh, AccessLow, AccessHigh, WriteLow, WriteHigh,
            Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfoNative info);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, IntPtr buffer, uint size);
}
