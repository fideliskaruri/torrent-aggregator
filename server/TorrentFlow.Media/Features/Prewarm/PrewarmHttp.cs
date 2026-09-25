using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Media.Features.Prewarm;

/// <summary>Request helpers mirroring the Next.js route semantics (JS coercion, browser-origin guard, safe errors).</summary>
internal static partial class PrewarmHttp
{
    public static JsonResult Json(object body, int status = 200) => new(body, PrewarmJson.Options) { StatusCode = status };

    public static string Iso(DateTime value) =>
        DateTime.SpecifyKind(value, DateTimeKind.Utc).ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    /// <summary>guardBrowserMutation (src/lib/http/request.ts): null = allowed, else the 403 message.</summary>
    public static string? BrowserMutationRefusal(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString().ToLowerInvariant();
        if (site.Length == 0 || site == "none" || site == "same-origin") return null;
        if (site == "cross-site") return "Cross-site browser requests are not allowed";
        if (site == "same-site")
        {
            var origin = request.Headers.Origin.ToString();
            var self = $"{request.Scheme}://{request.Host.Value}";
            return origin.Length > 0 && string.Equals(origin, self, StringComparison.OrdinalIgnoreCase) ? null : "Browser request origin does not match this application";
        }
        return "Unrecognised browser request origin";
    }

    /// <summary>Parse the request body as JSON; null when it is not valid JSON (the routes answer 400 "Invalid JSON").</summary>
    public static async Task<JsonElement?> ReadJsonAsync(HttpRequest request, CancellationToken ct)
    {
        try
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, cancellationToken: ct);
            return doc.RootElement.Clone();
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static JsonElement? Prop(JsonElement obj, string name) =>
        obj.ValueKind == JsonValueKind.Object && obj.TryGetProperty(name, out var v) ? v : null;

    public static string? Str(JsonElement obj, string name) => Prop(obj, name) is { ValueKind: JsonValueKind.String } v ? v.GetString() : null;

    /// <summary>A JSON number, or null for anything else (TypeScript <c>typeof x === "number"</c>).</summary>
    public static double? Num(JsonElement obj, string name) => Prop(obj, name) is { ValueKind: JsonValueKind.Number } v ? v.GetDouble() : null;

    /// <summary>JavaScript <c>Number(x)</c>: missing → NaN, null → 0, booleans → 0/1, numeric strings parse.</summary>
    public static double JsNumber(JsonElement obj, string name)
    {
        if (Prop(obj, name) is not { } v) return double.NaN;
        return v.ValueKind switch
        {
            JsonValueKind.Number => v.GetDouble(),
            JsonValueKind.Null => 0,
            JsonValueKind.True => 1,
            JsonValueKind.False => 0,
            JsonValueKind.String => v.GetString()!.Trim() is var s && s.Length == 0 ? 0
                : double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : double.NaN,
            _ => double.NaN,
        };
    }

    /// <summary>JavaScript truthiness of a property.</summary>
    public static bool Truthy(JsonElement obj, string name) => Prop(obj, name) is { } v && v.ValueKind switch
    {
        JsonValueKind.True => true,
        JsonValueKind.String => v.GetString()!.Length > 0,
        JsonValueKind.Number => v.GetDouble() is var d && d != 0 && !double.IsNaN(d),
        JsonValueKind.Object or JsonValueKind.Array => true,
        _ => false,
    };

    public sealed record SafeError(string Code, string Message);

    [GeneratedRegex(@"\b(401|403|unauthori[sz]ed|authentication|login failed)\b")] private static partial Regex Auth();
    [GeneratedRegex(@"\b(prisma|sqlite|database|sql_|p1001|p1008)\b")] private static partial Regex Db();
    [GeneratedRegex(@"\b(timeout|timed out|etimedout|aborterror)\b")] private static partial Regex Timeout();
    [GeneratedRegex(@"\b(econnrefused|econnreset|enotfound|enetunreach|ehostunreach|fetch failed|networkerror|unreachable|not listening|cannot reach)\b")] private static partial Regex Net();
    [GeneratedRegex(@"\b(enoent|not found|missing)\b")] private static partial Regex NotFound();
    [GeneratedRegex(@"\b(syntaxerror|invalid|malformed|validation)\b")] private static partial Regex Input();

    /// <summary>normalizeError (src/lib/observability/logging.ts): a stable, non-leaky code + message.</summary>
    public static SafeError Normalize(Exception? error)
    {
        var text = error == null ? "" : $"{error.GetType().Name} {error.Message} {error.InnerException?.Message}".ToLowerInvariant();
        if (error is OperationCanceledException or TimeoutException) text += " timeout";
        if (text.Length > 2000) text = text[..2000];
        if (Auth().IsMatch(text)) return new("AUTHENTICATION_FAILED", "Authentication failed.");
        if (Db().IsMatch(text)) return new("DATABASE_UNAVAILABLE", "The database is unavailable.");
        if (Timeout().IsMatch(text)) return new("OPERATION_TIMEOUT", "The operation timed out.");
        if (Net().IsMatch(text)) return new("UPSTREAM_UNAVAILABLE", "A required service is unavailable.");
        if (NotFound().IsMatch(text)) return new("NOT_FOUND", "The requested resource was not found.");
        if (Input().IsMatch(text)) return new("INVALID_INPUT", "The request could not be processed.");
        return new("INTERNAL_ERROR", "The operation could not be completed.");
    }
}
