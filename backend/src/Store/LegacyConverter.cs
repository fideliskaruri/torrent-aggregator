using System.Collections.Immutable;
using System.Globalization;
using System.Reflection;
using System.Security.Cryptography;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

/// <summary>Offline, read-only legacy import. Payload access requires an explicit copied-root map.</summary>
public sealed class LegacyConverter
{
    private readonly SqliteConnection source;
    private readonly SqliteConnection destination;
    private readonly string sourceDirectory;
    private readonly string destinationDirectory;
    private readonly Dictionary<string, string> paths;
    private readonly Dictionary<string, List<Dictionary<string, object?>>> old = new();
    private readonly Dictionary<string, string> workKeys = new(StringComparer.Ordinal);
    private readonly HashSet<string> workIds = new();
    private readonly HashSet<string> links = new();
    private readonly HashSet<string> primaryLinks = new();
    private readonly HashSet<string> verifiedLinks = new();
    private readonly HashSet<string> releases = new();
    private readonly HashSet<string> mediaPaths = new(StringComparer.OrdinalIgnoreCase);
    private readonly HashSet<string> targetCoordinates = new();
    private readonly Dictionary<string, string> episodes = new();
    private readonly HashSet<string> seasons = new();
    private readonly HashSet<string> folders = new();
    private readonly HashSet<string> nameIds = new();
    private readonly HashSet<string> observations = new();
    private readonly HashSet<string> blockClaims = new();
    private readonly HashSet<string> deletedHashes = new(StringComparer.OrdinalIgnoreCase);
    private readonly List<string> report = [];
    private readonly DateTimeOffset epoch = DateTimeOffset.UnixEpoch;
    private SqliteTransaction? transaction;
    private string owner = "local";
    private string? root;
    private readonly Func<string, (string Volume, string PhysicalKey)>? rootIdentity;

    private LegacyConverter(SqliteConnection source, SqliteConnection destination, string from, string to,
        Dictionary<string, string> paths, Func<string, (string Volume, string PhysicalKey)>? rootIdentity)
    {
        this.source = source;
        this.destination = destination;
        sourceDirectory = from;
        destinationDirectory = to;
        this.paths = paths;
        this.rootIdentity = rootIdentity;
    }

    public static async Task ConvertAsync(string from, string to, string? pathMap,
        Func<string, (string Volume, string PhysicalKey)>? rootIdentity = null)
    {
        from = Path.GetFullPath(from);
        to = Path.GetFullPath(to);
        if (Overlaps(from, to))
            throw new ArgumentException("Destination must be separate from the source.");
        var oldDb = File.Exists(Path.Combine(from, "torrentflow.db")) ? Path.Combine(from, "torrentflow.db")
            : Path.Combine(from, "data", "torrentflow.db");
        from = Path.GetDirectoryName(oldDb)!;
        if (Overlaps(from, to))
            throw new ArgumentException("Destination must be separate from the source data.");
        Directory.CreateDirectory(to);
        using var lease = new FileStream(Path.Combine(to, ".conversion.lock"), FileMode.OpenOrCreate,
            FileAccess.ReadWrite, FileShare.None);
        var suppliedMap = pathMap is null ? new Dictionary<string, string>()
            : JsonSerializer.Deserialize<Dictionary<string, string>>(File.ReadAllText(pathMap))!;
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var pair in suppliedMap)
        {
            if (!Path.IsPathFullyQualified(pair.Key) || !Path.IsPathFullyQualified(pair.Value)
                || Overlaps(Path.GetFullPath(pair.Value), Path.GetFullPath(pair.Key))
                || Overlaps(Path.GetFullPath(pair.Value), @"D:\Torrents")
                || Overlaps(Path.GetFullPath(pair.Value), from)
                || Overlaps(Path.GetFullPath(pair.Value), to)
                || Overlaps(Path.GetFullPath(pair.Value), Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData)))
                throw new ArgumentException("Rehearsal path maps must point to separate copied payload roots.");
            EnsureNoLinks(Path.GetFullPath(pair.Value));
            map.Add(Path.GetFullPath(pair.Key).TrimEnd(Path.DirectorySeparatorChar),
                Path.GetFullPath(pair.Value).TrimEnd(Path.DirectorySeparatorChar));
        }
        using var source = new SqliteConnection(new SqliteConnectionStringBuilder
        { DataSource = oldDb, Mode = SqliteOpenMode.ReadOnly, Pooling = false }.ToString());
        await source.OpenAsync();
        var backupDirectory = Path.Combine(to, "legacy-backup");
        var backupDb = Path.Combine(backupDirectory, "torrentflow.db");
        var marker = Path.Combine(to, "conversion-complete.json");
        var started = Path.Combine(to, "conversion-started.json");
        if (File.Exists(marker))
        {
            var completion = Json(File.ReadAllText(marker), "{}");
            if (!completion.GetProperty("completed").GetBoolean())
                throw new IOException("Invalid conversion completion marker. Do not start the new server; preserve this destination for review.");
            if (!File.Exists(Path.Combine(to, "torrentflow.db")) || !File.Exists(backupDb))
                throw new IOException("Completion marker exists without its database or immutable backup.");
            if (completion.GetProperty("sourceBackupSha256").GetString() != Digest(backupDb))
                throw new IOException("The conversion backup no longer matches its completion marker. Preserve this destination for review; no changes made.");
            Console.WriteLine("Already converted. No changes made.");
            return;
        }
        if (File.Exists(started) || File.Exists(Path.Combine(to, "torrentflow.db")))
            throw new IOException("Conversion was interrupted or this destination already contains a database. Do not start the new server. Preserve this destination and copied payloads; rerun with a fresh destination and fresh payload copies. The old server can still use its untouched data.");
        File.WriteAllText(started, JsonSerializer.Serialize(new { startedAt = DateTimeOffset.UtcNow, source = from }));
        Directory.CreateDirectory(backupDirectory);
        using (var backup = new SqliteConnection($"Data Source={backupDb};Pooling=False"))
        {
            backup.Open();
            source.BackupDatabase(backup);
        }
        foreach (var file in Directory.EnumerateFiles(from, "*", SearchOption.AllDirectories))
        {
            var relative = Path.GetRelativePath(from, file);
            if (relative.StartsWith("backups" + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(file).StartsWith("torrentflow.db", StringComparison.OrdinalIgnoreCase)) continue;
            var target = Path.Combine(backupDirectory, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target, true);
            if (relative is "sources.json" or "tmdb-settings.json" or "remote-access.json" or "push-vapid.json")
                ProtectFile(target);
        }
        var services = new ServiceCollection().AddStore(Path.Combine(to, "torrentflow.db"));
        await using (var provider = services.BuildServiceProvider())
        {
            await using var scope = provider.CreateAsyncScope();
            await scope.ServiceProvider.GetRequiredService<StoreDatabase>().InitializeAsync(null, true);
        }
        using var destination = new SqliteConnection($"Data Source={Path.Combine(to, "torrentflow.db")};Pooling=False");
        destination.Open();
        var converter = new LegacyConverter(source, destination, from, to, map, rootIdentity);
        converter.Run();
        var result = new
        {
            sourceBackupSha256 = Convert.ToHexStringLower(SHA256.HashData(File.ReadAllBytes(backupDb))),
            completed = true, schedulerPaused = true, report = converter.report,
        };
        File.WriteAllText(Path.Combine(to, "conversion-report.json"), JsonSerializer.Serialize(result, new JsonSerializerOptions { WriteIndented = true }));
        File.WriteAllText(marker + ".pending", JsonSerializer.Serialize(result));
        File.Move(marker + ".pending", marker);
        foreach (var line in converter.report) Console.WriteLine(line);
    }

    private static bool Overlaps(string first, string second) =>
        first.TrimEnd(Path.DirectorySeparatorChar).Equals(second.TrimEnd(Path.DirectorySeparatorChar), StringComparison.OrdinalIgnoreCase)
        || first.StartsWith(second.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)
        || second.StartsWith(first.TrimEnd(Path.DirectorySeparatorChar) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase);

    private void Run()
    {
        using (var command = source.CreateCommand())
        {
            command.CommandText = "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name";
            using var reader = command.ExecuteReader();
            var tables = new List<string>();
            while (reader.Read()) tables.Add(reader.GetString(0));
            reader.Close();
            foreach (var table in tables)
            {
                if (!new[] { "Work", "WorkLink", "AcquisitionTarget", "EngineTorrent", "ClientSettings",
                    "WatchListItem", "MediaRequest", "RequestAutoApproveRule", "AutoRule", "ReleaseBlock",
                    "ReleaseAttempt", "DownloadHistory", "GrabJob", "MediaProbe", "ReleaseHint", "SearchCache",
                    "CachedMetadata", "CatalogEntry", "Notification", "PushSubscription", "EngineDeletion",
                    "RunLock", "User", "__EFMigrationsHistory", "__EFMigrationsLock" }.Contains(table))
                    throw new InvalidDataException($"Unknown legacy table {table}; refusing an incomplete import.");
                using var rows = source.CreateCommand();
                rows.CommandText = $"SELECT * FROM \"{table}\"";
                using var values = rows.ExecuteReader();
                var list = new List<Dictionary<string, object?>>();
                while (values.Read())
                    list.Add(Enumerable.Range(0, values.FieldCount).ToDictionary(values.GetName,
                        i => values.IsDBNull(i) ? null : values.GetValue(i), StringComparer.OrdinalIgnoreCase));
                old[table] = list;
                report.Add($"Old {table}: {list.Count}");
            }
            foreach (var required in new[] { "Work", "EngineTorrent", "AcquisitionTarget", "ClientSettings", "User" })
                if (!old.ContainsKey(required)) throw new InvalidDataException($"Required legacy table {required} is missing.");
        }
        Execute("PRAGMA foreign_keys=OFF");
        transaction = destination.BeginTransaction();
        try
        {
            People();
            Catalog();
            Settings();
            Deletions();
            Staging();
            Manifest();
            Transfers();
            Targets();
            Associations();
            Intent();
            History();
            SideFiles();
            Execute("UPDATE Target SET state='done',reasonCode=NULL,reasonText=NULL WHERE state<>'removed' AND EXISTS (SELECT 1 FROM MediaFile m WHERE m.workId=Target.workId AND coalesce(m.episodeId,'')=coalesce(Target.episodeId,'') AND m.role='video' AND m.status='present')");
            Execute("UPDATE RequestItem SET settlement='fulfilled' WHERE settlement='open' AND targetId IN (SELECT id FROM Target WHERE state='done')");
            using var check = destination.CreateCommand();
            check.Transaction = transaction;
            check.CommandText = "PRAGMA foreign_key_check";
            using (var reader = check.ExecuteReader())
                if (reader.Read()) throw new InvalidDataException($"Foreign key failure in {reader.GetString(0)}");
            check.CommandText = "PRAGMA integrity_check";
            if ((string?)check.ExecuteScalar() != "ok") throw new InvalidDataException("Destination integrity check failed.");
            transaction.Commit();
            transaction.Dispose();
            transaction = null;
            Execute("PRAGMA foreign_keys=ON");
            Execute("PRAGMA wal_checkpoint(TRUNCATE)");
            foreach (var table in Schema.Tables)
            {
                using var count = destination.CreateCommand();
                count.CommandText = $"SELECT count(*) FROM \"{table.Name}\"";
                report.Add($"New {table.Name}: {count.ExecuteScalar()}");
            }
            report.Add("Dropped live SearchCache: incompatible parser/options revisions; immutable backup retained.");
            report.Add("Dropped RunLock/old EF locks and migrations: process-local leases and old schema history.");
            report.Add("Dropped progress, playback retention, eviction and unverified health hints: recomputed or removed behaviour.");
            report.Add("All source columns and side files retained in legacy-backup; secrets never printed.");
        }
        catch
        {
            transaction?.Rollback();
            throw;
        }
    }

    private IEnumerable<Dictionary<string, object?>> Rows(string table) => old.GetValueOrDefault(table) ?? [];
    private static string? S(Dictionary<string, object?> row, string field) =>
        row.GetValueOrDefault(field)?.ToString() is { Length: > 0 } value ? value : null;
    private static long? N(Dictionary<string, object?> row, string field) =>
        long.TryParse(S(row, field), out var value) ? Math.Max(0, value) : null;
    private static bool B(Dictionary<string, object?> row, string field) => S(row, field) is "1" or "true" or "True";
    private DateTimeOffset D(Dictionary<string, object?> row, string field = "createdAt") =>
        DateTimeOffset.TryParse(S(row, field), CultureInfo.InvariantCulture, DateTimeStyles.AssumeUniversal, out var value) ? value.ToUniversalTime() : epoch;
    private static string Id(string value) => "legacy-" + Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)))[..32];
    private static JsonElement Json(string? value, string fallback = "[]") => JsonDocument.Parse(value ?? fallback).RootElement.Clone();
    private static Dictionary<string, object?> Values(params (string Key, object? Value)[] values) =>
        values.ToDictionary(p => p.Key, p => p.Value, StringComparer.OrdinalIgnoreCase);

    private void Add(string table, Dictionary<string, object?> values)
    {
        var definition = Schema.Table(table);
        var ctor = definition.RowType.GetConstructors().OrderByDescending(c => c.GetParameters().Length).First();
        var parameters = ctor.GetParameters().Select(p =>
        {
            if (values.TryGetValue(p.Name!, out var value)) return Coerce(value, p.ParameterType);
            var type = Nullable.GetUnderlyingType(p.ParameterType) ?? p.ParameterType;
            if (p.Name?.ToLowerInvariant() is "version" or "policyrevision" or "revision") return (object)1L;
            if (type == typeof(DateTimeOffset)) return Nullable.GetUnderlyingType(p.ParameterType) is null ? epoch : null;
            if (type == typeof(string)) return new NullabilityInfoContext().Create(p).ReadState == NullabilityState.Nullable ? null : "";
            if (Nullable.GetUnderlyingType(p.ParameterType) is not null) return null;
            if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(ImmutableArray<>))
                return type.GetField("Empty")!.GetValue(null);
            if (type == typeof(JsonElement)) return Json("{}", "{}");
            return type.IsValueType ? Activator.CreateInstance(type) : null;
        }).ToArray();
        var row = (StoreRow)ctor.Invoke(parameters);
        var entity = definition.ToEntity(row);
        using var command = destination.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = $"INSERT INTO \"{table}\" ({string.Join(",", entity.Keys.Select(k => $"\"{k}\""))}) VALUES ({string.Join(",", entity.Keys.Select((_, i) => "$p" + i))})";
        var index = 0;
        foreach (var value in entity.Values) command.Parameters.AddWithValue("$p" + index++, value ?? DBNull.Value);
        command.ExecuteNonQuery();
    }

    private static object? Coerce(object? value, Type type)
    {
        if (value is null) return null;
        type = Nullable.GetUnderlyingType(type) ?? type;
        if (type.IsInstanceOfType(value)) return value;
        if (type.IsEnum) return Enum.Parse(type, value.ToString()!, true);
        return Convert.ChangeType(value, type, CultureInfo.InvariantCulture);
    }
    private void Execute(string sql)
    {
        using var command = destination.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.ExecuteNonQuery();
    }
    private void People()
    {
        var users = Rows("User").ToList();
        owner = users.Any(u => S(u, "id") == "local") ? "local" : S(users.FirstOrDefault() ?? [], "id") ?? "local";
        if (users.Count == 0) users.Add(Values(("id", owner), ("name", "Owner")));
        foreach (var user in users)
            Add("User", Values(("id", S(user, "id")), ("name", S(user, "name")), ("image", S(user, "image")),
                ("normalizedEmail", S(user, "email")?.Trim().ToLowerInvariant()),
                ("role", S(user, "id") == owner ? UserRole.Owner : UserRole.Requester),
                ("createdAt", D(user)), ("updatedAt", D(user, "updatedAt"))));
        foreach (var notification in Rows("Notification"))
            Add("Notification", Values(("id", S(notification, "id")), ("userId", S(notification, "recipientUserId") ?? owner),
                ("kind", S(notification, "kind")), ("title", S(notification, "title")), ("body", S(notification, "body")),
                ("link", S(notification, "link")), ("createdAt", D(notification)),
                ("readAt", S(notification, "readAt") is null ? null : D(notification, "readAt"))));
        foreach (var row in Rows("PushSubscription"))
            Add("PushSubscription", Values(("id", S(row, "id")), ("userId", S(row, "userId") ?? owner),
                ("endpoint", S(row, "endpoint")), ("p256dh", S(row, "p256dh")), ("auth", S(row, "auth")), ("createdAt", D(row))));
    }
    private string Work(Dictionary<string, object?> row)
    {
        var key = S(row, "workKey") ?? $"{S(row, "provider")}-{S(row, "providerId") ?? S(row, "externalId")}";
        if (workKeys.TryGetValue(key, out var existing)) return existing;
        var id = S(row, "workId") ?? (row.ContainsKey("canonicalTitle") ? S(row, "id") : null) ?? Id("work/" + key);
        if (workIds.Contains(id))
        {
            id = Id("work/" + key);
            report.Add($"Work ID collision retained separately: {key}");
        }
        workIds.Add(id);
        workKeys[key] = id;
        var kind = S(row, "mediaType") is "movie" or "film" ? WorkKind.Film
            : S(row, "mediaType") is "series" or "tv" or "anime" ? WorkKind.Series : WorkKind.Unknown;
        Add("Work", Values(("id", id), ("workKey", key), ("kind", kind),
            ("format", kind == WorkKind.Film ? WorkFormat.Movie : kind == WorkKind.Series ? WorkFormat.Series : WorkFormat.Unknown),
            ("anime", row.GetValueOrDefault("anime") is null ? null : B(row, "anime")),
            ("year", N(row, "year")), ("posterUrl", S(row, "posterUrl")), ("backdropUrl", S(row, "backdropUrl")),
            ("synopsis", S(row, "overview") ?? S(row, "synopsis")), ("originalLanguage", S(row, "originalLanguage")),
            ("refreshedAt", D(row, "namesRefreshedAt")), ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
        Names(id, S(row, "namesJson"), S(row, "canonicalTitle") ?? S(row, "title") ?? key, null);
        var provider = S(row, "provider");
        var external = S(row, "providerId") ?? S(row, "externalId");
        if (provider is not null && external is not null)
        {
            var saved = Rows("WorkLink").FirstOrDefault(link => S(link, "workId") == id && S(link, "provider") == provider
                && S(link, "externalId") == external && S(link, "mediaType") == S(row, "mediaType"));
            var linkId = saved is null ? Id("primary/" + id) : S(saved, "id")!;
            Link(id, linkId, provider, external, S(row, "mediaType"), saved is null || B(saved, "verified"),
                saved is not null && B(saved, "rejected"), true, saved is null ? "legacy" : S(saved, "source") ?? "legacy",
                saved is null ? null : S(saved, "mappingVersion"), 1, null);
            if (saved is not null && S(saved, "namesJson") is { } names) Names(id, names, key, linkId);
        }
        return id;
    }
    private void Names(string work, string? json, string fallback, string? link, bool aliases = false)
    {
        var names = new List<(string Value, NameLabel Label)>();
        if (json is not null)
            foreach (var name in Json(json).EnumerateArray())
            {
                var value = name.ValueKind == JsonValueKind.String ? name.GetString()
                    : name.TryGetProperty("text", out var text) ? text.GetString()
                    : name.TryGetProperty("value", out text) ? text.GetString() : null;
                var label = name.ValueKind == JsonValueKind.Object && name.TryGetProperty("kind", out var kind)
                    && Enum.TryParse<NameLabel>(kind.GetString(), true, out var parsed) ? parsed : NameLabel.Synonym;
                if (!string.IsNullOrWhiteSpace(value)) names.Add((value, label));
            }
        if (names.Count == 0 && !aliases) names.Add((fallback, NameLabel.English));
        var ordinal = 0;
        foreach (var name in names.Distinct())
        {
            var id = Id($"name/{work}/{link}/{name.Label}/{name.Value.Normalize().Trim().ToLowerInvariant()}");
            if (!nameIds.Add(id)) continue;
            Add("WorkName", Values(("id", id), ("workId", work),
                ("value", name.Value), ("normalizedValue", name.Value.Normalize().Trim().ToLowerInvariant()),
                ("label", name.Label), ("linkId", link), ("ordinal", ordinal++), ("authoritative", link is not null)));
        }
    }
    private void Link(string work, string id, string provider, string external, string? kind, bool verified,
        bool rejected, bool primary, string provenance, string? version, double confidence, string? season)
    {
        var claim = $"{provider}/{external}/{kind}";
        if (!links.Add($"{work}/{claim}")) return;
        var status = rejected ? LinkStatus.Rejected : verified && verifiedLinks.Add(claim) ? LinkStatus.Verified : LinkStatus.Suggested;
        Add("WorkLink", Values(("id", id), ("workId", work), ("provider", provider), ("externalId", external),
            ("providerKind", kind), ("seasonId", season), ("source", provenance), ("mappingVersion", version),
            ("confidence", Math.Clamp(confidence, 0, 1)), ("status", status), ("isPrimary", primary && primaryLinks.Add(work))));
    }
    private void Catalog()
    {
        foreach (var row in Rows("Work")) Work(row);
        foreach (var row in Rows("CatalogEntry")) Work(row);
        foreach (var row in Rows("Work"))
        {
            var work = ResolveWork(row);
            if (S(row, "idsJson") is { } ids)
                foreach (var claim in Json(ids, "{}").EnumerateObject())
                    if (claim.Value.ValueKind is JsonValueKind.String or JsonValueKind.Number)
                        Link(work, Id($"ids/{work}/{claim.Name}/{claim.Value}"), claim.Name, claim.Value.ToString(),
                            S(row, "mediaType"), true, false, false, "legacy-ids", S(row, "linksVersion"), 1, null);
            if (S(row, "aliasesJson") is { } aliases)
                Names(work, aliases, S(row, "canonicalTitle") ?? work, null, true);
        }
        foreach (var row in Rows("WorkLink"))
        {
            var work = S(row, "workId")!;
            if (!workIds.Contains(work)) { report.Add("Unresolved WorkLink archived: " + S(row, "id")); continue; }
            var before = links.Count;
            Link(work, S(row, "id")!, S(row, "provider")!, S(row, "externalId")!, S(row, "mediaType"),
                B(row, "verified"), B(row, "rejected"), false, S(row, "source") ?? "legacy", S(row, "mappingVersion"),
                double.TryParse(S(row, "confidence"), CultureInfo.InvariantCulture, out var confidence) ? confidence : 0,
                N(row, "season") is { } number ? Season(work, (int)number) : null);
            if (links.Count > before && S(row, "namesJson") is { } names) Names(work, names, work, S(row, "id"));
        }
    }
    private string Season(string work, int number)
    {
        var id = Id($"season/{work}/{number}");
        if (seasons.Add(id)) Add("Season", Values(("id", id), ("workId", work), ("number", number), ("mappingStatus", MappingStatus.Confirmed)));
        return id;
    }
    private string? Episode(string work, int? season, int? episode)
    {
        if (season is null || episode is null) return null;
        var coordinate = $"{work}/{season}/{episode}";
        if (episodes.TryGetValue(coordinate, out var existing)) return existing;
        var id = Id("episode/" + coordinate);
        episodes[coordinate] = id;
        Add("Episode", Values(("id", id), ("seasonId", Season(work, season.Value)), ("number", episode.Value),
            ("mappingStatus", MappingStatus.Confirmed)));
        return id;
    }
    private string ResolveWork(Dictionary<string, object?> row)
    {
        var work = S(row, "workId");
        if (work is not null && workIds.Contains(work)) return work;
        if (S(row, "workKey") is { } key && workKeys.TryGetValue(key, out var found)) return found;
        return Work(row);
    }
    private string? Map(string? path)
    {
        if (path is null) return null;
        foreach (var pair in paths.OrderByDescending(p => p.Key.Length))
            if (path.Equals(pair.Key, StringComparison.OrdinalIgnoreCase)
                || path.StartsWith(pair.Key.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
            {
                var mapped = Path.GetFullPath(pair.Value + path[pair.Key.Length..]);
                var boundary = Path.GetFullPath(pair.Value).TrimEnd('\\');
                if (!mapped.Equals(boundary, StringComparison.OrdinalIgnoreCase)
                    && !mapped.StartsWith(boundary + "\\", StringComparison.OrdinalIgnoreCase))
                    throw new InvalidDataException("Legacy path escapes its mapped root.");
                EnsureNoLinks(mapped);
                return mapped;
            }
        if (paths.Values.Any(root => path.StartsWith(Path.GetFullPath(root).TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase)))
        { EnsureNoLinks(path); return Path.GetFullPath(path); }
        return null;
    }
    private static void EnsureNoLinks(string path)
    {
        for (var current = new FileInfo(path).Directory; current is not null; current = current.Parent)
            if (current.Exists && (current.Attributes & FileAttributes.ReparsePoint) != 0)
                throw new IOException("Mapped payload paths must not traverse symbolic links or junctions.");
        if (File.Exists(path) && (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Mapped payload must not be a symbolic link.");
    }
    private void Settings()
    {
        var settings = Rows("ClientSettings").FirstOrDefault();
        if (settings is null) return;
        var basePath = S(settings, "baseDownloadPath") ?? S(settings, "savePath");
        if (basePath is not null)
        {
            root = Id("root/" + basePath);
            var mapped = Map(basePath) ?? Path.Combine(destinationDirectory, "unmapped-library");
            var confirmed = Map(basePath) is not null && Directory.Exists(mapped) && rootIdentity is not null;
            var identity = confirmed ? rootIdentity!(mapped) : ("review-required", mapped.ToLowerInvariant());
            if (confirmed)
            {
                var marker = Path.Combine(mapped, ".torrentflow-root");
                if (File.Exists(marker) && File.ReadAllText(marker) != root) throw new IOException("Copied payload root belongs to another library.");
                if (!File.Exists(marker)) File.WriteAllText(marker, root);
            }
            var rules = Json(S(settings, "pathRules"), "{}");
            string Folder(string key, string fallback) => rules.ValueKind == JsonValueKind.Object
                && rules.TryGetProperty(key, out var field) && field.ValueKind == JsonValueKind.String ? field.GetString()! : fallback;
            Add("StorageRoot", Values(("id", root), ("path", mapped), ("physicalKey", identity.Item2),
                ("kinds", ImmutableArray.Create(LibraryKind.Movies, LibraryKind.TV, LibraryKind.Anime, LibraryKind.AnimeMovies)),
                ("libraryFolders", new LibraryFolders(Folder("Movies", "Movies"), Folder("TV", "TV"), Folder("Anime", "Anime"), Folder("AnimeMovies", "Anime Movies"))),
                ("volumeSerial", identity.Item1), ("enabled", true), ("online", confirmed),
                ("reviewRequired", !confirmed), ("maxAllocatedBytes", N(settings, "maxStorageBytes")),
                ("lastError", confirmed ? null : "Legacy root has no approved copied-payload mapping.")));
        }
        UpdateSetting<EngineSettings>("engine", value => value with
        {
            MaxActiveDownloads = (int)(N(settings, "maxActiveDownloads") ?? value.MaxActiveDownloads),
            SetupComplete = B(settings, "storageCapConfigured"), VerboseDiagnostics = B(settings, "verboseDiagnostics"),
        });
        UpdateSetting<QualitySettings>("quality", value => value with
        {
            PreferredResolution = (int?)N(settings, "preferredResolution") ?? value.PreferredResolution,
            AudioLanguage = S(settings, "audioLanguage") ?? value.AudioLanguage,
        });
        UpdateSetting<SchedulerSettings>("scheduler", value => value with
        {
            Enabled = false, FirstFullRootScanComplete = false, ImportReviewComplete = false,
            IntervalMinutes = (int)(N(settings, "automationIntervalMinutes") ?? value.IntervalMinutes),
        });
        UpdateSetting<MigrationSettings>("migration", _ => new MigrationSettings(1, "convertedPendingRootReview"));
        if (S(settings, "password") is not null) throw new InvalidDataException("External client password needs its original protector; refusing to discard it.");
    }
    private void UpdateSetting<T>(string section, Func<T, T> update)
    {
        using var read = destination.CreateCommand();
        read.Transaction = transaction;
        read.CommandText = "SELECT valueJson FROM Setting WHERE section=$section";
        read.Parameters.AddWithValue("$section", section);
        var value = JsonSerializer.Deserialize<T>((string)read.ExecuteScalar()!, Schema.Json)!;
        using var write = destination.CreateCommand();
        write.Transaction = transaction;
        write.CommandText = "UPDATE Setting SET valueJson=$json WHERE section=$section";
        write.Parameters.AddWithValue("$section", section);
        write.Parameters.AddWithValue("$json", JsonSerializer.Serialize(update(value), Schema.Json));
        write.ExecuteNonQuery();
    }
    private string? Release(Dictionary<string, object?> row, string field)
    {
        var hash = S(row, field)?.ToLowerInvariant();
        if (hash is null || hash.Length is not (40 or 64) || hash.Any(c => !char.IsAsciiHexDigit(c))) return null;
        if (releases.Add(hash))
            Add("Release", Values(("id", hash), ("name", S(row, "name") ?? S(row, "title") ?? hash),
                ("parsed", new ParsedRelease(S(row, "name") ?? S(row, "title") ?? hash, "", null, [], [], [], [],
                    false, false, null, new Quality(null, null, null, null), null, [], false, false, false)),
                ("totalBytes", N(row, "sizeBytes")), ("magnet", S(row, "magnet")), ("torrentUri", S(row, "torrentUrl")),
                ("firstSeenAt", D(row)), ("lastSeenAt", D(row, "updatedAt"))));
        if (S(row, "source") is { } sourceId)
        {
            var query = S(row, "query") ?? "";
            var identity = $"{hash}/{sourceId}/{query}";
            if (observations.Add(identity))
                Add("ReleaseObservation", Values(("id", Id("observation/" + identity)), ("hash", hash),
                    ("sourceId", sourceId), ("query", query), ("observedAt", D(row)),
                    ("torrentUri", S(row, "torrentUrl")), ("listedSeeders", N(row, "seeders"))));
        }
        return hash;
    }
    private void Staging()
    {
        foreach (var row in Rows("EngineTorrent").Where(r => !deletedHashes.Contains(S(r, "hash") ?? "")))
        {
            var staged = Map(S(row, "stagePath"));
            var final = Map(S(row, "savePath"));
            if (staged is null || final is null) continue;
            var hash = S(row, "hash")!.ToLowerInvariant();
            var torrent = Path.Combine(sourceDirectory, "engine", "torrents", hash + ".torrent");
            if (!File.Exists(torrent)) { report.Add($"Staging {hash}: missing torrent metadata; left untouched."); continue; }
            var recoveringFinal = !Directory.Exists(staged);
            if (recoveringFinal && !Directory.Exists(final)) continue;
            (IReadOnlyList<LegacyTorrentFile> Files, bool Verified) inspection;
            try { inspection = LegacyTorrentVerifier.Inspect(torrent, hash, recoveringFinal ? final : staged); }
            catch (InvalidDataException error)
            {
                report.Add($"Staging {hash}: {error.Message} Payload left untouched, target wanted.");
                if (error.Message.StartsWith("Executable payload", StringComparison.Ordinal))
                {
                    Release(row, "hash");
                    if (blockClaims.Add(hash + "/"))
                        Add("Block", Values(("id", Id("unsafe-stage/" + hash)), ("hash", hash),
                            ("reason", "Executable payload in legacy torrent metadata"), ("origin", BlockOrigin.Unsafe)));
                }
                continue;
            }
            if (!inspection.Verified) { report.Add($"Staging {hash}: incomplete or hash mismatch; left untouched, wanted."); continue; }
            var manifest = new List<object>();
            foreach (var file in inspection.Files)
            {
                var sourcePath = Path.GetFullPath(Path.Combine(recoveringFinal ? final : staged, file.Path));
                var finalPath = Path.GetFullPath(Path.Combine(final, file.Path));
                EnsureNoLinks(sourcePath);
                EnsureNoLinks(finalPath);
                var digest = Digest(sourcePath);
                if (File.Exists(finalPath) && Digest(finalPath) != digest)
                    throw new IOException($"Staging destination conflict for {hash}, file {file.Index}; nothing overwritten.");
                var operation = Id($"stage/{hash}/{file.Index}");
                Directory.CreateDirectory(Path.GetDirectoryName(finalPath)!);
                if (!File.Exists(finalPath)) File.Copy(sourcePath, finalPath);
                if (Digest(finalPath) != digest) throw new IOException("Copied staging payload failed SHA-256 verification.");
                if (!recoveringFinal)
                {
                    if (Digest(sourcePath) != digest) throw new IOException("Staged payload changed during conversion.");
                    File.Delete(sourcePath);
                }
                Add("FileOperation", Values(("id", operation), ("kind", FileOperationKind.Move),
                    ("sourcePath", sourcePath), ("destinationPath", finalPath), ("expectedBytes", file.Bytes),
                    ("expectedDigest", digest), ("state", FileOperationState.Done), ("deleteSource", !recoveringFinal)));
                manifest.Add(new { path = file.Path, size = file.Bytes, fullPath = finalPath });
            }
            row["verifiedFilesJson"] = JsonSerializer.Serialize(manifest);
            row["savePath"] = final;
            report.Add($"Staging {hash}: all torrent pieces verified, {inspection.Files.Count} files {(recoveringFinal ? "reconciled at existing final paths" : "moved")} and SHA-256 checked.");
        }
    }
    private static string Digest(string path)
    {
        using var file = File.OpenRead(path);
        return Convert.ToHexStringLower(SHA256.HashData(file));
    }
    private void Manifest()
    {
        var file = Path.Combine(sourceDirectory, "engine", "layout-manifest.json");
        if (!File.Exists(file)) return;
        foreach (var entry in Json(File.ReadAllText(file)).EnumerateArray())
        {
            if (!entry.TryGetProperty("hash", out var hash)) throw new InvalidDataException("Unknown layout manifest shape.");
            var row = Rows("EngineTorrent").FirstOrDefault(r => S(r, "hash") == hash.GetString());
            if (row is null) { report.Add("Layout manifest hash has no engine row: " + hash.GetString()); continue; }
            if (S(row, "verifiedFilesJson") is not null) continue;
            if (!entry.TryGetProperty("files", out var files) || files.ValueKind != JsonValueKind.Array)
                throw new InvalidDataException("Layout manifest files must be an array.");
            var found = new List<object>();
            foreach (var item in files.EnumerateArray())
            {
                if (item.ValueKind != JsonValueKind.String) continue;
                var path = Map(item.GetString());
                if (path is null || !File.Exists(path)) continue;
                var info = new FileInfo(path);
                found.Add(new { path = Path.GetFileName(path), fullPath = path, size = info.Length });
            }
            if (found.Count > 0)
            {
                row["verifiedFilesJson"] = JsonSerializer.Serialize(found);
                report.Add($"Layout manifest {hash.GetString()}: {found.Count} exact-path copied files reconciled.");
            }
        }
        report.Add("Layout manifest reconciled with engine rows and copied disk paths; no live side manifest retained.");
    }
    private void Transfers()
    {
        foreach (var row in Rows("EngineTorrent").Where(r => !deletedHashes.Contains(S(r, "hash") ?? "")))
        {
            var hash = Release(row, "hash") ?? throw new InvalidDataException("EngineTorrent has an invalid hash.");
            var id = S(row, "id")!;
            Add("Download", Values(("id", id), ("hash", hash), ("intent", DownloadIntent.Stopped),
                ("rootId", root), ("addedAt", D(row)), ("admissionToken", Id("admission/" + id))));
            var work = S(row, "workId");
            if (work is null || !workIds.Contains(work))
            {
                Add("RawIntent", Values(("id", Id("raw/" + id)), ("actorUserId", S(row, "userId") ?? owner),
                    ("releaseHash", hash), ("downloadId", id), ("rootId", root), ("state", RawDownloadState.Paused),
                    ("batchId", Id("batch/" + id))));
                continue;
            }
            var queue = S(row, "queueKey");
            int? season = null, episode = null;
            if (queue is { Length: 12 } && queue[0] == 's' && queue[6] == 'e'
                && int.TryParse(queue.AsSpan(1, 5), out var sn) && int.TryParse(queue.AsSpan(7, 5), out var en))
            { season = sn; episode = en; }
            var episodeId = Episode(work, season, episode);
            var files = S(row, "verifiedFilesJson");
            if (files is null) continue;
            var index = 0;
            foreach (var file in Json(files).EnumerateArray())
            {
                var oldPath = file.TryGetProperty("fullPath", out var full) ? full.GetString()
                    : Path.Combine(S(row, "savePath")!, file.GetProperty("path").GetString()!);
                var path = Map(oldPath);
                if (path is null || !File.Exists(path))
                {
                    report.Add($"Missing copied payload: {hash} file {index++}; no ownership inferred.");
                    continue;
                }
                var info = new FileInfo(path);
                var expected = file.TryGetProperty("size", out var size) ? size.GetInt64() : info.Length;
                if (info.Length != expected) { report.Add($"Size mismatch: {hash} file {index++}"); continue; }
                var extension = info.Extension.ToLowerInvariant();
                var role = extension is ".mkv" or ".mp4" or ".avi" or ".m4v" or ".mov" or ".ts" ? FileRole.Video
                    : extension is ".srt" or ".ass" or ".vtt" or ".sub" ? FileRole.Subtitle : FileRole.Unwanted;
                if (role == FileRole.Unwanted) { index++; continue; }
                var media = Media(work, episodeId, path, id, index, role,
                    System.Text.RegularExpressions.Regex.Match(S(row, "name") ?? "", @"(?<!\d)(2160|1080|720|480)p", System.Text.RegularExpressions.RegexOptions.IgnoreCase) is { Success: true } match
                        ? int.Parse(match.Groups[1].Value, CultureInfo.InvariantCulture) : null);
                Add("DownloadFile", Values(("id", Id($"file/{id}/{index}")), ("downloadId", id), ("fileIndex", index++),
                    ("selected", true), ("finalPath", path), ("physicalKey", PhysicalKey(path)),
                    ("mediaFileId", media), ("role", role), ("expectedBytes", info.Length), ("enginePath", path), ("filed", true)));
            }
        }
    }
    private string Media(string work, string? episode, string path, string? download, int? index, FileRole role, int? resolution)
    {
        var id = Id("media/" + PhysicalKey(path));
        if (!mediaPaths.Add(path)) return id;
        var info = new FileInfo(path);
        Add("MediaFile", Values(("id", id), ("workId", work), ("episodeId", episode), ("rootId", root),
            ("path", path), ("physicalKey", PhysicalKey(path)), ("role", role), ("bytes", info.Length),
            ("mtimeUtc", new DateTimeOffset(info.LastWriteTimeUtc)), ("resolution", resolution), ("container", info.Extension.TrimStart('.')),
            ("origin", download is null ? MediaOrigin.Imported : MediaOrigin.Downloaded), ("downloadId", download),
            ("fileIndex", index), ("status", FilePresence.Present), ("lastSeenAt", new DateTimeOffset(info.LastWriteTimeUtc))));
        return id;
    }
    private void Associations()
    {
        foreach (var row in Rows("AcquisitionTarget"))
        {
            var hash = S(row, "infoHash")?.ToLowerInvariant();
            var download = Rows("EngineTorrent").FirstOrDefault(d => S(d, "hash")?.ToLowerInvariant() == hash);
            if (download is null || deletedHashes.Contains(hash ?? "")) continue;
            var target = S(row, "id")!;
            using var exists = destination.CreateCommand();
            exists.Transaction = transaction;
            exists.CommandText = "SELECT count(*) FROM Target WHERE id=$id";
            exists.Parameters.AddWithValue("$id", target);
            if ((long)exists.ExecuteScalar()! == 0) continue;
            Add("DownloadTarget", Values(("id", Id($"association/{S(download, "id")}/{target}")),
                ("downloadId", S(download, "id")), ("targetId", target), ("role", AssociationRole.Retired), ("createdAt", D(row))));
        }
        foreach (var row in Rows("EngineTorrent"))
        {
            var work = S(row, "workId");
            var path = Map(S(row, "savePath"));
            if (work is null || !workIds.Contains(work) || path is null || !Directory.Exists(path) || !folders.Add(work)) continue;
            if (Path.GetFileName(path).StartsWith("Season ", StringComparison.OrdinalIgnoreCase)) path = Path.GetDirectoryName(path)!;
            Add("WorkFolder", Values(("id", Id("folder/" + work)), ("workId", work), ("externalItemFolder", path)));
        }
    }
    private void Targets()
    {
        foreach (var row in Rows("AcquisitionTarget"))
        {
            var work = ResolveWork(row);
            var episode = Episode(work, (int?)N(row, "season"), (int?)N(row, "episode"));
            if (!targetCoordinates.Add($"{work}/{episode}"))
            { report.Add("Duplicate Target archived: " + S(row, "id")); continue; }
            var state = IsRemoval(row) || deletedHashes.Contains(S(row, "infoHash") ?? "") ? TargetState.Removed
                : S(row, "status") == "paused" ? TargetState.Paused : TargetState.Wanted;
            var path = Map(S(row, "filePath"));
            if (state != TargetState.Removed && path is not null && File.Exists(path))
            {
                Media(work, episode, path, null, null, FileRole.Video, (int?)N(row, "preferredResolution"));
                state = TargetState.Done;
            }
            Add("Target", Values(("id", S(row, "id")), ("workId", work), ("episodeId", episode), ("kind", TargetKind.Acquire),
                ("state", state), ("createdBy", S(row, "userId") ?? owner), ("resolutionFloor", N(row, "preferredResolution")),
                ("preferredResolution", N(row, "preferredResolution")), ("reasonText", S(row, "error")),
                ("batchId", S(row, "runId")), ("clickedAt", S(row, "clickedAt") is null ? null : D(row, "clickedAt")),
                ("substantiveMisses", N(row, "realMisses") ?? 0), ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
        }
    }
    private void Intent()
    {
        foreach (var row in Rows("WatchListItem"))
        {
            var work = ResolveWork(row);
            Add("WatchItem", Values(("id", S(row, "id")), ("userId", S(row, "userId") ?? owner), ("workId", work),
                ("status", Enum.TryParse<WatchStatus>(S(row, "status"), true, out var status) ? status : WatchStatus.Planned),
                ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
            Add("WorkPreference", Values(("id", Id("preference/" + work)), ("workId", work),
                ("resolutionFloor", N(row, "preferredResolution")), ("preferredResolution", N(row, "preferredResolution"))));
            if (B(row, "monitored"))
                Add("Follow", Values(("id", Id("follow/" + work)), ("workId", work), ("enabled", true),
                    ("fromEpisodeId", Episode(work, (int?)N(row, "fromSeason"), (int?)N(row, "fromEpisode"))),
                    ("newEpisodesSince", S(row, "newEpisodesSince") is null ? D(row) : D(row, "newEpisodesSince"))));
        }
        foreach (var row in Rows("MediaRequest"))
        {
            var work = ResolveWork(row);
            var id = S(row, "id")!;
            var scope = S(row, "scope") switch { "series" => RequestScope.Series, "season" or "seasons" => RequestScope.Seasons,
                "episode" or "episodes" => RequestScope.Episodes, _ => RequestScope.Film };
            var decision = S(row, "status") switch { "approved" or "fulfilled" or "downloading" or "partial" or "failed" => RequestDecision.Approved,
                "declined" or "rejected" => RequestDecision.Declined, "cancelled" => RequestDecision.Cancelled, _ => RequestDecision.Pending };
            Add("Request", Values(("id", id), ("userId", S(row, "requestedByUserId") ?? owner), ("workId", work),
                ("scope", scope), ("scopeData", new RequestScopeData(RequestSeasons(S(row, "seasons")), false)),
                ("decision", decision), ("note", S(row, "note")), ("decisionReason", S(row, "decisionReason")),
                ("decidedAt", S(row, "decidedAt") is null ? null : D(row, "decidedAt")),
                ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
            RequestItems(row, work, scope);
        }
        foreach (var row in Rows("RequestAutoApproveRule"))
            Add("AutoApproveRule", Values(("id", S(row, "id")), ("normalizedEmail", S(row, "email")!.Trim().ToLowerInvariant()),
                ("mode", Enum.Parse<AutoApproveMode>(S(row, "mode")!, true)), ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
        foreach (var row in Rows("AutoRule"))
            Add("AutoRule", Values(("id", S(row, "id")), ("userId", S(row, "userId") ?? owner), ("name", S(row, "name")),
                ("query", S(row, "query")), ("category", S(row, "category")), ("minListedSeeders", N(row, "minSeeders") ?? 0),
                ("maxBytes", N(row, "maxSizeBytes")), ("resolutionFloor", N(row, "resolution")),
                ("sourceIds", JsonSerializer.Deserialize<ImmutableArray<string>>(S(row, "sources") ?? "[]")),
                ("enabled", B(row, "enabled")), ("matchCount", N(row, "matchCount") ?? 0), ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
    }
    private static bool IsRemoval(Dictionary<string, object?> row) =>
        S(row, "status")?.ToLowerInvariant() is "removed" or "deleted" or "cancelled" or "deleting"
            or "removing" or "pending-delete" or "pendingdelete" or "pending_delete";

    private void Deletions()
    {
        foreach (var row in Rows("EngineTorrent").Where(IsRemoval))
            deletedHashes.Add(S(row, "hash")!);
        var deletions = Rows("EngineDeletion").ToList();
        foreach (var row in deletions)
        {
            var hash = S(row, "Hash") ?? throw new InvalidDataException("Deletion has no hash.");
            if (Rows("EngineTorrent").Any(r => string.Equals(S(r, "hash"), hash, StringComparison.OrdinalIgnoreCase) && !IsRemoval(r)))
            {
                report.Add($"Deletion {hash}: superseded by an existing transfer; its files retained.");
                continue;
            }
            deletedHashes.Add(hash);
            var files = JsonSerializer.Deserialize<string[]>(S(row, "FilesJson") ?? "[]") ?? [];
            var staged = S(row, "SavePath")?.Split(Path.DirectorySeparatorChar).Contains(".staging", StringComparer.OrdinalIgnoreCase) == true;
            if (!B(row, "DeleteFiles") && !staged)
            {
                report.Add($"Deletion {hash}: engine detach only; library files retained for explicit import review.");
                continue;
            }
            if (staged && Map(S(row, "SavePath")) is { } stage && Directory.Exists(stage))
            {
                EnsureNoLinks(stage);
                files = [.. files, .. Directory.EnumerateFiles(stage, "*", SearchOption.AllDirectories)];
            }
            foreach (var original in files.Distinct(StringComparer.OrdinalIgnoreCase))
            {
                var path = Map(original);
                if (path is null)
                {
                    report.Add($"Deletion {hash}: unmapped original file not accessed; no copied orphan exists.");
                    continue;
                }
                var shared = Rows("EngineTorrent").Where(r => !deletedHashes.Contains(S(r, "hash") ?? ""))
                    .Any(r => Json(S(r, "verifiedFilesJson")).EnumerateArray().Any(f =>
                        f.TryGetProperty("fullPath", out var full) && string.Equals(Map(full.GetString()), path, StringComparison.OrdinalIgnoreCase)));
                if (shared) throw new InvalidDataException($"Deletion {hash} overlaps a retained transfer. Review its copied files before converting.");
                var bytes = File.Exists(path) ? new FileInfo(path).Length : (long?)null;
                var digest = File.Exists(path) ? Digest(path) : null;
                File.Delete(path);
                if (File.Exists(path)) throw new IOException($"Deletion {hash} could not remove its copied payload; conversion stopped.");
                Add("FileOperation", Values(("id", Id($"delete/{hash}/{PhysicalKey(path)}")),
                    ("kind", FileOperationKind.Delete), ("sourcePath", path), ("expectedBytes", bytes),
                    ("expectedDigest", digest), ("state", FileOperationState.Done), ("deleteSource", true),
                    ("attempts", N(row, "Attempts") ?? 0), ("createdAt", D(row)), ("updatedAt", D(row))));
            }
            report.Add($"Deletion {hash}: {files.Length} exact copied file claims reconciled; original files untouched.");
        }
        foreach (var row in Rows("EngineTorrent").Where(IsRemoval))
        {
            if (!deletions.Any(d => string.Equals(S(d, "Hash"), S(row, "hash"), StringComparison.OrdinalIgnoreCase)))
                throw new InvalidDataException("A removing transfer has no deletion file manifest. Preserve copied files and complete the old deletion on a separate copy before converting.");
        }
    }

    private static ImmutableArray<int> RequestSeasons(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return [];
        if (value.TrimStart().StartsWith('[')) return JsonSerializer.Deserialize<ImmutableArray<int>>(value);
        return [.. value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Select(v => int.Parse(v, CultureInfo.InvariantCulture)).Distinct().Order()];
    }

    private static Dictionary<int, int> RequestMarks(string? value)
    {
        var marks = new Dictionary<int, int>();
        foreach (var token in (value ?? "").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var parts = token.Split(':');
            if (parts.Length != 2 || !int.TryParse(parts[0], CultureInfo.InvariantCulture, out var season)
                || !int.TryParse(parts[1], CultureInfo.InvariantCulture, out var episode) || season < 0 || episode < 0)
                throw new InvalidDataException("A request has an invalid high-water mark. Review the copied legacy request before converting.");
            marks[season] = Math.Max(episode, marks.GetValueOrDefault(season));
        }
        return marks;
    }

    private void RequestItems(Dictionary<string, object?> row, string work, RequestScope scope)
    {
        var request = S(row, "id")!;
        var selectedSeasons = RequestSeasons(S(row, "seasons"));
        var covered = RequestMarks(S(row, "coveredThrough"));
        var fulfilled = RequestMarks(S(row, "fulfilledThrough"));
        var candidates = Rows("AcquisitionTarget").Where(t =>
            (S(t, "workId") == work || S(t, "workKey") == S(row, "workKey")) &&
            (scope == RequestScope.Film ? N(t, "episode") is null :
                scope == RequestScope.Episodes ? S(t, "id") == S(row, "acquisitionTargetId") :
                scope == RequestScope.Series || selectedSeasons.Contains((int)(N(t, "season") ?? -1)))).ToList();
        var coordinates = candidates.Select(t => ((int?)N(t, "season"), (int?)N(t, "episode"))).ToHashSet();
        foreach (var mark in covered.Concat(fulfilled).GroupBy(m => m.Key))
        {
            if (scope != RequestScope.Series && !selectedSeasons.Contains(mark.Key)) continue;
            var through = mark.Max(m => m.Value);
            if (through > 10000 || through < 0) throw new InvalidDataException("Request high-water mark is outside supported episode bounds.");
            for (var number = 1; number <= through; number++)
                coordinates.Add((mark.Key, number));
        }
        if (scope == RequestScope.Film) coordinates.Add((null, null));
        var count = 0;
        foreach (var (season, number) in coordinates.OrderBy(c => c.Item1).ThenBy(c => c.Item2))
        {
            var episode = Episode(work, season, number);
            using var command = destination.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = "SELECT id,state FROM Target WHERE workId=$work AND coalesce(episodeId,'')=coalesce($episode,'') AND kind='acquire'";
            command.Parameters.AddWithValue("$work", work);
            command.Parameters.AddWithValue("$episode", episode ?? (object)DBNull.Value);
            string? target = null, state = null;
            using (var reader = command.ExecuteReader())
                if (reader.Read()) { target = reader.GetString(0); state = reader.GetString(1); }
            var historicalFulfilled = season is { } sn && number is { } en && en <= fulfilled.GetValueOrDefault(sn);
            var stopped = state == "removed" || (!historicalFulfilled && target is null && season is { } s && number <= covered.GetValueOrDefault(s));
            if (target is null && stopped)
            {
                target = Id($"request-tombstone/{work}/{episode}");
                Add("Target", Values(("id", target), ("workId", work), ("episodeId", episode),
                    ("kind", TargetKind.Acquire), ("state", TargetState.Removed), ("createdBy", owner),
                    ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
                targetCoordinates.Add($"{work}/{episode}");
            }
            var settlement = stopped ? ItemSettlement.StoppedByOwner :
                historicalFulfilled || state == "done" || (scope == RequestScope.Film && S(row, "status") == "fulfilled")
                    ? ItemSettlement.Fulfilled : ItemSettlement.Open;
            Add("RequestItem", Values(("id", Id($"request-item/{request}/{episode ?? "film"}")), ("requestId", request),
                ("episodeId", episode), ("targetId", target), ("settlement", settlement),
                ("settledAt", settlement == ItemSettlement.Open ? null : D(row, "updatedAt")),
                ("createdAt", D(row)), ("updatedAt", D(row, "updatedAt"))));
            count++;
        }
        report.Add($"Request {request}: {count} item links; high-water marks and owner removals retained.");
    }
    private void History()
    {
        foreach (var table in new[] { "DownloadHistory", "GrabJob", "ReleaseAttempt", "EngineTorrent" })
            foreach (var row in Rows(table))
            {
                var hash = Release(row, table == "ReleaseAttempt" ? "Hash" : table == "EngineTorrent" ? "hash" : "infoHash");
                var work = S(row, "workId");
                if (work is null && S(row, "workKey") is { } key) workKeys.TryGetValue(key, out work);
                if (work is not null && !workIds.Contains(work)) work = null;
                Add("Attempt", Values(("id", table + "/" + (S(row, "id") ?? Id(JsonSerializer.Serialize(row)))),
                    ("workId", work), ("releaseHash", hash), ("actorUserId", S(row, "userId") ?? owner),
                    ("kind", AttemptKind.LegacyEvent), ("startedAt", D(row, table == "ReleaseAttempt" ? "TriedAt" : "createdAt")),
                    ("endedAt", D(row, "updatedAt")), ("outcome", S(row, "status") ?? "legacyTried"),
                    ("reasonText", S(row, "message") ?? S(row, "error")), ("legacyContext", JsonSerializer.SerializeToElement(row))));
            }
        foreach (var row in Rows("ReleaseBlock"))
        {
            var hash = Release(row, "Hash");
            if (hash is null) { report.Add("Invalid ReleaseBlock hash archived."); continue; }
            if (!blockClaims.Add(hash + "/" + S(row, "WorkKey")))
            { report.Add($"Duplicate Block {hash} consolidated; strongest unsafe evidence retained."); continue; }
            Add("Block", Values(("id", Id($"block/{hash}/{S(row, "WorkKey")}")), ("hash", hash), ("workKey", S(row, "WorkKey")),
                ("reason", S(row, "Reason") ?? "Legacy owner block"), ("origin", BlockOrigin.Owner),
                ("replacedByHash", S(row, "ReplacedBy")), ("createdAt", D(row, "CreatedAt"))));
        }
        foreach (var row in Rows("MediaProbe"))
        {
            var path = Map(S(row, "filePath"));
            if (path is null || !mediaPaths.Contains(path)) { report.Add("Unmatched MediaProbe archived: " + S(row, "id")); continue; }
            using var command = destination.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = """
                UPDATE MediaFile SET container=$container,videoCodec=$codec,videoProfile=$profile,
                width=$width,height=$height,hdr=$hdr,runtimeSeconds=$runtime,bitrateBps=$bitrate,tracksJson=$tracks
                WHERE physicalKey=$path
                """;
            command.Parameters.AddWithValue("$container", S(row, "container") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$codec", S(row, "videoCodec") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$width", N(row, "width") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$height", N(row, "height") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$profile", S(row, "videoProfile") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$hdr", S(row, "colorTransfer") ?? (object)DBNull.Value);
            command.Parameters.AddWithValue("$runtime", double.TryParse(S(row, "durationSec"), CultureInfo.InvariantCulture, out var runtime) && runtime >= 0 ? runtime : DBNull.Value);
            command.Parameters.AddWithValue("$bitrate", N(row, "bitRateBps") ?? (object)DBNull.Value);
            var tracks = new List<MediaTrack>();
            if (S(row, "streamsJson") is { } streams)
            {
                var streamPayload = Json(streams, "{}");
                if (streamPayload.ValueKind == JsonValueKind.Object && streamPayload.TryGetProperty("tracks", out var entries))
                    foreach (var track in entries.EnumerateArray())
                        tracks.Add(new MediaTrack(track.TryGetProperty("number", out var number) ? Math.Max(0, number.GetInt32()) : tracks.Count,
                            track.TryGetProperty("kind", out var kind) ? kind.GetString()!.ToLowerInvariant() : "unknown",
                            track.TryGetProperty("language", out var language) ? language.GetString() : null,
                            track.TryGetProperty("codec", out var codec) ? codec.GetString() : null, null, null,
                            track.TryGetProperty("default", out var isDefault) ? isDefault.GetBoolean() : null,
                            track.TryGetProperty("forced", out var forced) ? forced.GetBoolean() : null));
            }
            command.Parameters.AddWithValue("$tracks", JsonSerializer.Serialize(tracks, Schema.Json));
            command.Parameters.AddWithValue("$path", PhysicalKey(path));
            command.ExecuteNonQuery();
        }
        foreach (var table in new[] { "ReleaseHint", "CachedMetadata" })
            report.Add($"{table}: backup preserves all {Rows(table).Count()} rows; provider-specific hint keys are not hash-bound and stale cache data cannot prove ownership; live adoption requires review.");
        report.Add($"CatalogEntry: {Rows("CatalogEntry").Count()} rows merged by public work key into catalog; browse rank/seed/health hints archived.");
    }
    private string PhysicalKey(string path) => rootIdentity is null
        ? Path.GetFullPath(path).TrimEnd('\\').ToLowerInvariant() : rootIdentity(path).PhysicalKey;
    private void SideFiles()
    {
        foreach (var name in new[] { "sources.json", "tmdb-settings.json", "remote-access.json", "desktop.json", "push-vapid.json",
            @"engine\layout-manifest.json", @"anime-lists\anime-list-full.json", @"anime-lists\anime-list-full.meta.json" })
        {
            var file = Path.Combine(sourceDirectory, name);
            if (!File.Exists(file)) { report.Add($"Optional side file absent: {name}"); continue; }
            var payload = Json(File.ReadAllText(file), "{}");
            if (name == @"anime-lists\anime-list-full.json")
                Add("MetadataCache", Values(("id", Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("fribb:https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json")))),
                    ("kind", CacheKind.FribbMap), ("cacheKey", "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json"),
                    ("payload", payload), ("fetchedAt", new DateTimeOffset(File.GetLastWriteTimeUtc(file))),
                    ("expiresAt", DateTimeOffset.MaxValue), ("complete", true), ("provider", "fribb")));
            else if (name == "remote-access.json")
            {
                var value = payload.Deserialize<RemoteAccessSettings>(new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (value is not null) UpdateSetting<RemoteAccessSettings>("remoteAccess", _ => value);
            }
            else if (name == "desktop.json")
            {
                var value = payload.Deserialize<DesktopSettings>(new JsonSerializerOptions(JsonSerializerDefaults.Web));
                if (value is not null) UpdateSetting<DesktopSettings>("desktop", _ => value);
            }
            else if (name == "sources.json") SourceSettings(payload);
            else if (name == "push-vapid.json")
            {
                if (!payload.TryGetProperty("PublicKey", out _) || !payload.TryGetProperty("PrivateKey", out _))
                    throw new InvalidDataException("Unknown VAPID key shape; refusing to regenerate subscriptions.");
                File.Copy(file, Path.Combine(destinationDirectory, "push-vapid.json"), false);
                ProtectFile(Path.Combine(destinationDirectory, "push-vapid.json"));
                report.Add("VAPID keypair preserved; values withheld.");
            }
            else if (name == "tmdb-settings.json")
            {
                if (!payload.TryGetProperty("apiKey", out var key) && !payload.TryGetProperty("token", out key))
                    throw new InvalidDataException("Unknown TMDB credential shape.");
                var reference = Secret(key.GetString()!);
                UpdateSetting<MetadataSettings>("metadata", value => value with { TmdbCredential = reference });
            }
            else if (name == @"engine\layout-manifest.json") report.Add("Layout manifest backup retained; exact copied paths reconciled before transfer import.");
            else if (name == @"anime-lists\anime-list-full.meta.json")
            {
                using var command = destination.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "UPDATE MetadataCache SET etag=$etag,lastModified=$modified WHERE kind='fribbmap'";
                command.Parameters.AddWithValue("$etag", payload.TryGetProperty("ETag", out var etag) ? etag.GetString() ?? (object)DBNull.Value : DBNull.Value);
                command.Parameters.AddWithValue("$modified", payload.TryGetProperty("LastModified", out var modified) ? modified.GetString() ?? (object)DBNull.Value : DBNull.Value);
                command.ExecuteNonQuery();
            }
            else report.Add($"Side file {name}: immutable backup retained; typed mapping requires review.");
        }
        foreach (var directory in paths.Values.Distinct(StringComparer.OrdinalIgnoreCase))
            if (Directory.Exists(Path.Combine(directory, ".staging")))
                report.Add("Staged payload present: hash verification and relocation required; left untouched, scheduler paused.");
    }
    private void SourceSettings(JsonElement payload)
    {
        if (payload.ValueKind != JsonValueKind.Array) throw new InvalidDataException("Expected sources array.");
        UpdateSetting<ImmutableArray<SourceSettings>>("sources", defaults =>
        {
            var sources = defaults.ToDictionary(s => s.Id);
            foreach (var entry in payload.EnumerateArray())
            {
                var id = entry.GetProperty("id").GetString()!;
                var credential = entry.TryGetProperty("credential", out var secret) && secret.ValueKind == JsonValueKind.String
                    && !string.IsNullOrWhiteSpace(secret.GetString()) ? Secret(secret.GetString()!) : null;
                if (id == "tmdb")
                {
                    if (credential is not null) UpdateSetting<MetadataSettings>("metadata", value => value with { TmdbCredential = credential });
                    continue;
                }
                var source = sources.GetValueOrDefault(id) ?? new SourceSettings(id, false, SourceTier.OptIn,
                    sources.Count, "public", id, null, [], ["all"], 6000, 1, 250, ImmutableDictionary<string, string>.Empty, null);
                sources[id] = source with
                {
                    Enabled = entry.TryGetProperty("enabled", out var enabled) ? enabled.GetBoolean() : source.Enabled,
                    Priority = entry.TryGetProperty("priority", out var priority) ? priority.GetInt32() : source.Priority,
                    BaseUrl = entry.TryGetProperty("baseUrl", out var url) ? url.GetString() : source.BaseUrl,
                    Mirrors = entry.TryGetProperty("mirrors", out var mirrors) ? mirrors.Deserialize<ImmutableArray<string>>() : source.Mirrors,
                    Categories = entry.TryGetProperty("categories", out var categories) ? categories.Deserialize<ImmutableArray<string>>() : source.Categories,
                    TimeoutMilliseconds = entry.TryGetProperty("timeoutMs", out var timeout) ? timeout.GetInt32() : source.TimeoutMilliseconds,
                    Kind = entry.TryGetProperty("kind", out var kind) ? kind.GetString()! : source.Kind,
                    Type = entry.TryGetProperty("type", out var type) ? type.GetString()! : source.Type,
                    Options = entry.TryGetProperty("options", out var options) ? options.Deserialize<ImmutableDictionary<string, string>>()! : source.Options,
                    Credential = credential ?? source.Credential,
                };
            }
            return [.. sources.Values.OrderBy(s => s.Priority).ThenBy(s => s.Id)];
        });
        report.Add("Sources overlaid on new defaults; credentials migrated to restricted files.");
    }
    private SecretReference Secret(string value)
    {
        var directory = Path.Combine(destinationDirectory, "secrets");
        Directory.CreateDirectory(directory);
        var id = "legacy-" + Guid.NewGuid().ToString("N");
        var file = Path.Combine(directory, id + ".secret");
        File.WriteAllText(file, value);
        ProtectFile(file);
        return new SecretReference(id, 1);
    }
    private static void ProtectFile(string path)
    {
        if (OperatingSystem.IsWindows())
        {
            var acl = new FileSecurity();
            acl.SetAccessRuleProtection(true, false);
            acl.AddAccessRule(new FileSystemAccessRule(WindowsIdentity.GetCurrent().User!, FileSystemRights.FullControl, AccessControlType.Allow));
            new FileInfo(path).SetAccessControl(acl);
        }
        else File.SetUnixFileMode(path, UnixFileMode.UserRead | UnixFileMode.UserWrite);
    }
}
