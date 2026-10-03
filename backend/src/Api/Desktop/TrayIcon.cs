using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;

namespace TorrentFlow.Api.Desktop;

/// <summary>
/// Notification-area icon built on Shell_NotifyIcon (no WinForms: the app targets cross-platform net10.0). Runs its
/// own STA message loop. The owner window is a hidden top-level window so <c>taskkill /IM TorrentFlow.exe</c> without
/// /F (used by the installer and uninstaller) delivers WM_CLOSE and TorrentFlow shuts down gracefully.
/// </summary>
[SupportedOSPlatform("windows")]
internal sealed class TrayIcon : IDisposable
{
    public sealed record MenuItem(string Text, Action OnClick, bool IsDefault = false);

    private const int WM_NULL = 0x0000;
    private const int WM_DESTROY = 0x0002;
    private const int WM_CLOSE = 0x0010;
    private const int WM_COMMAND = 0x0111;
    private const int WM_CONTEXTMENU = 0x007B;
    private const int WM_APP = 0x8000;
    private const int WM_TRAY = WM_APP + 1;
    private const int WM_SHUTDOWN = WM_APP + 2;
    private const int NIM_ADD = 0, NIM_MODIFY = 1, NIM_DELETE = 2, NIM_SETVERSION = 4;
    private const int NIF_MESSAGE = 0x1, NIF_ICON = 0x2, NIF_TIP = 0x4, NIF_SHOWTIP = 0x80;
    private const int NOTIFYICON_VERSION_4 = 4;
    private const int MF_STRING = 0x0, MF_SEPARATOR = 0x800;
    private const int TPM_RIGHTBUTTON = 0x2, TPM_BOTTOMALIGN = 0x20;
    private const int IDI_APPLICATION = 32512;
    private const int NIN_SELECT = 0x400, NIN_KEYSELECT = 0x401;

    private readonly string _tooltip;
    private readonly IReadOnlyList<MenuItem?> _menu;
    private readonly Action _onActivate;
    private readonly Action _onClose;
    private readonly ILogger _logger;
    private readonly TaskCompletionSource _ready = new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly WndProc _wndProc;
    private Thread? _thread;
    private IntPtr _hwnd;
    private IntPtr _icon;
    private uint _taskbarCreated;

    /// <param name="menu">Context menu items; null is a separator.</param>
    /// <param name="onActivate">Left click on the icon.</param>
    /// <param name="onClose">WM_CLOSE from outside (taskkill without /F).</param>
    public TrayIcon(string tooltip, IReadOnlyList<MenuItem?> menu, Action onActivate, Action onClose, ILogger logger)
    {
        _tooltip = tooltip.Length > 127 ? tooltip[..127] : tooltip;
        _menu = menu;
        _onActivate = onActivate;
        _onClose = onClose;
        _logger = logger;
        _wndProc = WindowProc;
    }

    /// <summary>Starts the message loop; completes once the icon is shown (or failed to be).</summary>
    public Task StartAsync()
    {
        _thread = new Thread(Run) { IsBackground = true, Name = "TorrentFlow tray" };
        _thread.SetApartmentState(ApartmentState.STA);
        _thread.Start();
        return _ready.Task;
    }

    private void Run()
    {
        try
        {
            var instance = GetModuleHandleW(null);
            var className = "TorrentFlowTrayWindow";
            var wc = new WNDCLASSEXW
            {
                cbSize = (uint)Marshal.SizeOf<WNDCLASSEXW>(),
                lpfnWndProc = _wndProc,
                hInstance = instance,
                lpszClassName = className,
            };
            if (RegisterClassExW(ref wc) == 0 && Marshal.GetLastWin32Error() != 1410 /* ERROR_CLASS_ALREADY_EXISTS */)
                throw new Win32Exception();
            _hwnd = CreateWindowExW(0, className, "TorrentFlow", 0, 0, 0, 0, 0, IntPtr.Zero, IntPtr.Zero, instance, IntPtr.Zero);
            if (_hwnd == IntPtr.Zero) throw new Win32Exception();
            _taskbarCreated = RegisterWindowMessageW("TaskbarCreated");
            _icon = LoadAppIcon();
            if (!AddIcon()) throw new Win32Exception("Shell_NotifyIcon failed");
            _ready.TrySetResult();

            while (GetMessageW(out var msg, IntPtr.Zero, 0, 0) > 0)
            {
                TranslateMessage(ref msg);
                DispatchMessageW(ref msg);
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "The TorrentFlow tray icon could not be shown");
            _ready.TrySetException(ex);
        }
    }

    private static IntPtr LoadAppIcon()
    {
        // The exe's own icon (ApplicationIcon); the stock application icon when it has none.
        var exe = Environment.ProcessPath;
        if (exe is not null && ExtractIconExW(exe, 0, out _, out var small, 1) > 0 && small != IntPtr.Zero) return small;
        return LoadIconW(IntPtr.Zero, (IntPtr)IDI_APPLICATION);
    }

    private NOTIFYICONDATAW IconData() => new()
    {
        cbSize = (uint)Marshal.SizeOf<NOTIFYICONDATAW>(),
        hWnd = _hwnd,
        uID = 1,
        uFlags = NIF_MESSAGE | NIF_ICON | NIF_TIP | NIF_SHOWTIP,
        uCallbackMessage = WM_TRAY,
        hIcon = _icon,
        szTip = _tooltip,
        szInfo = "",
        szInfoTitle = "",
        uTimeoutOrVersion = NOTIFYICON_VERSION_4,
    };

    private bool AddIcon()
    {
        var data = IconData();
        if (!Shell_NotifyIconW(NIM_ADD, ref data))
        {
            // Explorer restarts can leave a stale icon with our id; replace it.
            Shell_NotifyIconW(NIM_DELETE, ref data);
            if (!Shell_NotifyIconW(NIM_ADD, ref data)) return false;
        }
        Shell_NotifyIconW(NIM_SETVERSION, ref data);
        return true;
    }

    private IntPtr WindowProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam)
    {
        try
        {
            switch (msg)
            {
                case WM_TRAY:
                    // NOTIFYICON_VERSION_4: the event is in LOWORD(lParam); a left click arrives as NIN_SELECT and a
                    // right click as WM_CONTEXTMENU (the raw button messages come too and are ignored, or they would double up).
                    var ev = (int)(lParam.ToInt64() & 0xFFFF);
                    if (ev is NIN_SELECT or NIN_KEYSELECT) Dispatch(_onActivate);
                    else if (ev is WM_CONTEXTMENU) ShowMenu();
                    return IntPtr.Zero;
                case WM_COMMAND:
                    var id = (int)(wParam.ToInt64() & 0xFFFF) - 1;
                    if (id >= 0 && id < _menu.Count && _menu[id] is { } item) Dispatch(item.OnClick);
                    return IntPtr.Zero;
                case WM_CLOSE:
                    Dispatch(_onClose);
                    return IntPtr.Zero;
                case WM_SHUTDOWN:
                    DestroyWindow(hwnd);
                    return IntPtr.Zero;
                case WM_DESTROY:
                    var data = IconData();
                    Shell_NotifyIconW(NIM_DELETE, ref data);
                    PostQuitMessage(0);
                    return IntPtr.Zero;
            }
            if (_taskbarCreated != 0 && msg == _taskbarCreated)
            {
                AddIcon();
                return IntPtr.Zero;
            }
        }
        catch (Exception ex)
        {
            _logger.LogWarning(ex, "Tray icon message {Message} failed", msg);
        }
        return DefWindowProcW(hwnd, msg, wParam, lParam);
    }

    private void ShowMenu()
    {
        var menu = CreatePopupMenu();
        try
        {
            for (var i = 0; i < _menu.Count; i++)
            {
                if (_menu[i] is { } item)
                {
                    AppendMenuW(menu, MF_STRING, (UIntPtr)(uint)(i + 1), item.Text);
                    if (item.IsDefault) SetMenuDefaultItem(menu, (uint)(i + 1), 0);
                }
                else
                {
                    AppendMenuW(menu, MF_SEPARATOR, UIntPtr.Zero, null);
                }
            }
            GetCursorPos(out var point);
            // Without the foreground call the menu does not close when the user clicks elsewhere.
            SetForegroundWindow(_hwnd);
            TrackPopupMenuEx(menu, TPM_RIGHTBUTTON | TPM_BOTTOMALIGN, point.X, point.Y, _hwnd, IntPtr.Zero);
            PostMessageW(_hwnd, WM_NULL, IntPtr.Zero, IntPtr.Zero);
        }
        finally
        {
            DestroyMenu(menu);
        }
    }

    private void Dispatch(Action action) => ThreadPool.QueueUserWorkItem(_ =>
    {
        try { action(); }
        catch (Exception ex) { _logger.LogWarning(ex, "Tray action failed"); }
    });

    public void Dispose()
    {
        if (_hwnd != IntPtr.Zero) PostMessageW(_hwnd, WM_SHUTDOWN, IntPtr.Zero, IntPtr.Zero);
        if (_thread is { IsAlive: true } thread && thread != Thread.CurrentThread) thread.Join(TimeSpan.FromSeconds(3));
        _hwnd = IntPtr.Zero;
    }

    private delegate IntPtr WndProc(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct WNDCLASSEXW
    {
        public uint cbSize;
        public uint style;
        [MarshalAs(UnmanagedType.FunctionPtr)] public WndProc lpfnWndProc;
        public int cbClsExtra;
        public int cbWndExtra;
        public IntPtr hInstance;
        public IntPtr hIcon;
        public IntPtr hCursor;
        public IntPtr hbrBackground;
        public string? lpszMenuName;
        public string lpszClassName;
        public IntPtr hIconSm;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct NOTIFYICONDATAW
    {
        public uint cbSize;
        public IntPtr hWnd;
        public uint uID;
        public uint uFlags;
        public uint uCallbackMessage;
        public IntPtr hIcon;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szTip;
        public uint dwState;
        public uint dwStateMask;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string szInfo;
        public uint uTimeoutOrVersion;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string szInfoTitle;
        public uint dwInfoFlags;
        public Guid guidItem;
        public IntPtr hBalloonIcon;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MSG
    {
        public IntPtr hwnd;
        public uint message;
        public IntPtr wParam;
        public IntPtr lParam;
        public uint time;
        public POINT pt;
        public uint lPrivate;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT
    {
        public int X;
        public int Y;
    }

#pragma warning disable SYSLIB1054 // Runtime marshalling keeps these declarations simple; the app is not trimmed.
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr GetModuleHandleW(string? name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern ushort RegisterClassExW(ref WNDCLASSEXW wc);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateWindowExW(int exStyle, string className, string windowName, int style, int x, int y, int width, int height,
        IntPtr parent, IntPtr menu, IntPtr instance, IntPtr param);
    [DllImport("user32.dll")] private static extern bool DestroyWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DefWindowProcW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern uint RegisterWindowMessageW(string name);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetMessageW(out MSG msg, IntPtr hwnd, uint min, uint max);
    [DllImport("user32.dll")] private static extern bool TranslateMessage(ref MSG msg);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr DispatchMessageW(ref MSG msg);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool PostMessageW(IntPtr hwnd, uint msg, IntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll")] private static extern void PostQuitMessage(int code);
    [DllImport("user32.dll")] private static extern IntPtr CreatePopupMenu();
    [DllImport("user32.dll")] private static extern bool DestroyMenu(IntPtr menu);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern bool AppendMenuW(IntPtr menu, uint flags, UIntPtr id, string? text);
    [DllImport("user32.dll")] private static extern bool SetMenuDefaultItem(IntPtr menu, uint item, uint byPosition);
    [DllImport("user32.dll")] private static extern bool TrackPopupMenuEx(IntPtr menu, uint flags, int x, int y, IntPtr hwnd, IntPtr tpm);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr LoadIconW(IntPtr instance, IntPtr name);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern uint ExtractIconExW(string file, int index, out IntPtr large, out IntPtr small, uint count);
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)] private static extern bool Shell_NotifyIconW(int message, ref NOTIFYICONDATAW data);
#pragma warning restore SYSLIB1054
}
