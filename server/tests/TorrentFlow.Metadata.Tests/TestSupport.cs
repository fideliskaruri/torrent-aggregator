using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;

namespace TorrentFlow.Metadata.Tests;

/// <summary>A fake HttpMessageHandler: no network, every request answered by a delegate.</summary>
public sealed class FakeHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> respond) : HttpMessageHandler
{
    public List<HttpRequestMessage> Requests { get; } = [];
    public List<string?> Bodies { get; } = [];

    protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        lock (Requests) Requests.Add(request);
        var body = request.Content is null ? null : await request.Content.ReadAsStringAsync(cancellationToken);
        lock (Bodies) Bodies.Add(body);
        return await respond(request);
    }

    public static HttpResponseMessage Json(string json, HttpStatusCode status = HttpStatusCode.OK) =>
        new(status) { Content = new StringContent(json, Encoding.UTF8, "application/json") };

    public static FakeHandler Always(string json) => new(_ => Task.FromResult(Json(json)));
}

public sealed class FakeHttpFactory(HttpMessageHandler handler) : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(handler, disposeHandler: false);
}

public sealed class ManualTime(DateTimeOffset start) : TimeProvider
{
    private DateTimeOffset _now = start;
    public ManualTime() : this(new DateTimeOffset(2026, 5, 1, 12, 0, 0, TimeSpan.Zero)) { }
    public override DateTimeOffset GetUtcNow() => _now;
    public void Advance(TimeSpan by) => _now += by;
}

public static class Fixtures
{
    public static string Read(string name) => File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Fixtures", name));
    public static JsonElement Json(string name) => JsonDocument.Parse(Read(name)).RootElement.Clone();

    public static IOptions<MetadataOptions> Options(string? tmdbKey = null) =>
        Microsoft.Extensions.Options.Options.Create(new MetadataOptions { TmdbApiKey = tmdbKey });

    public const string TmdbKey = "1234567890abcdef1234567890abcdef";
}

/// <summary>A temp-file SQLite database with the real schema: every context gets its own connection, so concurrent rails are safe.</summary>
public sealed class TestDb : IDbContextFactory<TorrentFlowDbContext>, IDisposable
{
    private readonly string _path = Path.Combine(Path.GetTempPath(), $"tf-metadata-{Guid.NewGuid():N}.db");
    private readonly DbContextOptions<TorrentFlowDbContext> _options;

    public TestDb()
    {
        _options = new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite($"Data Source={_path}").Options;
        using var db = CreateDbContext();
        db.Database.EnsureCreated();
    }

    public TorrentFlowDbContext CreateDbContext() => new(_options);

    public void Dispose()
    {
        SqliteConnection.ClearAllPools();
        try { File.Delete(_path); } catch (IOException) { }
    }
}


/// <summary>Wires a BrowseService with its real collaborators over fake HTTP.</summary>
public static class BrowseFixture
{
    public static TorrentFlow.Metadata.Browse.BrowseService Create(TestDb db, IHttpClientFactory http, TimeProvider time,
        TorrentFlow.Metadata.Catalog.CatalogService? catalog = null, TorrentFlow.Core.Contracts.Metadata.ITorrentPresenceProbe? presence = null, string? tmdbKey = null)
    {
        var options = Fixtures.Options(tmdbKey);
        var tmdb = new TorrentFlow.Metadata.Providers.TmdbClient(http, options, time);
        var artwork = new TorrentFlow.Metadata.Artwork.ArtworkResolver(tmdb, new TorrentFlow.Metadata.Providers.AniListClient(http, time),
            new TorrentFlow.Metadata.Providers.KeylessClients(http), options, time);
        catalog ??= new TorrentFlow.Metadata.Catalog.CatalogService(db, tmdb, http, options, time,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<TorrentFlow.Metadata.Catalog.CatalogService>.Instance);
        presence ??= new TorrentFlow.Metadata.Browse.UnknownTorrentPresenceProbe();
        var homeReleases = new TorrentFlow.Metadata.Browse.HomeReleaseCache(db, artwork, tmdb, time,
            Microsoft.Extensions.Logging.Abstractions.NullLogger<TorrentFlow.Metadata.Browse.HomeReleaseCache>.Instance);
        return new TorrentFlow.Metadata.Browse.BrowseService(db, catalog, new TorrentFlow.Metadata.Browse.AvailabilityResolver(db, presence, time),
            homeReleases, presence, time, Microsoft.Extensions.Logging.Abstractions.NullLogger<TorrentFlow.Metadata.Browse.BrowseService>.Instance, artwork);
    }
}
