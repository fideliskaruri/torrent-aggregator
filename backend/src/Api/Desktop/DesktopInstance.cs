using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

namespace TorrentFlow.Api.Desktop;

internal sealed class DesktopInstance : IDisposable
{
    private readonly Mutex? mutex;

    public DesktopInstance(bool desktop, string dataDirectory, string url, bool background, bool noBrowser)
    {
        if (!desktop) { IsFirst = true; return; }
        var key = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            Path.GetFullPath(dataDirectory).ToUpperInvariant() + "|" + url)));
        mutex = new Mutex(false, @"Local\TorrentFlow-" + key, out var created);
        IsFirst = created;
        if (created || background || noBrowser) return;
        try { Process.Start(new ProcessStartInfo(url) { UseShellExecute = true })?.Dispose(); }
        catch (Exception ex) { Console.Error.WriteLine($"Could not open TorrentFlow: {ex.Message}"); }
    }

    public bool IsFirst { get; }
    public void Dispose()
    {
        mutex?.Dispose();
    }
}
