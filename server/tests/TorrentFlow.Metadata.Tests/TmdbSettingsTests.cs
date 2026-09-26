using System.Net;
using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Settings;

namespace TorrentFlow.Metadata.Tests;

public sealed class TmdbSettingsTests : IDisposable
{
    private readonly string root = Path.Combine(Directory.GetCurrentDirectory(), "test-artifacts", Guid.NewGuid().ToString("N"));
    private IConfiguration Configuration => new ConfigurationBuilder().AddInMemoryCollection(
        new Dictionary<string, string?> { ["TorrentFlow:DataDirectory"] = root }).Build();
    private TmdbSettingsStore Store(string? fallback = null) => new(Configuration, Fixtures.Options(fallback));

    [Fact]
    public void Saved_key_overrides_config_is_masked_and_survives_reload()
    {
        var store = Store("abcdef1234567890abcdef1234567890");
        Assert.Equal("environment", store.Status().Source);
        store.Save($" \"{Fixtures.TmdbKey}\" ");
        Assert.Equal(Fixtures.TmdbKey, store.ApiKey);
        Assert.Equal(new(true, "settings", "••••cdef"), store.Status());
        Assert.DoesNotContain(Fixtures.TmdbKey, JsonSerializer.Serialize(store.Status()));
        Assert.Equal(Fixtures.TmdbKey, Store().ApiKey);
        store.Remove();
        Assert.Equal("environment", store.Status().Source);
        Assert.Equal("abcdef1234567890abcdef1234567890", store.ApiKey);
        Assert.Null(Store().ApiKey);
        store.Remove();
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("your_api_key_here")]
    [InlineData("aaaaaaaaaaaaaaaa")]
    [InlineData("1234567890\nabcdef")]
    public void Rejects_invalid_values_without_changing_saved_key(string? key)
    {
        var store = Store();
        store.Save(Fixtures.TmdbKey);
        Assert.False(TmdbSettingsStore.Accepts(key));
        Assert.Equal(Fixtures.TmdbKey, store.ApiKey);
    }

    [Fact]
    public void Oversized_key_is_rejected_and_placeholder_config_is_absent()
    {
        Assert.False(TmdbSettingsStore.Accepts(string.Concat(Enumerable.Repeat("ab", 3000))));
        Assert.Equal(new(false, "none", ""), Store("your_api_key_here").Status());
    }

    [Fact]
    public async Task Existing_client_sees_save_and_remove_immediately()
    {
        var store = Store();
        using var handler = FakeHandler.Always("""{"results":[]}""");
        var client = new TmdbClient(new FakeHttpFactory(handler), Fixtures.Options(), TimeProvider.System, store);
        var revision = client.CredentialRevision;
        Assert.False(client.HasKey);
        store.Save(Fixtures.TmdbKey);
        Assert.True(client.HasKey);
        Assert.Equal(revision + 1, client.CredentialRevision);
        await client.SearchAsync("Movie");
        Assert.All(handler.Requests, r => Assert.Contains(Fixtures.TmdbKey, r.RequestUri!.Query));
        store.Remove();
        Assert.False(client.HasKey);
        Assert.Equal(revision + 2, client.CredentialRevision);
    }

    [Theory]
    [InlineData(HttpStatusCode.OK, "ok")]
    [InlineData(HttpStatusCode.Unauthorized, "invalid")]
    [InlineData(HttpStatusCode.ServiceUnavailable, "unavailable")]
    public async Task Test_returns_only_safe_status_and_does_not_save(HttpStatusCode code, string status)
    {
        var store = Store();
        using var handler = new FakeHandler(_ => Task.FromResult(FakeHandler.Json(Fixtures.TmdbKey, code)));
        var controller = new TmdbSettingsController(store, new FakeHttpFactory(handler))
        { ControllerContext = new() { HttpContext = new DefaultHttpContext() } };
        var result = Assert.IsType<OkObjectResult>(await controller.Test(
            JsonSerializer.SerializeToElement(new { apiKey = Fixtures.TmdbKey }), default));
        var json = JsonSerializer.Serialize(result.Value);
        Assert.Contains(status, json);
        Assert.DoesNotContain(Fixtures.TmdbKey, json);
        Assert.False(store.Status().Configured);
    }

    [Fact]
    public void Failed_disk_write_does_not_publish_new_value()
    {
        Directory.CreateDirectory(root);
        Directory.CreateDirectory(Path.Combine(root, "tmdb-settings.json.pending"));
        var store = Store();
        var revision = store.Revision;
        Assert.ThrowsAny<Exception>(() => store.Save(Fixtures.TmdbKey));
        Assert.Null(store.ApiKey);
        Assert.Equal(revision, store.Revision);
    }

    [Theory]
    [InlineData("{broken")]
    [InlineData("[]")]
    [InlineData("{\"apiKey\":\"your_api_key_here\"}")]
    public void Corrupt_or_invalid_saved_settings_fall_back_safely(string json)
    {
        Directory.CreateDirectory(root);
        File.WriteAllText(Path.Combine(root, "tmdb-settings.json"), json);
        var store = Store(Fixtures.TmdbKey);
        Assert.Equal("environment", store.Status().Source);
        Assert.Equal(Fixtures.TmdbKey, store.ApiKey);
    }

    public void Dispose() { if (Directory.Exists(root)) Directory.Delete(root, true); }
}
