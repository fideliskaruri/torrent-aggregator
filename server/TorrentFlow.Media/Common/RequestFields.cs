using System.Text.Json;
using Microsoft.AspNetCore.Mvc;

namespace TorrentFlow.Media.Common;

/// <summary>Port of the stringField/numberField/booleanField/objectField validators in src/lib/http/request.ts.</summary>
internal static class RequestFields
{
    public static IActionResult Fail(string error, string field) => MediaJson.Error(400, new { error, field });

    public static IActionResult? String(JsonElement body, string name, out string? value, bool required = false, int? maxLength = null)
    {
        value = null;
        if (!body.TryGetProperty(name, out var raw)) return required ? Fail($"{name} is required", name) : null;
        if (raw.ValueKind != JsonValueKind.String) return Fail($"{name} must be a string", name);
        var v = raw.GetString()!.Trim();
        if (required && v.Length == 0) return Fail($"{name} is required", name);
        if (maxLength is { } max && v.Length > max) return Fail($"{name} must be at most {max} characters", name);
        value = v;
        return null;
    }

    public static IActionResult? Number(JsonElement body, string name, out double? value, bool nullable = false, bool integer = false, double? min = null, double? max = null)
    {
        value = null;
        if (!body.TryGetProperty(name, out var raw)) return null;
        if (raw.ValueKind == JsonValueKind.Null && nullable) return null;
        if (raw.ValueKind != JsonValueKind.Number || !double.IsFinite(raw.GetDouble())) return Fail($"{name} must be a finite number", name);
        var v = raw.GetDouble();
        if (integer && v != Math.Floor(v)) return Fail($"{name} must be an integer", name);
        if (min is { } lo && v < lo) return Fail($"{name} must be at least {Js(lo)}", name);
        if (max is { } hi && v > hi) return Fail($"{name} must be at most {Js(hi)}", name);
        value = v;
        return null;
    }

    public static IActionResult? Boolean(JsonElement body, string name, out bool? value)
    {
        value = null;
        if (!body.TryGetProperty(name, out var raw)) return null;
        if (raw.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) return Fail($"{name} must be a boolean", name);
        value = raw.GetBoolean();
        return null;
    }

    public static IActionResult? Object(JsonElement body, string name, out JsonElement? value)
    {
        value = null;
        if (!body.TryGetProperty(name, out var raw)) return null;
        if (raw.ValueKind != JsonValueKind.Object) return Fail($"{name} must be an object", name);
        value = raw;
        return null;
    }

    private static string Js(double d) => d.ToString(System.Globalization.CultureInfo.InvariantCulture);
}
