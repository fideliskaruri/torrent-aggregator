using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public sealed partial class TargetPipeline
{
    public async Task<TargetActionReply> AcquireAsync(AcquireInput input, string actor, CancellationToken ct)
        => await AcceptAsync(input, actor, IntentOrigin.Owner, null, null, null, ct);

    public Task<TargetActionReply> AcceptAutomationAsync(AcquireInput input, IntentOrigin origin,
        string? ruleId, int? minSeeders, long? maxBytes, CancellationToken ct)
    {
        if (origin is not (IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter))
            throw new ArgumentException("Choose a supported automatic origin.");
        return AcceptAsync(input, "local", origin, ruleId, minSeeders, maxBytes, ct);
    }

    public Task<TargetActionReply> AcceptRequestAsync(AcquireInput input, string actor, CancellationToken ct) =>
        AcceptAsync(input, actor, IntentOrigin.Request, null, null, null, ct);

    private async Task<TargetActionReply> AcceptAsync(AcquireInput input, string actor, IntentOrigin origin,
        string? ruleId, int? minSeeders, long? maxBytes, CancellationToken ct, bool lockHeld = false,
        MetadataResult? resolved = null)
    {
        ValidateAcceptInput(input, minSeeders, maxBytes);
        if (!lockHeld) await stateGate.WaitAsync(ct);
        try
        {
            await using var serviceScope = scopes.CreateAsyncScope();
            var store = serviceScope.ServiceProvider.GetRequiredService<TargetStore>();
            var refreshScope = !IsAutomatic(origin) && input.Season is not null && input.Episode is null;
            resolved ??= await serviceScope.ServiceProvider.GetRequiredService<IMetadata>()
                .GetWorkAsync(input.WorkKey, refreshScope, ct);
            var work = resolved.Work?.Work
                ?? throw new ArgumentException("Open the title before downloading it.");
            var preference = (await store.ListAsync<WorkPreferenceRow>(row => row.WorkId == work.Id, ct)).FirstOrDefault();
            var audioLanguage = await GlobalAudioLanguageAsync(store, ct);
            input = input with { Quality = input.Quality ?? preference?.ResolutionFloor ?? preference?.PreferredResolution };
            ValidateRequestedScope(work, input);
            var film = work.Kind == WorkKind.Film || work.Kind == WorkKind.Unknown && input.Season is null;
            var seasons = await store.ListAsync<SeasonRow>(row => row.WorkId == work.Id, ct);
            var season = seasons.FirstOrDefault(s => s.Number == input.Season);
            var episodes = season is null ? [] : await store.ListAsync<EpisodeRow>(row => row.SeasonId == season.Id, ct);
            var selected = episodes.Where(e => e.SeasonId == season?.Id &&
                (input.Episode is null || e.Number == input.Episode) && e.MappingStatus == MappingStatus.Confirmed).ToArray();
            var now = DateTimeOffset.UtcNow;
            if (!film && (selected.Length == 0 || refreshScope &&
                (resolved.Failure is not null || resolved.Stale || season?.MappingStatus != MappingStatus.Confirmed ||
                    episodes.Any(e => e.MappingStatus != MappingStatus.Confirmed))))
            {
                if (origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                    throw new ArgumentException("Automatic downloads need confirmed episodes. Try again after metadata refresh.");
                return await QueueUnmappedScopeAsync(store, work, input, actor, audioLanguage, now, ct);
            }
            var scope = new TargetScope(work.Id, [.. selected.Select(e => e.Id)], film);
            var owned = await serviceScope.ServiceProvider.GetRequiredService<ILibraryPlacement>()
                .OwnedAsync(scope, ct);
            var items = film ? new string?[] { null } : selected.Select(e => (string?)e.Id).ToArray();
            var existing = await store.ListAsync<TargetRow>(row => row.WorkId == work.Id, ct);
            var writes = ImmutableArray.CreateBuilder<RowWrite>();
            var ids = ImmutableArray.CreateBuilder<string>();
            var ownedCount = 0;
            var queued = 0;
            var batch = Guid.NewGuid().ToString("N");
            foreach (var episodeId in items)
            {
                if (owned.Any(o => o.EpisodeId == episodeId)) { ownedCount++; continue; }
                var old = existing.FirstOrDefault(t => t.EpisodeId == episodeId);
                if (old is not null && origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                    continue;
                var id = old?.Id ?? $"target:{work.Id}:{episodeId ?? "film"}";
                ids.Add(id);
                if (old is not null && old.State is TargetState.Waiting or TargetState.Wanted &&
                    old.ReasonCode != WaitReason.Paused)
                {
                    // A manual Download on an item parked by an earlier failed search searches again now,
                    // instead of answering "Already queued" until the old retry time (often a day later).
                    writes.Add(new(old with
                    {
                        State = TargetState.Wanted, ReasonCode = null, ReasonText = null, NextTryAt = null,
                        ResumeState = null, LeaseToken = null, LeaseUntil = null, ClickedAt = now,
                        Origin = old.Origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter
                            ? origin : old.Origin,
                        ResolutionFloor = input.Quality ?? old.ResolutionFloor,
                        PreferredResolution = input.Quality ?? old.PreferredResolution,
                        UpdatedAt = now, Version = old.Version + 1,
                    }, old.Version, null));
                    queued++;
                    continue;
                }
                if (old is not null && old.State is not (TargetState.Removed or TargetState.Done))
                {
                    continue;
                }
                var row = old is null
                    ? NewTargetRow(id, work, episodeId, selected, actor, origin, ruleId, maxBytes, input.Quality, batch, now)
                    : old with { Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                        PickedReleaseHash = old.PickedReleaseHash,
                        Origin = origin, CreatedBy = actor,
                        State = TargetState.Wanted, ReasonCode = null, ReasonText = null, NextTryAt = null,
                        ChosenReleaseHash = null, ResumeState = null, LeaseToken = null, LeaseUntil = null,
                        UpdatedAt = now, Version = old.Version + 1 };
                row = row with { MinListedSeeders = minSeeders ?? row.MinListedSeeders };
                writes.Add(new(row, old?.Version, null));
                queued++;
            }
            if (writes.Count > 0) await CommitAsync(store, writes.ToImmutable(), [], ct);
            return AcceptReply(queued, ownedCount, ids.ToImmutable());
        }
        finally { if (!lockHeld) stateGate.Release(); }
    }

    private static void ValidateAcceptInput(AcquireInput input, int? minSeeders, long? maxBytes)
    {
        if (input.Quality is < 1 or > 4320 || minSeeders is < 0 || maxBytes is <= 0)
            throw new ArgumentException("Choose a valid quality, seed count and size.");
    }

    private static bool IsAutomatic(IntentOrigin origin) =>
        origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter;

    private static void ValidateRequestedScope(WorkRow work, AcquireInput input)
    {
        if (work.Kind == WorkKind.Series && input.Season is null ||
            work.Kind == WorkKind.Film && (input.Season is not null || input.Episode is not null))
            throw new ArgumentException("Choose a season for a series, or Download for a film.");
    }

    private async Task<TargetActionReply> QueueUnmappedScopeAsync(TargetStore store, WorkRow work,
        AcquireInput input, string actor, string audioLanguage, DateTimeOffset now, CancellationToken ct)
    {
        var id = $"scope:{work.Id}:{input.Season}:{input.Episode}";
        var prior = (await store.ListAsync<ScopeIntentRow>(row => row.Id == id, ct)).SingleOrDefault();
        if (prior is null || prior.State == ScopeIntentState.Cancelled)
        {
            var intent = new ScopeIntentRow { Id = id, ActorUserId = actor, WorkId = work.Id,
                Episode = input.Episode, Scope = input.Episode is null ? RequestScope.Seasons : RequestScope.Episodes,
                ScopeData = new([input.Season ?? 1], false),
                Policy = new(input.Quality, input.Quality ?? 1080, audioLanguage, null, null),
                Now = false, BatchId = id, State = ScopeIntentState.Pending, NextTryAt = now,
                CreatedAt = prior?.CreatedAt ?? now, UpdatedAt = now, Version = (prior?.Version ?? 0) + 1 };
            await CommitAsync(store, [new(intent, prior?.Version, null)], [], ct);
        }
        var added = prior is null || prior.State == ScopeIntentState.Cancelled;
        return new(true, added ? 1 : 0, 0, [], added ? "Season queued." : "Already queued");
    }

    private static TargetRow NewTargetRow(string id, WorkRow work, string? episodeId,
        EpisodeRow[] selected, string actor, IntentOrigin origin, string? ruleId, long? maxBytes,
        int? quality, string batch, DateTimeOffset now) => new()
    {
        Id = id, WorkId = work.Id, EpisodeId = episodeId, Kind = TargetKind.Acquire,
        State = TargetState.Wanted, ReasonCode = null, ReasonText = null, NextTryAt = null,
        ExpectedAt = episodeId is null ? work.DigitalAt ?? work.PhysicalAt ?? work.TheatricalAt :
            selected.FirstOrDefault(e => e.Id == episodeId)?.AirAt,
        ResolutionFloor = quality, PreferredResolution = quality ?? 1080, MaxBytes = maxBytes,
        DownloadNow = false, CreatedBy = actor, Origin = origin, AutoRuleId = ruleId,
        ChosenReleaseHash = null, ReplaceMediaFileId = null, ReplacementMode = null,
        BatchId = batch, ClickedAt = now, SubstantiveMisses = 0, HelpNotifiedAt = null,
        LeaseUntil = null, LeaseToken = null, CreatedAt = now, UpdatedAt = now, Version = 1,
    };

    private static TargetActionReply AcceptReply(int queued, int owned, ImmutableArray<string> ids)
    {
        var message = queued == 0 && owned > 0 ? "Already in your library" :
            queued == 0 && ids.Length > 0 ? "Already queued" :
            owned > 0 ? $"{queued} queued, {owned} already in your library" : $"{queued} queued";
        return new(true, queued, owned, ids, message);
    }
}
