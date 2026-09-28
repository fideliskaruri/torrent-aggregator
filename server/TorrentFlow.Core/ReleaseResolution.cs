using System.Text.RegularExpressions;

namespace TorrentFlow.Core;

/// <summary>The resolution contract used by search ranking, acquisition and playback.</summary>
public static class ReleaseResolution
{
    private static readonly (Regex Pattern, int Resolution)[] Patterns = new (string, int)[]
    {
        (@"\b4kto1080p\b", 1080),
        (@"\b(?:2160[pi]|3840\s*[x×]\s*2160|uhd|4k[-_. ]?(?:hevc|bd|h ?265))\b", 2160),
        (@"\b(?:1080[pi]|(?:1920|1440)\s*[x×]\s*1080|1440p|fhd)\b", 1080),
        (@"\b(?:720[pi]|1280\s*[x×]\s*720|960p)\b", 720),
        (@"\b576[pi]\b", 576),
        (@"\b(?:480[pi]|(?:640|848)\s*[x×]\s*480)\b", 480),
        (@"\b(?:360p|240p)\b", 360),
        (@"\b4k\b", 2160)
    }.Select(p => (new Regex(p.Item1, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1)), p.Item2)).ToArray();

    public static int? Parse(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;
        var normalized = title.Replace('.', ' ').Replace('_', ' ');
        foreach (var (pattern, resolution) in Patterns)
            if (pattern.IsMatch(normalized)) return resolution;
        return null;
    }
}
