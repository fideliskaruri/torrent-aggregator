using System.Runtime.Versioning;
using Microsoft.Win32;

namespace TorrentFlow.Api.Desktop;

/// <summary>The per-user startup programs list (HKCU\...\Run). Abstracted so tests never touch the real registry.</summary>
public interface IAutostartRegistry
{
    string? Get(string name);

    void Set(string name, string command);

    void Delete(string name);
}

[SupportedOSPlatform("windows")]
public sealed class WindowsAutostartRegistry : IAutostartRegistry
{
    public const string RunKeyPath = @"Software\Microsoft\Windows\CurrentVersion\Run";

    public string? Get(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: false);
        return key?.GetValue(name) as string;
    }

    public void Set(string name, string command)
    {
        using var key = Registry.CurrentUser.CreateSubKey(RunKeyPath, writable: true);
        key.SetValue(name, command, RegistryValueKind.String);
    }

    public void Delete(string name)
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKeyPath, writable: true);
        key?.DeleteValue(name, throwOnMissingValue: false);
    }
}

public sealed record AutostartStatus(bool Available, bool Enabled, bool PointsElsewhere, string? Command);

/// <summary>"Start with Windows": a Run value that launches this exe in the background (no browser window).</summary>
public sealed class AutostartService(IAutostartRegistry registry, DesktopEnvironment desktop)
{
    /// <summary>Also written by the installer's "Start with Windows" task and removed by its uninstaller.</summary>
    public const string ValueName = "TorrentFlow";

    public static string BuildCommand(string exePath) => $"\"{exePath}\" {DesktopEnvironment.BackgroundArg}";

    /// <summary>The exe a Run command launches: the quoted first token, or everything before the first space.</summary>
    public static string? ExeOf(string? command)
    {
        var raw = command?.Trim();
        if (string.IsNullOrEmpty(raw)) return null;
        if (raw[0] == '"')
        {
            var end = raw.IndexOf('"', 1);
            return end > 1 ? raw[1..end] : null;
        }
        var space = raw.IndexOf(' ');
        return space < 0 ? raw : raw[..space];
    }

    public AutostartStatus Status()
    {
        if (!desktop.IsDesktop || desktop.ExePath is null) return new AutostartStatus(false, false, false, null);
        var command = registry.Get(ValueName);
        var target = ExeOf(command);
        var enabled = target is not null;
        var elsewhere = enabled && !string.Equals(Path.GetFullPath(target!), Path.GetFullPath(desktop.ExePath), StringComparison.OrdinalIgnoreCase);
        return new AutostartStatus(true, enabled, elsewhere, command);
    }

    public void SetEnabled(bool enabled)
    {
        if (!desktop.IsDesktop || desktop.ExePath is null)
            throw new InvalidOperationException("Start with Windows is only available in the installed Windows app.");
        if (enabled) registry.Set(ValueName, BuildCommand(desktop.ExePath));
        else registry.Delete(ValueName);
    }
}
