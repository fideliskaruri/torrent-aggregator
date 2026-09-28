using System.Text.RegularExpressions;

namespace TorrentFlow.Core.Sources;

public static class TmdbCredentials
{
    private static readonly HashSet<string> Placeholders =
    [
        "changeme", "change_me", "dummy", "example", "fake", "insert_key_here", "none", "null", "placeholder", "replace_me",
        "secret", "todo", "undefined", "your_api_key", "your_api_key_here", "your_tmdb_api_key", "yourapikeyhere",
    ];
    public static string Normalize(string? value)
    {
        var key = value?.Trim() ?? "";
        if (key.Length >= 2 && ((key[0] == '"' && key[^1] == '"') || (key[0] == '\'' && key[^1] == '\''))) key = key[1..^1].Trim();
        return key;
    }
    public static bool IsUsable(string? value)
    {
        var key = Normalize(value);
        if (key.Length < 10 || Regex.IsMatch(key, @"^(.)\1*$", RegexOptions.Singleline)
            || Placeholders.Contains(key.ToLowerInvariant())
            || Regex.IsMatch(key, @"\byour\b|\bhere\b|^<.*>$|\bkey\s*goes\b", RegexOptions.IgnoreCase))
            return false;
        // v3 keys are 32 hex chars; v4 read-access tokens are JWT-shaped (three base64url segments).
        if (Regex.IsMatch(key, @"^[0-9a-fA-F]{32}$")) return true;
        var parts = key.Split('.');
        return parts.Length == 3 && parts.All(p => p.Length >= 8 && Regex.IsMatch(p, @"^[A-Za-z0-9_-]+$"));
    }
}
