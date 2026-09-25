using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using TorrentFlow.Metadata.Artwork;

namespace TorrentFlow.Metadata.Controllers;

[ApiController]
public sealed class ArtworkController(ArtworkResolver resolver) : ControllerBase
{
    private const int MaxItems = 60;

    /// <summary>POST /api/artwork {items:[{title,year,mediaType}]} → {artwork:{[title-slug:year]:{posterUrl,backdropUrl}}}.</summary>
    [HttpPost("/api/artwork")]
    public async Task<IActionResult> Post()
    {
        var empty = new { artwork = new Dictionary<string, ArtworkResult>() };
        JsonElement body;
        try
        {
            body = await JsonSerializer.DeserializeAsync<JsonElement>(Request.Body, cancellationToken: HttpContext.RequestAborted);
        }
        catch (JsonException)
        {
            return Ok(empty);
        }

        IEnumerable<JsonElement> items = body.ValueKind == JsonValueKind.Object && body.TryGetProperty("items", out var arr) && arr.ValueKind == JsonValueKind.Array
            ? arr.EnumerateArray()
            : [];
        var queries = items
            .Select(item => new ArtworkQuery(
                item.ValueKind == JsonValueKind.Object && item.TryGetProperty("title", out var t) && t.ValueKind == JsonValueKind.String ? t.GetString()!.Trim() : "",
                item.ValueKind == JsonValueKind.Object && item.TryGetProperty("year", out var y) ? AsYear(y) : null,
                item.ValueKind == JsonValueKind.Object && item.TryGetProperty("mediaType", out var m) && m.ValueKind == JsonValueKind.String &&
                m.GetString() is "movie" or "tv" or "anime" ? m.GetString() : null))
            .Where(q => q.Title.Length > 0)
            .Take(MaxItems)
            .ToList();
        if (queries.Count == 0) return Ok(empty);

        var resolved = await resolver.ResolveBatchAsync(queries, HttpContext.RequestAborted);
        var artwork = new Dictionary<string, ArtworkResult>(StringComparer.Ordinal);
        for (var i = 0; i < queries.Count; i++)
            artwork[ArtworkMatching.ArtworkKey(queries[i].Title, queries[i].Year)] = i < resolved.Count ? resolved[i] : ArtworkResult.None;
        return Ok(new { artwork });
    }

    /// <summary>JS: Number(value), integer, 1800 &lt; y &lt; 2200.</summary>
    internal static int? AsYear(JsonElement value)
    {
        double n;
        switch (value.ValueKind)
        {
            case JsonValueKind.Number: n = value.GetDouble(); break;
            case JsonValueKind.String:
                var s = value.GetString()!.Trim();
                if (s.Length == 0) n = 0;
                else if (!double.TryParse(s, NumberStyles.Float, CultureInfo.InvariantCulture, out n)) return null;
                break;
            case JsonValueKind.True: n = 1; break;
            case JsonValueKind.False or JsonValueKind.Null: n = 0; break;
            default: return null;
        }
        return n == Math.Floor(n) && n > 1800 && n < 2200 ? (int)n : null;
    }
}
