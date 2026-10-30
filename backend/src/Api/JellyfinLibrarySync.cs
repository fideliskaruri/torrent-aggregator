using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Globalization;
using System.Text.Json;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;
using TorrentFlow.Library;
using TorrentFlow.Library.Jellyfin;
using TorrentFlow.Requests;
using TorrentFlow.Store;

namespace TorrentFlow.Api;

internal sealed record JellyfinRootStatus(string State, ImmutableArray<string> Libraries, string? Message = null);

internal sealed class JellyfinLibrarySync(IServiceScopeFactory scopes, JellyfinClient client, string dataDirectory,
    ILogger<JellyfinLibrarySync> logger) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(30);
    private const string TurnedOffMessage = "This storage location is turned off.";
    private const string CheckingMessage = "Checking Jellyfin…";
    private readonly Channel<bool> requests = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropWrite,
        SingleReader = true,
        SingleWriter = false,
    });
    private readonly ConcurrentDictionary<string, JellyfinRootStatus> statuses = new(StringComparer.Ordinal);
    private readonly object gate = new();
    private readonly List<TaskCompletionSource> waiters = [];
    private CancellationTokenSource? activePass;

    public void RequestSync()
    {
        lock (gate) activePass?.Cancel();
        requests.Writer.TryWrite(true);
    }

    public async Task<JellyfinRootStatus> SyncNowAsync(string rootId, CancellationToken ct)
    {
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        lock (gate)
        {
            waiters.Add(completion);
            activePass?.Cancel();
        }
        requests.Writer.TryWrite(true);
        await completion.Task.WaitAsync(ct);
        return statuses.GetValueOrDefault(rootId, new("pending", []));
    }

    public ImmutableArray<JellyfinRootStatus> Statuses(ImmutableArray<StorageRootRow> roots, JellyfinSettings settings)
    {
        if (!settings.SyncLibraries)
            return [.. roots.Select(_ => new JellyfinRootStatus("off", [], "Library sync is turned off in Jellyfin settings."))];
        if (settings.ServerUrl is null || settings.Credential is null)
            return [.. roots.Select(_ => new JellyfinRootStatus("off", [], "Connect to Jellyfin to add storage folders."))];
        return [.. roots.Select(root =>
        {
            if (!root.Enabled) return new JellyfinRootStatus("off", [], TurnedOffMessage);
            var cached = statuses.GetValueOrDefault(root.Id);
            return cached is null
                ? new JellyfinRootStatus("pending", [])
                : cached.Message == TurnedOffMessage ? new JellyfinRootStatus("pending", [], CheckingMessage) : cached;
        })];
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        requests.Writer.TryWrite(true);
        while (!stoppingToken.IsCancellationRequested)
        {
            var read = requests.Reader.ReadAsync(stoppingToken).AsTask();
            var delay = Task.Delay(Interval, stoppingToken);
            try { await Task.WhenAny(read, delay); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }

            while (requests.Reader.TryRead(out _)) { }
            using var pass = CancellationTokenSource.CreateLinkedTokenSource(stoppingToken);
            lock (gate) activePass = pass;
            var completed = false;
            try
            {
                await SyncPassAsync(pass.Token);
                completed = true;
            }
            catch (OperationCanceledException) when (pass.IsCancellationRequested) { }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "Jellyfin library sync pass failed");
                await SetFailureStatusesAsync(ex.Message, stoppingToken);
                completed = true;
            }
            finally
            {
                lock (gate)
                {
                    if (ReferenceEquals(activePass, pass)) activePass = null;
                    if (completed)
                    {
                        foreach (var waiter in waiters) waiter.TrySetResult();
                        waiters.Clear();
                    }
                }
            }
        }
    }

    private async Task SyncPassAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var roots = await db.StorageRoots.AsNoTracking().OrderBy(root => root.Priority).ToArrayAsync(ct);
        var setting = await db.Settings.AsNoTracking().SingleAsync(row => row.Id == "jellyfin", ct);
        var settings = SettingsCatalog.Read<JellyfinSettings>(setting);
        var token = SecretFiles.Read(dataDirectory, settings.Credential);
        if (!settings.SyncLibraries)
        {
            foreach (var root in roots) statuses[root.Id] = new("off", [], "Library sync is turned off in Jellyfin settings.");
            return;
        }
        if (settings.ServerUrl is null || token is null)
        {
            foreach (var root in roots) statuses[root.Id] = new("off", [], "Connect to Jellyfin to add storage folders.");
            return;
        }

        var current = await client.GetCurrentUser(settings.ServerUrl, token, ct);
        current ??= settings.UserId is { Length: > 0 } userId
            ? await client.GetUser(settings.ServerUrl, token, userId, ct) : null;
        if (current?.IsAdmin != true)
        {
            foreach (var root in roots)
                statuses[root.Id] = new("off", [], "Sign in with an admin account to add folders to Jellyfin.");
            return;
        }

        var serverInfo = await client.GetSystemInfo(settings.ServerUrl, token, ct);
        if (string.IsNullOrWhiteSpace(serverInfo.ServerId))
            throw new JellyfinException(JellyfinErrorKind.InvalidResponse, "Jellyfin did not return its server id.");
        var serverId = serverInfo.ServerId;
        var mapper = new JellyfinPathMapper(settings.PathMappings);
        var folders = await client.GetVirtualFolders(settings.ServerUrl, token, ct);
        var recordedPaths = await db.JellyfinLibraryPaths.AsNoTracking()
            .Where(row => row.ServerId == serverId).ToArrayAsync(ct);
        var expectedByRoot = new Dictionary<string, List<(string Local, string Server, string Kind)>>(StringComparer.Ordinal);
        var added = false;

        foreach (var root in roots)
        {
            ct.ThrowIfCancellationRequested();
            if (!root.Enabled)
            {
                statuses[root.Id] = new("off", [], TurnedOffMessage);
                continue;
            }
            if (!root.Online || root.ReviewRequired)
            {
                var existing = recordedPaths.Where(path => path.RootId == root.Id)
                    .Select(path => path.LibraryName).Distinct(StringComparer.OrdinalIgnoreCase).ToImmutableArray();
                statuses[root.Id] = existing.IsEmpty
                    ? new("pending", [], root.ReviewRequired
                        ? "Confirm this storage location in Storage settings to sync its folders."
                        : "Reconnect this storage location to sync its folders.")
                    : new("registered", existing);
                continue;
            }

            var rootFolders = new List<(string Local, string Server, string Kind)>();
            foreach (var kind in root.Kinds.Distinct())
            {
                var relative = LibraryPaths.KindFolder(root.LibraryFolders, kind);
                var localPath = LibraryPaths.Within(root.Path, relative);
                LibraryPaths.NoLinks(root.Path);
                Directory.CreateDirectory(localPath);
                var serverPath = mapper.ToJellyfin(localPath);
                if (serverPath is null || (settings.PathMappings.IsEmpty && !JellyfinHost.IsThisComputer(settings.ServerUrl)))
                {
                    statuses[root.Id] = new("failed", [], serverPath is null
                        ? $"Add a path mapping for {localPath} in Jellyfin settings."
                        : $"Jellyfin runs on another computer. Add a path mapping in Jellyfin settings so it can reach {root.Path}.");
                    rootFolders.Clear();
                    break;
                }
                rootFolders.Add((localPath, serverPath, kind.ToString()));
            }
            if (rootFolders.Count != root.Kinds.Distinct().Count()) continue;
            expectedByRoot[root.Id] = rootFolders;

            var libraries = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            var failed = false;
            foreach (var (localPath, serverPath, kindName) in rootFolders)
            {
                var matchingLibrary = FindContainingLibrary(folders, serverPath, mapper);
                if (matchingLibrary is not null)
                {
                    if (matchingLibrary.Name is { Length: > 0 } existingName) libraries.Add(existingName);
                    continue;
                }

                var kind = Enum.Parse<LibraryKind>(kindName);
                var overrideName = settings.LibraryOverrides.GetValueOrDefault(kindName);
                var selected = overrideName is null
                    ? ChooseLibrary(folders, kind)
                    : folders.FirstOrDefault(folder => string.Equals(folder.CollectionType, CollectionType(kind),
                        StringComparison.OrdinalIgnoreCase) && string.Equals(folder.Name, overrideName,
                        StringComparison.OrdinalIgnoreCase));
                var requestedName = NewLibraryName(kind, overrideName);
                try
                {
                    if (selected is null)
                    {
                        var collection = CollectionType(kind);
                        await client.AddVirtualFolder(settings.ServerUrl, token, requestedName, collection, serverPath, ct);
                    }
                    else
                        await client.AddVirtualFolderPath(settings.ServerUrl, token, selected.Name!, serverPath, ct);
                    folders = await client.GetVirtualFolders(settings.ServerUrl, token, ct);
                    var target = folders.FirstOrDefault(folder => folder.Locations.Any(location =>
                        SameMappedPath(location, serverPath, mapper)) &&
                        (selected is null
                        ? string.Equals(folder.Name, requestedName, StringComparison.OrdinalIgnoreCase)
                            : string.Equals(folder.ItemId, selected.ItemId, StringComparison.Ordinal)));
                    if (target?.ItemId is null || target.Name is null)
                        throw new JellyfinException(JellyfinErrorKind.InvalidResponse,
                            "Jellyfin accepted the folder but did not return its library. Try syncing again.");
                    await SavePathAsync(db, serverId, target, root.Id, kindName, serverPath, ct);
                    libraries.Add(target.Name);
                    added = true;
                }
                catch (Exception ex) when (ex is JellyfinException or IOException or UnauthorizedAccessException or DbUpdateException)
                {
                    statuses[root.Id] = new("failed", [.. libraries], ex.Message);
                    failed = true;
                    logger.LogWarning(ex, "Could not sync Jellyfin folder {Path} for root {RootId}", localPath, root.Id);
                    break;
                }
            }
            if (failed) continue;

            var allPresent = rootFolders.All(path => FindContainingLibrary(folders, path.Server, mapper) is not null);
            var indexed = allPresent && await HasIndexedItemsAsync(settings, token, rootFolders, mapper, ct);
            statuses[root.Id] = new(indexed ? "indexed" : allPresent ? "registered" : "pending", [.. libraries]);
        }

        if (added)
        {
            await client.RefreshLibrary(settings.ServerUrl, token, ct);
            // A library refresh is asynchronous. Item presence is the plan's documented indexing signal.
        }
    }

    private async Task<bool> HasIndexedItemsAsync(JellyfinSettings settings, string token,
        List<(string Local, string Server, string Kind)> paths, JellyfinPathMapper mapper, CancellationToken ct)
    {
        var items = new List<JellyfinItemDto>();
        var start = 0;
        const int pageSize = 500;
        int total;
        do
        {
            var page = await client.GetItems(settings.ServerUrl!, token, new JellyfinItemQuery
            {
                UserId = settings.UserId,
                Recursive = true,
                Fields = ["Path"],
                Limit = pageSize,
                StartIndex = start,
            }, ct);
            items.AddRange(page.Items);
            total = page.TotalRecordCount;
            start += page.Items.Length;
        } while (start < total && start < 10000 && !ct.IsCancellationRequested);

        return items.Any(item => item.Path is { } path && mapper.ToLocal(path) is { } local &&
            paths.Any(folder => IsSameOrInside(folder.Local, local)));
    }

    private async Task SavePathAsync(TorrentFlowDbContext db, string serverId, JellyfinVirtualFolder folder,
        string rootId, string kind, string serverPath, CancellationToken ct)
    {
        if (await db.JellyfinLibraryPaths.AnyAsync(path => path.ServerId == serverId &&
            path.LibraryItemId == folder.ItemId && path.ServerPath == serverPath, ct)) return;
        db.JellyfinLibraryPaths.Add(new JellyfinLibraryPathRow
        {
            Id = Guid.NewGuid().ToString("N"),
            ServerId = serverId,
            LibraryItemId = folder.ItemId!,
            LibraryName = folder.Name!,
            RootId = rootId,
            Kind = kind,
            ServerPath = serverPath,
            AddedAt = DateTimeOffset.UtcNow,
        });
        await db.SaveChangesAsync(ct);
    }

    private async Task SetFailureStatusesAsync(string message, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var roots = await db.StorageRoots.AsNoTracking().ToArrayAsync(ct);
        foreach (var root in roots)
            statuses[root.Id] = !root.Enabled ? new("off", [], TurnedOffMessage)
                : new("failed", statuses.GetValueOrDefault(root.Id)?.Libraries ?? [], message);
    }

    public async Task<ImmutableArray<JellyfinRootStatus>> GetStatusesAsync(ImmutableArray<StorageRootRow> roots,
        CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var settings = SettingsCatalog.Read<JellyfinSettings>(
            await db.Settings.AsNoTracking().SingleAsync(row => row.Id == "jellyfin", ct));
        return Statuses(roots, settings);
    }

    public async Task<ImmutableArray<object>> OrphanPathsAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var roots = await db.StorageRoots.AsNoTracking().ToDictionaryAsync(root => root.Id, ct);
        var rows = await db.JellyfinLibraryPaths.AsNoTracking().OrderBy(path => path.AddedAt).ToArrayAsync(ct);
        return [.. rows.Where(path => !roots.TryGetValue(path.RootId, out var root) || !root.Enabled)
            .Select(path => (object)new
            {
                rootId = path.RootId,
                libraryName = path.LibraryName,
                path = path.ServerPath,
                state = roots.ContainsKey(path.RootId) ? "off" : "removed-root",
            })];
    }

    public async Task<object> RemoveRootPathsAsync(string rootId, CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var setting = await db.Settings.AsNoTracking().SingleAsync(row => row.Id == "jellyfin", ct);
        var settings = SettingsCatalog.Read<JellyfinSettings>(setting);
        var token = SecretFiles.Read(dataDirectory, settings.Credential);
        if (settings.ServerUrl is null || token is null)
            return new { removed = 0, ignored = 0, message = "Connect to Jellyfin before removing folders." };
        var current = await client.GetCurrentUser(settings.ServerUrl, token, ct);
        current ??= settings.UserId is { Length: > 0 } userId
            ? await client.GetUser(settings.ServerUrl, token, userId, ct) : null;
        if (current?.IsAdmin != true)
            return new { removed = 0, ignored = 0, message = "Sign in with an admin account to remove folders from Jellyfin." };
        var currentServerId = (await client.GetSystemInfo(settings.ServerUrl, token, ct)).ServerId;
        if (string.IsNullOrWhiteSpace(currentServerId))
            return new { removed = 0, ignored = 0, message = "Jellyfin did not return its server id. No folders were removed." };
        var libraries = await client.GetVirtualFolders(settings.ServerUrl, token, ct);
        var records = await db.JellyfinLibraryPaths.Where(path => path.RootId == rootId).ToArrayAsync(ct);
        var removed = 0;
        var ignored = 0;
        var failed = 0;
        foreach (var record in records)
        {
            ct.ThrowIfCancellationRequested();
            var library = libraries.FirstOrDefault(folder => folder.ItemId == record.LibraryItemId &&
                folder.Locations.Any(path => JellyfinPathMapper.PathsEqual(path, record.ServerPath)));
            if (record.ServerId != currentServerId || library is null || library.Name is null)
            {
                ignored++;
                continue;
            }
            // Jellyfin removes by exact string and silently ignores a mismatch, so send its own spelling.
            var location = library.Locations.First(path => JellyfinPathMapper.PathsEqual(path, record.ServerPath));
            await client.RemoveVirtualFolderPath(settings.ServerUrl, token, library.Name, location, ct);
            libraries = await client.GetVirtualFolders(settings.ServerUrl, token, ct);
            var stillThere = libraries.Any(folder => folder.ItemId == record.LibraryItemId &&
                folder.Locations.Any(path => JellyfinPathMapper.PathsEqual(path, record.ServerPath)));
            if (stillThere)
            {
                failed++;
                continue;
            }
            db.JellyfinLibraryPaths.Remove(record);
            removed++;
        }
        if (removed > 0) await db.SaveChangesAsync(ct);
        if (removed > 0) statuses[rootId] = new("pending", [], "Folders were removed from Jellyfin.");
        var message = failed > 0
            ? $"Jellyfin kept {failed} folder{(failed == 1 ? "" : "s")}. Remove {(failed == 1 ? "it" : "them")} in Jellyfin's library settings."
            : removed > 0 ? "Recorded Jellyfin folders were removed."
            : "No matching folders were removed. The server, library or exact path did not match.";
        return new { removed, ignored, failed, message };
    }

    private static JellyfinVirtualFolder? FindContainingLibrary(IEnumerable<JellyfinVirtualFolder> folders,
        string serverPath, JellyfinPathMapper mapper) =>
        folders.FirstOrDefault(folder => folder.Locations.Any(location =>
            SameMappedPath(location, serverPath, mapper)));

    private static bool SameMappedPath(string first, string second, JellyfinPathMapper mapper)
    {
        var localFirst = mapper.ToLocal(first) ?? first;
        var localSecond = mapper.ToLocal(second) ?? second;
        return JellyfinPathMapper.PathsEqual(localFirst, localSecond);
    }

    private static bool IsSameOrInside(string folder, string path)
    {
        var normalizedFolder = NormalizePath(folder);
        var normalizedPath = NormalizePath(path);
        return normalizedPath.Equals(normalizedFolder, StringComparison.OrdinalIgnoreCase) ||
            normalizedPath.StartsWith(normalizedFolder.TrimEnd('/') + "/", StringComparison.OrdinalIgnoreCase);
    }

    private static string NormalizePath(string path) => path.Replace('\\', '/').TrimEnd('/');

    private static JellyfinVirtualFolder? ChooseLibrary(IEnumerable<JellyfinVirtualFolder> folders, LibraryKind kind)
    {
        var typed = folders.Where(folder => string.Equals(folder.CollectionType, CollectionType(kind),
            StringComparison.OrdinalIgnoreCase)).ToArray();
        var anime = kind is LibraryKind.Anime or LibraryKind.AnimeMovies;
        if (anime)
            return typed.FirstOrDefault(folder => folder.Name?.Contains("anime", StringComparison.OrdinalIgnoreCase) == true)
                ?? typed.FirstOrDefault();
        return typed.FirstOrDefault(folder => folder.Name?.Contains("anime", StringComparison.OrdinalIgnoreCase) != true)
            ?? typed.FirstOrDefault();
    }

    private static string CollectionType(LibraryKind kind) =>
        kind is LibraryKind.TV or LibraryKind.Anime ? "tvshows" : "movies";

    private static string NewLibraryName(LibraryKind kind, string? overrideName = null) =>
        overrideName ?? (kind switch
        {
            LibraryKind.Movies => "Movies",
            LibraryKind.TV => "Shows",
            LibraryKind.AnimeMovies => "Anime Movies",
            _ => "Anime",
        });
}

internal sealed class JellyfinJobWorker : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(10);
    private readonly IServiceScopeFactory scopes;
    private readonly JellyfinClient client;
    private readonly string dataDirectory;
    private readonly ILogger<JellyfinJobWorker> logger;
    private readonly IReadOnlyDictionary<string, Func<TorrentFlowDbContext, JellyfinJobRow[], CancellationToken, Task>> handlers;

    public JellyfinJobWorker(IServiceScopeFactory scopes, JellyfinClient client, string dataDirectory,
        ILogger<JellyfinJobWorker> logger)
    {
        this.scopes = scopes;
        this.client = client;
        this.dataDirectory = dataDirectory;
        this.logger = logger;
        handlers = new Dictionary<string, Func<TorrentFlowDbContext, JellyfinJobRow[], CancellationToken, Task>>
        {
            ["rescan"] = ProcessRescansAsync,
            ["inspect"] = ProcessInspectionsAsync,
            ["matchfix"] = ProcessMatchfixesAsync,
        };
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { await ProcessDueAsync(stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
            catch (Exception ex) { logger.LogWarning(ex, "Jellyfin job pass failed"); }
            try { await Task.Delay(Interval, stoppingToken); }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { break; }
        }
    }

    private async Task ProcessDueAsync(CancellationToken ct)
    {
        await using var scope = scopes.CreateAsyncScope();
        var db = scope.ServiceProvider.GetRequiredService<TorrentFlowDbContext>();
        var now = DateTimeOffset.UtcNow;
        var expired = await db.JellyfinJobs.Where(job => job.State == "pending" && job.CreatedAt < now.AddDays(-7))
            .ToArrayAsync(ct);
        foreach (var job in expired) db.Entry(job).CurrentValues.SetValues(job with
        { State = "failed", LastError = "This Jellyfin update expired after 7 days.", NextAttemptAt = now });
        if (expired.Length > 0) await db.SaveChangesAsync(ct);

        var due = await db.JellyfinJobs.AsNoTracking().Where(job => job.State == "pending" &&
            job.NextAttemptAt <= now && job.CreatedAt >= now.AddDays(-7))
            .OrderBy(job => job.CreatedAt).Take(100).ToArrayAsync(ct);
        foreach (var group in due.GroupBy(job => job.Kind))
        {
            if (handlers.TryGetValue(group.Key, out var handler))
                await handler(db, [.. group], ct);
        }
    }

    private async Task ProcessRescansAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs, CancellationToken ct)
    {
        var setting = await db.Settings.AsNoTracking().SingleAsync(row => row.Id == "jellyfin", ct);
        var settings = SettingsCatalog.Read<JellyfinSettings>(setting);
        var token = SecretFiles.Read(dataDirectory, settings.Credential);
        if (settings.ServerUrl is null || token is null)
        {
            await FailJobsAsync(db, jobs, "Connect to Jellyfin to send the pending file updates.", ct);
            return;
        }
        var mapper = new JellyfinPathMapper(settings.PathMappings);
        if (settings.PathMappings.IsEmpty && !JellyfinHost.IsThisComputer(settings.ServerUrl))
        {
            await FailJobsAsync(db, jobs, "Jellyfin runs on another computer. Add a path mapping in Jellyfin settings.", ct);
            return;
        }
        var updates = new List<(JellyfinJobRow Job, JellyfinMediaUpdate Update)>();
        foreach (var job in jobs)
        {
            try
            {
                var payload = job.PayloadJson;
                var paths = payload.TryGetProperty("paths", out var pathArray) ? pathArray :
                    payload.TryGetProperty("Paths", out pathArray) ? pathArray : default;
                if (paths.ValueKind != JsonValueKind.Array) throw new InvalidDataException("The update has no folder paths.");
                var updateType = payload.TryGetProperty("updateType", out var type) ? type.GetString() : null;
                if (string.IsNullOrWhiteSpace(updateType)) updateType = "Created";
                foreach (var pathValue in paths.EnumerateArray())
                {
                    var local = pathValue.GetString();
                    var serverPath = local is null ? null : mapper.ToJellyfin(local);
                    if (serverPath is null) throw new InvalidDataException("Add a path mapping in Jellyfin settings for this storage folder.");
                    updates.Add((job, new(serverPath, updateType)));
                }
            }
            catch (Exception ex) when (ex is InvalidDataException or InvalidOperationException or JsonException)
            {
                await FailJobsAsync(db, [job], ex.Message, ct);
            }
        }
        if (updates.Count == 0) return;
        try
        {
            await client.ReportMediaUpdated(settings.ServerUrl, token, updates.Select(item => item.Update), ct);
            await CompleteRescansAsync(db, updates.Select(item => item.Job).DistinctBy(job => job.Id).ToArray(), ct);
        }
        catch (Exception ex) when (ex is JellyfinException or HttpRequestException)
        {
            await FailJobsAsync(db, updates.Select(item => item.Job).DistinctBy(job => job.Id).ToArray(), ex.Message, ct);
        }
    }

    private async Task ProcessInspectionsAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs,
        CancellationToken ct)
    {
        var setting = await db.Settings.AsNoTracking().SingleOrDefaultAsync(row => row.Id == "jellyfin", ct);
        var settings = setting is null ? null : SettingsCatalog.Read<JellyfinSettings>(setting);
        var token = settings is null ? null : SecretFiles.Read(dataDirectory, settings.Credential);
        if (settings?.ServerUrl is null || token is null)
        {
            await FailJobsAsync(db, jobs, "Connect to Jellyfin to inspect downloaded files.", ct);
            return;
        }
        if (string.IsNullOrWhiteSpace(settings.UserId))
        {
            await FailJobsAsync(db, jobs, "Choose a Jellyfin user to inspect downloaded files.", ct);
            return;
        }
        var mapper = new JellyfinPathMapper(settings.PathMappings);
        if (settings.PathMappings.IsEmpty && !JellyfinHost.IsThisComputer(settings.ServerUrl))
        {
            await FailJobsAsync(db, jobs, "Jellyfin runs on another computer. Add a path mapping in Jellyfin settings.", ct);
            return;
        }
        var qualityRow = await db.Settings.AsNoTracking().SingleOrDefaultAsync(row => row.Id == "quality", ct);
        var globalLanguage = qualityRow is null ? null :
            SettingsCatalog.Read<QualitySettings>(qualityRow).AudioLanguage;

        foreach (var job in jobs)
        {
            try
            {
                var mediaFileId = job.MediaFileId ?? PayloadMediaFileId(job.PayloadJson);
                if (string.IsNullOrWhiteSpace(mediaFileId))
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }
                var file = await db.MediaFiles.AsNoTracking().SingleOrDefaultAsync(row => row.Id == mediaFileId, ct);
                if (file is null || file.Status != FilePresence.Present)
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }
                var mappedPath = mapper.ToJellyfin(file.Path);
                if (mappedPath is null)
                {
                    await FailJobsAsync(db, [job],
                        "Add a path mapping in Jellyfin settings for this storage folder.", ct);
                    continue;
                }
                var item = await FindInspectionItemAsync(settings.ServerUrl, token, settings.UserId,
                    mapper, file, mappedPath, ct);
                if (item is null)
                {
                    if (job.CreatedAt <= DateTimeOffset.UtcNow.AddMinutes(-30))
                    {
                        await SaveInspectionAsync(db, file.Id, "unknown", file.JellyfinItemId, null, [], ct);
                        await CompleteJobsAsync(db, [job], ct, "Jellyfin has not indexed this file yet.");
                    }
                    else
                        await FailJobsAsync(db, [job], "Jellyfin has not indexed this file yet.", ct);
                    continue;
                }

                var source = item.MediaSources.IsDefaultOrEmpty ? null : item.MediaSources.FirstOrDefault(media =>
                    media.Path is not null && JellyfinPathMapper.PathsEqual(media.Path, mappedPath));
                var streams = source?.MediaStreams.IsDefault == false ? source.MediaStreams : [];
                if (streams.IsEmpty && job.CreatedAt > DateTimeOffset.UtcNow.AddMinutes(-30))
                {
                    // Indexed but not probed yet; Jellyfin reads the streams shortly after adding the item.
                    await FailJobsAsync(db, [job], "Jellyfin has not read this file's tracks yet.", ct);
                    continue;
                }
                var tracks = streams.Select((stream, index) => (stream, index))
                    .Where(pair => IsTrackType(pair.stream.Type))
                    .Select(pair => new MediaTrack(pair.stream.Index ?? pair.index, pair.stream.Type!,
                        LanguageCodes.Normalize(pair.stream.Language), pair.stream.Codec, pair.stream.Channels,
                        pair.stream.ChannelLayout, pair.stream.IsDefault, pair.stream.IsForced))
                    .ToImmutableArray();
                var audioStreams = tracks.Where(track =>
                    string.Equals(track.Type, "Audio", StringComparison.OrdinalIgnoreCase)).ToArray();
                var languages = audioStreams.Select(track => track.Language).OfType<string>()
                    .Distinct(StringComparer.Ordinal).ToArray();
                var audioLanguages = languages.Length == 0 ? null : string.Join(',', languages);
                var inspectionState = InspectionState(streams.Length, audioStreams, languages,
                    await InspectionLanguagesAsync(db, job, file, globalLanguage, ct));
                await SaveInspectionAsync(db, file.Id, inspectionState, item.Id,
                    audioLanguages, tracks, ct);
                if (inspectionState == "rejected")
                    await WriteRejectedActivityAsync(db, file, job, languages, ct);
                await QueueMatchfixIfNeededAsync(db, settings, token, mapper, file, item, job, ct);
                await CompleteJobsAsync(db, [job], ct);
            }
            catch (Exception ex) when (ex is JellyfinException or HttpRequestException)
            {
                await FailJobsAsync(db, [job], ex.Message, ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
                await FailJobsAsync(db, [job], "The library file changed while it was being inspected.", ct);
            }
            catch (DbUpdateException ex)
            {
                db.ChangeTracker.Clear();
                logger.LogWarning(ex, "Could not save the inspection of {MediaFileId}.", job.MediaFileId);
                await FailJobsAsync(db, [job], "The inspection could not be saved.", ct);
            }
        }
    }

    private async Task QueueMatchfixIfNeededAsync(TorrentFlowDbContext db, JellyfinSettings settings, string token,
        JellyfinPathMapper mapper, MediaFileRow file, JellyfinItemDto item, JellyfinJobRow sourceJob,
        CancellationToken ct)
    {
        if (item.Id is null || item.LockData == true || item.IsLocked == true || file.RootId is null) return;

        var target = item;
        if (string.Equals(item.Type, "Episode", StringComparison.OrdinalIgnoreCase))
        {
            if (string.IsNullOrWhiteSpace(item.SeriesId)) return;
            var series = await client.GetItems(settings.ServerUrl!, token, new JellyfinItemQuery
            {
                UserId = settings.UserId,
                Ids = [item.SeriesId],
                Fields = ["ProviderIds", "LockData", "Path", "ProductionYear", "Name"],
                Limit = 1,
            }, ct);
            target = series.Items.FirstOrDefault()!;
            if (target is null || target.Id is null || target.LockData == true || target.IsLocked == true) return;
        }

        var targetLocalPath = target.Path is null ? null : mapper.ToLocal(target.Path);
        if (targetLocalPath is null) return;
        var roots = await db.StorageRoots.AsNoTracking().Where(root => root.Enabled).ToArrayAsync(ct);
        if (!roots.Any(root => IsWithinRoot(file.Path, root.Path) && root.Id == file.RootId) ||
            !roots.Any(root => IsWithinRoot(targetLocalPath, root.Path)))
            return;

        var links = await db.WorkLinks.AsNoTracking().Where(link => link.WorkId == file.WorkId &&
            link.Status == LinkStatus.Verified &&
            (link.Provider == "tmdb" || link.Provider == "tvdb" || link.Provider == "imdb"))
            .ToArrayAsync(ct);
        var verified = links.GroupBy(link => link.Provider, StringComparer.Ordinal)
            .ToDictionary(group => group.Key, group => group.First().ExternalId, StringComparer.Ordinal);
        var existing = target.ProviderIds ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var contradicted = false;
        foreach (var provider in new[] { "tmdb", "tvdb", "imdb" })
        {
            if (!verified.TryGetValue(provider, out var held) || string.IsNullOrWhiteSpace(held)) continue;
            var providerKey = existing.Keys.FirstOrDefault(key => ProviderMatches(key, provider));
            if (providerKey is null || string.Equals(existing[providerKey], held, StringComparison.OrdinalIgnoreCase))
                continue;
            contradicted = true;
        }
        if (!contradicted) return;

        var now = DateTimeOffset.UtcNow;
        var recentJobs = await db.JellyfinJobs.AsNoTracking().Where(job => job.Kind == "matchfix" &&
            job.CreatedAt >= now.AddHours(-24) && (job.State == "pending" || job.State == "done"))
            .ToArrayAsync(ct);
        if (recentJobs.Any(job => PayloadString(job.PayloadJson, "itemId") == target.Id) ||
            await HasRecentMatchfixActivityAsync(db, target.Id, now, ct))
            return;

        db.JellyfinJobs.Add(new JellyfinJobRow
        {
            Id = Guid.NewGuid().ToString("N"),
            Kind = "matchfix",
            PayloadJson = JsonSerializer.SerializeToElement(new
            {
                itemId = target.Id,
                mediaItemId = item.Id,
                mediaFileId = file.Id,
                workId = file.WorkId,
            }),
            TargetId = sourceJob.TargetId,
            MediaFileId = file.Id,
            Attempts = 0,
            NextAttemptAt = now,
            CreatedAt = now,
            LastError = null,
            State = "pending",
        });
        await db.SaveChangesAsync(ct);
    }

    private static bool ProviderMatches(string jellyfinProvider, string provider) =>
        provider switch
        {
            "tmdb" => jellyfinProvider.Equals("Tmdb", StringComparison.OrdinalIgnoreCase) ||
                      jellyfinProvider.Equals("TheMovieDb", StringComparison.OrdinalIgnoreCase),
            "tvdb" => jellyfinProvider.Equals("Tvdb", StringComparison.OrdinalIgnoreCase) ||
                      jellyfinProvider.Equals("TheTVDB", StringComparison.OrdinalIgnoreCase),
            "imdb" => jellyfinProvider.Equals("Imdb", StringComparison.OrdinalIgnoreCase),
            _ => false,
        };

    private static bool IsWithinRoot(string path, string root)
    {
        try
        {
            var relative = Path.GetRelativePath(Path.GetFullPath(root), Path.GetFullPath(path));
            return relative == "." || (!Path.IsPathRooted(relative) && relative != ".." &&
                !relative.StartsWith(".." + Path.DirectorySeparatorChar, StringComparison.Ordinal));
        }
        catch (Exception ex) when (ex is ArgumentException or IOException or NotSupportedException)
        {
            return false;
        }
    }

    private async Task ProcessMatchfixesAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs,
        CancellationToken ct)
    {
        var setting = await db.Settings.AsNoTracking().SingleOrDefaultAsync(row => row.Id == "jellyfin", ct);
        var settings = setting is null ? null : SettingsCatalog.Read<JellyfinSettings>(setting);
        var token = settings is null ? null : SecretFiles.Read(dataDirectory, settings.Credential);
        if (settings?.ServerUrl is null || token is null || string.IsNullOrWhiteSpace(settings.UserId))
        {
            await FailJobsAsync(db, jobs, "Connect to Jellyfin and choose a user to fix library matches.", ct);
            return;
        }

        var mapper = new JellyfinPathMapper(settings.PathMappings);
        foreach (var job in jobs)
        {
            try
            {
                var itemId = PayloadString(job.PayloadJson, "itemId");
                var mediaItemId = PayloadString(job.PayloadJson, "mediaItemId");
                var mediaFileId = job.MediaFileId ?? PayloadString(job.PayloadJson, "mediaFileId");
                var workId = PayloadString(job.PayloadJson, "workId");
                if (itemId is null || mediaItemId is null || mediaFileId is null || workId is null)
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }

                var file = await db.MediaFiles.AsNoTracking().SingleOrDefaultAsync(row => row.Id == mediaFileId, ct);
                if (file is null || file.Status != FilePresence.Present || file.RootId is null ||
                    !string.Equals(file.WorkId, workId, StringComparison.Ordinal))
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }

                var mediaItem = await GetItemAsync(settings.ServerUrl, token, settings.UserId, mediaItemId, ct);
                var target = itemId == mediaItemId
                    ? mediaItem
                    : await GetItemAsync(settings.ServerUrl, token, settings.UserId, itemId, ct);
                if (mediaItem is null || target is null || target.Id is null ||
                    mediaItem.LockData == true || mediaItem.IsLocked == true ||
                    target.LockData == true || target.IsLocked == true ||
                    target.Path is null || mapper.ToLocal(target.Path) is not { } targetPath)
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }

                var roots = await db.StorageRoots.AsNoTracking().Where(root => root.Enabled).ToArrayAsync(ct);
                if (!roots.Any(root => root.Id == file.RootId && IsWithinRoot(file.Path, root.Path)) ||
                    !roots.Any(root => IsWithinRoot(targetPath, root.Path)))
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }

                var links = await db.WorkLinks.AsNoTracking().Where(link => link.WorkId == workId &&
                    link.Status == LinkStatus.Verified &&
                    (link.Provider == "tmdb" || link.Provider == "tvdb" || link.Provider == "imdb"))
                    .ToArrayAsync(ct);
                var verified = links.GroupBy(link => link.Provider, StringComparer.Ordinal)
                    .ToDictionary(group => group.Key, group => group.First().ExternalId, StringComparer.Ordinal);
                var existing = target.ProviderIds ?? new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
                var corrected = new Dictionary<string, string>(existing, StringComparer.OrdinalIgnoreCase);
                var contradicted = false;
                foreach (var provider in new[] { "tmdb", "tvdb", "imdb" })
                {
                    if (!verified.TryGetValue(provider, out var held) || string.IsNullOrWhiteSpace(held)) continue;
                    var key = existing.Keys.FirstOrDefault(candidate => ProviderMatches(candidate, provider));
                    if (key is null || string.Equals(existing[key], held, StringComparison.OrdinalIgnoreCase)) continue;
                    corrected[key] = held;
                    contradicted = true;
                }
                if (!contradicted)
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }

                var now = DateTimeOffset.UtcNow;
                var recentJobs = await db.JellyfinJobs.AsNoTracking().Where(candidate =>
                    candidate.Id != job.Id && candidate.Kind == "matchfix" &&
                    candidate.State == "done" && candidate.CreatedAt >= now.AddHours(-24))
                    .ToArrayAsync(ct);
                if (recentJobs.Any(candidate => PayloadString(candidate.PayloadJson, "itemId") == itemId))
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }
                if (await HasRecentMatchfixActivityAsync(db, itemId, now, ct))
                {
                    await QueueInspectionsAfterMatchfixAsync(db, file, job, ct);
                    continue;
                }

                var searchProvider = verified.ContainsKey("tmdb") ? "TheMovieDb" :
                    verified.ContainsKey("tvdb") ? "TheTVDB" :
                    verified.ContainsKey("imdb") ? "Imdb" : null;
                if (searchProvider is null)
                {
                    await CompleteJobsAsync(db, [job], ct);
                    continue;
                }
                await client.ApplyRemoteSearch(settings.ServerUrl, token, itemId, new
                {
                    Name = target.Name,
                    ProductionYear = target.ProductionYear,
                    ProviderIds = corrected,
                    SearchProviderName = searchProvider,
                }, replaceAllImages: false, ct);
                await WriteMatchfixActivityAsync(db, file, job, target, ct);
                await QueueInspectionsAfterMatchfixAsync(db, file, job, ct);
            }
            catch (Exception ex) when (ex is JellyfinException or HttpRequestException)
            {
                await FailJobsAsync(db, [job], ex.Message, ct);
            }
            catch (DbUpdateConcurrencyException)
            {
                db.ChangeTracker.Clear();
                await FailJobsAsync(db, [job], "The library file changed while its match was being fixed.", ct);
            }
            catch (DbUpdateException ex)
            {
                db.ChangeTracker.Clear();
                logger.LogWarning(ex, "Could not save Jellyfin match fix for {ItemId}.",
                    PayloadString(job.PayloadJson, "itemId"));
                await FailJobsAsync(db, [job], "The Jellyfin match fix could not be saved.", ct);
            }
        }
    }

    private async Task<JellyfinItemDto?> GetItemAsync(string server, string token, string userId, string itemId,
        CancellationToken ct)
    {
        var result = await client.GetItems(server, token, new JellyfinItemQuery
        {
            UserId = userId,
            Ids = [itemId],
            Fields = ["ProviderIds", "LockData", "Path", "ProductionYear", "Name"],
            Limit = 1,
        }, ct);
        return result.Items.FirstOrDefault();
    }

    private static async Task WriteMatchfixActivityAsync(TorrentFlowDbContext db, MediaFileRow file,
        JellyfinJobRow job, JellyfinItemDto item, CancellationToken ct)
    {
        var work = await db.Works.AsNoTracking().SingleOrDefaultAsync(row => row.Id == file.WorkId, ct);
        if (work is null) return;
        var batchId = $"jellyfin-matchfix:{item.Id}:{DateTimeOffset.UtcNow:yyyyMMdd}";
        if (await db.Attempts.AsNoTracking().AnyAsync(row => row.BatchId == batchId, ct)) return;
        var names = await db.WorkNames.AsNoTracking().Where(row => row.WorkId == work.Id).ToArrayAsync(ct);
        var title = NotificationReadModels.Title(work, names);
        var year = work.Year ?? item.ProductionYear;
        if (year is not null) title += $" ({year.Value.ToString(CultureInfo.InvariantCulture)})";
        var targetId = job.TargetId is { } id &&
            await db.Targets.AsNoTracking().AnyAsync(row => row.Id == id, ct) ? id : null;
        var now = DateTimeOffset.UtcNow;
        db.Attempts.Add(new AttemptRow
        {
            Id = Guid.NewGuid().ToString("N"),
            TargetId = targetId,
            WorkId = work.Id,
            ActorUserId = "local",
            Kind = AttemptKind.LegacyEvent,
            StartedAt = now,
            EndedAt = now,
            Outcome = "Completed",
            ReasonText = $"Fixed Jellyfin match for {title}.",
            BatchId = batchId,
        });
        await db.SaveChangesAsync(ct);
    }

    private static async Task QueueInspectionsAfterMatchfixAsync(TorrentFlowDbContext db, MediaFileRow matchedFile,
        JellyfinJobRow job, CancellationToken ct)
    {
        var files = await db.MediaFiles.Where(file => file.WorkId == matchedFile.WorkId &&
            file.Status == FilePresence.Present).ToArrayAsync(ct);
        var pendingIds = (await db.JellyfinJobs.AsNoTracking().Where(row => row.Kind == "inspect" &&
                row.State == "pending" && row.MediaFileId != null)
            .Select(row => row.MediaFileId).ToArrayAsync(ct)).OfType<string>()
            .ToHashSet(StringComparer.Ordinal);
        var now = DateTimeOffset.UtcNow;
        foreach (var file in files)
        {
            db.Entry(file).CurrentValues.SetValues(file with
            {
                InspectionState = "pending",
                Version = file.Version + 1,
            });
            if (!pendingIds.Add(file.Id)) continue;
            db.JellyfinJobs.Add(new JellyfinJobRow
            {
                Id = Guid.NewGuid().ToString("N"),
                Kind = "inspect",
                PayloadJson = JsonSerializer.SerializeToElement(new { mediaFileId = file.Id }),
                TargetId = job.TargetId,
                MediaFileId = file.Id,
                Attempts = 0,
                NextAttemptAt = now.AddSeconds(60),
                CreatedAt = now,
                LastError = null,
                State = "pending",
            });
        }
        await CompleteJobsAsync(db, [job], ct);
    }

    private static string? PayloadString(JsonElement payload, string key) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty(key, out var value) &&
        value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static Task<bool> HasRecentMatchfixActivityAsync(TorrentFlowDbContext db, string itemId,
        DateTimeOffset now, CancellationToken ct)
    {
        var prefix = $"jellyfin-matchfix:{itemId}:";
        return db.Attempts.AsNoTracking().AnyAsync(row => row.BatchId != null &&
            row.BatchId.StartsWith(prefix) && row.StartedAt >= now.AddHours(-24), ct);
    }

    private async Task<JellyfinItemDto?> FindInspectionItemAsync(string server, string token, string userId,
        JellyfinPathMapper mapper, MediaFileRow file, string mappedPath, CancellationToken ct)
    {
        const int pageSize = 500;
        const int maxItems = 100000;
        var fields = ImmutableArray.Create("Path", "MediaSources", "ProviderIds", "LockData", "ProductionYear");
        if (!string.IsNullOrWhiteSpace(file.JellyfinItemId))
        {
            try
            {
                var known = await client.GetItems(server, token, new JellyfinItemQuery
                {
                    UserId = userId,
                    Ids = [file.JellyfinItemId],
                    Fields = fields,
                    Limit = 1,
                }, ct);
                var match = known.Items.FirstOrDefault(item =>
                    InspectionPathsMatch(mapper, file.Path, mappedPath, item.Path));
                if (match is not null) return match;
            }
            catch (JellyfinException ex) when (ex.Kind == JellyfinErrorKind.NotFound) { }
        }

        var start = 0;
        JellyfinItemsResult page;
        do
        {
            page = await client.GetItems(server, token, new JellyfinItemQuery
            {
                UserId = userId,
                Recursive = true,
                IncludeItemTypes = ["Movie", "Episode"],
                Fields = fields,
                Limit = pageSize,
                StartIndex = start,
            }, ct);
            var match = page.Items.FirstOrDefault(item =>
                InspectionPathsMatch(mapper, file.Path, mappedPath, item.Path));
            if (match is not null) return match;
            start += page.Items.Length;
            if (page.Items.IsEmpty && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse,
                    "Jellyfin returned an incomplete library item list.");
            if (start >= maxItems && start < page.TotalRecordCount)
                throw new JellyfinException(JellyfinErrorKind.InvalidResponse,
                    "Jellyfin returned too many items to inspect safely.");
        } while (page.Items.Length > 0 && start < page.TotalRecordCount);
        return null;
    }

    private static bool InspectionPathsMatch(JellyfinPathMapper mapper, string localPath, string mappedPath,
        string? itemPath) =>
        itemPath is not null && (JellyfinPathMapper.PathsEqual(itemPath, mappedPath) ||
            mapper.ToLocal(itemPath) is { } local && JellyfinPathMapper.PathsEqual(local, localPath));

    private static bool IsTrackType(string? type) =>
        string.Equals(type, "Audio", StringComparison.OrdinalIgnoreCase) ||
        string.Equals(type, "Subtitle", StringComparison.OrdinalIgnoreCase);

    /// <summary>Verified when any audio track is an accepted language; rejected only when every track is
    /// tagged and none is accepted. A null accepted set means any language is fine.</summary>
    private static string InspectionState(int streamCount, MediaTrack[] audioStreams, string[] languages,
        IReadOnlySet<string>? accepted)
    {
        if (streamCount == 0 || audioStreams.Length == 0) return "unknown";
        if (accepted is null || languages.Any(accepted.Contains)) return "verified";
        if (audioStreams.Any(track => track.Language is null)) return "unknown";
        return "rejected";
    }

    /// <summary>The audio languages this file may have. "auto" means English or the title's own language,
    /// so Japanese-only anime is not flagged.</summary>
    private static async Task<IReadOnlySet<string>?> InspectionLanguagesAsync(TorrentFlowDbContext db,
        JellyfinJobRow job, MediaFileRow file, string? globalLanguage, CancellationToken ct)
    {
        var target = string.IsNullOrWhiteSpace(job.TargetId) ? null :
            await db.Targets.AsNoTracking().SingleOrDefaultAsync(row => row.Id == job.TargetId, ct);
        string? selected = null;
        if (target?.BatchId is { Length: > 0 } batchId)
            selected = await db.ScopeIntents.AsNoTracking()
                .Where(row => row.BatchId == batchId && row.WorkId == file.WorkId)
                .Select(row => row.Policy.AudioLanguage).FirstOrDefaultAsync(ct);
        if (string.IsNullOrWhiteSpace(selected) || selected.Equals("auto", StringComparison.OrdinalIgnoreCase))
            selected = globalLanguage;
        if (string.Equals(selected, "any", StringComparison.OrdinalIgnoreCase)) return null;
        if (!string.IsNullOrWhiteSpace(selected) && !selected.Equals("auto", StringComparison.OrdinalIgnoreCase))
            return new HashSet<string>(StringComparer.Ordinal) { LanguageCodes.Normalize(selected) ?? "en" };
        var original = await db.Works.AsNoTracking().Where(row => row.Id == file.WorkId)
            .Select(row => row.OriginalLanguage).FirstOrDefaultAsync(ct);
        var languages = new HashSet<string>(StringComparer.Ordinal) { "en" };
        if (LanguageCodes.Normalize(original) is { } code) languages.Add(code);
        return languages;
    }

    private static async Task SaveInspectionAsync(TorrentFlowDbContext db, string mediaFileId,
        string state, string? jellyfinItemId, string? audioLanguages, ImmutableArray<MediaTrack> tracks,
        CancellationToken ct)
    {
        var current = await db.MediaFiles.SingleOrDefaultAsync(row => row.Id == mediaFileId, ct);
        if (current is null || current.Status != FilePresence.Present) return;
        db.Entry(current).CurrentValues.SetValues(current with
        {
            InspectionState = state,
            JellyfinItemId = jellyfinItemId,
            InspectedAt = DateTimeOffset.UtcNow,
            AudioLanguages = audioLanguages,
            Tracks = tracks,
            Version = current.Version + 1,
        });
        await db.SaveChangesAsync(ct);
    }

    private static async Task WriteRejectedActivityAsync(TorrentFlowDbContext db, MediaFileRow file,
        JellyfinJobRow job, string[] languages, CancellationToken ct)
    {
        var work = await db.Works.AsNoTracking().SingleOrDefaultAsync(row => row.Id == file.WorkId, ct);
        if (work is null || languages.Length == 0) return;
        var activityKey = "jellyfin-rejected:" + file.Id;
        if (await db.Attempts.AsNoTracking().AnyAsync(row => row.BatchId == activityKey, ct)) return;
        var names = await db.WorkNames.AsNoTracking().Where(row => row.WorkId == work.Id).ToArrayAsync(ct);
        var title = NotificationReadModels.Title(work, names);
        if (file.EpisodeId is { } episodeId)
        {
            var episode = await db.Episodes.AsNoTracking().SingleOrDefaultAsync(row => row.Id == episodeId, ct);
            var season = episode is null ? null :
                await db.Seasons.AsNoTracking().SingleOrDefaultAsync(row => row.Id == episode.SeasonId, ct);
            if (episode is not null && season is not null)
                title += $" S{season.Number.ToString("00", CultureInfo.InvariantCulture)}E{episode.Number.ToString("00", CultureInfo.InvariantCulture)}";
        }
        var displayLanguages = languages.Select(language => CultureInfo.GetCultureInfo(language).EnglishName).ToArray();
        var joined = displayLanguages.Length switch
        {
            1 => displayLanguages[0],
            2 => $"{displayLanguages[0]} and {displayLanguages[1]}",
            _ => string.Join(", ", displayLanguages[..^1]) + " and " + displayLanguages[^1],
        };
        var now = DateTimeOffset.UtcNow;
        var targetId = job.TargetId is { } jobTarget &&
            await db.Targets.AsNoTracking().AnyAsync(row => row.Id == jobTarget, ct) ? jobTarget : null;
        db.Attempts.Add(new AttemptRow
        {
            Id = Guid.NewGuid().ToString("N"),
            TargetId = targetId,
            WorkId = work.Id,
            ActorUserId = "local",
            Kind = AttemptKind.LegacyEvent,
            StartedAt = now,
            EndedAt = now,
            Outcome = "Rejected",
            ReasonText = $"{title} has {joined} audio only.",
            BatchId = activityKey,
        });
        await db.SaveChangesAsync(ct);
    }

    private static string? PayloadMediaFileId(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("mediaFileId", out var id)
            ? id.GetString() : null;

    private async Task CompleteRescansAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs, CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        var pendingIds = (await db.JellyfinJobs.AsNoTracking().Where(row => row.Kind == "inspect" &&
                row.State == "pending" && row.MediaFileId != null)
            .Select(row => row.MediaFileId).ToArrayAsync(ct)).OfType<string>()
            .ToHashSet(StringComparer.Ordinal);
        foreach (var job in jobs)
        {
            var ids = PayloadMediaFileIds(job.PayloadJson);
            foreach (var mediaFileId in ids)
            {
                var file = await db.MediaFiles.SingleOrDefaultAsync(row => row.Id == mediaFileId, ct);
                if (file is not null)
                    db.Entry(file).CurrentValues.SetValues(file with
                    {
                        InspectionState = "pending",
                        Version = file.Version + 1,
                    });
                if (!pendingIds.Add(mediaFileId)) continue;
                db.JellyfinJobs.Add(new JellyfinJobRow
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Kind = "inspect",
                    PayloadJson = JsonSerializer.SerializeToElement(new { mediaFileId }),
                    TargetId = job.TargetId,
                    MediaFileId = mediaFileId,
                    Attempts = 0,
                    NextAttemptAt = now.AddSeconds(60),
                    CreatedAt = now,
                    LastError = null,
                    State = "pending",
                });
            }
        }
        await CompleteJobsAsync(db, jobs, ct);
    }

    private static string[] PayloadMediaFileIds(JsonElement payload) =>
        payload.ValueKind == JsonValueKind.Object && payload.TryGetProperty("mediaFileIds", out var ids) &&
        ids.ValueKind == JsonValueKind.Array
            ? [.. ids.EnumerateArray().Where(value => value.ValueKind == JsonValueKind.String)
                .Select(value => value.GetString()).OfType<string>().Distinct(StringComparer.Ordinal)]
            : [];

    private static async Task CompleteJobsAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs,
        CancellationToken ct, string? lastError = null)
    {
        foreach (var job in jobs)
        {
            var current = await db.JellyfinJobs.SingleOrDefaultAsync(row => row.Id == job.Id, ct);
            if (current is not null) db.Entry(current).CurrentValues.SetValues(current with
            { State = "done", LastError = lastError });
        }
        await db.SaveChangesAsync(ct);
    }

    private static async Task FailJobsAsync(TorrentFlowDbContext db, JellyfinJobRow[] jobs, string error,
        CancellationToken ct)
    {
        var now = DateTimeOffset.UtcNow;
        foreach (var job in jobs)
        {
            var current = await db.JellyfinJobs.SingleOrDefaultAsync(row => row.Id == job.Id, ct);
            if (current is null) continue;
            var attempts = current.Attempts + 1;
            var seconds = Math.Min(30 * Math.Pow(2, Math.Min(attempts - 1, 10)), 1800);
            db.Entry(current).CurrentValues.SetValues(current with
            {
                Attempts = attempts,
                NextAttemptAt = now.AddSeconds(seconds),
                LastError = error,
                State = current.CreatedAt < now.AddDays(-7) ? "failed" : "pending",
            });
        }
        await db.SaveChangesAsync(ct);
    }
}

internal static class JellyfinHost
{
    // With no path mappings, TorrentFlow's paths only mean the same folder when Jellyfin runs on this computer.
    internal static bool IsThisComputer(string? serverUrl)
    {
        if (!Uri.TryCreate(serverUrl, UriKind.Absolute, out var uri)) return false;
        var host = uri.Host.Trim('[', ']');
        if (uri.IsLoopback || string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase)) return true;
        var machine = Environment.MachineName;
        if (string.Equals(host, machine, StringComparison.OrdinalIgnoreCase) ||
            host.StartsWith(machine + ".", StringComparison.OrdinalIgnoreCase)) return true;
        if (!System.Net.IPAddress.TryParse(host, out var address)) return false;
        try
        {
            return System.Net.NetworkInformation.NetworkInterface.GetAllNetworkInterfaces()
                .SelectMany(network => network.GetIPProperties().UnicastAddresses)
                .Any(unicast => unicast.Address.Equals(address));
        }
        catch (System.Net.NetworkInformation.NetworkInformationException) { return false; }
    }
}
