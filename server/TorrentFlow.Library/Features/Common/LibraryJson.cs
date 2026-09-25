using System.Globalization;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.Mvc.Filters;

namespace TorrentFlow.Library.Features.Common;

internal static class LibraryJson
{
    public static Dictionary<string, object?> Object(params (string Key, object? Value)[] fields) =>
        fields.ToDictionary(x => x.Key, x => x.Value);

    // Prisma exposes scalar columns, including explicit nulls, but not navigation properties.
    public static Dictionary<string, object?> Row<T>(T row) where T : class =>
        typeof(T).GetProperties().Where(p => p.PropertyType == typeof(string) ||
            p.PropertyType.IsValueType).ToDictionary(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name),
                p => p.GetValue(row));

    public static string Iso(DateTime value) => value.ToUniversalTime().ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);

    public static string? Hash(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        raw = raw.Trim();
        if (raw.StartsWith("magnet:", StringComparison.OrdinalIgnoreCase))
            raw = Uri.UnescapeDataString(Regex.Match(raw, @"(?:\?|&)xt=urn:btih:([^&]+)", RegexOptions.IgnoreCase).Groups[1].Value);
        if (Regex.IsMatch(raw, "^[a-fA-F0-9]{40}$")) return raw.ToLowerInvariant();
        if (!Regex.IsMatch(raw, "^[A-Z2-7]{32}$", RegexOptions.IgnoreCase)) return null;
        var bytes = new List<byte>();
        var bits = 0;
        var buffer = 0;
        foreach (var c in raw.ToUpperInvariant())
        {
            buffer = (buffer << 5) | "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".IndexOf(c);
            bits += 5;
            if (bits < 8) continue;
            bits -= 8;
            bytes.Add((byte)(buffer >> bits));
        }
        return Convert.ToHexStringLower(bytes.ToArray());
    }
}

internal sealed class LibraryRequestException(int status, string message, string? field = null) : Exception(message)
{
    public int Status { get; } = status;
    public string? Field { get; } = field;
}

public sealed class LibraryExceptionFilter : IExceptionFilter
{
    public void OnException(ExceptionContext context)
    {
        if (context.Exception is not LibraryRequestException error) return;
        var body = LibraryJson.Object(("error", error.Message));
        if (error.Field != null) body["field"] = error.Field;
        context.Result = new ObjectResult(body) { StatusCode = error.Status };
        context.ExceptionHandled = true;
    }
}

internal sealed class Fields(JsonElement body)
{
    public bool Has(string key) => body.TryGetProperty(key, out _);
    public JsonElement Raw(string key) => body.TryGetProperty(key, out var value) ? value : default;
    public string? String(string key, bool required = false, int max = 500, bool nullable = false)
    {
        var value = Raw(key);
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            if (required) Fail($"{key} is required", key);
            return null;
        }
        if (value.ValueKind == JsonValueKind.Null && nullable) return null;
        if (value.ValueKind != JsonValueKind.String) Fail($"{key} must be a string", key);
        var text = value.GetString()!.Trim();
        if (required && text.Length == 0) Fail($"{key} is required", key);
        if (text.Length > max) Fail($"{key} must be at most {max} characters", key);
        return text;
    }
    public double? Number(string key, bool required = false, double min = 0, double max = 1e9, bool integer = false, bool nullable = false)
    {
        var value = Raw(key);
        if (value.ValueKind == JsonValueKind.Undefined)
        {
            if (required) Fail($"{key} is required", key);
            return null;
        }
        if (value.ValueKind == JsonValueKind.Null && nullable) return null;
        if (value.ValueKind != JsonValueKind.Number || !value.TryGetDouble(out var number) || !double.IsFinite(number))
            throw new LibraryRequestException(400, $"{key} must be a finite number", key);
        if (integer && number != Math.Truncate(number)) Fail($"{key} must be an integer", key);
        if (number < min) Fail($"{key} must be at least {min.ToString(CultureInfo.InvariantCulture)}", key);
        if (number > max) Fail($"{key} must be at most {max.ToString(CultureInfo.InvariantCulture)}", key);
        return number;
    }
    public int? Int(string key, int max = 100000, bool required = false) =>
        (int?)Number(key, required, 1, max, true, true);
    public bool? Bool(string key)
    {
        var value = Raw(key);
        if (value.ValueKind == JsonValueKind.Undefined) return null;
        if (value.ValueKind is not (JsonValueKind.True or JsonValueKind.False)) Fail($"{key} must be a boolean", key);
        return value.GetBoolean();
    }
    public string? Enum(string key, string[] values, bool required = false, bool nullable = false)
    {
        var value = String(key, required, nullable: nullable);
        if (value != null && !values.Contains(value)) Fail($"{key} must be one of {string.Join(", ", values)}", key);
        return value;
    }
    public static void Fail(string message, string? field = null) => throw new LibraryRequestException(400, message, field);
    public static void Guard(HttpRequest request)
    {
        var site = request.Headers["Sec-Fetch-Site"].ToString().ToLowerInvariant();
        if (site is "" or "none" or "same-origin") return;
        if (site == "same-site" && request.Headers.Origin == $"{request.Scheme}://{request.Host}") return;
        throw new LibraryRequestException(403, site == "cross-site" ? "Cross-site browser requests are not allowed" :
            site == "same-site" ? "Browser request origin does not match this application" : "Unrecognised browser request origin");
    }
    public static async Task<Fields> Read(HttpRequest request, CancellationToken ct)
    {
        Guard(request);
        if (request.ContentType?.Contains("json", StringComparison.OrdinalIgnoreCase) != true)
            throw new LibraryRequestException(415, "Content-Type must be application/json");
        const int limit = 65536;
        if (request.ContentLength > limit) throw new LibraryRequestException(413, $"JSON body exceeds the {limit}-byte limit");
        using var output = new MemoryStream();
        var buffer = new byte[8192];
        int count;
        while ((count = await request.Body.ReadAsync(buffer, ct)) > 0)
        {
            if (output.Length + count > limit) throw new LibraryRequestException(413, $"JSON body exceeds the {limit}-byte limit");
            output.Write(buffer, 0, count);
        }
        if (output.Length == 0) throw new LibraryRequestException(400, "JSON body is required");
        try
        {
            using var doc = JsonDocument.Parse(output.ToArray());
            if (doc.RootElement.ValueKind != JsonValueKind.Object) throw new LibraryRequestException(400, "JSON body must be an object");
            return new Fields(doc.RootElement.Clone());
        }
        catch (JsonException) { throw new LibraryRequestException(400, "Request body is not valid JSON"); }
    }
}
