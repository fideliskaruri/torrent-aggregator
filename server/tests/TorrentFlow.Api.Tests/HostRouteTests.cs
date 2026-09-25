using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace TorrentFlow.Api.Tests;

public sealed class HostFactory : WebApplicationFactory<Program>
{
    public string Root { get; } = Path.Combine(Path.GetTempPath(), "tf-host-" + Guid.NewGuid().ToString("N"));

    public string WebRoot { get; } = Path.Combine(Path.GetTempPath(), "tf-web-" + Guid.NewGuid().ToString("N"));

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        Directory.CreateDirectory(Path.Combine(WebRoot, "assets"));
        File.WriteAllText(Path.Combine(WebRoot, "index.html"), "<!doctype html><div id=root></div>");
        File.WriteAllText(Path.Combine(WebRoot, "assets", "app.js"), "export {};");
        File.WriteAllText(Path.Combine(WebRoot, "manifest.webmanifest"), "{}");
        builder.UseSetting("TorrentFlow:DataDirectory", Root);
        builder.UseSetting("TorrentFlow:WebRoot", WebRoot);
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        try { Directory.Delete(Root, recursive: true); Directory.Delete(WebRoot, recursive: true); } catch (IOException) { } catch (UnauthorizedAccessException) { }
    }
}

public sealed class HostRouteTests(HostFactory factory) : IClassFixture<HostFactory>
{
    private HttpClient Client() => factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

    [Theory]
    [InlineData("/activity", "/notifications")]
    [InlineData("/client", "/downloads")]
    public async Task RenamedPagesRedirectPermanently(string from, string to)
    {
        var response = await Client().GetAsync(from);
        Assert.Equal(HttpStatusCode.PermanentRedirect, response.StatusCode);
        Assert.Equal(to, response.Headers.Location?.OriginalString);
    }

    [Fact]
    public async Task HealthReportsReadyDatabaseInTheNextShape()
    {
        var response = await Client().GetAsync("/api/health");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("no-store", response.Headers.CacheControl?.ToString());
        using var doc = JsonDocument.Parse(await response.Content.ReadAsStringAsync());
        var root = doc.RootElement;
        Assert.Equal("ok", root.GetProperty("status").GetString());
        Assert.True(root.GetProperty("live").GetBoolean());
        Assert.True(root.GetProperty("ready").GetBoolean());
        Assert.EndsWith("Z", root.GetProperty("timestamp").GetString());
        Assert.Equal("up", root.GetProperty("process").GetProperty("status").GetString());
        Assert.Equal("up", root.GetProperty("database").GetProperty("status").GetString());
        Assert.InRange(root.GetProperty("database").GetProperty("latencyMs").GetInt32(), 0, 30_000);
    }

    [Theory]
    [InlineData("/assets/app.js", "text/javascript")]
    [InlineData("/manifest.webmanifest", "application/manifest+json")]
    [InlineData("/", "text/html")]
    [InlineData("/search", "text/html")]
    public async Task ServesSpaAssetsAndFallsBackForClientRoutes(string path, string contentType)
    {
        var response = await Client().GetAsync(path);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(contentType, response.Content.Headers.ContentType?.MediaType);
    }

    [Fact]
    public async Task UnknownApiRoutesAreNotAnsweredWithTheSpa()
    {
        var response = await Client().GetAsync("/api/does-not-exist");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }
}