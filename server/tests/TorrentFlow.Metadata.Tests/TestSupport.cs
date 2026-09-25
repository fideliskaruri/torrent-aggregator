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

/// <summary>An in-memory SQLite database with the real schema, kept open for the test's lifetime.</summary>
public sealed class TestDb : IDbContextFactory<TorrentFlowDbContext>, IDisposable
{
    private readonly SqliteConnection _connection = new("DataSource=:memory:");
    private readonly DbContextOptions<TorrentFlowDbContext> _options;

    public TestDb()
    {
        _connection.Open();
        _options = new DbContextOptionsBuilder<TorrentFlowDbContext>().UseSqlite(_connection).Options;
        using var db = CreateDbContext();
        db.Database.EnsureCreated();
    }

    public TorrentFlowDbContext CreateDbContext() => new(_options);
    public void Dispose() => _connection.Dispose();
}
