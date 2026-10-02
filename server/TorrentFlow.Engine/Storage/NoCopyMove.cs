using System.ComponentModel;
using System.Runtime.InteropServices;

namespace TorrentFlow.Engine.Storage;

/// <summary>A rename that could only work by copying: the two paths are on different volumes or mounts.</summary>
internal sealed class CrossDeviceMoveException(string message) : IOException(message);

/// <summary>
/// The move promotion uses (docs/english-gates-plan.md section 1): a rename that never copies and never replaces.
/// <see cref="File.Move(string, string)"/> copies and deletes across volumes (MOVEFILE_COPY_ALLOWED on Windows, the EXDEV
/// fallback on Linux), so a restart mid-copy leaves a half-written file and a long copy stalls the monitor. Here a move
/// between volumes fails with <see cref="CrossDeviceMoveException"/> instead, whatever the drive letters say: a junction,
/// a mounted folder or a Docker bind mount is caught by the operating system itself. Works for files and folders.
/// </summary>
internal static class NoCopyMove
{
    private const int ErrorNotSameDevice = 17; // Windows ERROR_NOT_SAME_DEVICE
    private const int Exdev = 18;              // EXDEV on Linux and macOS

    public static void Move(string source, string target)
    {
        source = Path.GetFullPath(source);
        target = Path.GetFullPath(target);
        // Neither rename(2) nor a folder rename may replace what is there.
        if (File.Exists(target) || Directory.Exists(target)) throw new IOException($"{target} already exists.");
        if (OperatingSystem.IsWindows())
        {
            if (MoveFileEx(Extended(source), Extended(target), 0)) return;
            var error = Marshal.GetLastPInvokeError();
            if (error == ErrorNotSameDevice) throw new CrossDeviceMoveException($"{target} is on another drive than {source}.");
            throw new IOException($"Moving {source} to {target} failed: {new Win32Exception(error).Message}", error);
        }
        int result;
        try { result = Rename(source, target); }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            throw new IOException("This system can't move files without copying them.", ex);
        }
        if (result == 0) return;
        var errno = Marshal.GetLastPInvokeError();
        if (errno == Exdev) throw new CrossDeviceMoveException($"{target} is on another mount than {source}.");
        throw new IOException($"Moving {source} to {target} failed (errno {errno}).", errno);
    }

    /// <summary>The \\?\ form for a path too long for the classic Windows API.</summary>
    private static string Extended(string full) =>
        full.Length < 248 || full.StartsWith(@"\\?\", StringComparison.Ordinal) ? full
        : full.StartsWith(@"\\", StringComparison.Ordinal) ? @"\\?\UNC\" + full[2..] : @"\\?\" + full;

    // No MOVEFILE_COPY_ALLOWED and no MOVEFILE_REPLACE_EXISTING: a plain rename on one volume, or an error.
    [DllImport("kernel32.dll", EntryPoint = "MoveFileExW", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool MoveFileEx(string existingFileName, string newFileName, uint flags);

    [DllImport("libc", EntryPoint = "rename", SetLastError = true)]
    private static extern int Rename([MarshalAs(UnmanagedType.LPUTF8Str)] string oldPath, [MarshalAs(UnmanagedType.LPUTF8Str)] string newPath);
}
