using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

internal sealed record DiscoveryStop(string ScopeKey, string PoolKey, string VerdictKey,
    DateTimeOffset NextTryAt, string Reason);

internal sealed class DiscoveryStopping(IServiceScopeFactory scopes, ICheck check)
{
    private const string ReasonCode = "discovery_stop";

    internal static string ScopeKey(WorkSnapshot work, TargetScope scope, Policy policy,
        PriorityLane lane, bool exhaust, ImmutableArray<TargetRow> targets,
        ImmutableArray<OwnedItem> owned, ImmutableHashSet<string>? excluded, CheckOptions options,
        ImmutableArray<string> sources = default) =>
        Digest(new
        {
            work = new
            {
                work.Work.Id, work.Work.Kind, work.Work.Format, work.Work.Anime, work.Work.Year,
                work.Work.OriginalLanguage, work.Work.RuntimeMinutes, work.Work.NumberingVersion,
                work.Work.TheatricalAt, work.Work.DigitalAt, work.Work.PhysicalAt, work.Work.ProviderStatus,
                names = work.Names.OrderBy(n => n.Id).Select(n => new
                {
                    n.Id, n.Value, n.NormalizedValue, n.Label, n.LinkId, n.Ordinal, n.Authoritative,
                }),
                links = work.Links.OrderBy(l => l.Id).Select(l => new
                {
                    l.Id, l.Provider, l.ExternalId, l.ProviderKind, l.SeasonId, l.MappingVersion, l.Status, l.IsPrimary,
                }),
                seasons = work.Seasons.OrderBy(s => s.Id).Select(s => new
                {
                    s.Id, s.Number, s.MappingStatus, s.ProviderEntryId, s.ExpectedEpisodeCount,
                }),
                episodes = work.Episodes.OrderBy(e => e.Id).Select(e => new
                {
                    e.Id, e.SeasonId, e.Number, e.AbsoluteNumber, e.AirAt, e.RuntimeMinutes, e.MappingStatus,
                }),
            },
            scope = new { scope.WorkId, scope.Film, EpisodeIds = scope.EpisodeIds.Order(StringComparer.Ordinal) },
            policy, lane, exhaust, options.UnknownMinutes, options.Slots, options.BackgroundSlots,
            sources = sources.IsDefault ? [] : sources.Order(StringComparer.Ordinal).ToArray(),
            targets = targets.OrderBy(t => t.Id).Select(t => new
            {
                t.Id, t.EpisodeId, t.Kind, t.ResolutionFloor, t.PreferredResolution,
                t.MaxBytes, t.PolicyRevision, t.MinListedSeeders, t.PickedReleaseHash,
                t.ReplaceMediaFileId, t.ReplacementMode,
            }),
            owned = owned.IsDefault ? [] : owned,
            excluded = excluded?.Order(StringComparer.OrdinalIgnoreCase).ToArray() ?? [],
        });

    internal static string PoolKey(CandidateBatch batch) => Digest(new
    {
        batch.Complete, batch.NamePhase, batch.Tier, batch.TierComplete,
        candidates = batch.Candidates.OrderBy(c => c.Release.Id).Select(c => new
        {
            c.Release.Id, c.Release.Name, c.Release.Parsed, c.Release.Files, c.Release.TotalBytes,
            c.TrustedSeeders, c.CoversFilm, c.CoveredEpisodeIds,
        }),
        queries = batch.Queries.OrderBy(q => q.SourceId, StringComparer.Ordinal)
            .ThenBy(q => q.Query, StringComparer.Ordinal).ThenBy(q => q.NamePhase).ThenBy(q => q.Tier)
            .Select(q => new { q.Query, q.SourceId, q.NamePhase, q.Tier, q.Result.Outcome }),
    });

    internal static string VerdictKey(IEnumerable<SwarmEvidence> evidence) => Digest(
        evidence.OrderBy(e => e.Hash).Select(e => new
        {
            e.Hash, e.Band, e.CheckedAt, e.ExpiresAt, e.ProbeVersion, e.Files, e.PieceLength,
        }));

    internal async Task<DiscoveryStop?> ReadAsync(string workId, string scopeKey, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var store = scope.ServiceProvider.GetRequiredService<IStore>();
        var history = await new CatalogState(store).ReadAsync<AttemptRow>(CatalogState.Query(workId: workId), ct);
        foreach (var attempt in history.Where(a => a.ReasonCode == ReasonCode)
                     .OrderByDescending(a => a.StartedAt))
        {
            if (attempt.LegacyContext is not { } context) continue;
            var stop = context.Deserialize<DiscoveryStop>();
            if (stop?.ScopeKey == scopeKey)
                return stop.NextTryAt > DateTimeOffset.UtcNow ? stop : null;
        }
        return null;
    }

    internal async Task SaveAsync(string workId, string scopeKey, CandidateBatch batch,
        ImmutableArray<TargetRow> targets, string reason,
        CheckOptions options, CancellationToken ct)
    {
        var measurements = ImmutableArray.CreateBuilder<SwarmEvidence>();
        foreach (var hashes in batch.Candidates.Select(c => c.Release.Id).Chunk(500))
            measurements.AddRange((await check.LoadAsync([.. hashes], ct)).Where(e =>
                e.ExpiresAt > DateTimeOffset.UtcNow && (e.Band != HealthBand.Unknown ||
                    e.CheckedAt.AddMinutes(options.UnknownMinutes) > DateTimeOffset.UtcNow)));
        var now = DateTimeOffset.UtcNow;
        var due = targets.Min(t => TargetPipeline.NextTry(t, WaitReason.RejectedCandidates, now));
        due = new[] { due, now.AddMinutes(30) }.Min();
        foreach (var measurement in measurements)
        {
            var expires = measurement.Band == HealthBand.Unknown
                ? new[] { measurement.ExpiresAt, measurement.CheckedAt.AddMinutes(options.UnknownMinutes) }.Min()
                : measurement.ExpiresAt;
            if (expires < due) due = expires;
        }
        if (due <= now) return;
        var stop = new DiscoveryStop(scopeKey, PoolKey(batch), VerdictKey(measurements), due, reason);
        await using var serviceScope = scopes.CreateAsyncScope();
        var store = serviceScope.ServiceProvider.GetRequiredService<IStore>();
        var attempt = new AttemptRow { Id = "discovery-stop:" + Guid.NewGuid().ToString("N"), TargetId = null, WorkId = workId, ReleaseHash = null, ActorUserId = null, Kind = AttemptKind.Plan, StartedAt = now, EndedAt = now, Outcome = "Stopped", ReasonCode = ReasonCode, ReasonText = reason, Decision = null, LegacyContext = JsonSerializer.SerializeToElement(stop), BatchId = null, DownloadId = null, DeadlineAt = null, Swap = null };
        await TargetPipeline.CommitAsync(store, [new(attempt, null, null)], [], ct);
    }

    private static string Digest<T>(T value) =>
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value))));
}
