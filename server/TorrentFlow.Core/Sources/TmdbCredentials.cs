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
        return key.Length >= 10 && !Regex.IsMatch(key, @"^(.)\1*$", RegexOptions.Singleline) &&
            !Placeholders.Contains(key.ToLowerInvariant()) &&
            !Regex.IsMatch(key, @"\byour\b|\bhere\b|^<.*>$|\bkey\s*goes\b", RegexOptions.IgnoreCase);
    }
}
