using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Clients.External;
using TorrentFlow.Engine.Settings;
using TorrentFlow.Engine.Storage;

namespace TorrentFlow.Engine.Controllers;

[ApiController]
[Route("api/settings/client")]
public sealed class SettingsClientController(
    TorrentFlowDbContext db,
    ClientSettingsStore store,
    SecretProtector secrets,
    StorageBudget storage,
    ExternalClientRegistry clients) : ControllerBase
{
    internal static readonly int[] SelectableResolutions = [480, 720, 1080, 2160];
    internal const int DefaultResolution = 1080;
    internal static readonly int[] AutomationIntervals = [0, 30, 120, 360];

    [HttpGet]
    public async Task<IActionResult> Get(CancellationToken ct)
    {
        var row = await store.EnsureAsync(db, ct);
        return Ok(new { settings = await PublicSettingsAsync(row, ct), defaults = Defaults() });
    }

    internal static object Defaults() => new
    {
        categories = ClientSettingsStore.DefaultCategories,
        baseDownloadPath = ClientSettingsStore.DefaultDownloadDir(),
        clientType = "builtin",
    };

    internal async Task<Dictionary<string, object?>> PublicSettingsAsync(ClientSetting s, CancellationToken ct)
    {
        var config = ClientSettingsStore.ToConfig(s);
        var cap = config.MaxStorageBytes;
        var hasFolder = config.DownloadRoot is not null;
        return new Dictionary<string, object?>
        {
            ["clientType"] = s.ClientType,
            ["externalClientType"] = config.ExternalClientType,
            ["host"] = s.Host,
            ["username"] = s.Username,
            ["hasPassword"] = config.HasPassword,
            ["category"] = s.Category,
            ["savePath"] = s.SavePath,
            ["baseDownloadPath"] = s.BaseDownloadPath,
            ["maxStorageBytes"] = cap,
            ["maxStorageGb"] = cap is { } c ? Math.Round(c / 1e9 * 10) / 10 : 0,
            ["storageCapConfigured"] = cap is not null,
            ["setupComplete"] = hasFolder && cap is > 0,
            ["verboseDiagnostics"] = s.VerboseDiagnostics == true,
            ["preferredResolution"] = s.PreferredResolution is { } r && SelectableResolutions.Contains(r) ? r : DefaultResolution,
            ["automationIntervalMinutes"] = s.AutomationIntervalMinutes is { } m && AutomationIntervals.Contains(m) ? m : 0,
            ["categories"] = config.Categories,
            ["pathRules"] = config.PathRules,
            ["pathWarnings"] = PathWarnings(config),
            ["hasExternal"] = config.ExternalClientType is not null,
            ["defaultRetentionPolicy"] = s.DefaultRetentionPolicy?.Trim().ToUpperInvariant() is "KEEP" or "KEPT" ? "KEPT" : "EPHEMERAL",
            ["defaultRetentionPolicyPersisted"] = !string.IsNullOrEmpty(s.DefaultRetentionPolicy),
            ["storageUsage"] = await StorageUsageAsync(config, ct),
        };
    }

    private static List<object> PathWarnings(ClientConfig config)
    {
        var list = new List<object>();
        static string Normalize(string path) => path.Trim().Trim('"', '\'').Replace('\\', '/').TrimEnd('/').ToLowerInvariant();
        var current = new DirectoryInfo(Directory.GetCurrentDirectory());
        while (current.Parent is not null && !System.IO.File.Exists(Path.Combine(current.FullName, "TorrentFlow.slnx"))) current = current.Parent;
        var repo = Normalize(System.IO.File.Exists(Path.Combine(current.FullName, "TorrentFlow.slnx"))
            ? current.FullName : Directory.GetCurrentDirectory());
        var temporary = Normalize(Path.GetTempPath());
        void Check(string field, string? path, string? category = null)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            var normalized = Normalize(path);
            var segments = normalized.Split('/', StringSplitOptions.RemoveEmptyEntries);
            var reasons = new List<string>();
            if (segments.Any(s => System.Text.RegularExpressions.Regex.IsMatch(s, @"(?:^|[._-])e2e(?:$|[._-])|^(?:\.?playwright(?:[-_.].*)?|test-results?|playwright-report)$")))
                reasons.Add("test-directory");
            if (segments.Contains("node_modules")) reasons.Add("dependencies");
            if (segments.Any(s => s is "tmp" or ".tmp" or "temp" or ".temp") || normalized == temporary || normalized.StartsWith(temporary + '/', StringComparison.Ordinal))
                reasons.Add("temporary-directory");
            if (normalized == repo || normalized.StartsWith(repo + '/', StringComparison.Ordinal)) reasons.Add("inside-repository");
            if (reasons.Count == 0) return;
            var detail = reasons.Contains("inside-repository") ? "It is inside the TorrentFlow project."
                : reasons.Contains("temporary-directory") ? "It is in a temporary directory."
                : reasons.Contains("dependencies") ? "It is inside node_modules." : "It looks like a test directory.";
            list.Add(new { field, category, path, reasons, message = $"{detail} Tests, updates, or cleanup tools may remove files stored there. Choose a permanent media folder; TorrentFlow will not move existing files automatically." });
        }
        Check("baseDownloadPath", config.BaseDownloadPath);
        Check("savePath", config.SavePath);
        foreach (var (cat, p) in config.PathRules) Check("pathRule", p, cat);
        return list;
    }

    private async Task<object?> StorageUsageAsync(ClientConfig config, CancellationToken ct)
    {
        var rows = await db.EngineTorrents.AsNoTracking().Where(r => r.UserId == LocalUser.Id).ToListAsync(ct);
        return SettingsDiskInventory.Usage(config, rows, ct);
    }

    [HttpPut]
    public async Task<IActionResult> Put(CancellationToken ct)
    {
        if (await JsonBody.ReadAsync(Request, ct) is not { } body) return JsonBody.InvalidJson();
        if (SettingsInput.Validate(body) is { } failure) return BadRequest(new { error = failure.Error, field = failure.Field });
        IActionResult Bad(string reason) => BadRequest(new { ok = false, error = reason, message = reason });

        var row = await store.EnsureAsync(db, ct);

        if (body.Bool("switchToBuiltin") == true)
        {
            if (string.IsNullOrEmpty(row.ExternalClientType) && row.ClientType is "qbittorrent" or "transmission")
                row.ExternalClientType = row.ClientType;
            row.ClientType = "builtin";
            row.UpdatedAt = DateTime.UtcNow;
            await db.SaveChangesAsync(ct);
            return Ok(new
            {
                settings = await PublicSettingsAsync(row, ct),
                message = "Switched to built-in engine. External client kept for optional Send to my client.",
            });
        }

        if (body.Str("clientType") is { } clientType)
        {
            row.ClientType = clientType.Trim();
        }
        if (body.Has("externalClientType"))
        {
            var ext = body.Str("externalClientType")?.Trim();
            row.ExternalClientType = ext is null or "" or "none" ? null : ext;
        }
        if (row.ClientType is "qbittorrent" or "transmission") row.ExternalClientType = row.ClientType;
        if (body.Str("host")?.Trim() is { Length: > 0 } host)
        {
            if (!Uri.TryCreate(host.Trim(), UriKind.Absolute, out var uri) || uri.Scheme is not ("http" or "https"))
                return Bad("host must be an http(s) URL");
            row.Host = host.TrimEnd('/');
        }
        if (body.Has("username")) row.Username = body.Str("username")?.Trim();
        if (body.Has("password") && body.IsNull("password")) row.Password = null;
        if (body.Str("password") is { Length: > 0 } password)
        {
            if (password.Length > 4096) return Bad("password is too long");
            row.Password = secrets.Encrypt(password);
        }

        foreach (var field in new[] { "category", "savePath", "baseDownloadPath" })
        {
            if (!body.Has(field)) continue;
            var value = body.Str(field);
            if (value?.Contains('\0') == true) return Bad($"{field} contains an invalid null character");
            value = NullIfBlank(value);
            if (field == "category") row.Category = value;
            else if (field == "savePath") row.SavePath = value;
            else row.BaseDownloadPath = value;
        }

        var hasGb = body.Has("maxStorageGb");
        var hasBytes = body.Has("maxStorageBytes");
        if (hasGb && hasBytes) return BadRequest(new { error = "Provide maxStorageGb or maxStorageBytes, not both" });
        if (hasGb || hasBytes)
        {
            var field = hasGb ? "maxStorageGb" : "maxStorageBytes";
            if (body.IsNull(field) || body.Str(field) == "")
            {
                row.MaxStorageBytes = null;
                row.StorageCapConfigured = false;
            }
            else
            {
                var n = body.Num(field) ?? (double.TryParse(body.Str(field), System.Globalization.NumberStyles.Float, System.Globalization.CultureInfo.InvariantCulture, out var p) ? p : double.NaN);
                if (!double.IsFinite(n) || n < 0) return Bad($"{field} must be a non-negative number");
                var bytes = hasGb ? Math.Round(n * 1e9) : n;
                if (!hasGb && bytes != Math.Floor(bytes)) return Bad("maxStorageBytes must be an integer");
                if (bytes > long.MaxValue) return Bad($"{field} is too large");
                row.MaxStorageBytes = bytes > 0 ? (long)bytes : null;
                row.StorageCapConfigured = bytes > 0;
            }
            storage.ResetDirectorySizeCache();
        }

        if (body.Bool("verboseDiagnostics") is { } verbose) row.VerboseDiagnostics = verbose;
        if (body.Has("preferredResolution"))
        {
            var r = body.Num("preferredResolution") ?? DefaultResolution;
            row.PreferredResolution = (int)r;
        }
        if (body.Has("automationIntervalMinutes"))
        {
            var m = body.Num("automationIntervalMinutes") ?? 0;
            row.AutomationIntervalMinutes = (int)m;
        }
        if (body.TryGetProperty("categories", out var cats) && cats.ValueKind != JsonValueKind.Null)
        {
            if (cats.ValueKind != JsonValueKind.Array) return Bad("categories must be an array");
            var list = cats.EnumerateArray().Select(c => c.GetString()!.Trim()).ToList();
            if (list.Count > 64) return Bad("At most 64 categories");
            row.Categories = JsonSerializer.Serialize(list);
        }
        if (body.TryGetProperty("pathRules", out var rules) && rules.ValueKind != JsonValueKind.Null)
        {
            if (rules.ValueKind == JsonValueKind.Null) row.PathRules = null;
            else if (rules.ValueKind != JsonValueKind.Object) return Bad("pathRules must be an object");
            else
            {
                var map = new Dictionary<string, string>();
                foreach (var p in rules.EnumerateObject())
                {
                    if (p.Value.ValueKind != JsonValueKind.String) continue;
                    var path = p.Value.GetString()!.Trim();
                    if (path.Contains('\0')) return Bad("pathRules contains an invalid null character");
                    if (path.Length > 0) map[p.Name.Trim()] = path;
                }
                if (map.Count > 64) return Bad("At most 64 path rules");
                row.PathRules = map.Count > 0 ? JsonSerializer.Serialize(map) : null;
            }
        }
        if (body.Has("defaultRetentionPolicy"))
            row.DefaultRetentionPolicy = body.Str("defaultRetentionPolicy")?.Trim() is "KEEP" or "KEPT" ? "KEPT" : "EPHEMERAL";

        storage.ResetDirectorySizeCache();
        row.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);

        object? testResult = null;
        if (body.Bool("test") == true)
        {
            var config = await clients.GetConfigAsync(ct);
            var type = body.Str("testTarget") == "external" && config.ExternalClientType is { } external && !string.IsNullOrWhiteSpace(config.Host)
                ? external : config.ClientType;
            testResult = type == "builtin"
                ? new EngineActionResult(true, "Built-in engine is running.")
                : await clients.Get(type).TestAsync(config with { ClientType = type }, ct);
        }

        return Ok(new Dictionary<string, object?>
        {
            ["settings"] = await PublicSettingsAsync(row, ct),
            ["testResult"] = testResult,
            ["retentionWarning"] = null,
        });
    }

    private static string? NullIfBlank(string? s) => string.IsNullOrWhiteSpace(s) ? null : s.Trim();
}
