using System.Collections.Immutable;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal sealed class CheckRepository(IServiceScopeFactory scopes, CheckOptions options) : ICheckRepository
{
    private readonly SemaphoreSlim writes = new(1);

    public async Task<EngineSettings> SettingsAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var entity = await db.Set<Dictionary<string, object>>("Setting").AsNoTracking()
            .SingleAsync(r => EF.Property<string>(r, "section") == "engine", ct);
        return SettingsCatalog.Read<EngineSettings>((SettingRow)Schema.Table("Setting").ToRow(entity));
    }

    public async Task<ImmutableArray<SwarmEvidence>> LoadAsync(ImmutableArray<string> hashes, CancellationToken ct)
    {
        if (hashes.Length > 500) throw new ArgumentException("Read at most 500 hashes.");
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var values = hashes.Distinct().ToArray();
        var verdicts = await db.Set<Dictionary<string, object>>("Verdict").AsNoTracking()
            .Where(r => values.Contains(EF.Property<string>(r, "hash"))).ToListAsync(ct);
        var releases = await db.Set<Dictionary<string, object>>("Release").AsNoTracking()
            .Where(r => values.Contains(EF.Property<string>(r, "hash"))).ToListAsync(ct);
        var evidence = Evidence(verdicts, releases, await SettingsAsync(ct));
        var files = releases.Select(r => (ReleaseRow)Schema.Table("Release").ToRow(r)).ToDictionary(r => r.Id, r => r.Files);
        return [.. values.Select(hash => evidence.FirstOrDefault(e => e.Hash == hash) ??
            new SwarmEvidence(hash, HealthBand.Unknown, files.GetValueOrDefault(hash), 0, 0, 0, 0,
                TimeSpan.Zero, null, "No cached swarm measurement.", DateTimeOffset.MinValue,
                DateTimeOffset.MinValue, false, false, null) { FromCache = true })];
    }

    public async Task<ImmutableArray<SwarmEvidence>> RecentAsync(int limit, CancellationToken ct)
    {
        if (limit is < 1 or > 500) throw new ArgumentOutOfRangeException(nameof(limit));
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var verdicts = await db.Set<Dictionary<string, object>>("Verdict").AsNoTracking()
            .OrderByDescending(r => EF.Property<string>(r, "checkedAt")).Take(limit).ToListAsync(ct);
        var values = verdicts.Select(r => (string)r["hash"]).ToArray();
        var releases = await db.Set<Dictionary<string, object>>("Release").AsNoTracking()
            .Where(r => values.Contains(EF.Property<string>(r, "hash"))).ToListAsync(ct);
        return Evidence(verdicts, releases, await SettingsAsync(ct));
    }

    private ImmutableArray<SwarmEvidence> Evidence(List<Dictionary<string, object>> verdicts,
        List<Dictionary<string, object>> releases, EngineSettings settings)
    {
        var files = releases.Select(r => (ReleaseRow)Schema.Table("Release").ToRow(r)).ToDictionary(r => r.Id, r => r.Files);
        var now = DateTimeOffset.UtcNow;
        var version = CheckVersion.For(settings, options);
        return [.. verdicts.Select(entity =>
        {
            var row = (VerdictRow)Schema.Table("Verdict").ToRow(entity);
            var valid = row.ExpiresAt > now &&
                row.ProbeVersion == (row.Band == HealthBand.Unknown ? options.ProbeVersion : version) &&
                (row.Band != HealthBand.Good || row.ByteSendingPeers > 0 && row.BytesDelivered > 0) &&
                (row.Band != HealthBand.Dead || row.ProbeMetrics?.HashFailures > 0 ||
                    row.ByteSendingPeers == 0 && row.BytesDelivered == 0);
            return new SwarmEvidence(row.Id, valid ? row.Band : HealthBand.Unknown,
                files.GetValueOrDefault(row.Id), row.ConnectedPeers, row.ConnectedSeeders, row.ByteSendingPeers,
                row.BytesDelivered, TimeSpan.FromMilliseconds(row.SampleMilliseconds), row.ScrapedSeeders,
                valid ? row.Reason : "Cached measurement expired or has an invalid probe version.",
                row.CheckedAt, valid ? row.ExpiresAt : DateTimeOffset.MinValue, false, false, null)
                {
                    FromCache = true, ProbeVersion = row.ProbeVersion,
                    PieceLength = row.ProbeMetrics?.PieceLength,
                    VerifiedPieceBytes = row.ProbeMetrics?.VerifiedPieceBytes ?? 0,
                    VerifiedPieces = row.ProbeMetrics?.VerifiedPieces ?? 0,
                    HashFailures = row.ProbeMetrics?.HashFailures ?? 0,
                    PeerBytesReceived = row.ProbeMetrics?.PeerBytesReceived ?? ImmutableDictionary<string, long>.Empty,
                };
        })];
    }

    public async Task SaveAsync(Candidate candidate, SwarmEvidence evidence, CancellationToken ct)
    {
        if (!evidence.Persistable || evidence.FromLiveTransfer || evidence.FromCache) return;
        ct.ThrowIfCancellationRequested();
        await writes.WaitAsync(ct);
        try { await SaveCoreAsync(candidate, evidence, ct); }
        finally { writes.Release(); }
    }

    private async Task SaveCoreAsync(Candidate candidate, SwarmEvidence evidence, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        await using var transaction = await db.Database.BeginTransactionAsync(ct);
        var releases = db.Set<Dictionary<string, object>>("Release");
        var release = await releases.SingleOrDefaultAsync(r => EF.Property<string>(r, "hash") == evidence.Hash, ct);
        var current = release is null ? candidate.Release : (ReleaseRow)Schema.Table("Release").ToRow(release);
        var next = current with { Files = current.Files ?? evidence.Files, LastSeenAt = evidence.CheckedAt };
        if (release is null) releases.Add(Schema.Table("Release").ToEntity(next));
        else db.Entry(release).CurrentValues.SetValues(Schema.Table("Release").ToEntity(next));
        var verdicts = db.Set<Dictionary<string, object>>("Verdict");
        var existing = await verdicts.SingleOrDefaultAsync(r => EF.Property<string>(r, "hash") == evidence.Hash, ct);
        var row = new VerdictRow(evidence.Hash, evidence.Band, evidence.ConnectedPeers, evidence.ConnectedSeeders,
            evidence.BytesDelivered, (int)evidence.Window.TotalMilliseconds, evidence.ScrapedSeeders, evidence.Reason,
            evidence.CheckedAt, evidence.ExpiresAt, evidence.ProbeVersion)
        {
            ByteSendingPeers = evidence.ByteSendingPeers,
            ProbeMetrics = new(evidence.PieceLength, evidence.VerifiedPieceBytes, evidence.VerifiedPieces,
                evidence.HashFailures, evidence.PeerBytesReceived),
        };
        if (existing is null) verdicts.Add(Schema.Table("Verdict").ToEntity(row));
        else if (((VerdictRow)Schema.Table("Verdict").ToRow(existing)).CheckedAt <= evidence.CheckedAt)
            db.Entry(existing).CurrentValues.SetValues(Schema.Table("Verdict").ToEntity(row));
        await db.SaveChangesAsync(ct);
        await transaction.CommitAsync(ct);
    }
}
