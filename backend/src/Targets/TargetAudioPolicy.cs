using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Targets;

public static class TargetAudioPolicy
{
    public static async Task<string> ResolveAsync(IStore store, WorkRow work,
        WorkPreferenceRow? preference, CancellationToken ct)
    {
        var configured = preference?.AudioLanguage;
        if (string.IsNullOrWhiteSpace(configured))
        {
            var row = (await store.ReadAsync<SettingRow>(CatalogState.Query("quality"), ct)).SingleOrDefault();
            configured = row is null ? "auto" : SettingsCatalog.Read<QualitySettings>(row).AudioLanguage;
        }
        return configured?.Trim().ToLowerInvariant() switch
        {
            null or "" or "auto" => work.Anime == true ? "ja" : "en",
            "english" => "en",
            "japanese" => "ja",
            var language => language,
        };
    }
}
