using System.Collections.Immutable;
using System.Collections.Concurrent;
using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Api.Catalog;
using TorrentFlow.Domain;
using TorrentFlow.Engine;
using TorrentFlow.Library;
using TorrentFlow.Store;
using TorrentFlow.Targets;

namespace TorrentFlow.Api;

internal static class DownloadEndpoints
{
    private static readonly JsonSerializerOptions Wire = new(JsonSerializerDefaults.Web);
    private static IResult Reply(object body) => Results.Json(body, Wire);

    internal static void MapDownloads(this WebApplication app)
    {
        var group = app.MapGroup("/api").AddEndpointFilter(async (context, next) =>
        {
            if (AccessIdentity.Actor(context.HttpContext).Role != UserRole.Owner)
                return Results.StatusCode(403);
            context.HttpContext.Response.Headers.CacheControl = "no-store";
            try { return await next(context); }
            catch (ArgumentException ex) { return Results.BadRequest(new { message = ex.Message }); }
            catch (InvalidOperationException ex) { return Results.Conflict(new { message = ex.Message }); }
        });
        ReleaseReplacementEndpoints.Map(group);
        TorrentSendEndpoints.Map(group);
        group.MapGet("/client/torrents", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ListAsync(ct)));
        group.MapPost("/client/torrents", async (DownloadAction input, DownloadsApi api, CancellationToken ct) =>
            Reply(await api.ActionAsync(input, ct)));
        group.MapPost("/downloads/{transferId}/keep", async (string transferId, DownloadsApi api, CancellationToken ct) =>
            await api.KeepAsync(transferId, ct));
        group.MapPost("/title/{workKey}", async (string workKey, TitleDownload input, HttpContext http,
            TargetPipeline targets, IMetadata metadata, ILibraryPlacement library, CancellationToken ct) =>
        {
            if (input.Season is < 0 or > 999 || input.Episode is < 1 or > 99999 ||
                input.PreferredResolution is < 1 or > 4320)
                return Results.BadRequest(new { message = "Choose a valid season, episode and quality." });
            if (!DownloadsApi.SetupComplete(await library.RootsAsync(ct)))
            {
                const string message = "Choose a download folder and a space limit first.";
                return Results.Conflict(new { ok = false, message, storage = new { limit = "setup", message } });
            }
            var work = (await metadata.GetWorkAsync(workKey, false, ct)).Work;
            if (work is null && input.Provider is { } provider && input.ProviderId is { } providerId)
            {
                if (provider is not ("tmdb" or "anilist" or "cinemeta" or "tvmaze" or "itunes"))
                    return Results.BadRequest(new { ok = false, message = "A supported title provider is required." });
                work = (await metadata.ResolveAsync(new(new(provider, providerId,
                    input.MediaType == "movie" ? "movie" : "tv"), input.Title, input.Year,
                    input.MediaType == "movie" ? WorkKind.Film : WorkKind.Series), ct)).Work;
            }
            var resolvedKey = work?.Work.WorkKey ?? workKey;
            var reply = await targets.AcquireAsync(new(resolvedKey, input.Season, input.Episode,
                input.PreferredResolution), AccessIdentity.Actor(http).UserId, ct);
            return Results.Ok(AdmissionProjection.Title(reply, resolvedKey));
        });
        group.MapGet("/wanted", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedAsync(ct)));
        group.MapDelete("/wanted", async (string workKey, int? season, int? episode,
            DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedActionAsync(workKey, season, episode, TargetAction.Remove, ct)));
        group.MapPost("/wanted/try", async (string workKey, int? season, int? episode,
            DownloadsApi api, CancellationToken ct) =>
            Reply(await api.WantedActionAsync(workKey, season, episode, TargetAction.TryNow, ct)));
        group.MapGet("/settings/client", async (DownloadsApi api, LibraryPlacement library, CancellationToken ct) =>
            Reply(await api.SettingsAsync(null, library, ct)));
        group.MapPut("/settings/client", async (JsonElement input, DownloadsApi api, LibraryPlacement library,
            CancellationToken ct) => Reply(await api.SettingsAsync(input, library, ct)));
        group.MapGet("/settings/download-recovery", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.RecoveryAsync(false, ct)));
        group.MapPost("/settings/download-recovery", async (DownloadsApi api, CancellationToken ct) =>
            Reply(await api.RecoveryAsync(true, ct)));
        group.MapGet("/settings/download-recovery/sources", async (IConfiguration configuration,
            MediaImport importer, ImportReviewRepository reviews, ILibraryRepository inventory,
            TargetPipeline targets, CancellationToken ct) =>
        {
            var scan = new ExternalDownloadScanner().Scan(configuration["TorrentFlow:ExternalDownloadScan:ScanRoot"], ct,
                OldAppDownloads.Read(configuration));
            var adoption = new ExternalMediaAdoption(importer, inventory);
            var downloadHashes = (await targets.ReadAsync(ct)).Downloads
                .Select(d => d.Hash.ToLowerInvariant()).ToHashSet(StringComparer.Ordinal);
            var candidates = new List<object>();
            foreach (var row in scan.Candidates)
                candidates.Add(new { row.Id, row.Source, row.Hash, row.Name, row.SizeBytes, row.SavePath,
                    row.DataExists, row.Complete, alreadyImported =
                        downloadHashes.Contains(row.Hash.ToLowerInvariant()) ||
                        await adoption.AlreadyOwnedAsync(row.Files, ct) });
            return Reply(new { candidates, scan.Warnings });
        });
        group.MapPost("/settings/download-recovery/sources", async (RecoverySourcesInput input,
            IConfiguration configuration, MediaImport importer, ImportReviewRepository reviews,
            ILibraryRepository inventory, TargetPipeline targets, OldTorrentHandoff handoff,
            HttpContext http, CancellationToken ct) =>
        {
            try
            {
                if (!input.Acknowledged)
                    return Results.BadRequest(new { error = "Confirm that the other client will not write to these files." });
                if (input.Ids is null || input.Ids.Length > 500 || input.Ids.Any(string.IsNullOrWhiteSpace))
                    return Results.BadRequest(new { error = "Select between 1 and 500 torrents to import." });
                if (input.Ids.Length == 0)
                    return Results.Ok(new { imported = 0, paused = 0, skipped = 0, failed = 0, errors = Array.Empty<string>() });
                var scan = new ExternalDownloadScanner().Scan(configuration["TorrentFlow:ExternalDownloadScan:ScanRoot"], ct,
                    OldAppDownloads.Read(configuration));
                var adoption = new ExternalMediaAdoption(importer, inventory);
                var unfinished = scan.Candidates.Where(c => !c.Complete && input.Ids.Contains(c.Id)).ToArray();
                var result = await adoption.ImportAsync(input.Ids.Where(id => unfinished.All(c => c.Id != id)),
                    [.. scan.Candidates.Select(c => new ExternalAdoptionSource(c.Id, c.Name, c.SavePath, c.Complete, c.Files))],
                    reviews.GetAsync, reviews.SaveAsync, reviews.DecideAsync, ct);
                foreach (var candidate in unfinished)
                {
                    try
                    {
                        if ((await targets.ReadAsync(ct)).Downloads.Any(d =>
                            d.Hash.Equals(candidate.Hash, StringComparison.OrdinalIgnoreCase)))
                        {
                            result = result with { Skipped = result.Skipped + 1 };
                            continue;
                        }
                        var selected = input.Selections?.Where(s => s.SourceId == candidate.Id).ToArray() ?? [];
                        var source = new ExternalAdoptionSource(candidate.Id, candidate.Name,
                            candidate.SavePath, candidate.Complete, candidate.Files);
                        ImportScanView review;
                        ImmutableArray<ExternalIdentityPick> picks;
                        if (selected.Length == 0)
                        {
                            var suggestion = await adoption.SuggestPicksAsync(source,
                                reviews.GetAsync, reviews.SaveAsync, ct);
                            if (suggestion.Picks.IsEmpty)
                            {
                                result = result with { Failed = result.Failed + 1,
                                    Errors = result.Errors.Add($"{candidate.Name}: confirm the matching title in Import, then import it again.") };
                                continue;
                            }
                            review = suggestion.Review;
                            picks = suggestion.Picks;
                        }
                        else
                        {
                            picks = [.. selected.Select(s =>
                                new ExternalIdentityPick(s.FileIndex, s.WorkId, s.EpisodeId))];
                            review = await adoption.ReviewTransferAsync(source, picks,
                                reviews.GetAsync, reviews.SaveAsync, ct);
                        }
                        var reviewItemIds = review.Items.Where(i => picks.Any(p =>
                                LibraryPaths.PhysicalKey(i.Path) ==
                                LibraryPaths.PhysicalKey(candidate.Files[p.FileIndex])))
                            .Select(i => i.Id).ToImmutableArray();
                        var admitted = await targets.AdmitExternalAsync(new(candidate.Hash, candidate.Name,
                            candidate.TorrentBytes, candidate.Files,
                            [.. picks.Select(p => new ExternalTransferItem(p.FileIndex, p.WorkId, p.EpisodeId))],
                            input.Paused, review.Id, reviewItemIds), AccessIdentity.Actor(http).UserId, ct);
                        if (!admitted.Accepted) throw new IOException(admitted.Failure?.Message);
                        result = result with { Imported = result.Imported + 1,
                            Paused = result.Paused + (input.Paused ? 1 : 0) };
                    }
                    catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or ArgumentException or InvalidOperationException)
                    {
                        result = result with { Failed = result.Failed + 1,
                            Errors = result.Errors.Add($"{candidate.Name}: {ex.Message}") };
                    }
                }
                return Reply(result);
            }
            finally { handoff.Kick(); }
        });
    }

    internal sealed record DownloadAction(string Action, string? Hash = null, string[]? Hashes = null,
        string? OwnerClientType = null, bool DeleteFiles = false, string[]? TransferIds = null);
    internal sealed record RecoverySourcesInput(string[]? Ids, bool Acknowledged,
        ExternalSelection[]? Selections = null, bool Paused = false);
    internal sealed record ExternalSelection(string SourceId, int FileIndex, string WorkId, string? EpisodeId = null);
    internal sealed record TitleDownload(int? Season = null, int? Episode = null, int? PreferredResolution = null,
        string? Provider = null, string? ProviderId = null, string? MediaType = null, string? Title = null, int? Year = null);
}

internal sealed class DownloadsApi(TargetPipeline targets, RawDownloads rawDownloads, IEngine engine,
    IDbContextFactory<TorrentFlowDbContext> contexts, IConfiguration configuration, IParser parser)
{
    private readonly SemaphoreSlim settingsGate = new(1, 1);
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
        { Converters = { new JsonStringEnumConverter() } };
    private static readonly ConcurrentDictionary<string, ParsedRelease> ParsedReleases = new(StringComparer.Ordinal);

    internal async Task<object> ListAsync(CancellationToken ct)
    {
        var snapshot = await targets.ReadAsync(ct);
        await using var db = await contexts.CreateDbContextAsync(ct);
        var links = await db.DownloadTargets.AsNoTracking().ToListAsync(ct);
        var works = await db.Works.AsNoTracking().ToListAsync(ct);
        var names = await db.WorkNames.AsNoTracking().OrderBy(n => n.Id).ToListAsync(ct);
        var episodes = await db.Episodes.AsNoTracking().ToListAsync(ct);
        var seasons = await db.Seasons.AsNoTracking().ToListAsync(ct);
        var releases = await db.Releases.AsNoTracking().ToListAsync(ct);
        var raw = await db.RawIntents.AsNoTracking().ToListAsync(ct);
        var files = await db.DownloadFiles.AsNoTracking().OrderBy(f => f.Id).ToListAsync(ct);
        var media = await db.MediaFiles.AsNoTracking().OrderBy(m => m.Id).ToListAsync(ct);
        var cap = SettingsCatalog.Read<EngineSettings>(await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "engine", ct))
            .MaxActiveDownloads;
        var nowDownloads = snapshot.Queue.Where(q => q.Now).Select(q => q.DownloadId).ToHashSet(StringComparer.Ordinal);
        var full = snapshot.Live.Count(l => l.Active && !l.Complete && !nowDownloads.Contains(l.DownloadId)) >= cap;
        var rows = new List<object>();
        var queuePosition = 0;
        foreach (var download in snapshot.Queue.Select(q => snapshot.Downloads.Single(d => d.Id == q.DownloadId)))
        {
            var associations = links.Where(l => l.DownloadId == download.Id).ToArray();
            var targetIds = associations.Select(l => l.TargetId).ToHashSet(StringComparer.Ordinal);
            var linked = snapshot.Targets.Where(t => targetIds.Contains(t.Id) && t.State != TargetState.Removed).ToArray();
            // A target re-requested onto another release keeps an old link here; it belongs to its new download.
            var current = linked.Where(t => download.Hash.Equals(t.ChosenReleaseHash, StringComparison.OrdinalIgnoreCase))
                .ToArray();
            var items = current.Length > 0 ? current : linked;
            if (targetIds.Count > 0 && items.Length == 0) continue;
            var live = snapshot.Live.FirstOrDefault(l => l.DownloadId == download.Id);
            var rawIntent = raw.FirstOrDefault(r => r.Id == download.RawIntentId);
            var release = releases.FirstOrDefault(r => r.Id == download.Hash);
            var queued = items.Length > 0
                ? items.Any(target => DownloadRowView.State(target.State == TargetState.Done,
                    target.IsPaused() || live?.Intent == DownloadIntent.Paused,
                    target.State == TargetState.Filing, live,
                    target.State == TargetState.Filing && target.ReasonCode == WaitReason.FilingBlocked) == "queued")
                : DownloadRowView.State(download.FinishedAt is not null || rawIntent?.State == RawDownloadState.Done,
                    rawIntent?.State == RawDownloadState.Paused || live?.Intent == DownloadIntent.Paused,
                    rawIntent?.State == RawDownloadState.Publishing, live) == "queued";
            var downloadPosition = queued ? ++queuePosition : (int?)null;
            var packed = items.Length > 1;

            void AddRow(TargetRow? target)
            {
                var libraryFile = media.FirstOrDefault(m => m.DownloadId == download.Id && m.Role == FileRole.Video &&
                    (target is null || m.EpisodeId == target.EpisodeId));
                var work = works.FirstOrDefault(w => w.Id == (target?.WorkId ?? libraryFile?.WorkId));
                var episode = episodes.FirstOrDefault(e => e.Id == (target?.EpisodeId ?? libraryFile?.EpisodeId));
                var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
                var selected = target is null
                    ? files.Where(f => f.DownloadId == download.Id && f.Role != FileRole.Unwanted).ToArray()
                    : files.Where(f => f.DownloadId == download.Id && f.TargetId == target.Id &&
                        f.Role != FileRole.Unwanted).ToArray();
                var done = target is null
                    ? download.FinishedAt is not null || rawIntent?.State == RawDownloadState.Done
                    : target.State == TargetState.Done || !packed && download.FinishedAt is not null;
                var paused = target?.IsPaused() == true || rawIntent?.State == RawDownloadState.Paused ||
                    live?.Intent == DownloadIntent.Paused;
                var state = DownloadRowView.State(done, paused, target?.State == TargetState.Filing, live,
                    target?.State == TargetState.Filing && target.ReasonCode == WaitReason.FilingBlocked,
                    target is null && rawIntent?.State == RawDownloadState.Publishing);
                var failed = state == "error";
                var size = target is not null ? selected.Sum(f => f.ExpectedBytes) :
                    selected.Length > 0 ? selected.Sum(f => f.ExpectedBytes) :
                    live?.SelectedBytes ?? release?.TotalBytes ?? 0;
                if (target is null)
                    size += media.Where(m => m.DownloadId == download.Id &&
                        selected.All(f => f.FileIndex != m.FileIndex)).Sum(m => m.Bytes);
                var completed = target is not null || selected.Length > 0
                    ? selected.Sum(f => f.Filed ? f.ExpectedBytes :
                        live?.Files.FirstOrDefault(l => l.Index == f.FileIndex)?.CompletedBytes ?? 0)
                    : live?.CompletedSelectedBytes ?? 0;
                var title = work is null ? null : CatalogProjection.Title(new(work,
                    [.. names.Where(n => n.WorkId == work.Id)], [], [], []));
                var releaseName = release?.Name ?? title ?? download.Hash;
                var parsed = ParseRelease(releaseName);
                var rowError = target?.State == TargetState.Filing &&
                    target.ReasonCode == WaitReason.FilingBlocked ? target.ReasonText :
                    live?.Failure?.Message ?? (failed ? target?.ReasonText : null);
                var position = state == "queued" ? downloadPosition : null;
                var heldStatus = packed && target is not null
                    ? DownloadRowView.HeldStatus(state, live, selected.Select(file => (file.FileIndex, file.Filed)))
                    : null;
                var rowStatus = heldStatus ??
                    DownloadRowView.Status(state, position, full, live?.StalledMetadata == true, rowError);
                if (target?.State == TargetState.Filing && target.ReasonCode == WaitReason.FileBusy &&
                    rowStatus.Status == "finishing")
                    rowStatus = rowStatus with { StatusLabel = "Finishing, retrying soon" };
                var forced = target?.DownloadNow == true || rawIntent?.NowAt is not null;
                var filesExist = selected.Length > 0 && selected.All(f => f.MediaFileId is not null &&
                    media.Any(m => m.Id == f.MediaFileId && m.MissingSince is null));
                var filesMissing = done && selected.Length > 0 && !filesExist;
                rows.Add(new
                {
                    hash = download.Hash, name = releaseName,
                    progress = done ? 1d : size > 0 ? Math.Clamp((double)completed / size, 0, 1) : 0,
                    sizeBytes = size, dlspeed = heldStatus is null ? live?.BytesPerSecond ?? 0 : 0, upspeed = 0,
                    eta = heldStatus is null ? live?.Eta?.TotalSeconds : null, peers = live?.Peers ?? 0,
                    status = rowStatus.Status, statusLabel = rowStatus.StatusLabel,
                    error = rowError,
                    category = work?.Kind == WorkKind.Series ? "TV" : "Movies",
                    savePath = rawIntent?.ExplicitDirectory ?? Path.GetDirectoryName(selected.FirstOrDefault()?.FinalPath),
                    magnet = release?.Magnet, addedAt = download.AddedAt, filesMissing,
                    transferId = packed && target is not null
                        ? $"builtin:{download.Hash}:{target.Id}" : "builtin:" + download.Hash,
                    targetId = packed ? target?.Id : null,
                    packed,
                    workId = work?.Id, workKey = work?.WorkKey,
                    workTitle = title ?? (string.IsNullOrWhiteSpace(parsed.Title) ? null : parsed.Title), workYear = work?.Year,
                    workMediaType = work is null ? null : work.Kind == WorkKind.Series ? "tv" : "movie",
                    posterUrl = work?.PosterUrl,
                    season = season?.Number ?? (parsed.Seasons.IsEmpty ? null : parsed.Seasons[0]),
                    episode = episode?.Number ??
                        (parsed.Episodes.IsEmpty ? parsed.AbsoluteNumbers.IsEmpty ? null : parsed.AbsoluteNumbers[0] : parsed.Episodes[0]),
                    quality = DownloadRowView.Quality(parsed.Quality),
                    mediaKind = DownloadRowView.MediaKind(work, parsed),
                    groupKey = work?.WorkKey ?? "raw:" + download.Hash,
                    isSeries = DownloadRowView.IsSeries(work, parsed),
                    actions = DownloadRowView.Actions(rowStatus.Status, forced, target is not null, filesExist,
                        target?.State == TargetState.Filing &&
                        target.ReasonCode is WaitReason.FilingBlocked or WaitReason.FileBusy),
                });
            }

            if (packed)
                foreach (var target in items) AddRow(target);
            else
                AddRow(items.FirstOrDefault());
        }
        return new { torrents = rows };
    }

    internal async Task<object> ActionAsync(DownloadEndpoints.DownloadAction input, CancellationToken ct)
    {
        if (input.OwnerClientType is not (null or "builtin"))
            throw new ArgumentException("Only the built-in client is available.");
        var retryFiling = input.Action == "retry-filing";
        var action = input.Action switch
        {
            "pause" => TargetAction.Pause, "resume" => TargetAction.Resume,
            "delete" => TargetAction.Remove, "force" => TargetAction.DownloadNow,
            "retry-filing" => TargetAction.Acquire,
            _ => throw new ArgumentException("Choose pause, resume, delete, force or retry filing."),
        };
        if (input.DeleteFiles && action != TargetAction.Remove)
            throw new ArgumentException("Delete files is only available when removing a download.");
        var hashes = input.Hashes ?? (input.Hash is { } singleHash ? [singleHash] : []);
        var transferIds = input.TransferIds ?? [];
        if (hashes.Length + transferIds.Length == 0 || hashes.Length + transferIds.Length > 500)
            throw new ArgumentException("Choose downloads to change.");
        var snapshot = await targets.ReadAsync(ct);
        await using var db = await contexts.CreateDbContextAsync(ct);
        var links = await db.DownloadTargets.AsNoTracking().OrderBy(l => l.Id).ToListAsync(ct);
        var work = new List<(string Hash, string? TargetId)>();
        work.AddRange(hashes.Select(hash => (hash, (string?)null)));
        foreach (var transferId in transferIds)
        {
            var match = System.Text.RegularExpressions.Regex.Match(transferId.Trim(),
                "^(?:builtin:)?([0-9a-f]{40})(?::(.+))?$",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                    System.Text.RegularExpressions.RegexOptions.CultureInvariant);
            if (!match.Success) throw new ArgumentException("Choose a valid download.");
            work.Add((match.Groups[1].Value, match.Groups[2].Success ? match.Groups[2].Value : null));
        }
        foreach (var (hash, targetId) in work.Distinct())
        {
            var download = snapshot.Downloads.FirstOrDefault(d => d.Hash.Equals(hash, StringComparison.OrdinalIgnoreCase));
            if (download is null)
            {
                if (targetId is not null) throw new ArgumentException("This download no longer has an action.");
                continue;
            }
            var ids = links.Where(l => l.DownloadId == download.Id).Select(l => l.TargetId).Distinct().ToArray();
            if (targetId is not null)
            {
                if (!ids.Contains(targetId, StringComparer.Ordinal) ||
                    !snapshot.Targets.Any(t => t.Id == targetId &&
                        download.Hash.Equals(t.ChosenReleaseHash, StringComparison.OrdinalIgnoreCase)))
                    throw new ArgumentException("This download no longer has an action.");
                if (retryFiling)
                {
                    await targets.RetryFilingAsync(targetId, ct);
                    continue;
                }
                if (input.DeleteFiles) await targets.DeleteTargetFilesAsync(download.Hash, targetId, ct);
                await targets.ActionAsync(targetId, action, ct);
                continue;
            }
            if (retryFiling)
            {
                var blocked = snapshot.Targets.Where(t => ids.Contains(t.Id, StringComparer.Ordinal) &&
                    t.State == TargetState.Filing &&
                    download.Hash.Equals(t.ChosenReleaseHash, StringComparison.OrdinalIgnoreCase)).ToArray();
                if (blocked.Length == 0) throw new ArgumentException("This download cannot retry filing.");
                foreach (var target in blocked) await targets.RetryFilingAsync(target.Id, ct);
                continue;
            }
            if (ids.Length == 0 && download.RawIntentId is not null)
            {
                if (action == TargetAction.Remove) await rawDownloads.RemoveAsync(download.Hash, input.DeleteFiles, ct);
                else if (action == TargetAction.DownloadNow)
                    await rawDownloads.DownloadNowAsync(download.Hash, ct);
                else await rawDownloads.PauseAsync(download.RawIntentId, action == TargetAction.Pause, ct);
                continue;
            }
            if (ids.Length == 0) throw new ArgumentException("This download no longer has an action.");
            if (input.DeleteFiles) await targets.DeleteDownloadFilesAsync(hash, ct);
            foreach (var id in ids) await targets.ActionAsync(id, action, ct);
        }
        return new { ok = true };
    }

    private ParsedRelease ParseRelease(string releaseName)
    {
        if (ParsedReleases.Count > 4000) ParsedReleases.Clear();
        try { return ParsedReleases.GetOrAdd(releaseName, parser.Parse); }
        catch (System.Text.RegularExpressions.RegexMatchTimeoutException)
        {
            return new ParsedRelease(releaseName, releaseName, null, [], [], [], [], false, false, null,
                new(null, null, null, null), null, [], false, false, false);
        }
    }

    internal async Task<IResult> KeepAsync(string transferId, CancellationToken ct)
    {
        var match = System.Text.RegularExpressions.Regex.Match(transferId.Trim(),
            "^(?:builtin:)?([0-9a-f]{40})(?::(.+))?$", System.Text.RegularExpressions.RegexOptions.IgnoreCase |
                System.Text.RegularExpressions.RegexOptions.CultureInvariant);
        if (!match.Success) return Results.BadRequest(new { ok = false, reason = "invalid-id",
            error = "That is not a download id.", message = "Reload the page and try again." });
        var hash = match.Groups[1].Value.ToLowerInvariant();
        var snapshot = await targets.ReadAsync(ct);
        var download = snapshot.Downloads.SingleOrDefault(d => d.Hash == hash);
        if (download is null) return Results.NotFound(new { ok = false, reason = "not-found",
            error = "Torrent not found in engine.", message = "Torrent not found in engine." });
        var episodeDone = match.Groups[2].Success &&
            snapshot.Targets.Any(t => t.Id == match.Groups[2].Value && t.State == TargetState.Done);
        if (download.FinishedAt is null && !episodeDone) return Results.Conflict(new { ok = false, reason = "not-held",
            error = "This download is still finishing. Try again when it is ready.",
            message = "This download is still finishing. Try again when it is ready." });
        return Results.Ok(new { ok = true, message = "The download is already kept in your library." });
    }

    private async Task<(TargetRow Target, WorkRow? Work, string? Title, int? Season, int? Episode)[]> WantedRows(CancellationToken ct)
    {
        var snapshot = await targets.ReadAsync(ct);
        await using var db = await contexts.CreateDbContextAsync(ct);
        var works = await db.Works.AsNoTracking().ToListAsync(ct);
        var names = await db.WorkNames.AsNoTracking().OrderBy(n => n.Id).ToListAsync(ct);
        var episodes = await db.Episodes.AsNoTracking().ToListAsync(ct);
        var seasons = await db.Seasons.AsNoTracking().ToListAsync(ct);
        var links = await db.DownloadTargets.AsNoTracking().ToListAsync(ct);
        return snapshot.Targets.Where(t => !t.IsPaused() &&
            t.State is TargetState.Wanted or TargetState.Waiting or TargetState.Searching)
            .Where(t => !links.Any(l => l.TargetId == t.Id && snapshot.Downloads.Any(d => d.Id == l.DownloadId)))
            .Select(t =>
        {
            var work = works.FirstOrDefault(w => w.Id == t.WorkId);
            var episode = episodes.FirstOrDefault(e => e.Id == t.EpisodeId);
            var season = seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
            return (t, work, work is null ? null : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == t.WorkId)], [], [], [])),
                season?.Number, episode?.Number);
        }).ToArray();
    }

    internal async Task<object> WantedAsync(CancellationToken ct)
    {
        var rows = (await WantedRows(ct)).Select(r => (object)new
        {
            status = "waiting", statusLabel = DownloadRowView.WantedStatusLabel(r.Target.State, r.Target.ReasonText),
            workKey = r.Work?.WorkKey ?? r.Target.WorkId, title = r.Title, year = r.Work?.Year,
            mediaType = r.Work?.Kind == WorkKind.Series ? "tv" : "movie", season = r.Season, episode = r.Episode,
            mediaKind = r.Work?.Anime == true ? "anime" : r.Work?.Kind == WorkKind.Series ? "series" : "movie",
            looking = r.Target.State is TargetState.Wanted or TargetState.Searching,
            nextAttemptAt = r.Target.NextTryAt,
        }).ToList();
        var snapshot = await targets.ReadAsync(ct);
        await using var db = await contexts.CreateDbContextAsync(ct);
        var works = await db.Works.AsNoTracking().ToListAsync(ct);
        var names = await db.WorkNames.AsNoTracking().OrderBy(n => n.Id).ToListAsync(ct);
        foreach (var intent in snapshot.Scopes.Where(s => s.State == ScopeIntentState.Pending))
        {
            var work = works.FirstOrDefault(w => w.Id == intent.WorkId);
            var title = work is null ? intent.WorkId : CatalogProjection.Title(new(work,
                [.. names.Where(n => n.WorkId == work.Id)], [], [], []));
            var episode = intent.Scope == RequestScope.Episodes ? intent.Episode : null;
            foreach (var season in intent.ScopeData.Seasons.Distinct())
                rows.Add(new
                {
                    status = "waiting", statusLabel = "Waiting for the episode list",
                    workKey = work?.WorkKey ?? intent.WorkId, title, year = work?.Year,
                    mediaType = "tv", mediaKind = work?.Anime == true ? "anime" : "series",
                    season = (int?)season, episode,
                    looking = false, nextAttemptAt = intent.NextTryAt,
                });
        }
        return new { wanted = rows, queue = snapshot.Queue };
    }

    internal async Task<object> WantedActionAsync(string key, int? season, int? episode, TargetAction action, CancellationToken ct)
    {
        var rows = (await WantedRows(ct)).Where(r => (r.Work?.WorkKey == key || r.Target.WorkId == key) &&
            (season is null || r.Season == season) && (episode is null || r.Episode == episode)).ToArray();
        foreach (var row in rows) await targets.ActionAsync(row.Target.Id, action, ct);
        var pending = await targets.ScopeActionAsync(key, season, episode, action, ct);
        return new { ok = true, removed = action == TargetAction.Remove ? rows.Length + pending : 0,
            retried = action == TargetAction.TryNow ? rows.Length + pending : 0 };
    }

    internal async Task<object> SettingsAsync(JsonElement? input, LibraryPlacement library, CancellationToken ct)
    {
        await settingsGate.WaitAsync(ct);
        try
        {
            await using var db = await contexts.CreateDbContextAsync(ct);
            var row = await db.Settings.SingleAsync(s => s.Id == "engine", ct);
            var value = SettingsCatalog.Read<EngineSettings>(row);
            var qualityRow = await db.Settings.SingleAsync(s => s.Id == "quality", ct);
            var quality = SettingsCatalog.Read<QualitySettings>(qualityRow);
            if (input is { } body)
            {
                if (body.ValueKind != JsonValueKind.Object)
                    throw new ArgumentException("Send a settings object.");
                await SaveRootAsync(library, body, ct);
                if (body.TryGetProperty("preferredResolution", out var resolution))
                {
                    if (resolution.ValueKind != JsonValueKind.Number || !resolution.TryGetInt32(out var pixels) ||
                        pixels is not (480 or 720 or 1080 or 2160))
                        throw new ArgumentException("Choose 480, 720, 1080 or 2160 for download quality.");
                    quality = quality with { PreferredResolution = pixels };
                }
                if (body.TryGetProperty("audioLanguage", out var audio))
                {
                    if (audio.ValueKind != JsonValueKind.String || audio.GetString() is not ("auto" or "english" or "en" or "any"))
                        throw new ArgumentException("Choose automatic, English or any audio language.");
                    quality = quality with { AudioLanguage = audio.GetString() };
                }
                if (body.TryGetProperty("maxActiveDownloads", out var cap))
                {
                    if (cap.ValueKind != JsonValueKind.Number || !cap.TryGetInt32(out var count) || count is < 1 or > 20)
                        throw new ArgumentException("Downloads at once must be a whole number from 1 to 20.");
                    value = value with { MaxActiveDownloads = count };
                }
                if (body.TryGetProperty("verboseDiagnostics", out var verbose))
                    value = value with { VerboseDiagnostics = verbose.GetBoolean() };
                var next = row with { Value = JsonSerializer.SerializeToElement(value, Json),
                    Revision = row.Revision + 1, UpdatedAt = DateTimeOffset.UtcNow };
                var nextQuality = qualityRow with { Value = JsonSerializer.SerializeToElement(quality, Json),
                    Revision = qualityRow.Revision + 1, UpdatedAt = next.UpdatedAt };
                SettingsCatalog.Validate(next);
                SettingsCatalog.Validate(nextQuality);
                db.Entry(row).CurrentValues.SetValues(next);
                db.Entry(qualityRow).CurrentValues.SetValues(nextQuality);
                try { await db.SaveChangesAsync(ct); }
                catch (DbUpdateConcurrencyException) { throw new InvalidOperationException("Settings changed. Try again."); }
                await engine.UpdateSettingsAsync(value, ct);
            }
            var roots = await db.StorageRoots.AsNoTracking().OrderBy(r => r.Id).ToListAsync(ct);
            var scheduler = SettingsCatalog.Read<SchedulerSettings>(
                await db.Settings.AsNoTracking().SingleAsync(s => s.Id == "scheduler", ct));
            var mediaBytes = await db.MediaFiles.SumAsync(m => m.Bytes, ct);
            var maximum = roots.FirstOrDefault(r => r.Enabled)?.MaxAllocatedBytes;
            var rootPath = roots.FirstOrDefault(r => r.Enabled)?.Path;
            var setupComplete = SetupComplete(roots);
            var categories = new[] { "Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other" };
            // The write contract is the editable form, not the richer read-only settings view.
            if (input is not null)
                return new { settings = new
                {
                    clientType = "builtin", externalClientType = "",
                    host = "http://127.0.0.1:8080", username = "", password = "", category = "", savePath = "",
                    baseDownloadPath = rootPath ?? "",
                    maxStorageGb = (maximum / 1_000_000_000d ?? 0).ToString(CultureInfo.InvariantCulture),
                    preferredResolution = quality.PreferredResolution, audioLanguage = quality.AudioLanguage ?? "auto",
                    automationIntervalMinutes = scheduler.Enabled ? scheduler.IntervalMinutes : 0,
                    maxActiveDownloads = value.MaxActiveDownloads, setupComplete,
                    downloadWindows = Array.Empty<object>(), categories, pathRules = new { },
                }, testResult = (object?)null, retentionWarning = (string?)null };
            return new { settings = new
            {
                clientType = "builtin", externalClientType = (string?)null, externalClientsEnabled = false,
                host = "http://127.0.0.1:8080", username = (string?)null, hasPassword = false, category = (string?)null,
                savePath = (string?)null, baseDownloadPath = rootPath,
                maxStorageBytes = maximum, maxStorageGb = maximum / 1_000_000_000d ?? 0,
                storageCapConfigured = maximum is not null,
                setupComplete, verboseDiagnostics = value.VerboseDiagnostics,
                preferredResolution = quality.PreferredResolution, audioLanguage = quality.AudioLanguage ?? "auto",
                automationIntervalMinutes = scheduler.Enabled ? scheduler.IntervalMinutes : 0,
                maxActiveDownloads = value.MaxActiveDownloads, maxActiveDownloadsDefault = 4,
                effectiveMaxActive = value.MaxActiveDownloads, maxActiveSource = "setting",
                downloadWindows = Array.Empty<object>(), downloadWindowOpen = true,
                categories, pathRules = new { },
                pathWarnings = Array.Empty<object>(), hasExternal = false,
                defaultRetentionPolicy = "KEPT", defaultRetentionPolicyPersisted = true,
                storageUsage = new { totalBytes = mediaBytes, keptBytes = mediaBytes,
                    indeterminateBytes = 0, items = Array.Empty<object>(),
                    diskBytes = 0L, orphanBytes = 0L, orphans = Array.Empty<object>(),
                    disk = new
                    {
                        root = rootPath, status = "not-scanned", authoritative = false,
                        observedBytes = 0L, trackedBytes = mediaBytes, internalBytes = 0L,
                        fileCount = 0, orphanFileCount = 0, truncated = false,
                        truncatedBy = Array.Empty<string>(), groupsTruncated = false,
                        unreadablePaths = Array.Empty<string>(), linksSkipped = 0, scannedAtMs = 0L,
                    } },
            }, defaults = new
            {
                categories, baseDownloadPath = configuration["TorrentFlow:DefaultDownloadDirectory"] is { Length: > 0 } configured
                    ? configured
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "TorrentFlow"),
                clientType = "builtin",
            } };
        }
        finally { settingsGate.Release(); }
    }

    internal static bool SetupComplete(IEnumerable<StorageRootRow> roots) =>
        roots.FirstOrDefault(r => r.Enabled)?.MaxAllocatedBytes > 0;

    // v1 keeps one storage root: the download folder and space limit both live on it.
    private static async Task SaveRootAsync(LibraryPlacement library, JsonElement body, CancellationToken ct)
    {
        var path = body.TryGetProperty("baseDownloadPath", out var p) && p.ValueKind == JsonValueKind.String &&
            p.GetString() is { Length: > 0 } text ? text.Trim() : null;
        long? cap = null;
        if (body.TryGetProperty("maxStorageGb", out var g) && g.ValueKind != JsonValueKind.Null)
        {
            var gb = g.ValueKind == JsonValueKind.Number ? g.GetDouble() :
                double.TryParse(g.GetString(), NumberStyles.Float, CultureInfo.InvariantCulture, out var parsed) ? parsed : -1;
            if (gb <= 0) throw new ArgumentException("Set a space limit above 0 GB.");
            cap = (long)(gb * 1_000_000_000d);
        }
        if (path is not null && !Path.IsPathFullyQualified(path))
            throw new ArgumentException("Enter the full folder path, for example D:\\Media.");
        if (path is null && cap is null) return;
        var current = (await library.RootsAsync(ct)).FirstOrDefault(r => r.Enabled);
        if (current is not null && (path is null || string.Equals(Path.GetFullPath(path).TrimEnd(Path.DirectorySeparatorChar),
                current.Path, StringComparison.OrdinalIgnoreCase)))
        {
            if (cap is null || cap == current.MaxAllocatedBytes) return;
            Check(await library.ConfigureRootAsync(current.Id, new(current.Priority, current.ReserveBytes, true,
                current.Kinds, current.Version, MaxAllocatedBytes: cap), ct));
            return;
        }
        if (path is null) throw new ArgumentException("Choose a download folder.");
        Check(await library.SetDownloadRootAsync(path, cap ?? current?.MaxAllocatedBytes, ct));

        static StorageRootRow Check(LibraryRootResult result) =>
            result.Root ?? throw new ArgumentException(result.Failure?.Message ?? "Could not save the download folder.");
    }

    internal async Task<object> RecoveryAsync(bool restore, CancellationToken ct)
    {
        await using var db = await contexts.CreateDbContextAsync(ct);
        if (restore)
        {
            await engine.RecoverAsync([.. await db.Downloads.AsNoTracking().OrderBy(d => d.Id).ToListAsync(ct)],
                [.. await db.DownloadFiles.AsNoTracking().OrderBy(f => f.Id).ToListAsync(ct)], ct);
            return new { ok = true, message = "Saved downloads restored." };
        }
        return new { dataDirectory = HostPaths.DataDirectory(configuration),
            downloadDirectory = (await db.StorageRoots.AsNoTracking().OrderBy(r => r.Id)
                .FirstOrDefaultAsync(r => r.Enabled, ct))?.Path,
            hasMedia = await db.MediaFiles.AnyAsync(m => m.MissingSince == null, ct) };
    }
}
