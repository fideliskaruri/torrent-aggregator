using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

internal sealed record ColumnDefinition(PropertyInfo Property, string Name, Type StorageType, bool Nullable, bool Json);
internal sealed record IndexDefinition(string Table, string Columns, bool Unique = false, string? Filter = null)
{
    public string Name => $"IX_{Table}_{new string(Columns.Select(c => char.IsLetterOrDigit(c) ? c : '_').ToArray())}_{(Filter is null ? "all" : new string(Filter.Where(char.IsLetterOrDigit).ToArray()))}";
    public bool Expression => Columns.Contains("coalesce", StringComparison.Ordinal);
}
internal sealed record ForeignKeyDefinition(string Table, string Column, string Principal, bool Cascade = false);

internal sealed class TableDefinition
{
    public Type RowType { get; }
    public string Name { get; }
    public string Key { get; }
    public ColumnDefinition[] Columns { get; }

    public TableDefinition(Type rowType)
    {
        RowType = rowType;
        Name = rowType.Name[..^3];
        Key = Name switch { "Release" or "Verdict" => "hash", "Setting" => "section", _ => "id" };
        var nullability = new NullabilityInfoContext();
        Columns = rowType.GetProperties().Select(property =>
        {
            var type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
            var json = type != typeof(string) && type != typeof(DateTimeOffset) && !type.IsEnum && !type.IsPrimitive;
            var name = property.Name == "Id" ? Key : property.Name switch
            {
                "ScopeData" => "scopeJson",
                "LibraryFolders" => "libraryFoldersJson",
                _ => char.ToLowerInvariant(property.Name[0]) + property.Name[1..] + (json ? "Json" : ""),
            };
            return new ColumnDefinition(property, name,
                type.IsEnum || type == typeof(DateTimeOffset) || json ? typeof(string) : property.PropertyType,
                nullability.Create(property).ReadState == NullabilityState.Nullable, json);
        }).ToArray();
    }

    public Dictionary<string, object> ToEntity(StoreRow row) => Columns.ToDictionary(c => c.Name, c =>
    {
        var value = c.Property.GetValue(row);
        return value switch
        {
            null => null!,
            DateTimeOffset date => date.ToUniversalTime().ToString("O", System.Globalization.CultureInfo.InvariantCulture),
            Enum choice => choice.ToString().ToLowerInvariant(),
            _ when c.Json => JsonSerializer.Serialize(value, c.Property.PropertyType, Schema.Json),
            _ => value,
        };
    });

    public StoreRow ToRow(Dictionary<string, object> entity)
    {
        var payload = new Dictionary<string, object?>();
        foreach (var column in Columns)
        {
            var value = entity.GetValueOrDefault(column.Name);
            var type = Nullable.GetUnderlyingType(column.Property.PropertyType) ?? column.Property.PropertyType;
            payload[column.Property.Name] = value is null ? null
                : column.Json ? JsonSerializer.Deserialize((string)value, column.Property.PropertyType, Schema.Json)
                : type.IsEnum ? Enum.Parse(type, (string)value, ignoreCase: true)
                : type == typeof(DateTimeOffset) ? DateTimeOffset.Parse((string)value, System.Globalization.CultureInfo.InvariantCulture)
                : value;
        }
        return (StoreRow)JsonSerializer.Deserialize(JsonSerializer.Serialize(payload, Schema.Json), RowType, Schema.Json)!;
    }
}

internal static class Schema
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true,
        RespectNullableAnnotations = true,
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase, allowIntegerValues: false) },
    };
    internal static readonly TableDefinition[] Tables = Enum.GetNames<StoreTable>()
        .Select(name => new TableDefinition(typeof(StoreRow).Assembly.GetType($"TorrentFlow.Domain.{name}Row", throwOnError: true)!))
        .ToArray();
    internal static TableDefinition Table(Type type) => Tables.Single(t => t.RowType == type);
    internal static TableDefinition Table(string name) => Tables.Single(t => t.Name == name);

    internal static readonly IndexDefinition[] Indexes =
    [
        new("Work", "workKey", true), new("Work", "kind,anime"), new("Work", "digitalAt"), new("Work", "refreshedAt"),
        new("WorkName", "workId,normalizedValue,label,coalesce(linkId,'')", true), new("WorkName", "workId,ordinal"),
        new("WorkLink", "workId,provider,externalId,coalesce(providerKind,'')", true),
        new("WorkLink", "provider,externalId,coalesce(providerKind,'')", true, "status='verified'"),
        new("WorkLink", "workId", true, "isPrimary=1"), new("WorkLink", "workId,status"),
        new("Season", "workId,number", true), new("Season", "mappingStatus,refreshedAt"),
        new("Episode", "seasonId,number", true, "mappingStatus <> 'unavailable'"),
        new("Episode", "provider,providerEpisodeId", true, "providerEpisodeId IS NOT NULL"),
        new("Episode", "airAt"), new("Episode", "seasonId,absoluteNumber"),
        new("MetadataCache", "kind,cacheKey", true), new("MetadataCache", "expiresAt"),
        new("WorkPreference", "workId", true),
        new("Target", "workId", true, "episodeId IS NULL"), new("Target", "episodeId", true, "episodeId IS NOT NULL"),
        new("Target", "state,nextTryAt,rank"), new("Target", "batchId"), new("Target", "chosenReleaseHash"),
        new("ScopeIntent", "state,nextTryAt"), new("ScopeIntent", "workId"), new("ScopeIntent", "batchId"),
        new("RawIntent", "downloadId", true, "downloadId IS NOT NULL"), new("RawIntent", "state,nextTryAt"), new("RawIntent", "releaseHash"),
        new("Request", "userId,decision,createdAt"), new("Request", "workId,decision"),
        new("RequestItem", "requestId,coalesce(episodeId,'')", true), new("RequestItem", "targetId"), new("RequestItem", "requestId,settlement"),
        new("AutoApproveRule", "normalizedEmail", true),
        new("Follow", "workId", true), new("Follow", "enabled,lastMaterializedAt"),
        new("WatchItem", "userId,workId", true), new("WatchItem", "upgradeWatch"),
        new("UpgradeEvidence", "workId,coalesce(episodeId,'')", true), new("UpgradeEvidence", "expiresAt"),
        new("AutoRule", "userId,enabled,lastRunAt"),
        new("Release", "lastSeenAt"),
        new("ReleaseObservation", "hash,sourceId,query", true), new("ReleaseObservation", "sourceId,observedAt"),
        new("Verdict", "expiresAt"), new("Verdict", "checkedAt"),
        new("Attempt", "targetId,startedAt"), new("Attempt", "workId,startedAt"), new("Attempt", "actorUserId,startedAt"),
        new("Attempt", "releaseHash"), new("Attempt", "downloadId", true, "kind='swap' AND endedAt IS NULL"), new("Attempt", "kind,endedAt,deadlineAt"),
        new("Block", "hash,coalesce(workKey,'')", true), new("Block", "until"), new("Block", "workKey"),
        new("SearchCache", "normalizedQuery,scopeKey,sourceId,sourceRevision,credentialRevision,parserVersion", true),
        new("SearchCache", "normalizedQuery,expiresAt"), new("SearchCache", "expiresAt"),
        new("Download", "hash", true), new("Download", "admissionToken", true), new("Download", "intent,addedAt"),
        new("DownloadTarget", "downloadId,targetId", true),
        new("DownloadTarget", "targetId", true, "role='current'"), new("DownloadTarget", "targetId", true, "role='replacement'"),
        new("DownloadTarget", "downloadId,role"),
        new("DownloadFile", "downloadId,fileIndex", true), new("DownloadFile", "physicalKey", true, "physicalKey IS NOT NULL"),
        new("DownloadFile", "targetId"), new("DownloadFile", "mediaFileId"),
        new("StorageRoot", "physicalKey", true), new("StorageRoot", "enabled,priority"),
        new("WorkFolder", "workId", true), new("WorkFolder", "rootId,relativeItemFolder", true, "rootId IS NOT NULL"),
        new("WorkFolder", "externalItemFolder", true, "externalItemFolder IS NOT NULL"),
        new("MediaFile", "physicalKey", true), new("MediaFile", "downloadId,fileIndex", true, "downloadId IS NOT NULL"),
        new("MediaFile", "workId,episodeId,status"), new("MediaFile", "rootId,status"), new("MediaFile", "parentMediaFileId"), new("MediaFile", "missingSince"),
        new("FileOperation", "state,nextTryAt"), new("FileOperation", "downloadId"), new("FileOperation", "mediaFileId"),
        new("FilePathClaim", "physicalKey", true), new("FilePathClaim", "operationId"),
        new("User", "normalizedEmail", true, "normalizedEmail IS NOT NULL"), new("User", "role", true, "role='owner'"),
        new("Notification", "userId,dedupeKey", true, "dedupeKey IS NOT NULL"), new("Notification", "userId,createdAt"), new("Notification", "pushPending,pushAttemptAt"),
        new("PushSubscription", "endpoint", true), new("PushSubscription", "userId"),
    ];

    internal static readonly ForeignKeyDefinition[] ForeignKeys =
    [
        new("WorkName", "workId", "Work"), new("WorkName", "linkId", "WorkLink", true),
        new("WorkLink", "workId", "Work"), new("WorkLink", "seasonId", "Season"),
        new("Season", "workId", "Work"), new("Episode", "seasonId", "Season"),
        new("WorkPreference", "workId", "Work"), new("WorkPreference", "storageRootOverrideId", "StorageRoot"),
        new("Target", "workId", "Work"), new("Target", "episodeId", "Episode"), new("Target", "createdBy", "User"),
        new("Target", "autoRuleId", "AutoRule"), new("Target", "chosenReleaseHash", "Release"), new("Target", "replaceMediaFileId", "MediaFile"),
        new("ScopeIntent", "actorUserId", "User"), new("ScopeIntent", "workId", "Work"),
        new("RawIntent", "actorUserId", "User"), new("RawIntent", "releaseHash", "Release"), new("RawIntent", "downloadId", "Download"), new("RawIntent", "rootId", "StorageRoot"),
        new("Request", "userId", "User"), new("Request", "workId", "Work"), new("Request", "decidedBy", "User"),
        new("RequestItem", "requestId", "Request", true), new("RequestItem", "episodeId", "Episode"), new("RequestItem", "targetId", "Target"),
        new("Follow", "workId", "Work"), new("Follow", "fromEpisodeId", "Episode"),
        new("WatchItem", "userId", "User"), new("WatchItem", "workId", "Work"),
        new("UpgradeEvidence", "workId", "Work"), new("UpgradeEvidence", "episodeId", "Episode"), new("UpgradeEvidence", "candidateHash", "Release"),
        new("AutoRule", "userId", "User"), new("AutoRule", "lastMatchHash", "Release"),
        new("ReleaseObservation", "hash", "Release", true), new("Verdict", "hash", "Release"),
        new("Attempt", "targetId", "Target"), new("Attempt", "workId", "Work"), new("Attempt", "releaseHash", "Release"), new("Attempt", "actorUserId", "User"), new("Attempt", "downloadId", "Download"),
        new("Download", "hash", "Release"), new("Download", "rootId", "StorageRoot"), new("Download", "rawIntentId", "RawIntent"),
        new("DownloadTarget", "downloadId", "Download"), new("DownloadTarget", "targetId", "Target"),
        new("DownloadFile", "downloadId", "Download"), new("DownloadFile", "targetId", "Target"), new("DownloadFile", "mediaFileId", "MediaFile"),
        new("WorkFolder", "workId", "Work"), new("WorkFolder", "rootId", "StorageRoot"),
        new("MediaFile", "workId", "Work"), new("MediaFile", "episodeId", "Episode"), new("MediaFile", "rootId", "StorageRoot"),
        new("MediaFile", "parentMediaFileId", "MediaFile"), new("MediaFile", "downloadId", "Download"),
        new("FileOperation", "targetId", "Target"), new("FileOperation", "downloadId", "Download"), new("FileOperation", "mediaFileId", "MediaFile"),
        new("FilePathClaim", "operationId", "FileOperation"), new("Notification", "userId", "User"), new("PushSubscription", "userId", "User"),
    ];
}
