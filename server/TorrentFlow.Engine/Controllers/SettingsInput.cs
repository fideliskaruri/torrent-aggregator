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
        if (body.Has("maxActiveDownloads") && !body.IsNull("maxActiveDownloads")
            && (body.Num("maxActiveDownloads") is not { } cap || cap != Math.Floor(cap)
                || cap < Queue.DownloadLimits.MinActiveDownloads || cap > Queue.DownloadLimits.MaxActiveDownloads))
            return new($"maxActiveDownloads must be a whole number from {Queue.DownloadLimits.MinActiveDownloads} to {Queue.DownloadLimits.MaxActiveDownloads}", "maxActiveDownloads");
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
        if (body.TryGetProperty("downloadWindows", out var windows) && windows.ValueKind != JsonValueKind.Null
            && ParseWindows(windows, out _) is { } windowError)
            return new(windowError, "downloadWindows");
        return null;
    }

    /// <summary>
    /// Strictly reads the settings API's download-window array: whole numbers only, known fields only, at most
    /// <see cref="Queue.DownloadWindows.MaxWindows"/> rules. Returns the error text, or null with the parsed rules.
    /// </summary>
    internal static string? ParseWindows(JsonElement value, out List<Queue.DownloadWindow> parsed)
    {
        parsed = [];
        if (value.ValueKind != JsonValueKind.Array) return "downloadWindows must be an array";
        if (value.GetArrayLength() > Queue.DownloadWindows.MaxWindows)
            return $"downloadWindows may contain at most {Queue.DownloadWindows.MaxWindows} rules";
        string[] known = ["days", "startHour", "endHour", "maxActiveDownloads", "maxDownloadRate", "maxUploadRate"];
        var index = 0;
        foreach (var item in value.EnumerateArray())
        {
            var at = $"downloadWindows[{index++}]";
            if (item.ValueKind != JsonValueKind.Object) return $"{at} must be an object";
            foreach (var p in item.EnumerateObject())
                if (!known.Contains(p.Name)) return $"{at} has an unknown field {p.Name}";
            if (!item.TryGetProperty("days", out var days) || days.ValueKind != JsonValueKind.Array)
                return $"{at}.days must be an array of weekdays";
            var dayList = new List<int>();
            foreach (var d in days.EnumerateArray())
            {
                if (d.ValueKind != JsonValueKind.Number || !d.TryGetInt32(out var day)) return $"{at}.days must hold whole numbers 0 to 6";
                dayList.Add(day);
            }
            static string? Whole(JsonElement o, string name, bool required, out long? number)
            {
                number = null;
                if (!o.TryGetProperty(name, out var v) || v.ValueKind == JsonValueKind.Null) return required ? $"{name} is required" : null;
                if (v.ValueKind != JsonValueKind.Number || !v.TryGetInt64(out var n)) return $"{name} must be a whole number";
                number = n;
                return null;
            }
            long? start = null, end = null, cap = null, down = null, up = null;
            var fieldError = Whole(item, "startHour", true, out start) ?? Whole(item, "endHour", true, out end)
                ?? Whole(item, "maxActiveDownloads", false, out cap) ?? Whole(item, "maxDownloadRate", false, out down)
                ?? Whole(item, "maxUploadRate", false, out up);
            if (fieldError is not null) return $"{at}.{fieldError}";
            if (start is < int.MinValue or > int.MaxValue || end is < int.MinValue or > int.MaxValue || cap is < int.MinValue or > int.MaxValue)
                return $"{at} has an out-of-range hour or downloads-at-once";
            var window = new Queue.DownloadWindow(dayList, (int)start!.Value, (int)end!.Value, (int?)cap, down, up);
            if (Queue.DownloadWindows.Validate(window) is { } invalid) return $"{at}: {invalid}";
            parsed.Add(Queue.DownloadWindows.Normalize(window));
        }
        return null;
    }
}
