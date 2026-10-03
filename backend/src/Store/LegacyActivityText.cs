using System.Text.Json;

namespace TorrentFlow.Store;

public static class LegacyActivityText
{
    public static string? Field(JsonElement? payload, string key)
    {
        if (payload is not { ValueKind: JsonValueKind.Object } value) return null;
        foreach (var field in value.EnumerateObject())
            if (field.Name.Equals(key, StringComparison.OrdinalIgnoreCase) &&
                field.Value.ValueKind == JsonValueKind.String &&
                field.Value.GetString() is { Length: > 0 } text &&
                !text.TrimStart().StartsWith('{') && !text.TrimStart().StartsWith('['))
                return text;
        return null;
    }

    public static string Read(string? text, string? outcome)
    {
        if (!string.IsNullOrWhiteSpace(text))
        {
            if (!text.TrimStart().StartsWith('{') && !text.TrimStart().StartsWith('[')) return text;
            try
            {
                using var payload = JsonDocument.Parse(text);
                if (payload.RootElement.ValueKind == JsonValueKind.Object)
                    foreach (var key in new[] { "message", "error", "reasonText" })
                        foreach (var field in payload.RootElement.EnumerateObject())
                            if (field.Name.Equals(key, StringComparison.OrdinalIgnoreCase) &&
                                field.Value.ValueKind == JsonValueKind.String &&
                                field.Value.GetString() is { Length: > 0 } message &&
                                !message.TrimStart().StartsWith('{') && !message.TrimStart().StartsWith('['))
                                return message;
            }
            catch (JsonException) { }
        }
        return outcome?.ToLowerInvariant() switch
        {
            "sent" or "fetching" or "added" or "accepted" => "Download started.",
            "done" or "filed" or "completed" => "Download ready.",
            "failed" or "error" or "exhausted" => "The download failed. Try again or choose another release.",
            "searching" => "Looking for a release.",
            "paused" => "Download paused.",
            "skipped" => "No new download was needed.",
            "queued" => "Download queued.",
            _ => "Release checked.",
        };
    }
}
