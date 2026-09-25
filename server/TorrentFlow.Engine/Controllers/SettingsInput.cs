using System.Text.Json;

namespace TorrentFlow.Engine.Controllers;

internal static class SettingsInput
{
    internal sealed record Failure(string Error, string Field);

    internal static Failure? Validate(JsonElement body)
    {
        foreach (var (name, max, nullable) in new (string, int, bool)[]
        {
            ("clientType", 0, false), ("externalClientType", 32, true), ("host", 2048, false),
            ("username", 500, true), ("password", 4096, true), ("category", 100, true),
            ("savePath", 4096, true), ("baseDownloadPath", 4096, true),
            ("testTarget", 0, false), ("defaultRetentionPolicy", 0, true),
        })
        {
            if (!body.TryGetProperty(name, out var value) || nullable && value.ValueKind == JsonValueKind.Null) continue;
            if (value.ValueKind != JsonValueKind.String) return new($"{name} must be a string", name);
            var text = name == "password" ? value.GetString()! : value.GetString()!.Trim();
            if (max > 0 && text.Length > max) return new($"{name} must be at most {max} characters", name);
            if (name is "savePath" or "baseDownloadPath" && text.Contains('\0')) return new($"{name} contains an invalid null character", name);
        }
        foreach (var (name, choices) in new (string, string[])[]
        {
            ("clientType", ["qbittorrent", "transmission", "builtin"]),
            ("testTarget", ["primary", "external"]),
            ("defaultRetentionPolicy", ["EPHEMERAL", "KEPT", "STREAM", "KEEP"]),
        })
            if (body.Str(name) is { } text && !choices.Contains(text.Trim()))
                return new($"{name} must be one of: {string.Join(", ", choices)}", name);
        if (body.Str("externalClientType") is { } ext && ext.Trim() is not ("" or "none" or "qbittorrent" or "transmission"))
            return new("Invalid externalClientType", "externalClientType");
        if (body.Str("host")?.Trim() is { Length: > 0 } host)
        {
            if (!Uri.TryCreate(host, UriKind.Absolute, out var uri)) return new("host must be a valid URL", "host");
            if (uri.Scheme is not ("http" or "https")) return new("host must use http or https", "host");
        }
        foreach (var name in new[] { "verboseDiagnostics", "test", "switchToBuiltin" })
            if (body.Has(name) && body.Bool(name) is null) return new($"{name} must be a boolean", name);
        foreach (var name in new[] { "maxStorageGb", "maxStorageBytes", "preferredResolution", "automationIntervalMinutes" })
        {
            if (!body.Has(name) || body.IsNull(name)) continue;
            if (body.Num(name) is not { } number || !double.IsFinite(number)) return new($"{name} must be a finite number", name);
            if (name != "maxStorageGb" && number != Math.Floor(number)) return new($"{name} must be an integer", name);
            if (name != "preferredResolution" && number < 0) return new($"{name} must be at least 0", name);
            var max = name == "maxStorageGb" ? 9007199.25474099 : 9007199254740991d;
            if (name.StartsWith("maxStorage", StringComparison.Ordinal) && number > max)
                return new($"{name} must be at most {max.ToString(System.Globalization.CultureInfo.InvariantCulture)}", name);
            var choices = name == "preferredResolution" ? SettingsClientController.SelectableResolutions
                : name == "automationIntervalMinutes" ? SettingsClientController.AutomationIntervals : null;
            if (choices is not null && !choices.Any(n => n == number))
                return new($"{name} must be one of: {string.Join(", ", choices)}", name);
        }
        if (body.TryGetProperty("categories", out var cats) && cats.ValueKind != JsonValueKind.Null)
        {
            if (cats.ValueKind != JsonValueKind.Array) return new("categories must be an array", "categories");
            if (cats.GetArrayLength() > 64) return new("categories may contain at most 64 items", "categories");
            var index = 0;
            foreach (var cat in cats.EnumerateArray())
            {
                if (cat.ValueKind != JsonValueKind.String) return new($"categories[{index}] must be a string", "categories");
                var text = cat.GetString()!.Trim();
                if (text.Length == 0) return new($"categories[{index}] may not be empty", "categories");
                if (text.Length > 100) return new($"categories[{index}] must be at most 100 characters", "categories");
                index++;
            }
        }
        if (body.TryGetProperty("pathRules", out var rules) && rules.ValueKind != JsonValueKind.Null)
        {
            if (rules.ValueKind != JsonValueKind.Object) return new("pathRules must be an object of string values", "pathRules");
            if (rules.EnumerateObject().Count() > 64) return new("pathRules may contain at most 64 entries", "pathRules");
            foreach (var rule in rules.EnumerateObject())
            {
                if (string.IsNullOrWhiteSpace(rule.Name) || rule.Value.ValueKind != JsonValueKind.String || string.IsNullOrWhiteSpace(rule.Value.GetString()))
                    return new("pathRules keys and values must be non-empty strings", "pathRules");
                if (rule.Name.Trim().Length > 100) return new("pathRules keys must be at most 100 characters", "pathRules");
                if (rule.Value.GetString()!.Trim().Length > 4096) return new("pathRules values must be at most 4096 characters", "pathRules");
                if (rule.Value.GetString()!.Contains('\0')) return new("pathRules contains an invalid null character", "pathRules");
            }
        }
        return null;
    }
}
