using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Core.Sources;
using System.Text.Json.Nodes;

namespace TorrentFlow.Metadata.Settings;

public sealed record TmdbKeyStatus(bool Configured, string Source, string Hint);

public sealed class TmdbSettingsStore : ITmdbCredentialProvider
{
    private readonly object gate = new();
    private readonly string path;
    private readonly IOptions<MetadataOptions> options;
    private string? saved;
    private long revision = Random.Shared.NextInt64(1, long.MaxValue / 2);
    private readonly SourceRegistry? registry;

    public TmdbSettingsStore(IConfiguration configuration, IOptions<MetadataOptions> options, SourceRegistry? registry = null)
    {
        this.registry = registry;
        this.options = options;
        path = Path.Combine(configuration["TorrentFlow:DataDirectory"] ?? Path.Combine(AppContext.BaseDirectory, "data"), "tmdb-settings.json");
        if (File.Exists(path))
        {
            try
            {
                using var json = JsonDocument.Parse(File.ReadAllText(path));
                if (json.RootElement.ValueKind == JsonValueKind.Object &&
                    json.RootElement.TryGetProperty("apiKey", out var value) && value.ValueKind == JsonValueKind.String &&
                    Accepts(value.GetString()))
                    saved = Valid(value.GetString());
            }
            catch (JsonException) { }
        }
        if (registry is not null && saved is not null && registry.Find("tmdb")?.Credential is null)
        {
            registry.Update("tmdb", new JsonObject { ["credential"] = saved });
            File.Delete(path);
        }
    }

    private static string? Valid(string? value) => TmdbClient.IsUsableKey(value) ? TmdbClient.NormalizeCredential(value) : null;
    public string? ApiKey { get { lock (gate) return registry is not null
        ? registry.Find("tmdb") is { Enabled: true } source ? Valid(source.Credential) ?? Valid(options.Value.TmdbApiKey) : null
        : saved ?? Valid(options.Value.TmdbApiKey); } }
    public long Revision { get { lock (gate) return registry?.Revision ?? revision; } }

    public TmdbKeyStatus Status()
    {
        lock (gate)
        {
            var key = ApiKey;
            return new(key is not null, (registry is not null ? registry.Find("tmdb")?.Credential : saved) is not null ? "settings" : key is not null ? "environment" : "none",
                key is null ? "" : $"••••{key[^4..]}");
        }
    }

    public static bool Accepts(string? value) =>
        value is { Length: <= 4096 } && !value.Any(char.IsControl) && TmdbClient.IsUsableKey(value);

    public void Save(string value)
    {
        if (!Accepts(value)) throw new ArgumentException("Enter a usable TMDB API key.");
        lock (gate)
        {
            var normalized = TmdbClient.NormalizeCredential(value);
            if (registry is not null)
            {
                registry.Update("tmdb", new JsonObject { ["credential"] = normalized, ["enabled"] = true });
                return;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path)!);
            var pending = path + ".pending";
            try
            {
                File.WriteAllText(pending, JsonSerializer.Serialize(new { apiKey = normalized }));
                File.Move(pending, path, overwrite: true);
                saved = normalized;
                revision++;
            }
            finally { if (File.Exists(pending)) File.Delete(pending); }
        }
    }

    public void Remove()
    {
        lock (gate)
        {
            if (registry is not null)
            {
                registry.Update("tmdb", new JsonObject { ["credential"] = null });
                return;
            }
            File.Delete(path);
            saved = null;
            revision++;
        }
    }
}
