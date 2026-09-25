using System.Diagnostics;
using System.Net.WebSockets;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace TorrentFlow.Search.Adapters;

public sealed record BrowserPage(int Status, string Html, string FinalUrl);
public interface IIndexerBrowserFetcher
{
    Task<BrowserPage?> FetchAsync(string url, int timeoutMs, string selector, CancellationToken cancellationToken);
}

/// <summary>Optional isolated Chromium fallback. No browser or profile is shared with the owner.</summary>
public sealed class BrowserFetcher(IConfiguration configuration, IOptions<SearchModuleOptions> options, IHttpClientFactory clients, ILogger<BrowserFetcher> logger) : IIndexerBrowserFetcher
{
    private readonly SemaphoreSlim slot = new(1);
    public async Task<BrowserPage?> FetchAsync(string url, int timeoutMs, string selector, CancellationToken cancellationToken)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(timeoutMs);
        var token = timeout.Token;
        var configured = options.Value.BrowserExecutable;
        string[] candidates = [configured ?? "",
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Microsoft", "Edge", "Application", "msedge.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe")];
        var binary = candidates.FirstOrDefault(File.Exists);
        if (binary == null) { logger.LogDebug("Optional indexer browser is unavailable"); return null; }
        var acquired = false;
        Process? process = null;
        string? profile = null;
        try
        {
            await slot.WaitAsync(token);
            acquired = true;
            var root = configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(AppContext.BaseDirectory, "data");
            profile = Path.Combine(root, "indexer-browser", Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(profile);
            var start = new ProcessStartInfo(binary) { UseShellExecute = false, CreateNoWindow = true };
            foreach (var arg in new[] { "--headless=new", "--remote-debugging-port=0", "--remote-debugging-address=127.0.0.1", "--no-first-run",
                "--no-default-browser-check", "--disable-blink-features=AutomationControlled", "--window-size=1365,900", $"--user-data-dir={profile}", "about:blank" })
                start.ArgumentList.Add(arg);
            process = Process.Start(start) ?? throw new IOException("Could not launch optional indexer browser");
            var portFile = Path.Combine(profile, "DevToolsActivePort");
            while (!File.Exists(portFile)) { if (process.HasExited) return null; await Task.Delay(100, token); }
            var lines = await File.ReadAllLinesAsync(portFile, token);
            if (!int.TryParse(lines.FirstOrDefault(), out var port) || port is < 1 or > 65535) return null;
            using var http = clients.CreateClient("TorrentFlow.Indexers");
            using var response = await http.PutAsync($"http://127.0.0.1:{port}/json/new?about:blank", null, token);
            response.EnsureSuccessStatusCode();
            using var target = JsonDocument.Parse(await response.Content.ReadAsStringAsync(token));
            using var socket = new ClientWebSocket();
            await socket.ConnectAsync(new Uri(target.RootElement.GetProperty("webSocketDebuggerUrl").GetString()!), token);
            var id = 0;
            var status = 200;
            async Task<JsonElement> Command(string method, object parameters)
            {
                var current = ++id;
                await socket.SendAsync(JsonSerializer.SerializeToUtf8Bytes(new { id = current, method, @params = parameters }), WebSocketMessageType.Text, true, token);
                while (true)
                {
                    using var bytes = new MemoryStream();
                    var buffer = new byte[16384];
                    WebSocketReceiveResult received;
                    do
                    {
                        received = await socket.ReceiveAsync(buffer, token);
                        if (received.MessageType == WebSocketMessageType.Close) throw new IOException("Indexer browser disconnected");
                        if (bytes.Length + received.Count > 8 * 1024 * 1024) throw new IOException("Indexer browser response exceeds 8 MiB");
                        bytes.Write(buffer, 0, received.Count);
                    } while (!received.EndOfMessage);
                    using var doc = JsonDocument.Parse(bytes.ToArray());
                    var message = doc.RootElement;
                    if (message.TryGetProperty("method", out var eventName) && eventName.GetString() == "Network.responseReceived")
                    {
                        var p = message.GetProperty("params");
                        if (p.GetProperty("type").GetString() == "Document") status = p.GetProperty("response").GetProperty("status").GetInt32();
                    }
                    if (!message.TryGetProperty("id", out var replyId) || replyId.GetInt32() != current) continue;
                    if (message.TryGetProperty("error", out var error)) throw new IOException(error.ToString());
                    return message.GetProperty("result").Clone();
                }
            }
            async Task<JsonElement> Evaluate(string expression)
            {
                var result = await Command("Runtime.evaluate", new { expression, returnByValue = true });
                return result.GetProperty("result").TryGetProperty("value", out var value) ? value.Clone() : default;
            }
            await Command("Page.enable", new { });
            await Command("Network.enable", new { });
            await Command("Network.setUserAgentOverride", new { userAgent = IndexerHttp.BrowserAgent.Replace("Chrome/122", "Chrome/131"), acceptLanguage = "en-US" });
            await Command("Page.addScriptToEvaluateOnNewDocument", new { source = "Object.defineProperty(navigator, 'webdriver', { get: () => undefined });" });
            await Command("Page.navigate", new { url });
            while ((await Evaluate("location.href !== 'about:blank' && document.readyState !== 'loading'")).ValueKind != JsonValueKind.True)
                await Task.Delay(150, token);
            var challengeUntil = DateTime.UtcNow.AddSeconds(12);
            while (DateTime.UtcNow < challengeUntil && (await Evaluate("document.title.toLowerCase().includes('just a moment')")).ValueKind == JsonValueKind.True)
                await Task.Delay(250, token);
            var selectorUntil = DateTime.UtcNow.AddSeconds(8);
            while (DateTime.UtcNow < selectorUntil && (await Evaluate($"!!document.querySelector({JsonSerializer.Serialize(selector)})")).ValueKind != JsonValueKind.True)
                await Task.Delay(250, token);
            var page = await Evaluate("({html:document.documentElement.outerHTML,url:location.href,title:document.title})");
            var html = page.GetProperty("html").GetString() ?? "";
            if (html.Contains("cf-challenge") || html.Contains("Performing security verification") || page.GetProperty("title").GetString()!.Contains("just a moment", StringComparison.OrdinalIgnoreCase))
                status = 403;
            return new(status, html, page.GetProperty("url").GetString() ?? url);
        }
        catch (Exception e) when (!cancellationToken.IsCancellationRequested)
        {
            logger.LogWarning(e, "Optional indexer browser fetch failed");
            return null;
        }
        finally
        {
            if (process != null)
            {
                try { if (!process.HasExited) { process.Kill(entireProcessTree: true); await process.WaitForExitAsync(CancellationToken.None); } }
                catch (InvalidOperationException e) { logger.LogDebug(e, "Isolated browser already exited"); }
                catch (System.ComponentModel.Win32Exception e) { logger.LogWarning(e, "Could not stop isolated browser process {Pid}", process.Id); }
                finally { process.Dispose(); }
            }
            if (profile != null)
            {
                try { Directory.Delete(profile, true); }
                catch (IOException e) { logger.LogWarning(e, "Could not remove isolated browser profile {Profile}", profile); }
                catch (UnauthorizedAccessException e) { logger.LogWarning(e, "Could not remove isolated browser profile {Profile}", profile); }
            }
            if (acquired) slot.Release();
        }
    }
}
