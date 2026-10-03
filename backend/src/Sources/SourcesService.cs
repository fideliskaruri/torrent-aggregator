using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Sources;

internal sealed class SourcesService(SourceTransport transport, IConfiguration configuration,
    IServiceScopeFactory scopes) : ISources
{
    public void PromoteSearch(string flightId) => transport.Promote(flightId);
    public void ForgetSearch(string flightId) => transport.Forget(flightId);
    private static readonly JsonSerializerOptions SettingsJson = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter() }
    };

    public async Task<SourceResult> SearchAsync(string sourceId, SourceQuery query, CancellationToken cancellationToken)
    {
        SourceResult? final = null;
        await foreach (var batch in SearchStreamAsync(sourceId, query, cancellationToken)) final = batch;
        return final!;
    }

    public Task<SourceResult> TestAsync(string sourceId, CancellationToken cancellationToken) =>
        SearchAsync(sourceId, new("Sintel", "all", null, PriorityLane.Owner, 50,
            DateTimeOffset.UtcNow.AddSeconds(6), 0, 0), cancellationToken);

    public async IAsyncEnumerable<SourceResult> SearchStreamAsync(string sourceId, SourceQuery query,
        [EnumeratorCancellation] CancellationToken cancellationToken)
    {
        var enqueued = Stopwatch.GetTimestamp();
        var budget = query.DeadlineAt - DateTimeOffset.UtcNow;
        if (budget > TimeSpan.FromSeconds(6)) budget = TimeSpan.FromSeconds(6);
        var channel = Channel.CreateUnbounded<SourceResult>(new() { SingleReader = true, SingleWriter = true });
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        if (budget <= TimeSpan.Zero) deadline.Cancel();
        else deadline.CancelAfter(budget);
        var producer = RunAsync(sourceId, query, enqueued, channel.Writer, deadline.Token, cancellationToken);
        try
        {
            await foreach (var result in channel.Reader.ReadAllAsync(cancellationToken)) yield return result;
        }
        finally
        {
            await deadline.CancelAsync();
            await producer.ConfigureAwait(false);
            transport.Forget(query.FlightId);
        }
    }

    private async Task RunAsync(string id, SourceQuery query, long enqueued, ChannelWriter<SourceResult> writer,
        CancellationToken ct, CancellationToken caller)
    {
        var trace = new CallTrace();
        var pool = ImmutableArray.CreateBuilder<RawRelease>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var limit = Math.Clamp(query.Limit, 50, 80);
        SourceResult Snapshot(SourceOutcome outcome, string code, string? error = null,
            DateTimeOffset? retry = null, bool truncated = false) =>
            new(id, outcome, pool.ToImmutable(), retry, error, Stopwatch.GetElapsedTime(enqueued))
            {
                Complete = outcome == SourceOutcome.Success,
                Diagnostics = new(code, trace.QueueWait, trace.Requests, trace.HttpStatus,
                    trace.StartedAt, pool.Count, truncated) { UpstreamElapsed = trace.UpstreamElapsed }
            };
        try
        {
            ct.ThrowIfCancellationRequested();
            var settings = await SettingsAsync(id, ct).ConfigureAwait(false);
            if (settings is null || !settings.Enabled)
            {
                writer.TryWrite(Snapshot(SourceOutcome.Unsupported, "Disabled", "This source is disabled or unknown."));
                return;
            }
            if ((!SourceDefaults.Endpoints.ContainsKey(id) && settings.Type != "torznab") || settings.BaseUrl is null)
            {
                writer.TryWrite(Snapshot(SourceOutcome.Unconfigured, "Unconfigured", id == "torznab"
                    ? "Torznab needs a configured API endpoint. Set its BaseUrl before enabling it."
                    : "This adapter is not installed."));
                return;
            }
            var category = query.Category switch { "tv" => "series", "movies" => "films", _ => query.Category };
            if (string.IsNullOrWhiteSpace(query.Query) || category != "all" &&
                !settings.Categories.Contains("all", StringComparer.OrdinalIgnoreCase) &&
                !settings.Categories.Contains(category, StringComparer.OrdinalIgnoreCase))
            {
                writer.TryWrite(Snapshot(SourceOutcome.Unsupported, "Unsupported", "The source does not support this category or query."));
                return;
            }
            if (id == "eztv" && (query.Identity?.Provider != "imdb" ||
                !query.Identity.ExternalId.StartsWith("tt", StringComparison.Ordinal) ||
                !query.Identity.ExternalId.AsSpan(2).ContainsAnyInRange('0', '9') ||
                query.Identity.ExternalId.AsSpan(2).ContainsAnyExceptInRange('0', '9')))
            {
                writer.TryWrite(Snapshot(SourceOutcome.Unsupported, "IdentityRequired", "EZTV needs an IMDb series identity from Metadata."));
                return;
            }
            var truncated = false;
            await foreach (var parsed in PagesAsync(id, settings, query, limit, trace, ct))
            {
                ct.ThrowIfCancellationRequested();
                truncated = parsed.HasMore;
                foreach (var release in parsed.Rows)
                {
                    ct.ThrowIfCancellationRequested();
                    if (pool.Count == limit) { truncated = true; break; }
                    var identity = release.Hash.Length > 0 ? release.Hash : release.TorrentUri ?? release.Magnet ?? release.Name;
                    if (!seen.Add(identity)) continue;
                    pool.Add(release);
                    if (pool.Count % 20 == 0)
                        writer.TryWrite(Snapshot(SourceOutcome.Partial, "Streaming"));
                }
                writer.TryWrite(Snapshot(SourceOutcome.Partial, "Streaming"));
                if (pool.Count >= limit) break;
            }
            ct.ThrowIfCancellationRequested();
            writer.TryWrite(Snapshot(truncated ? SourceOutcome.Partial : SourceOutcome.Success,
                truncated ? "PoolCap" : "Complete", truncated: truncated));
        }
        catch (OperationCanceledException) when (!caller.IsCancellationRequested)
        {
            writer.TryWrite(Snapshot(SourceOutcome.TimedOut, "Deadline",
                "The source could not finish within six seconds from enqueue."));
        }
        catch (OperationCanceledException)
        {
            writer.TryComplete();
        }
        catch (SourceException ex)
        {
            writer.TryWrite(Snapshot(ex.Code switch
                {
                    "CoolingDown" => SourceOutcome.CoolingDown, "Unsupported" => SourceOutcome.Unsupported,
                    "Unconfigured" => SourceOutcome.Unconfigured, "RequestBudget" => SourceOutcome.Partial,
                    _ => SourceOutcome.Failed
                },
                ex.Code, ex.Message, ex.RetryAt));
        }
        catch (System.Xml.XmlException ex)
        {
            writer.TryWrite(Snapshot(SourceOutcome.Failed, "SourceFailure",
                $"The site returned invalid RSS/XML at line {ex.LineNumber}, column {ex.LinePosition}."));
        }
        catch (Exception ex) when (ex is HttpRequestException or JsonException or
            FormatException or InvalidOperationException or ArgumentException or IOException or
            NotSupportedException or
            System.Text.RegularExpressions.RegexMatchTimeoutException)
        {
            writer.TryWrite(Snapshot(SourceOutcome.Failed, "SourceFailure",
                ex is HttpRequestException ? "The source could not be reached securely." : "The source returned a malformed response."));
        }
        finally { writer.TryComplete(); }
    }

    private async IAsyncEnumerable<CoreAdapters.Page> PagesAsync(string id, SourceSettings settings, SourceQuery query,
        int limit, CallTrace trace, [EnumeratorCancellation] CancellationToken ct)
    {
        if (settings.Type == "torznab") id = "torznab";
        if (id is not ("apibay" or "nyaa" or "eztv" or "yts" or "torrentscsv" or "knaben" or "animetosho"))
        {
            await foreach (var page in AdditionalAdapters.SearchAsync(id, settings, query, limit, transport, trace, configuration, ct))
                yield return page;
            yield break;
        }
        string? cursor = null;
        var hashes = new HashSet<string>(StringComparer.Ordinal);
        for (var page = 1; page <= 4; page++)
        {
            ct.ThrowIfCancellationRequested();
            var request = CoreAdapters.Request(id, settings.BaseUrl!, query, page, limit, cursor);
            var content = await transport.ReadAsync(request.Uri, request.Body, settings, query, trace, ct);
            var parsed = CoreAdapters.Parse(id, content);
            ct.ThrowIfCancellationRequested();
            cursor = parsed.Cursor;
            foreach (var release in parsed.Rows) hashes.Add(release.Hash);
            var more = parsed.HasMore || parsed.Rows.Count > limit;
            yield return parsed with { HasMore = more };
            if (!more || !request.Paginates || hashes.Count >= limit || page == 4) yield break;
        }
    }

    private async Task<SourceSettings?> SettingsAsync(string id, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredKeyedService<IStore>("find");
        var rows = await store.ReadAsync<SettingRow>(new("sources", null, null, null, null, null, null,
            null, null, null, null, null, null, null, 1, StoreOrder.PrimaryKey), ct).ConfigureAwait(false);
        SourceSettings? defaults = null;
        if (rows.Length > 0 && rows[0].Value.ValueKind == JsonValueKind.Array)
        {
            var configured = rows[0].Value.Deserialize<ImmutableArray<SourceSettings>>(SettingsJson);
            defaults = configured.FirstOrDefault(s => s.Id == id);
        }
        if (defaults is null) return null;
        var section = configuration.GetSection($"TorrentFlow:Sources:{id}");
        return defaults with
        {
            BaseUrl = section["BaseUrl"] ?? defaults.BaseUrl ?? SourceDefaults.Endpoints.GetValueOrDefault(id),
            Enabled = section.GetValue<bool?>("Enabled") ?? defaults.Enabled
        };
    }
}
