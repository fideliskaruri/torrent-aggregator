using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal sealed class CatalogStore(IServiceScopeFactory scopes)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    internal static StoreQuery Query(string? id = null, string? workId = null, string? seasonId = null,
        string? cursor = null) => new(id, workId, null, null, null, null, null, seasonId, null,
            null, null, null, null, cursor, 500, StoreOrder.PrimaryKey);

    internal async Task<ImmutableArray<T>> ReadAsync<T>(StoreQuery query, CancellationToken ct) where T : StoreRow
    {
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IStore>().ReadAsync<T>(query, ct);
    }

    internal async Task<ImmutableArray<T>> AllAsync<T>(StoreQuery? query, CancellationToken ct) where T : StoreRow
    {
        var rows = ImmutableArray.CreateBuilder<T>();
        var pageQuery = query ?? Query();
        while (true)
        {
            var page = await ReadAsync<T>(pageQuery, ct);
            rows.AddRange(page);
            if (page.Length < pageQuery.Limit) return rows.ToImmutable();
            pageQuery = pageQuery with { Cursor = Convert.ToBase64String(Encoding.UTF8.GetBytes(page[^1].Id)) };
        }
    }

    internal async Task<CommitResult> CommitAsync(IEnumerable<RowWrite> writes, IEnumerable<RowDelete>? deletes,
        CancellationToken ct)
    {
        var key = Guid.CreateVersion7().ToString();
        var now = DateTimeOffset.UtcNow;
        var receipt = new AttemptRow { Id = "commit:metadata:" + key, TargetId = null, WorkId = null, ReleaseHash = null, ActorUserId = null, Kind = AttemptKind.LegacyEvent, StartedAt = now, EndedAt = now, Outcome = "metadata", ReasonCode = null, ReasonText = null, Decision = null, LegacyContext = null, BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
        await using var scope = scopes.CreateAsyncScope();
        return await scope.ServiceProvider.GetRequiredService<IStore>().CommitAsync(
            new(key, StoreOwner.Metadata, [.. writes, new(receipt, null, null)], [.. deletes ?? []]), ct);
    }

    internal async Task<MetadataSettings> SettingsAsync(CancellationToken ct)
    {
        var row = (await ReadAsync<SettingRow>(Query("metadata"), ct)).FirstOrDefault();
        var options = new JsonSerializerOptions(Json) { Converters = { new JsonStringEnumConverter() } };
        var settings = row?.Value.Deserialize<MetadataSettings>(options)
            ?? new(null, FribbMap.DefaultUrl, ["tmdb", "anilist", "cinemeta", "tvmaze", "itunes"]);
        var sources = settings.Sources;
        var metadata = sources.Where(s => s.Kind == "metadata").ToArray();
        return metadata.Length == 0 ? settings : settings with
            { EnabledProviders = [.. metadata.Where(s => s.Enabled).Select(s => s.Type)] };
    }

    internal async Task<ImmutableArray<SourceSettings>> SourceSettingsAsync(CancellationToken ct)
    {
        var row = (await ReadAsync<SettingRow>(Query("metadata"), ct)).FirstOrDefault();
        var options = new JsonSerializerOptions(Json) { Converters = { new JsonStringEnumConverter() } };
        return row?.Value.Deserialize<MetadataSettings>(options)?.Sources ?? [];
    }

    internal async Task<WorkSnapshot?> SnapshotAsync(string id, CancellationToken ct)
    {
        var work = (await ReadAsync<WorkRow>(Query(id), ct)).FirstOrDefault()
            ?? (await AllAsync<WorkRow>(null, ct)).FirstOrDefault(w => w.WorkKey == id);
        if (work is null) return null;
        var seasons = await AllAsync<SeasonRow>(Query(workId: work.Id), ct);
        var episodes = ImmutableArray.CreateBuilder<EpisodeRow>();
        foreach (var season in seasons)
            episodes.AddRange(await AllAsync<EpisodeRow>(Query(seasonId: season.Id), ct));
        return new(work, [.. (await AllAsync<WorkNameRow>(Query(workId: work.Id), ct)).OrderBy(n => n.Ordinal)],
            await AllAsync<WorkLinkRow>(Query(workId: work.Id), ct),
            [.. seasons.OrderBy(s => s.Number)], episodes.ToImmutable());
    }
}
