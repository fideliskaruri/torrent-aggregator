using System.Collections.Concurrent;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>
/// Pre-warm the next episode (src/lib/prewarm/prewarm.ts). Once ~15% of an episode is watched, quietly start
/// fetching the next one. Never a user action: no DownloadHistory, never advances the library cursor, stamped
/// origin=prewarm + GrabJob kind=prewarm, never surfaces an error.
/// </summary>
public sealed class PrewarmService
{
    public const double TriggerFraction = 0.15;
    public const int MaxConcurrentPrewarms = 1;
    public const double MinForegroundProgress = 0.5;
    public static readonly TimeSpan Cooldown = TimeSpan.FromMinutes(30);

    private readonly IDbContextFactory<TorrentFlowDbContext> _factory;
    private readonly ITorrentEngine _engine;
    private readonly ITorrentSearchService _search;
    private readonly PreRanker _ranker;
    private readonly PrewarmEviction _eviction;
    private readonly ForegroundTracker _foreground;
    private readonly TimeProvider _time;
    private readonly ILogger _logger;
    private readonly ConcurrentDictionary<string, byte> _inFlight = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _cooldownUntil = new(StringComparer.Ordinal);

    public PrewarmService(IDbContextFactory<TorrentFlowDbContext> factory, ITorrentEngine engine, ITorrentSearchService search,
        PreRanker ranker, PrewarmEviction eviction, ForegroundTracker foreground, TimeProvider? time = null, ILogger<PrewarmService>? logger = null)
    {
        _factory = factory;
        _engine = engine;
        _search = search;
        _ranker = ranker;
        _eviction = eviction;
        _foreground = foreground;
        _time = time ?? TimeProvider.System;
        _logger = (ILogger?)logger ?? NullLogger.Instance;
    }

    private long NowMs => _time.GetUtcNow().ToUnixTimeMilliseconds();

    /// <summary>Clear cooldowns and in-flight state. Tests only.</summary>
    public void ResetRuntimeState() { _inFlight.Clear(); _cooldownUntil.Clear(); }

    public static bool ShouldTrigger(double positionSec, double? durationSec)
    {
        if (durationSec is not { } d || !double.IsFinite(d) || d <= 0) return false;
        if (!double.IsFinite(positionSec) || positionSec < 0) return false;
        return positionSec / d >= TriggerFraction;
    }

    public sealed record PlaybackContext
    {
        public required string UserId { get; init; }
        public required string InfoHash { get; init; }
        public required string Title { get; init; }
        public double? Season { get; init; }
        public double? Episode { get; init; }
        public string? WatchListItemId { get; init; }
        public double PositionSec { get; init; }
        public double? DurationSec { get; init; }
    }

    private static int? Unit(double? n)
    {
        if (n is not { } value || !double.IsFinite(value)) return null;
        var v = Math.Truncate(value);
        return v >= 1 && v <= int.MaxValue ? (int)v : null;
    }

    /// <summary>The episode a pre-warm should fetch, or null. What is playing first, then the hunt cursor. Never moves a cursor.</summary>
    public async Task<NextEpisode?> ResolveNextEpisodeAsync(PlaybackContext ctx, CancellationToken ct = default)
    {
        var season = Unit(ctx.Season);
        var episode = Unit(ctx.Episode);
        WatchListItem? item = null;
        if (!string.IsNullOrEmpty(ctx.WatchListItemId))
        {
            try
            {
                await using var db = await _factory.CreateDbContextAsync(ct);
                item = await db.WatchListItems.AsNoTracking().FirstOrDefaultAsync(i => i.Id == ctx.WatchListItemId && i.UserId == ctx.UserId, ct);
            }
            catch (Exception e) when (!ct.IsCancellationRequested)
            {
                _logger.LogDebug(e, "[prewarm] watchlist item unreadable");
                item = null;
            }
        }

        if (item is not null)
        {
            if (!ReleaseText.IsSeriesMediaType(item.MediaType)) return null;
            if (season is { } s && episode is { } e)
            {
                var next = ReleaseText.AdvanceCursor(s, e);
                return new NextEpisode { Title = item.Title, MediaType = item.MediaType, Season = next.Season, Episode = next.Episode, WatchListItemId = item.Id, Source = "playing-episode" };
            }
            var hunt = ReleaseText.ResolveHuntCursor(item.MediaType, item.CursorSeason, item.CursorEpisode, item.FromSeason, item.FromEpisode, item.LastEpisode, item.NextEpisodeHint);
            if (hunt is not { } cursor) return null;
            return new NextEpisode { Title = item.Title, MediaType = item.MediaType, Season = cursor.Season, Episode = cursor.Episode, WatchListItemId = item.Id, Source = "hunt-cursor" };
        }

        // No library row: a series only if the player told us an episode; the show name comes from the release name.
        if (season is not { } ps || episode is not { } pe) return null;
        var name = ReleaseText.WorkName(ctx.Title).Trim();
        if (name.Length == 0) return null;
        var advanced = ReleaseText.AdvanceCursor(ps, pe);
        return new NextEpisode { Title = name, MediaType = null, Season = advanced.Season, Episode = advanced.Episode, WatchListItemId = null, Source = "playing-episode" };
    }

    /// <summary>Client configuration a pre-warm needs. External clients are not supported by the .NET host.</summary>
    public sealed record ClientConfig(string ClientType);

    public sealed record RunOptions
    {
        public required string UserId { get; init; }
        public required NextEpisode Next { get; init; }
        public IReadOnlyList<string>? ProtectHashes { get; init; }
        public bool Force { get; init; }
        /// <summary>Test seam: when set, replaces the DB lookup (a null value = no client configured).</summary>
        public Func<ClientConfig?>? Config { get; init; }
        public Func<string, Task<EngineActionResult>>? Delete { get; init; }
        /// <summary>Test seam: overrides the foreground-progress read (a null value = cannot tell).</summary>
        public Func<double?>? ForegroundProgress { get; init; }
        public bool? ForegroundActive { get; init; }
    }

    private static PreRankTarget TargetOf(NextEpisode next) =>
        new() { Title = next.Title, MediaType = next.MediaType, Season = next.Season, Episode = next.Episode };

    private static PrewarmOutcome Outcome(string status, string reason, string message, NextEpisode? next = null, string? title = null) =>
        new() { Status = status, Reason = reason, Message = message, Next = next, Title = title };

    /// <summary>Speculatively grab <see cref="RunOptions.Next"/>, honouring the disk budget. Never throws.</summary>
    public async Task<PrewarmOutcome> PrewarmNextEpisodeAsync(RunOptions options, CancellationToken ct = default)
    {
        var next = options.Next;
        var label = ReleaseText.FormatEpisodeLabel(next.Season, next.Episode);
        var title = $"{next.Title} {label}";
        var key = $"{options.UserId}|{PreRanker.Key(TargetOf(next))}";

        if (_inFlight.ContainsKey(key)) return Outcome("skipped", "in-flight", $"Already pre-warming {label}", next, title);
        if (!options.Force && _cooldownUntil.TryGetValue(key, out var until) && until > NowMs)
            return Outcome("skipped", "cooldown", $"Pre-warmed {label} recently", next, title);
        if (!_inFlight.TryAdd(key, 0)) return Outcome("skipped", "in-flight", $"Already pre-warming {label}", next, title);
        try
        {
            return await RunAsync(options, next, label, title, key, ct);
        }
        catch (Exception e)
        {
            _logger.LogWarning("[prewarm] {Label} failed: {Message}", label, e.Message);
            return Outcome("failed", "error", e.Message, next, title);
        }
        finally
        {
            _inFlight.TryRemove(key, out _);
        }
    }

    private static List<string> NormalizeHashes(IEnumerable<string>? hashes) =>
        (hashes ?? []).Select(h => h.Trim().ToLowerInvariant()).Where(h => h.Length > 0).Distinct().ToList();

    private async Task<ClientConfig?> ClientConfigAsync(string userId, CancellationToken ct)
    {
        await using var db = await _factory.CreateDbContextAsync(ct);
        var type = await db.ClientSettings.AsNoTracking().Where(s => s.UserId == userId).Select(s => s.ClientType).FirstOrDefaultAsync(ct);
        return new ClientConfig(string.IsNullOrWhiteSpace(type) ? "builtin" : type);
    }

    private async Task<PrewarmOutcome> RunAsync(RunOptions options, NextEpisode next, string label, string title, string key, CancellationToken ct)
    {
        var userId = options.UserId;
        var protect = NormalizeHashes(options.ProtectHashes);

        if (await ForegroundIsStreamOnlyAsync(userId, protect, ct))
            return Outcome("skipped", "streaming-source", "Playing a stream, not a download — next episode stays on demand", next, title);

        var config = options.Config is not null ? options.Config() : await ClientConfigAsync(userId, ct);
        if (config is null) return Outcome("skipped", "no-client", "No client configured", next, title);
        if (config.ClientType != "builtin")
            return Outcome("skipped", "unlabelable-client", $"Pre-warm needs the built-in engine (client is {config.ClientType})", next, title);

        var suspension = await _foreground.SyncAsync(userId, foregroundOverride: options.ForegroundActive, ct: ct);
        if (suspension.Foreground)
        {
            var parked = suspension.Suspended.Count > 0 ? $"; parked {suspension.Suspended.Count} pre-warm(s)" : "";
            return Outcome("skipped", "foreground-busy", $"Playback is active{parked}", next, title);
        }

        var foreground = options.ForegroundProgress is not null ? options.ForegroundProgress() : await ForegroundProgressAsync(userId, protect, ct);
        if (foreground is { } fp && fp < MinForegroundProgress)
            return Outcome("skipped", "foreground-busy", $"Playing torrent is only {(long)Math.Round(fp * 100, MidpointRounding.AwayFromZero)}% fetched", next, title);

        await using (var db = await _factory.CreateDbContextAsync(ct))
        {
            string[] busy = ["downloading", "queued", "checking"];
            var active = await db.EngineTorrents.CountAsync(t => t.UserId == userId && t.Origin == PrewarmOrigins.Prewarm && busy.Contains(t.Status) && t.Progress < 1, ct);
            if (active >= MaxConcurrentPrewarms)
                return Outcome("skipped", "at-concurrency-cap", $"{active} pre-warm(s) already active", next, title);
        }

        var target = TargetOf(next);
        var choice = await _ranker.PreRankAsync(target, ct: ct);
        if (choice is null) return Outcome("not-applicable", "not-determined", $"Could not pre-rank {label}", next, title);
        if (choice.Candidate is null)
            return Outcome("not-applicable", "no-release", $"No usable release for {label} in {choice.ResultCount} results", next, title) with { PreRanked = true };

        var preRankedHash = ReleaseText.ReleaseInfoHash(choice.Candidate);
        var preRanked = choice.Source != "search";

        if (preRankedHash is not null && await HeldAsync(userId, preRankedHash, ct))
        {
            await _eviction.MarkUsedAsync(userId, preRankedHash, ct: ct);
            _cooldownUntil[key] = NowMs + (long)Cooldown.TotalMilliseconds;
            return Outcome("skipped", "already-held", $"{label} is already here", next, title) with { PreRanked = preRanked, InfoHash = preRankedHash };
        }

        return await GrabAsync(options, next, label, title, key, target, preRankedHash, preRanked, protect, ct);
    }

    private async Task<bool> HeldAsync(string userId, string hash, CancellationToken ct)
    {
        await using var db = await _factory.CreateDbContextAsync(ct);
        return await db.EngineTorrents.AnyAsync(t => t.UserId == userId && t.Hash == hash, ct);
    }

    /// <summary>The shared grab pipeline, configured for a pre-warm: search, select, dedupe, budget, send, record.</summary>
    private async Task<PrewarmOutcome> GrabAsync(RunOptions options, NextEpisode next, string label, string title, string key,
        PreRankTarget target, string? preRankedHash, bool preRanked, IReadOnlyList<string> protect, CancellationToken ct)
    {
        var userId = options.UserId;
        var search = PreRanker.SearchOptionsFor(target);
        var response = await _search.SearchAsync(search, ct);
        var fastPath = response.Cached == true;
        var results = response.Results;

        TorrentResult? candidate = null;
        if (preRankedHash is not null) candidate = results.FirstOrDefault(r => ReleaseText.ReleaseInfoHash(r) == preRankedHash);
        candidate ??= PreRanker.SelectBestRelease(results, target);

        PrewarmOutcome Common(string status, string reason, string message, int evictedCount = 0, long freedBytes = 0) => new()
        {
            Status = status,
            Reason = reason,
            Message = message,
            Next = next,
            Title = candidate?.Title ?? title,
            InfoHash = candidate is not null ? ReleaseText.ReleaseInfoHash(candidate) : preRankedHash,
            PreRanked = preRanked,
            FastPath = fastPath,
            EvictedCount = evictedCount,
            FreedBytes = freedBytes,
        };

        if (candidate is null || string.IsNullOrEmpty(candidate.Magnet))
        {
            var message = results.Count > 0 ? $"Pre-warm: no matching {label} release in {results.Count} results" : $"Pre-warm: no seeded torrent for {label}";
            await RecordGrabAsync(userId, title, search.Query, "skipped", message, null, next, ct);
            candidate = null;
            return Common("skipped", "no-release", message);
        }

        var hash = ReleaseText.ReleaseInfoHash(candidate);
        var dupe = hash is null ? "Release has no info hash" : await HeldAsync(userId, hash, ct) ? "Already downloading" : null;
        if (dupe is not null)
        {
            await RecordGrabAsync(userId, candidate.Title, search.Query, "skipped", dupe, candidate, next, ct);
            return Common("skipped", "no-release", dupe);
        }

        var sendStartedAt = _time.GetUtcNow().UtcDateTime;
        var request = new EngineAddRequest
        {
            Magnet = candidate.Magnet,
            Name = candidate.Title,
            Purpose = TorrentPurpose.Prewarm,
            ExpectedSizeBytes = candidate.SizeBytes,
        };
        var evictedCount = 0; long freedBytes = 0;
        var send = await SendAsync(request, ct);
        if (!send.Ok && send.StorageLimit is not null)
        {
            // Over budget: reclaim from speculative downloads only; a user's download is never a cache entry.
            var needed = Math.Max(1, candidate.SizeBytes ?? 0);
            var freed = await _eviction.EvictForBytesAsync(userId, needed, protect, new PrewarmEviction.Seams { Delete = options.Delete }, ct);
            evictedCount = freed.Evicted.Count; freedBytes = freed.FreedBytes;
            if (evictedCount > 0) send = await SendAsync(request, ct);
            if (!send.Ok && send.StorageLimit is not null)
            {
                await RecordGrabAsync(userId, candidate.Title, search.Query, "failed", send.Message, candidate, next, ct);
                return Common("failed", "no-space", send.Message, evictedCount, freedBytes);
            }
        }

        await RecordGrabAsync(userId, candidate.Title, search.Query, send.Ok ? "sent" : "failed", send.Message, candidate, next, ct);
        if (!send.Ok) return Common("failed", "send-failed", send.Message, evictedCount, freedBytes);

        _cooldownUntil[key] = NowMs + (long)Cooldown.TotalMilliseconds;
        int stamped;
        await using (var db = await _factory.CreateDbContextAsync(ct))
        {
            stamped = hash is null ? 0 : await db.EngineTorrents.CountAsync(t => t.UserId == userId && t.Hash == hash && t.Origin == PrewarmOrigins.Prewarm && t.CreatedAt >= sendStartedAt, ct);
        }
        if (stamped == 0)
            _logger.LogWarning("[prewarm] {Label} sent but the EngineTorrent row was not stamped origin=prewarm — it will not be evictable.", label);
        return Common("sent", "sent", send.Message, evictedCount, freedBytes) with { Labelled = stamped > 0 };
    }

    private async Task<EngineAddResult> SendAsync(EngineAddRequest request, CancellationToken ct)
    {
        try
        {
            return await _engine.AddAsync(request, ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            return new EngineAddResult(false, e.Message);
        }
    }

    private async Task RecordGrabAsync(string userId, string title, string query, string status, string message, TorrentResult? candidate, NextEpisode next, CancellationToken ct)
    {
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var now = _time.GetUtcNow().UtcDateTime;
            db.GrabJobs.Add(new GrabJob
            {
                Id = Ids.New(),
                UserId = userId,
                Title = title,
                Query = query,
                Status = status,
                Message = message,
                Magnet = candidate?.Magnet,
                InfoHash = candidate is null ? null : ReleaseText.NormalizeInfoHash(candidate.InfoHash),
                Source = candidate?.Source,
                Kind = PrewarmOrigins.GrabKind,
                ExternalId = next.WatchListItemId,
                CreatedAt = now,
                UpdatedAt = now,
            });
            await db.SaveChangesAsync(ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("[prewarm] could not record the grab job: {Message}", e.Message);
        }
    }

    /// <summary>How much of the torrent being watched is fetched; null when we cannot tell (never blocks a pre-warm).</summary>
    private async Task<double?> ForegroundProgressAsync(string userId, IReadOnlyList<string> hashes, CancellationToken ct)
    {
        if (hashes.Count == 0) return null;
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            var rows = await db.EngineTorrents.AsNoTracking().Where(t => t.UserId == userId && hashes.Contains(t.Hash)).Select(t => t.Progress).ToListAsync(ct);
            return rows.Count == 0 ? null : rows.Min();
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] foreground progress unreadable");
            return null;
        }
    }

    /// <summary>Is the episode on screen a stream-only torrent? A pre-warm must never shadow a stream. Fails open.</summary>
    private async Task<bool> ForegroundIsStreamOnlyAsync(string userId, IReadOnlyList<string> hashes, CancellationToken ct)
    {
        if (hashes.Count == 0) return false;
        try
        {
            await using var db = await _factory.CreateDbContextAsync(ct);
            return await db.EngineTorrents.AnyAsync(t => t.UserId == userId && hashes.Contains(t.Hash) && t.Origin == PrewarmOrigins.Stream, ct);
        }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogDebug(e, "[prewarm] stream-origin check failed");
            return false;
        }
    }

    /// <summary>
    /// Called on every playback progress ping: mark the watched torrent used, reconcile suspension, and past ~15%
    /// pre-warm the next episode.
    /// </summary>
    public async Task<PrewarmOutcome> OnPlaybackProgressAsync(PlaybackContext signal, RunOptions? template = null, CancellationToken ct = default)
    {
        try { await _eviction.MarkUsedAsync(signal.UserId, signal.InfoHash, ct: ct); }
        catch (Exception e) when (!ct.IsCancellationRequested) { _logger.LogDebug(e, "[prewarm] mark-used failed"); }

        try { await _foreground.SyncAsync(signal.UserId, foregroundOverride: template?.ForegroundActive, ct: ct); }
        catch (Exception e) when (!ct.IsCancellationRequested) { _logger.LogWarning("[prewarm] suspension sync failed: {Message}", e.Message); }

        if (!ShouldTrigger(signal.PositionSec, signal.DurationSec)) return Outcome("not-applicable", "below-trigger", "Below 15% watched");

        NextEpisode? next;
        try { next = await ResolveNextEpisodeAsync(signal, ct); }
        catch (Exception e) when (!ct.IsCancellationRequested)
        {
            _logger.LogWarning("[prewarm] could not resolve next episode: {Message}", e.Message);
            next = null;
        }
        if (next is null) return Outcome("not-applicable", "no-next-episode", "No next episode to pre-warm");

        var run = template is null
            ? new RunOptions { UserId = signal.UserId, Next = next, ProtectHashes = [signal.InfoHash] }
            : template with { UserId = signal.UserId, Next = next, ProtectHashes = template.ProtectHashes ?? [signal.InfoHash] };
        return await PrewarmNextEpisodeAsync(run, ct);
    }
}
