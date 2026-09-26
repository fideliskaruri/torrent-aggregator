using System.Text.Json;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Options;
using TorrentFlow.Core.Contracts.Metadata;
using TorrentFlow.Metadata.Providers;

namespace TorrentFlow.Metadata.Settings;

public sealed record TmdbKeyStatus(bool Configured, string Source, string Hint);

public sealed class TmdbSettingsStore : ITmdbCredentialProvider
{
    private readonly object gate = new();
    private readonly string path;
    private readonly IOptions<MetadataOptions> options;
    private string? saved;
    private long revision = Random.Shared.NextInt64(1, long.MaxValue / 2);

    public TmdbSettingsStore(IConfiguration configuration, IOptions<MetadataOptions> options)
    {
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
    }

    private static string? Valid(string? value) => TmdbClient.IsUsableKey(value) ? TmdbClient.NormalizeCredential(value) : null;
    public string? ApiKey { get { lock (gate) return saved ?? Valid(options.Value.TmdbApiKey); } }
    public long Revision { get { lock (gate) return revision; } }

    public TmdbKeyStatus Status()
    {
        lock (gate)
        {
            var key = ApiKey;
            return new(key is not null, saved is not null ? "settings" : key is not null ? "environment" : "none",
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
            File.Delete(path);
            saved = null;
            revision++;
        }
    }
}
