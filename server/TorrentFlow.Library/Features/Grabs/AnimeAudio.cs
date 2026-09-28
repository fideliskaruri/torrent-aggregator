using System.Text.RegularExpressions;

namespace TorrentFlow.Library.Features.Grabs;

public static partial class AnimeAudio
{
    public static bool Allowed(string title, string mediaType, bool preferDub) =>
        mediaType != "anime" || preferDub || !Dub().IsMatch(title) || Dual().IsMatch(title);

    public static int Preference(string title, bool preferDub) =>
        preferDub ? Dub().IsMatch(title) || Dual().IsMatch(title) ? 0 : 1
            : Sub().IsMatch(title) || Dual().IsMatch(title) ? 0 : 1;

    [GeneratedRegex(@"\bdub(?:bed)?\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Dub();
    [GeneratedRegex(@"\bdual[ ._-]*(?:audio)?\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Dual();
    [GeneratedRegex(@"\b(?:multi[ ._-]*)?sub(?:bed|s|title[s]?)?\b|\bmultiple[ ._-]+subtitle[s]?\b", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)]
    private static partial Regex Sub();
}
