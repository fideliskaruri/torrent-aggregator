using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Api.Automation;

internal sealed record HunterItem(string WorkKey, string EpisodeId, int Season, int Episode,
    DateTimeOffset ExpectedAt, string Origin, string Status, string? RuleId = null,
    string? Message = null);
internal sealed record HunterPass(string Lane, bool Busy, ImmutableArray<HunterItem> Items, int Owned,
    int Existing, int Notifications, string? BlockedReason);

internal sealed class Hunter(AutomationRepository repository, IMetadata metadata, TargetPipeline targets,
    IServiceScopeFactory scopes)
{
    private readonly SemaphoreSlim gate = new(1, 1);

    internal async Task<HunterPass> RunAsync(CancellationToken ct)
    {
        if (!await gate.WaitAsync(0, ct)) return new("background", true, [], 0, 0, 0, null);
        try
        {
            await using var serviceScope = scopes.CreateAsyncScope();
            var library = serviceScope.ServiceProvider.GetRequiredService<ILibraryPlacement>();
            var now = DateTimeOffset.UtcNow;
            var snapshot = await targets.ReadAsync(ct);
            var items = ImmutableArray.CreateBuilder<HunterItem>();
            var ownedCount = 0;
            var existingCount = 0;
            foreach (var follow in (await repository.ReadAsync<FollowRow>(ct)).Where(f => f.Enabled))
            {
                var result = await metadata.GetWorkAsync(follow.WorkId, true, ct);
                if (result.Work is not { } work) continue;
                var aired = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
                    e.AirAt is { } air && air <= now &&
                    (follow.NewEpisodesSince == DateTimeOffset.UnixEpoch || air > follow.NewEpisodesSince)).ToArray();
                if (follow.FromEpisodeId is { } from)
                {
                    var start = work.Episodes.FirstOrDefault(e => e.Id == from);
                    var startSeason = work.Seasons.FirstOrDefault(s => s.Id == start?.SeasonId);
                    if (start is null || startSeason is null) continue;
                    aired = aired.Where(e => work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId) is { } season &&
                        (season.Number > startSeason.Number ||
                            season.Number == startSeason.Number && e.Number >= start.Number)).ToArray();
                }
                var owned = await library.OwnedAsync(new(work.Work.Id, [.. aired.Select(e => e.Id)], false), ct);
                foreach (var episode in aired)
                {
                    if (owned.Any(o => o.EpisodeId == episode.Id)) { ownedCount++; continue; }
                    if (snapshot.Targets.Any(t => t.WorkId == work.Work.Id && t.EpisodeId == episode.Id &&
                        t.State != TargetState.Removed)) { existingCount++; continue; }
                    var season = work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId);
                    if (season is null || season.Number < 1) continue;
                    var preference = (await repository.ReadAsync<WorkPreferenceRow>(ct)).FirstOrDefault(p => p.WorkId == work.Work.Id);
                    var accepted = await targets.AcceptAutomationAsync(new(work.Work.Id, season.Number,
                        episode.Number, preference?.ResolutionFloor ?? preference?.PreferredResolution),
                        IntentOrigin.Follow, null, null, null, ct);
                    items.Add(new(work.Work.WorkKey, episode.Id, season.Number, episode.Number,
                        episode.AirAt!.Value, "Follow", AdmissionProjection.Status(accepted),
                        Message: accepted.Message));
                }
            }
            foreach (var rule in (await repository.ReadAsync<AutoRuleRow>(ct)).Where(r => r.Enabled))
            {
                var matches = await metadata.SearchAsync(new(rule.Query, rule.Category == "movies" ? "films" : rule.Category, 20), ct);
                var count = 0;
                foreach (var match in matches.Works)
                {
                    var work = (await metadata.GetWorkAsync(match.Work.WorkKey, false, ct)).Work;
                    if (work is null) continue;
                    if (work.Work.Kind == WorkKind.Film)
                    {
                        var accepted = await targets.AcceptAutomationAsync(new(work.Work.Id, Quality: rule.ResolutionFloor),
                            IntentOrigin.Rule, rule.Id, rule.MinListedSeeders, rule.MaxBytes, ct);
                        count += accepted.Queued;
                        ownedCount += accepted.Owned;
                        items.Add(new(work.Work.WorkKey, "", 0, 0, work.Work.DigitalAt ?? now,
                            "Rule", AdmissionProjection.Status(accepted), rule.Id, accepted.Message));
                    }
                    else foreach (var episode in work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed && e.AirAt <= now))
                    {
                        var season = work.Seasons.FirstOrDefault(s => s.Id == episode.SeasonId);
                        if (season is null || season.Number < 1) continue;
                        var accepted = await targets.AcceptAutomationAsync(new(work.Work.Id, season.Number,
                            episode.Number, rule.ResolutionFloor), IntentOrigin.Rule, rule.Id,
                            rule.MinListedSeeders, rule.MaxBytes, ct);
                        count += accepted.Queued;
                        ownedCount += accepted.Owned;
                        if (accepted.Queued > 0 || accepted.Owned > 0)
                            items.Add(new(work.Work.WorkKey, episode.Id, season.Number, episode.Number,
                                episode.AirAt!.Value, "Rule", AdmissionProjection.Status(accepted),
                                rule.Id, accepted.Message));
                    }
                }
                await repository.SaveAsync(rule with { LastRunAt = now, MatchCount = rule.MatchCount + count,
                    UpdatedAt = now, Version = rule.Version + 1 }, rule.Version, ct);
            }
            const int notifications = 0;
            return new("background", false, items.ToImmutable(), ownedCount, existingCount, notifications,
                null);
        }
        finally { gate.Release(); }
    }
}

internal sealed class HunterScheduler(Hunter hunter, IConfiguration configuration, ILogger<HunterScheduler> logger)
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
