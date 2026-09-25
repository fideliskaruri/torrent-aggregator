using System.Globalization;
using System.Text.Json;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>
/// Holds the remote access settings. <see cref="Startup"/> is what the listener was built from; <see cref="Current"/>
/// is what token checks use, so team, audience and owners apply as soon as they are saved.
/// </summary>
public sealed class RemoteAccessStore
{
    public const string FileName = "remote-access.json";

    private static readonly JsonSerializerOptions WriteOptions = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly SemaphoreSlim _writeLock = new(1, 1);
    private RemoteAccessOptions _current;

    private RemoteAccessStore(string filePath, RemoteAccessOptions options, IReadOnlyList<string> loadWarnings)
    {
        FilePath = filePath;
        Startup = options;
        _current = options;
        LoadWarnings = loadWarnings;
    }

    public string FilePath { get; }

    public RemoteAccessOptions Startup { get; }

    public RemoteAccessOptions Current => Volatile.Read(ref _current);

    public IReadOnlyList<string> LoadWarnings { get; private set; }

    /// <summary>Set once the server has started: whether Kestrel really bound the tunnel port. Null when unknown (test host).</summary>
    public bool? TunnelBound { get; set; }

    /// <summary>The tunnel listener was requested at startup and was not found missing from the bound addresses.</summary>
    public bool TunnelListening => ActiveTunnelPort is not null && TunnelBound != false;

    /// <summary>Ports the owner (local) listener binds, so the tunnel port can never share one.</summary>
    public IReadOnlyList<int> OwnerPorts { get; set; } = [];

    /// <summary>True once enabled, port or bind address differ from what the running listener was built from.</summary>
    public bool RestartRequired => !Current.ListenerEquals(Startup);

    /// <summary>The port the tunnel listener actually listens on, or null when it was not started.</summary>
    public int? ActiveTunnelPort => Startup.Enabled ? Startup.TunnelPort : null;

    public static RemoteAccessStore Load(IConfiguration configuration, string dataDirectory)
    {
        var warnings = new List<string>();
        var section = configuration.GetSection(RemoteAccessOptions.SectionName);
        var options = new RemoteAccessOptions();
        options = Apply(options, new ConfigSource(section), "configuration", warnings);

        var path = Path.Combine(dataDirectory, FileName);
        if (File.Exists(path))
        {
            try
            {
                using var doc = JsonDocument.Parse(File.ReadAllBytes(path), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
                if (doc.RootElement.ValueKind == JsonValueKind.Object)
                    options = Apply(options, new JsonSource(doc.RootElement), FileName, warnings);
                else
                    warnings.Add($"{FileName} is not a JSON object and was ignored.");
            }
            catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException)
            {
                warnings.Add($"{FileName} could not be read and was ignored: {ex.Message}");
            }
        }
        return new RemoteAccessStore(path, options, warnings);
    }

    public async Task SaveAsync(RemoteAccessOptions next, CancellationToken ct)
    {
        await _writeLock.WaitAsync(ct);
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var temp = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            var payload = new
            {
                next.Enabled,
                next.TunnelPort,
                next.TunnelBindAddress,
                next.TeamDomain,
                next.Audience,
                next.OwnerEmails,
            };
            try
            {
                await using (var stream = new FileStream(temp, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
                    await JsonSerializer.SerializeAsync(stream, payload, WriteOptions, ct);
                File.Move(temp, FilePath, overwrite: true);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
            Volatile.Write(ref _current, next);
            // The saved file now reflects valid values, so warnings about what was loaded no longer apply.
            LoadWarnings = [];
        }
        finally
        {
            _writeLock.Release();
        }
    }

    private static RemoteAccessOptions Apply(RemoteAccessOptions options, ISource source, string origin, List<string> warnings)
    {
        if (source.Bool("enabled") is { } enabled) options = options with { Enabled = enabled };
        if (source.Has("tunnelPort"))
        {
            if (source.Int("tunnelPort") is { } port and >= RemoteAccessRules.MinPort and <= RemoteAccessRules.MaxPort)
                options = options with { TunnelPort = port };
            else
                warnings.Add($"Ignored an invalid tunnelPort in {origin}.");
        }
        if (source.String("tunnelBindAddress") is { } bind)
        {
            if (RemoteAccessRules.IsValidBindAddress(bind.Trim())) options = options with { TunnelBindAddress = bind.Trim() };
            else warnings.Add($"Ignored an invalid tunnelBindAddress in {origin}.");
        }
        if (source.Has("teamDomain"))
        {
            var raw = source.String("teamDomain");
            var team = RemoteAccessRules.NormalizeTeamDomain(raw);
            if (team is null && !string.IsNullOrWhiteSpace(raw)) warnings.Add($"Ignored an invalid teamDomain in {origin}.");
            options = options with { TeamDomain = team };
        }
        if (source.Has("audience"))
        {
            var audience = source.String("audience")?.Trim();
            if (!string.IsNullOrEmpty(audience) && !RemoteAccessRules.IsValidAudience(audience))
            {
                warnings.Add($"Ignored an invalid audience in {origin}.");
                audience = null;
            }
            options = options with { Audience = string.IsNullOrEmpty(audience) ? null : audience };
        }
        if (source.Strings("ownerEmails") is { } emails)
        {
            var normalized = new List<string>();
            foreach (var email in emails)
            {
                var value = RemoteAccessRules.NormalizeEmail(email);
                if (value is null) { if (!string.IsNullOrWhiteSpace(email)) warnings.Add($"Ignored an invalid owner email in {origin}."); continue; }
                if (!normalized.Contains(value)) normalized.Add(value);
            }
            options = options with { OwnerEmails = normalized };
        }
        return options;
    }

    private interface ISource
    {
        bool Has(string key);
        string? String(string key);
        bool? Bool(string key);
        int? Int(string key);
        IReadOnlyList<string>? Strings(string key);
    }

    private sealed class ConfigSource(IConfigurationSection section) : ISource
    {
        private IConfigurationSection Child(string key) => section.GetSection(key);

        public bool Has(string key) => Child(key).Exists();

        public string? String(string key) => Child(key).Exists() ? Child(key).Value : null;

        public bool? Bool(string key) => bool.TryParse(String(key), out var value) ? value : null;

        public int? Int(string key) => int.TryParse(String(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var value) ? value : null;

        public IReadOnlyList<string>? Strings(string key)
        {
            var child = Child(key);
            if (!child.Exists()) return null;
            var children = child.GetChildren().Select(c => c.Value).OfType<string>().ToList();
            if (children.Count > 0) return children;
            // An environment variable carries a single comma/semicolon separated value; JSON config an array.
            return (child.Value ?? "").Split([',', ';'], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        }
    }

    private sealed class JsonSource(JsonElement root) : ISource
    {
        private bool TryGet(string key, out JsonElement value)
        {
            foreach (var property in root.EnumerateObject())
            {
                if (string.Equals(property.Name, key, StringComparison.OrdinalIgnoreCase)) { value = property.Value; return true; }
            }
            value = default;
            return false;
        }

        public bool Has(string key) => TryGet(key, out _);

        public string? String(string key) => TryGet(key, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

        public bool? Bool(string key) => TryGet(key, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

        public int? Int(string key) => TryGet(key, out var v) && v.ValueKind == JsonValueKind.Number && v.TryGetInt32(out var i) ? i : null;

        public IReadOnlyList<string>? Strings(string key) =>
            TryGet(key, out var v) && v.ValueKind == JsonValueKind.Array
                ? v.EnumerateArray().Where(e => e.ValueKind == JsonValueKind.String).Select(e => e.GetString()!).ToList()
                : null;
    }
}
