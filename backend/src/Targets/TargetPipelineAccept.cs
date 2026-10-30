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

    public Task<TargetActionReply> AcceptPickedAsync(string workKey, ImmutableArray<string> episodeIds,
        bool film, string releaseHash, string actor, CancellationToken ct)
    {
        if (string.IsNullOrWhiteSpace(workKey) || string.IsNullOrWhiteSpace(releaseHash))
            throw new ArgumentException("Choose a title and source.");
        releaseHash = releaseHash.Trim().ToLowerInvariant();
        if (releaseHash.Length != 40 || releaseHash.Any(c => !char.IsAsciiHexDigit(c)))
            throw new ArgumentException("Choose a valid source.");
        return AcceptAsync(new(workKey), actor, IntentOrigin.Owner, null, null, null, ct,
            pickedEpisodeIds: episodeIds, pickedFilm: film, pickedHash: releaseHash);
    }

    private async Task<TargetActionReply> AcceptAsync(AcquireInput input, string actor, IntentOrigin origin,
        string? ruleId, int? minSeeders, long? maxBytes, CancellationToken ct, bool lockHeld = false,
        MetadataResult? resolved = null, ImmutableArray<string>? pickedEpisodeIds = null,
        bool? pickedFilm = null, string? pickedHash = null)
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
            var seasons = await store.ListAsync<SeasonRow>(row => row.WorkId == work.Id, ct);
            var allEpisodes = seasons.Length == 0 ? [] :
                await store.ListAsync<EpisodeRow>(row => seasons.Select(s => s.Id).Contains(row.SeasonId), ct);
            bool film;
            EpisodeRow[] selected;
            var scopeUnmapped = false;
            if (pickedEpisodeIds is { } ids)
            {
                film = pickedFilm == true;
                if (film && (!ids.IsEmpty || work.Kind != WorkKind.Film) ||
                    !film && work.Kind != WorkKind.Series)
                    throw new ArgumentException("The chosen title does not match the torrent scope.");
                var requested = ids.Distinct(StringComparer.Ordinal).ToArray();
                selected = allEpisodes.Where(e => requested.Contains(e.Id, StringComparer.Ordinal) &&
                    e.MappingStatus == MappingStatus.Confirmed &&
                    seasons.FirstOrDefault(s => s.Id == e.SeasonId)?.MappingStatus == MappingStatus.Confirmed)
                    .ToArray();
                if (!film && (requested.Length == 0 || selected.Length != requested.Length))
                    throw new ArgumentException("The torrent does not identify confirmed episodes for this title.");
            }
            else
            {
                ValidateRequestedScope(work, input);
                film = work.Kind == WorkKind.Film || work.Kind == WorkKind.Unknown && input.Season is null;
                var season = seasons.FirstOrDefault(s => s.Number == input.Season);
                var seasonEpisodes = allEpisodes.Where(e => e.SeasonId == season?.Id).ToArray();
                selected = seasonEpisodes.Where(e =>
                    (input.Episode is null || e.Number == input.Episode) &&
                    e.MappingStatus == MappingStatus.Confirmed).ToArray();
                scopeUnmapped = season?.MappingStatus != MappingStatus.Confirmed ||
                    seasonEpisodes.Any(e => e.MappingStatus != MappingStatus.Confirmed);
            }
            var now = DateTimeOffset.UtcNow;
            if (!film && (selected.Length == 0 || refreshScope &&
                (resolved.Failure is not null || resolved.Stale || scopeUnmapped)))
            {
                if (origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                    throw new ArgumentException("Automatic downloads need confirmed episodes. Try again after metadata refresh.");
                return await QueueUnmappedScopeAsync(store, work, input, actor, audioLanguage, now, ct);
            }
            var scope = new TargetScope(work.Id, [.. selected.Select(e => e.Id)], film);
            var library = serviceScope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var owned = await library.OwnedAsync(scope, ct);
            var jellyfinOwnedEpisodes = ImmutableHashSet<string>.Empty.WithComparer(StringComparer.Ordinal);
            if (!film && input.Season is not null && input.Episode is null)
            {
                var media = await serviceScope.ServiceProvider.GetRequiredService<ILibraryRepository>()
                    .MediaAsync(work.Id, ct);
                var jellyfin = await jellyfinOwnedStateReader.ReadAsync(resolved.Work!, media, ct);
                if (jellyfin?.EpisodeItemIds is { } itemIds)
                    jellyfinOwnedEpisodes = itemIds.Keys.ToImmutableHashSet(StringComparer.Ordinal);
            }
            var items = film ? new string?[] { null } : selected.Select(e => (string?)e.Id).ToArray();
            var existing = await store.ListAsync<TargetRow>(row => row.WorkId == work.Id, ct);
            var batch = Guid.NewGuid().ToString("N");
            var result = BuildTargetWrites(items, owned, existing, work, selected, actor, origin,
                ruleId, maxBytes, input.Quality, minSeeders, batch, now, pickedHash, jellyfinOwnedEpisodes);
            if (result.Writes.Length > 0) await CommitAsync(store, result.Writes, [], ct);
            foreach (var id in result.SearchingIds)
                if (cancellations.TryGetValue(id, out var cancellation)) cancellation.Cancel();
            return AcceptReply(result.Queued, result.Owned, result.Ids);
        }
        finally { if (!lockHeld) stateGate.Release(); }
    }

    private sealed record AcceptWrites(ImmutableArray<RowWrite> Writes, ImmutableArray<string> Ids,
        ImmutableArray<string> SearchingIds, int Queued, int Owned);

    private static AcceptWrites BuildTargetWrites(string?[] items, ImmutableArray<OwnedItem> owned,
        TargetRow[] existing, WorkRow work, EpisodeRow[] selected, string actor,
        IntentOrigin origin, string? ruleId, long? maxBytes, int? quality, int? minSeeders,
        string batch, DateTimeOffset now, string? pickedHash, ImmutableHashSet<string> jellyfinOwnedEpisodes)
    {
        var writes = ImmutableArray.CreateBuilder<RowWrite>();
        var ids = ImmutableArray.CreateBuilder<string>();
        var searching = ImmutableArray.CreateBuilder<string>();
        var ownedCount = 0;
        var queued = 0;
        foreach (var episodeId in items)
        {
            if (owned.Any(o => o.EpisodeId == episodeId) ||
                episodeId is not null && jellyfinOwnedEpisodes.Contains(episodeId))
            {
                ownedCount++;
                continue;
            }
            // One target row per episode (unique index), so a Replace row is reused and rewritten too.
            var old = existing.FirstOrDefault(t => t.EpisodeId == episodeId);
            if (old is not null && origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter)
                continue;
            var id = old?.Id ?? $"target:{work.Id}:{episodeId ?? "film"}";
            ids.Add(id);
            if (pickedHash is not null)
            {
                if (old is not null && (old.State is TargetState.Fetching or TargetState.Filing ||
                    old.ResumeState is TargetState.Fetching or TargetState.Filing)) continue;
                if (old is not null && old.State is not
                    (TargetState.Waiting or TargetState.Wanted or TargetState.Searching or TargetState.Done or TargetState.Removed))
                    continue;
                if (old?.State == TargetState.Searching) searching.Add(id);
                var picked = old is null
                    ? NewTargetRow(id, work, episodeId, selected, actor, IntentOrigin.Owner, null,
                        maxBytes, quality, batch, now)
                    : old with
                    {
                        Kind = TargetKind.Acquire, ReplacementMode = null, ReplaceMediaFileId = null,
                        Origin = IntentOrigin.Owner, CreatedBy = actor, State = TargetState.Wanted,
                        ReasonCode = null, ReasonText = null, NextTryAt = null, ResumeState = null,
                        LeaseToken = null, LeaseUntil = null, ClickedAt = now, SubstantiveMisses = 0,
                        HelpNotifiedAt = null, ChosenReleaseHash = null, BatchId = batch,
                        ResolutionFloor = quality ?? old.ResolutionFloor,
                        PreferredResolution = quality ?? old.PreferredResolution,
                        UpdatedAt = now, Version = old.Version + 1,
                    };
                picked = picked with { PickedReleaseHash = pickedHash, MinListedSeeders = null };
                writes.Add(new(picked, old?.Version, null));
                queued++;
                continue;
            }
            if (old is not null && old.State is TargetState.Waiting or TargetState.Wanted &&
                old.ReasonCode != WaitReason.Paused)
            {
                writes.Add(new(old with
                {
                    State = TargetState.Wanted, ReasonCode = null, ReasonText = null, NextTryAt = null,
                    ResumeState = null, LeaseToken = null, LeaseUntil = null, ClickedAt = now,
                    SubstantiveMisses = 0,
                    Origin = old.Origin is IntentOrigin.Follow or IntentOrigin.Rule or IntentOrigin.Hunter
                        ? origin : old.Origin,
                    ResolutionFloor = quality ?? old.ResolutionFloor,
                    PreferredResolution = quality ?? old.PreferredResolution,
                    UpdatedAt = now, Version = old.Version + 1,
                }, old.Version, null));
                queued++;
                continue;
            }
            if (old is not null && old.State is not (TargetState.Removed or TargetState.Done))
                continue;
            var row = old is null
                ? NewTargetRow(id, work, episodeId, selected, actor, origin, ruleId, maxBytes, quality, batch, now)
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
        return new(writes.ToImmutable(), ids.ToImmutable(), searching.ToImmutable(), queued, ownedCount);
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
