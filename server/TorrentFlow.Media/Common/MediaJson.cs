using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Media.Common;

/// <summary>JSON body helpers matching the Next.js route messages exactly.</summary>
internal static partial class MediaJson
{
    public const int MaxMutationBytes = 65536;

    public static IActionResult Error(int status, object body) => new ObjectResult(body) { StatusCode = status };

    /// <summary>Plain <c>await request.json()</c>: null on any parse failure; non-objects are returned as-is.</summary>
    public static async Task<JsonElement?> ReadAnyAsync(HttpRequest request, CancellationToken ct)
    {
        try
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, default, ct);
            return doc.RootElement.Clone();
        }
        catch (JsonException) { return null; }
    }

    /// <summary>
    /// Port of readMutationObject (src/lib/http/request.ts): browser-origin guard, JSON content type, 64 KiB cap,
    /// object body. Returns either the object or a ready error result.
    /// </summary>
    public static async Task<(JsonElement? Body, IActionResult? Failure)> ReadMutationObjectAsync(HttpRequest request, CancellationToken ct)
    {
        if (GuardBrowserMutation(request) is { } guard) return (null, guard);
        var contentType = request.ContentType ?? "";
        if (!JsonContentTypeRe().IsMatch(contentType.ToLowerInvariant()))
            return (null, Error(415, new { error = "Content-Type must be application/json" }));
        if (request.ContentLength is > MaxMutationBytes)
            return (null, Error(413, new { error = $"JSON body exceeds the {MaxMutationBytes}-byte limit" }));
        string text;
        try
        {
            using var reader = new StreamReader(request.Body, Encoding.UTF8);
            text = await reader.ReadToEndAsync(ct);
        }
        catch (IOException) { return (null, Error(400, new { error = "Could not read request body" })); }
        if (Encoding.UTF8.GetByteCount(text) > MaxMutationBytes)
            return (null, Error(413, new { error = $"JSON body exceeds the {MaxMutationBytes}-byte limit" }));
        if (string.IsNullOrWhiteSpace(text)) return (null, Error(400, new { error = "JSON body is required" }));
        JsonElement root;
        try
        {
            using var doc = JsonDocument.Parse(text);
            root = doc.RootElement.Clone();
        }
        catch (JsonException) { return (null, Error(400, new { error = "Request body is not valid JSON" })); }
        if (root.ValueKind != JsonValueKind.Object) return (null, Error(400, new { error = "JSON body must be an object" }));
        return (root, null);
    }

    public static IActionResult? GuardBrowserMutation(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString();
        if (string.IsNullOrEmpty(site) || site == "none" || site == "same-origin") return null;
        if (site == "cross-site") return Error(403, new { error = "Cross-site browser requests are not allowed" });
        if (site == "same-site")
        {
            var origin = request.Headers.Origin.ToString();
            var own = $"{request.Scheme}://{request.Host}";
            return string.Equals(origin, own, StringComparison.OrdinalIgnoreCase)
                ? null
                : Error(403, new { error = "Browser request origin does not match this application" });
        }
        return Error(403, new { error = "Unrecognised browser request origin" });
    }

    public static string? Str(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static bool Has(this JsonElement e, string name) => e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out _);

    public static bool? Bool(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    public static double? Num(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    public static JsonElement? Obj(this JsonElement e, string name) =>
        e.ValueKind == JsonValueKind.Object && e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Object ? v : null;

    /// <summary>JS truthiness for a property.</summary>
    public static bool Truthy(this JsonElement e, string name)
    {
        if (e.ValueKind != JsonValueKind.Object || !e.TryGetProperty(name, out var v)) return false;
        return v.ValueKind switch
        {
            JsonValueKind.True => true,
            JsonValueKind.String => v.GetString()!.Length > 0,
            JsonValueKind.Number => v.GetDouble() != 0,
            JsonValueKind.Object or JsonValueKind.Array => true,
            _ => false,
        };
    }

    /// <summary>The TS <c>num(v)</c> helper: finite number ≥ 1, truncated; else null.</summary>
    public static int? PositiveInt(this JsonElement e, string name) =>
        e.Num(name) is { } d && double.IsFinite(d) && d >= 1 ? (int)Math.Truncate(d) : null;

    [GeneratedRegex(@"(?:^|/)(?:json|[^;+]+\+json)(?:;|$)")] private static partial Regex JsonContentTypeRe();
}
