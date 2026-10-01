using System.Text.Json;

namespace TorrentFlow.Core.Contracts.Engine;

/// <summary>
/// The English check a transfer owes after it was added (docs/release-language.md), kept with its engine row as JSON:
/// the want, the release name and site category it was judged on, whether it was a hand pick, and how far the check got.
/// </summary>
/// <param name="State"><see cref="Pending"/>, <see cref="Probing"/>, <see cref="Passed"/>, <see cref="Unconfirmed"/>,
/// <see cref="Failed"/> or <see cref="HandPick"/>.</param>
/// <param name="Reason">What decided it, in plain words ("Chinese subtitles only", "timeout").</param>
public sealed record EngineLanguageState(string Preference, bool Anime, string? OriginalLanguage, string? Name, string? SourceCategory,
    bool AcceptClash, string State, string? Reason = null)
{
    /// <summary>Added before its file list was known: the file list is checked when it arrives.</summary>
    public const string Pending = "pending";
    /// <summary>The file list didn't settle it: the header probe is queued or running.</summary>
    public const string Probing = "probing";
    public const string Passed = "passed";
    /// <summary>Kept, but English could not be confirmed (the probe timed out or the header said nothing).</summary>
    public const string Unconfirmed = "unconfirmed";
    /// <summary>Stopped and blocked: no English audio or subtitles.</summary>
    public const string Failed = "failed";
    /// <summary>Picked by hand: always goes, never checked or blocked.</summary>
    public const string HandPick = "hand_pick";

    /// <summary>What the Downloads row says while English is not confirmed.</summary>
    public const string NotConfirmedNote = "English not confirmed";

    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    public LanguageWant Want => new(Preference, Anime, OriginalLanguage);

    public static EngineLanguageState For(EngineLanguageCheck check, string? name, string? sourceCategory, string state) =>
        new(check.Want.Preference, check.Want.Anime, check.Want.OriginalLanguage, name, sourceCategory, check.AcceptClash,
            check.AcceptClash ? HandPick : state);

    public static EngineLanguageState? Read(string? json)
    {
        if (string.IsNullOrWhiteSpace(json)) return null;
        try { return JsonSerializer.Deserialize<EngineLanguageState>(json, Json); }
        catch (JsonException) { return null; }
    }

    public string Write() => JsonSerializer.Serialize(this, Json);

    /// <summary>The Downloads row's note: <see cref="NotConfirmedNote"/> while unconfirmed, else null.</summary>
    public static string? Note(string? json) => json != null && json.Contains("\"unconfirmed\"", StringComparison.Ordinal) &&
        Read(json) is { State: Unconfirmed } ? NotConfirmedNote : null;
}
