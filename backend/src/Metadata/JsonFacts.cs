using System.Globalization;
using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using TorrentFlow.Domain;

namespace TorrentFlow.Metadata;

internal static partial class JsonFacts
{
    internal static JsonElement Obj(this JsonElement e, string key) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(key, out var value) ? value : default;
    internal static string? Text(this JsonElement e, string key) => e.Obj(key) is var v && v.ValueKind switch
    {
        JsonValueKind.String => true, JsonValueKind.Number => true, _ => false,
    } ? v.ToString() : null;
    internal static int? Int(this JsonElement e, string key) =>
        int.TryParse(e.Text(key), NumberStyles.Integer, CultureInfo.InvariantCulture, out var n) ? n : null;
    internal static double? Number(this JsonElement e, string key) =>
        double.TryParse(e.Text(key), NumberStyles.Float, CultureInfo.InvariantCulture, out var n) ? n : null;
    internal static IEnumerable<JsonElement> Items(this JsonElement e) =>
        e.ValueKind == JsonValueKind.Array ? e.EnumerateArray() : [];
    internal static IEnumerable<string> Strings(this JsonElement e) =>
        e.Items().Where(v => v.ValueKind == JsonValueKind.String).Select(v => v.GetString()!).Where(v => !string.IsNullOrWhiteSpace(v));
    internal static DateTimeOffset? Date(string? value) =>
        DateTimeOffset.TryParse(value, CultureInfo.InvariantCulture,
            DateTimeStyles.AssumeUniversal | DateTimeStyles.AdjustToUniversal, out var at) ? at : null;
    internal static DateTimeOffset? Start(JsonElement e)
    {
        if (e.Int("year") is not { } y || e.Int("month") is not { } m || e.Int("day") is not { } d) return null;
        try { return new DateTimeOffset(y, m, d, 0, 0, 0, TimeSpan.Zero); }
        catch (ArgumentOutOfRangeException) { return null; }
    }
    internal static string Fold(string value) => new(value.Normalize(NormalizationForm.FormD)
        .Where(char.IsLetterOrDigit).Select(char.ToLowerInvariant).ToArray());
    internal static string Term(string value) => Whitespace().Replace(value.Trim(), " ");
    internal static string? Plain(string? value) => value is null ? null : WebUtility.HtmlDecode(Html().Replace(value, "")).Trim();
    internal static int? Year(string? value) => value?.Length >= 4 && int.TryParse(value[..4], out var n) ? n : null;
    internal static string Kind(WorkKind kind) => kind == WorkKind.Series ? "tv" : "movie";
    internal static string? Image(string? path, string size) => string.IsNullOrWhiteSpace(path) ? null :
        "https://image.tmdb.org/t/p/" + size + path;
    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
    [GeneratedRegex("<[^>]+>")] private static partial Regex Html();
}
