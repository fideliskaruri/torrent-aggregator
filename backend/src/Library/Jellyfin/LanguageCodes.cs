using System.Globalization;

namespace TorrentFlow.Library.Jellyfin;

public static class LanguageCodes
{
    private static readonly Dictionary<string, string> Codes = BuildCodes();
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["ger"] = "de", ["fre"] = "fr", ["dut"] = "nl", ["chi"] = "zh",
        ["cze"] = "cs", ["gre"] = "el", ["per"] = "fa", ["rum"] = "ro",
        ["slo"] = "sk", ["wel"] = "cy", ["alb"] = "sq", ["arm"] = "hy",
        ["baq"] = "eu", ["bur"] = "my", ["ice"] = "is", ["mac"] = "mk",
        ["mao"] = "mi", ["may"] = "ms", ["tib"] = "bo",
    };
    private static readonly Dictionary<string, string> SubtitleAliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["fra"] = "fre", ["deu"] = "ger", ["nld"] = "dut", ["zho"] = "chi",
        ["ces"] = "cze", ["ell"] = "gre", ["fas"] = "per", ["ron"] = "rum",
        ["slk"] = "slo", ["cym"] = "wel", ["sqi"] = "alb", ["hye"] = "arm",
        ["eus"] = "baq", ["mya"] = "bur", ["isl"] = "ice", ["mkd"] = "mac",
        ["mri"] = "mao", ["msa"] = "may", ["bod"] = "tib",
    };

    public static string? Normalize(string? language)
    {
        if (string.IsNullOrWhiteSpace(language)) return null;
        var value = language.Trim().Replace('_', '-');
        if (value.Length == 0) return null;
        if (value.Contains('(')) value = value[..value.IndexOf('(')].Trim();
        if (value.Length == 0) return null;

        var key = value.ToLowerInvariant();
        if (key is "und" or "mis" or "mul" or "zxx" || key.StartsWith("qaa", StringComparison.Ordinal))
            return null;
        if (Aliases.TryGetValue(key, out var alias)) return alias;
        if (Codes.TryGetValue(key, out var code)) return code;
        var baseLanguage = key.Split('-', 2)[0];
        if (baseLanguage is "und" or "mis" or "mul" or "zxx" || baseLanguage.StartsWith("qaa", StringComparison.Ordinal))
            return null;
        if (Aliases.TryGetValue(baseLanguage, out alias)) return alias;
        return Codes.TryGetValue(baseLanguage, out code) ? code : null;
    }

    public static string? ToThreeLetter(string? language)
    {
        var normalized = Normalize(language);
        if (normalized is null) return null;
        try
        {
            var threeLetter = CultureInfo.GetCultureInfo(normalized).ThreeLetterISOLanguageName.ToLowerInvariant();
            return SubtitleAliases.GetValueOrDefault(threeLetter, threeLetter);
        }
        catch (CultureNotFoundException) { return null; }
    }

    private static Dictionary<string, string> BuildCodes()
    {
        var codes = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (var culture in CultureInfo.GetCultures(CultureTypes.NeutralCultures))
        {
            var twoLetter = culture.TwoLetterISOLanguageName;
            if (string.IsNullOrWhiteSpace(twoLetter) || twoLetter.Equals("iv", StringComparison.OrdinalIgnoreCase))
                continue;
            Add(culture.Name, twoLetter);
            Add(culture.TwoLetterISOLanguageName, twoLetter);
            Add(culture.ThreeLetterISOLanguageName, twoLetter);
            Add(culture.EnglishName, twoLetter);
        }
        return codes;

        void Add(string key, string code)
        {
            if (!string.IsNullOrWhiteSpace(key)) codes.TryAdd(key.Trim(), code.ToLowerInvariant());
        }
    }
}
