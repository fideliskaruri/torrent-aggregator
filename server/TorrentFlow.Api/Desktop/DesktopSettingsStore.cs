using System.Text.Json;

namespace TorrentFlow.Api.Desktop;

public sealed record LatestRelease(string Version, string Tag, string? PageUrl, string? InstallerName, string? InstallerUrl, string? InstallerSha256, long? InstallerSize);

public sealed record DesktopSettings
{
    public bool CheckForUpdates { get; init; } = true;
    public DateTimeOffset? LastCheckedAt { get; init; }
    public string? LastCheckError { get; init; }
    public LatestRelease? Latest { get; init; }
}

/// <summary>desktop.json in the data directory: update preference and the last update check result.</summary>
public sealed class DesktopSettingsStore
{
    public const string FileName = "desktop.json";

    private static readonly JsonSerializerOptions Json = new() { WriteIndented = true, PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
    private readonly Lock _gate = new();
    private DesktopSettings _current;

    public DesktopSettingsStore(string dataDirectory, ILogger<DesktopSettingsStore>? logger = null)
    {
        FilePath = Path.Combine(dataDirectory, FileName);
        _current = Load(FilePath, logger);
    }

    public string FilePath { get; }

    public DesktopSettings Current
    {
        get { lock (_gate) return _current; }
    }

    public DesktopSettings Update(Func<DesktopSettings, DesktopSettings> change)
    {
        lock (_gate)
        {
            var next = change(_current);
            Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
            var temp = FilePath + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temp, JsonSerializer.Serialize(next, Json));
                File.Move(temp, FilePath, overwrite: true);
            }
            finally
            {
                if (File.Exists(temp)) File.Delete(temp);
            }
            _current = next;
            return next;
        }
    }

    private static DesktopSettings Load(string path, ILogger? logger)
    {
        if (!File.Exists(path)) return new DesktopSettings();
        try
        {
            return JsonSerializer.Deserialize<DesktopSettings>(File.ReadAllText(path), Json) ?? new DesktopSettings();
        }
        catch (Exception ex) when (ex is JsonException or IOException or UnauthorizedAccessException or NotSupportedException)
        {
            logger?.LogWarning("{File} could not be read and was ignored: {Message}", FileName, ex.Message);
            return new DesktopSettings();
        }
    }
}
