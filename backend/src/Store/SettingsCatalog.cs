using System.Collections.Immutable;
using System.Text.Json;
using TorrentFlow.Domain;

namespace TorrentFlow.Store;

public static class SettingsCatalog
{
    private static readonly IReadOnlyDictionary<string, Type> Types = new Dictionary<string, Type>
    {
        ["engine"] = typeof(EngineSettings), ["sources"] = typeof(ImmutableArray<SourceSettings>),
        ["metadata"] = typeof(MetadataSettings), ["remoteAccess"] = typeof(RemoteAccessSettings),
        ["desktop"] = typeof(DesktopSettings), ["quality"] = typeof(QualitySettings),
        ["requests"] = typeof(RequestSettings), ["scheduler"] = typeof(SchedulerSettings),
        ["jellyfin"] = typeof(JellyfinSettings),
        ["recovery"] = typeof(RecoverySettings),
    };

    public static T Read<T>(SettingRow row)
    {
        Validate(row);
        if (Types[row.Id] != typeof(T)) throw new ArgumentException($"Section '{row.Id}' does not contain {typeof(T).Name}.");
        return row.Value.Deserialize<T>(StoreJson.Options)!;
    }

    internal static void Validate(SettingRow row)
    {
        if (row.SchemaVersion != 1 || !Types.TryGetValue(row.Id, out var type))
            throw new ArgumentException("Unknown settings section or schema version.");
        var value = row.Value.Deserialize(type, StoreJson.Options) ?? throw new ArgumentException("Settings must not be null.");
        if (value is ImmutableArray<SourceSettings> sources && sources.IsDefault)
            throw new ArgumentException("Sources must be an array.");
        ValidateSecrets(value);
    }

    private static void ValidateSecrets(object value)
    {
        var references = value switch
        {
            MetadataSettings metadata => new[] { metadata.TmdbCredential },
            JellyfinSettings jellyfin => new[] { jellyfin.Credential },
            EngineSettings engine => new[] { engine.ExternalClient?.Password },
            ImmutableArray<SourceSettings> sources => sources.Select(s => s.Credential),
            _ => [],
        };
        foreach (var reference in references.OfType<SecretReference>())
            if (reference.Revision < 1 || string.IsNullOrWhiteSpace(reference.FileId)
                || reference.FileId.Any(c => !char.IsAsciiLetterOrDigit(c) && c is not '-' and not '_'))
                throw new ArgumentException("Secrets must be opaque protected-file references.");
    }

    internal static SettingRow[] Defaults(SecretReference? tmdb, bool schedulerDisabled)
    {
        var now = DateTimeOffset.UtcNow;
        return
        [
            Row("engine", new EngineSettings(0, 4, 400, 120, 40, 12, 32 * 1024 * 1024, 40,
                true, true, true, true, ProbeScope.Off, [], TimeZoneInfo.Local.Id,
                20, 256 * 1024, 64 * 1024, 180, 600, 1024 * 1024, [], false, null)),
            Row("sources", SourceDefaults()),
            Row("metadata", new MetadataSettings(tmdb,
                "https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json",
                ["tmdb", "anilist", "cinemeta", "itunes", "tvmaze"])),
            Row("remoteAccess", new RemoteAccessSettings(false, 3939, null, null, [], true)),
            Row("desktop", new DesktopSettings(false, true, null, null)),
            Row("quality", new QualitySettings(1080, "en", null)),
            Row("requests", new RequestSettings(AutoApproveMode.None, 100)),
            Row("scheduler", new SchedulerSettings(!schedulerDisabled, 1, 8, 2, 8, 10, 2)),
            Row("jellyfin", new JellyfinSettings(null, null, null)),
            Row("recovery", new RecoverySettings()),
        ];

        SettingRow Row<T>(string section, T value) =>
            new() { Id = section, SchemaVersion = 1, Value = JsonSerializer.SerializeToElement(value, StoreJson.Options), Revision = 1, UpdatedAt = now };
    }

    private static ImmutableArray<SourceSettings> SourceDefaults()
    {
        var definitions = new (string Id, SourceTier Tier, string[] Categories, int Concurrency, int Spacing)[]
        {
            ("apibay", SourceTier.Core, ["all"], 2, 2000),
            ("nyaa", SourceTier.Core, ["anime"], 2, 1000),
            ("eztv", SourceTier.Core, ["series"], 2, 250),
            ("yts", SourceTier.Core, ["films"], 2, 250),
            ("torrentscsv", SourceTier.Core, ["all"], 2, 250),
            ("knaben", SourceTier.Core, ["all"], 2, 250),
            ("animetosho", SourceTier.Core, ["anime"], 2, 250),
            ("therarbg", SourceTier.Fallback, ["all"], 2, 250),
            ("bitsearch", SourceTier.Fallback, ["all"], 1, 1000),
            ("limetorrents", SourceTier.Fallback, ["all"], 2, 250),
            ("torrentdownloads", SourceTier.Fallback, ["all"], 2, 250),
            ("torrentdownloadinfo", SourceTier.Fallback, ["all"], 2, 250),
            ("1337x", SourceTier.OptIn, ["all"], 1, 1000),
            ("subsplease", SourceTier.OptIn, ["anime"], 1, 1000),
            ("archive", SourceTier.OptIn, ["all"], 2, 250),
            ("torznab", SourceTier.OptIn, ["all"], 2, 250),
        };
        return definitions.Select((s, priority) => new SourceSettings(s.Id, s.Tier != SourceTier.OptIn,
            s.Tier, priority, "public", s.Id, null, [], [.. s.Categories], 6000, s.Concurrency, s.Spacing,
            ImmutableDictionary<string, string>.Empty, null)).ToImmutableArray();
    }
}
