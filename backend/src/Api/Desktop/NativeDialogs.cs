using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace TorrentFlow.Api.Desktop;

/// <summary>The published Windows exe is a GUI-subsystem app: no console window, so errors go to a message box.</summary>
[SupportedOSPlatform("windows")]
internal static class NativeDialogs
{
    private const uint MB_OK = 0x0, MB_ICONERROR = 0x10, MB_SETFOREGROUND = 0x10000, MB_TOPMOST = 0x40000;
    private const int ATTACH_PARENT_PROCESS = -1;

    public static void ShowError(string message) =>
        MessageBoxW(IntPtr.Zero, message, "TorrentFlow", MB_OK | MB_ICONERROR | MB_SETFOREGROUND | MB_TOPMOST);

    /// <summary>When started from a terminal, write logs to it; a double-click or autostart launch has none and stays silent.</summary>
    public static bool AttachToParentConsole() => GetConsoleWindow() == IntPtr.Zero && AttachConsole(ATTACH_PARENT_PROCESS);

#pragma warning disable SYSLIB1054
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int MessageBoxW(IntPtr hwnd, string text, string caption, uint type);
    [DllImport("kernel32.dll")] private static extern IntPtr GetConsoleWindow();
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool AttachConsole(int processId);
#pragma warning restore SYSLIB1054
}
