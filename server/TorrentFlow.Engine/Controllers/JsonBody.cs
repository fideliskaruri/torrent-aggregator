using System.Text.Json;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Engine.Controllers;

/// <summary>Reads JSON bodies by hand so validation messages match the Next.js routes exactly.</summary>
internal static class JsonBody
{
    public static async Task<JsonElement?> ReadAsync(HttpRequest request, CancellationToken ct)
    {
        try
        {
            using var doc = await JsonDocument.ParseAsync(request.Body, default, ct);
            return doc.RootElement.ValueKind == JsonValueKind.Object ? doc.RootElement.Clone() : null;
        }
        catch (JsonException)
        {
            return null;
        }
    }

    public static IActionResult InvalidJson() => new BadRequestObjectResult(new { error = "Invalid JSON body" });

    public static bool Has(this JsonElement e, string name) => e.TryGetProperty(name, out _);

    public static string? Str(this JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    public static bool IsNull(this JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Null;

    public static bool? Bool(this JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind is JsonValueKind.True or JsonValueKind.False ? v.GetBoolean() : null;

    public static double? Num(this JsonElement e, string name) =>
        e.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? v.GetDouble() : null;

    public static bool IsKind(this JsonElement e, string name, params JsonValueKind[] kinds) =>
        !e.TryGetProperty(name, out var v) || kinds.Contains(v.ValueKind);
}
