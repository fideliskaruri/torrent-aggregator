namespace TorrentFlow.Metadata;

public static class TmdbCredentialSettings
{
    public static string Normalize(string? value)
    {
        var key = value?.Trim() ?? "";
        if (key.Length >= 2 && (key[0] == '"' && key[^1] == '"' || key[0] == '\'' && key[^1] == '\''))
            key = key[1..^1].Trim();
        return key;
    }

    public static bool Accepts(string? value)
    {
        if (value is null || value.Length > 4096 || value.Any(char.IsControl)) return false;
        var key = Normalize(value);
        if (key.Length < 10 || key.All(c => c == key[0])) return false;
        if (key.Length == 32 && key.All(char.IsAsciiHexDigit)) return true;
        var parts = key.Split('.');
        return parts.Length == 3 && parts.All(part => part.Length >= 8 &&
            part.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_'));
    }
}
