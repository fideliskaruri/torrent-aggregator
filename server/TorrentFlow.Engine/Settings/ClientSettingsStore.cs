using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Clients.External;

namespace TorrentFlow.Engine.Settings;

/// <summary>Parsed ClientSettings row (the TypeScript ClientConnectionConfig).</summary>
public sealed record ClientConfig
{
    public string ClientType { get; init; } = "builtin";
    public string? ExternalClientType { get; init; }
    public string Host { get; init; } = ClientSettingsStore.DefaultHost;
    public string? Username { get; init; }
    public bool HasPassword { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public string? Password { get; init; }
    public string? Category { get; init; }
    public string? SavePath { get; init; }
    public string? BaseDownloadPath { get; init; }
    public long? MaxStorageBytes { get; init; }
    public IReadOnlyList<string> Categories { get; init; } = ClientSettingsStore.DefaultCategories;
    public IReadOnlyDictionary<string, string> PathRules { get; init; } = new Dictionary<string, string>();

    /// <summary>Folder the storage cap is measured under.</summary>
    public string? DownloadRoot => NullIfBlank(BaseDownloadPath) ?? NullIfBlank(SavePath);

    internal static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}

public sealed record DownloadTarget(string? Category, string? SavePath);

public sealed class ClientSettingsStore(
    IDbContextFactory<TorrentFlowDbContext> dbFactory,
    IOptions<ExternalClientOptions>? externalClients = null,
    IConfiguration? configuration = null)
{
    public const string DefaultHost = "http://127.0.0.1:8080";
    public static readonly IReadOnlyList<string> DefaultCategories = ["Anime", "Movies", "TV", "Music", "Games", "Software", "Books", "Other"];

    public static string DefaultDownloadDir(IConfiguration? configuration = null) =>
        ClientConfig.NullIfBlank(configuration?["TorrentFlow:DefaultDownloadDirectory"])
        ?? Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "TorrentFlow");

    public string DefaultDownloadDirectory => DefaultDownloadDir(configuration);
    public bool RunningInContainer => string.Equals(configuration?["DOTNET_RUNNING_IN_CONTAINER"], "true", StringComparison.OrdinalIgnoreCase);

    public bool ExternalClientsEnabled => externalClients?.Value.Enabled == true;

    /// <summary>
    /// First run: built-in is the default client. Folder and storage cap are deliberately not backfilled —
    /// both require an explicit owner decision during setup.
    /// </summary>
    public async Task<ClientSetting> EnsureAsync(TorrentFlowDbContext db, CancellationToken ct = default)
    {
        var row = await db.ClientSettings.FirstOrDefaultAsync(s => s.UserId == LocalUser.Id, ct);
        if (row is not null)
        {
            // Built-in-only builds: settle a stored external selection on builtin, like switchToBuiltin does
            // (externalClientType is kept), so modules that read the row directly agree with the effective client.
            if (!ExternalClientsEnabled && row.ClientType is not "builtin")
            {
                row.ClientType = "builtin";
                row.UpdatedAt = DateTime.UtcNow;
                await db.SaveChangesAsync(ct);
            }
            return row;
        }
        var now = DateTime.UtcNow;
        row = new ClientSetting
        {
            Id = Ids.New(),
            UserId = LocalUser.Id,
            ClientType = "builtin",
            Host = DefaultHost,
            Categories = JsonSerializer.Serialize(DefaultCategories),
            DefaultRetentionPolicy = "EPHEMERAL",
            CreatedAt = now,
            UpdatedAt = now,
        };
        db.ClientSettings.Add(row);
        await db.SaveChangesAsync(ct);
        return row;
    }

    public async Task<ClientConfig> GetConfigAsync(CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        return EffectiveConfig(ToConfig(await EnsureAsync(db, ct)));
    }

    public async Task<ClientConfig> GetConnectionConfigAsync(SecretProtector secrets, CancellationToken ct = default)
    {
        await using var db = await dbFactory.CreateDbContextAsync(ct);
        var row = await EnsureAsync(db, ct);
        return EffectiveConfig(ToConfig(row)) with { Password = secrets.Decrypt(row.Password) };
    }

    private ClientConfig EffectiveConfig(ClientConfig config) =>
        ExternalClientsEnabled ? config : config with { ClientType = "builtin", ExternalClientType = null };

    public static ClientConfig ToConfig(ClientSetting s)
    {
        var categories = ParseArray(s.Categories);
        return new ClientConfig
        {
            ClientType = s.ClientType,
            ExternalClientType = s.ExternalClientType is "qbittorrent" or "transmission" ? s.ExternalClientType : null,
            Host = s.Host,
            Username = s.Username,
            HasPassword = !string.IsNullOrEmpty(s.Password),
            Category = s.Category,
            SavePath = s.SavePath,
            BaseDownloadPath = s.BaseDownloadPath,
            MaxStorageBytes = ConfiguredCap(s),
            Categories = categories.Count > 0 ? categories : DefaultCategories,
            PathRules = ParseRecord(s.PathRules),
        };
    }

    /// <summary>A cap only counts when it is positive; storageCapConfigured=false means the owner cleared it.</summary>
    public static long? ConfiguredCap(ClientSetting s) =>
        s.MaxStorageBytes is > 0 && s.StorageCapConfigured != false ? s.MaxStorageBytes : null;

    public static List<string> ParseArray(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            return JsonSerializer.Deserialize<List<string?>>(json)?.Where(x => !string.IsNullOrWhiteSpace(x)).Select(x => x!.Trim()).ToList() ?? [];
        }
        catch (JsonException) { return []; }
    }

    public static Dictionary<string, string> ParseRecord(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return [];
        try
        {
            var raw = JsonSerializer.Deserialize<Dictionary<string, JsonElement>>(json) ?? [];
            return raw.Where(kv => kv.Value.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(kv.Value.GetString()))
                .ToDictionary(kv => kv.Key, kv => kv.Value.GetString()!);
        }
        catch (JsonException) { return []; }
    }

    /// <summary>Join base + category using the separator implied by the base path.</summary>
    public static string JoinDownloadPath(string @base, string category)
    {
        var b = @base.TrimEnd('/', '\\');
        var cat = category.Trim('/', '\\');
        if (b.Length == 0) return cat;
        if (cat.Length == 0) return b;
        var sep = b.Contains('\\') ? '\\' : '/';
        return $"{b}{sep}{cat}";
    }

    /// <summary>
    /// Category + save path for a send. Priority: explicit savePath, pathRules[category],
    /// baseDownloadPath/category, then savePath default, then baseDownloadPath alone.
    /// </summary>
    public static DownloadTarget ResolveDownloadTarget(ClientConfig config, string? categoryOverride, string? savePathOverride)
    {
        var category = !string.IsNullOrEmpty(categoryOverride) ? categoryOverride : config.Category;
        category = ClientConfig.NullIfBlank(category);
        string? savePath = ClientConfig.NullIfBlank(savePathOverride);
        if (savePath is null && category is not null && config.PathRules.TryGetValue(category, out var rule)) savePath = ClientConfig.NullIfBlank(rule);
        if (savePath is null && category is not null && ClientConfig.NullIfBlank(config.BaseDownloadPath) is { } baseDir)
            savePath = JoinDownloadPath(baseDir, category);
        savePath ??= ClientConfig.NullIfBlank(config.SavePath) ?? ClientConfig.NullIfBlank(config.BaseDownloadPath);
        return new DownloadTarget(category, savePath);
    }
}
