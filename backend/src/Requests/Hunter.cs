using System.Collections.Immutable;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Requests;

public sealed record HunterItem(string WorkKey, string EpisodeId, int Season, int Episode,
    DateTimeOffset ExpectedAt, string Origin, string Status, string? RuleId = null,
    string? Message = null);
public sealed record HunterPass(string Lane, bool Busy, ImmutableArray<HunterItem> Items, int Owned,
    int Existing, int Notifications, string? BlockedReason);

public sealed class Hunter(AutomationRepository repository, IMetadata metadata, TargetPipeline targets,
    ILogger<Hunter> logger)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    public async Task<HunterPass> RunAsync(CancellationToken ct)
    {
        if (!await gate.WaitAsync(0, ct)) return new("background", true, [], 0, 0, 0, null);
        try
        {
            var now = DateTimeOffset.UtcNow;
            var snapshot = await targets.ReadAsync(ct);
            var inventory = await repository.ReadAsync<MediaFileRow>(ct);
            var items = ImmutableArray.CreateBuilder<HunterItem>();
            var ownedCount = 0;
            var existingCount = 0;
            var acceptedTargets = new HashSet<string>(StringComparer.Ordinal);

            foreach (var rule in (await repository.ReadAsync<AutoRuleRow>(ct)).Where(r => r.Enabled))
            {
                var matches = await metadata.SearchAsync(new(rule.Query,
                    rule.Category == "movies" ? "films" : rule.Category, 20), ct);
                var queued = 0;
                foreach (var match in matches.Works)
                {
                    var result = await metadata.GetWorkAsync(match.Work.WorkKey, false, ct);
                    if (result.Work is not { } work) continue;
                    var owned = inventory.Where(f => f.WorkId == work.Work.Id &&
                        f.Role == FileRole.Video && (f.Status is FilePresence.Present or FilePresence.Offline) &&
                        File.Exists(f.Path)).ToArray();
                    var targetsForWork = snapshot.Targets.Where(t => t.WorkId == work.Work.Id &&
                        t.State != TargetState.Removed).ToArray();

                    if (work.Work.Kind == WorkKind.Film)
                    {
                        if (owned.Any(f => f.EpisodeId is null))
                        {
                            ownedCount++;
                            continue;
                        }
                        if (targetsForWork.Any(t => t.EpisodeId is null) ||
                            !acceptedTargets.Add(work.Work.Id + ":film"))
                        {
                            existingCount++;
                            continue;
                        }
                        var accepted = await targets.AcceptAutomationAsync(
                            new(work.Work.Id, Quality: rule.ResolutionFloor),
                            IntentOrigin.Rule, rule.Id, rule.MinListedSeeders, rule.MaxBytes, ct);
                        queued += accepted.Queued;
                        ownedCount += accepted.Owned;
                        existingCount += accepted.Queued == 0 && accepted.Owned == 0 ? 1 : 0;
                        if (accepted.Queued > 0)
                            items.Add(new(work.Work.WorkKey, "", 0, 0,
                                work.Work.DigitalAt ?? now, "Rule",
                                "queued", rule.Id, accepted.Message));
                        continue;
                    }

                    foreach (var episode in work.Episodes.Where(e =>
                        e.MappingStatus == MappingStatus.Confirmed && e.AirAt is { } air && air <= now))
                    {
                        var season = work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId);
                        if (season is null || season.Number < 1) continue;
                        if (owned.Any(f => f.EpisodeId == episode.Id))
                        {
                            ownedCount++;
                            continue;
                        }
                        var targetKey = work.Work.Id + ":" + episode.Id;
                        if (targetsForWork.Any(t => t.EpisodeId == episode.Id) ||
                            !acceptedTargets.Add(targetKey))
                        {
                            existingCount++;
                            continue;
                        }
                        var accepted = await targets.AcceptAutomationAsync(
                            new(work.Work.Id, season.Number, episode.Number, rule.ResolutionFloor),
                            IntentOrigin.Rule, rule.Id, rule.MinListedSeeders, rule.MaxBytes, ct);
                        queued += accepted.Queued;
                        ownedCount += accepted.Owned;
                        existingCount += accepted.Queued == 0 && accepted.Owned == 0 ? 1 : 0;
                        if (accepted.Queued > 0)
                            items.Add(new(work.Work.WorkKey, episode.Id, season.Number, episode.Number,
                                episode.AirAt!.Value, "Rule",
                                "queued", rule.Id, accepted.Message));
                    }
                }
                await repository.SaveAsync(rule with
                {
                    LastRunAt = now,
                    MatchCount = rule.MatchCount + queued,
                    UpdatedAt = now,
                    Version = rule.Version + 1,
                }, rule.Version, ct);
            }

            foreach (var follow in (await repository.ReadAsync<FollowRow>(ct)).Where(f => f.Enabled))
            {
                try
                {
                    var currentFollow = follow;
                    var result = await metadata.GetWorkAsync(currentFollow.WorkId, false, ct);
                    if (result.Work is not { } work) continue;

                    var owned = inventory.Where(f => f.WorkId == work.Work.Id &&
                        f.Role == FileRole.Video && (f.Status is FilePresence.Present or FilePresence.Offline) &&
                        File.Exists(f.Path)).ToArray();
                    var targetsForWork = snapshot.Targets.Where(t => t.WorkId == work.Work.Id).ToArray();

                    if (work.Work.Kind == WorkKind.Film)
                    {
                        if (owned.Any(f => f.EpisodeId is null))
                        {
                            ownedCount++;
                            continue;
                        }
                        if (targetsForWork.Any(t => t.EpisodeId is null))
                        {
                            existingCount++;
                            continue;
                        }

                        var link = work.Links.FirstOrDefault(l =>
                            l.IsPrimary && l.Status == LinkStatus.Verified) ??
                            work.Links.FirstOrDefault(l => l.Status == LinkStatus.Verified);
                        var extras = await metadata.ExtrasAsync(new(link is null ? null :
                            new(link.Provider, link.ExternalId, link.ProviderKind),
                            work.Names.FirstOrDefault(n => n.Label == NameLabel.English)?.Value ??
                                work.Names.FirstOrDefault()?.Value ?? work.Work.WorkKey,
                            work.Work.Year, work.Work.Kind), null, ct);
                        if (extras is null) continue;
                        var releaseAt = ReleaseAvailability.ReleaseDate(extras.Work);
                        var released = ReleaseAvailability.HunterReleased(extras.Work, now);
                        if (!released || extras.InTheatricalWindow) continue;

                        if (await ReadEnabledFollowAsync(follow.Id, ct) is null) continue;
                        if (!acceptedTargets.Add(work.Work.Id + ":film"))
                        {
                            existingCount++;
                            continue;
                        }
                        var accepted = await targets.AcceptAutomationAsync(
                            new(work.Work.Id), IntentOrigin.Follow, null, null, null, ct);
                        ownedCount += accepted.Owned;
                        existingCount += accepted.Queued == 0 && accepted.Owned == 0 ? 1 : 0;
                        if (accepted.Queued > 0)
                            items.Add(new(work.Work.WorkKey, "", 0, 0, releaseAt ?? now,
                                "Follow", "queued", Message: accepted.Message));
                        continue;
                    }

                    if (work.Work.Kind != WorkKind.Series) continue;
                    var seasonsById = work.Seasons.ToDictionary(s => s.Id);
                    var aired = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
                        e.AirAt is { } air && air <= now && seasonsById.TryGetValue(e.SeasonId, out var season) &&
                        season.Number >= 1).ToArray();
                    IEnumerable<EpisodeRow> inScope;
                    if (currentFollow.FromEpisodeId is { } fromEpisodeId)
                    {
                        var start = work.Episodes.FirstOrDefault(e => e.Id == fromEpisodeId);
                        if (start is null || !seasonsById.TryGetValue(start.SeasonId, out var startSeason))
                            continue;
                        inScope = aired.Where(e =>
                        {
                            var season = seasonsById[e.SeasonId];
                            return season.Number > startSeason.Number ||
                                season.Number == startSeason.Number && e.Number >= start.Number;
                        });
                    }
                    else if (currentFollow.NewEpisodesSince > DateTimeOffset.UnixEpoch)
                    {
                        var since = currentFollow.NewEpisodesSince.UtcDateTime.Date;
                        inScope = aired.Where(e => e.AirAt!.Value.UtcDateTime.Date >= since);
                    }
                    else
                    {
                        var latestSeason = aired.Select(e => seasonsById[e.SeasonId].Number)
                            .DefaultIfEmpty(0).Max();
                        inScope = aired.Where(e => seasonsById[e.SeasonId].Number == latestSeason);
                    }

                    var acceptedEpisodes = 0;
                    foreach (var episode in inScope.OrderBy(e => seasonsById[e.SeasonId].Number)
                                 .ThenBy(e => e.Number))
                    {
                        if (acceptedEpisodes >= 25) break;
                        try
                        {
                            var season = seasonsById[episode.SeasonId];
                            if (owned.Any(f => f.EpisodeId == episode.Id)) continue;
                            var targetKey = work.Work.Id + ":" + episode.Id;
                            if (targetsForWork.Any(t => t.EpisodeId == episode.Id) ||
                                !acceptedTargets.Add(targetKey))
                            {
                                existingCount++;
                                continue;
                            }
                            if (await ReadEnabledFollowAsync(follow.Id, ct) is null) break;

                            var accepted = await targets.AcceptAutomationAsync(
                                new(work.Work.Id, season.Number, episode.Number, null),
                                IntentOrigin.Follow, null, null, null, ct);
                            ownedCount += accepted.Owned;
                            existingCount += accepted.Queued == 0 && accepted.Owned == 0 ? 1 : 0;
                            if (accepted.Queued <= 0) continue;
                            acceptedEpisodes++;
                            items.Add(new(work.Work.WorkKey, episode.Id, season.Number, episode.Number,
                                episode.AirAt!.Value, "Follow", "queued", Message: accepted.Message));
                        }
                        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                        catch (Exception ex) { LogFollowFailure(ex, follow.Id, episode.Id); }
                    }
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
                catch (Exception ex) { LogFollowFailure(ex, follow.Id, null); }
            }
            return new("background", false, items.ToImmutable(), ownedCount, existingCount, 0, null);
        }
        finally { gate.Release(); }
    }

    private async Task<FollowRow?> ReadEnabledFollowAsync(string id, CancellationToken ct) =>
        (await repository.ReadAsync<FollowRow>(ct)).FirstOrDefault(f => f.Id == id && f.Enabled);

    private void LogFollowFailure(Exception exception, string followId, string? episodeId) =>
        logger.LogWarning(exception, "Automatic follow {FollowId} failed for episode {EpisodeId}; continuing.",
            followId, episodeId);
}

public sealed class HunterScheduler(Hunter hunter, IConfiguration configuration, ILogger<HunterScheduler> logger)
    : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (configuration.GetValue<bool>("TorrentFlow:Scheduler:Disabled")) return;
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(
            Math.Clamp(configuration.GetValue("TorrentFlow:Scheduler:IntervalMinutes", 15), 1, 1440)));
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            try { await hunter.RunAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning(ex, "Automatic checks failed; retrying on the next pass."); }
        }
    }
}
