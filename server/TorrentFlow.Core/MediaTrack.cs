namespace TorrentFlow.Core;

public enum MediaTrackKind { Video, Audio, Subtitle }

/// <summary>
/// One track as a video file's own header lists it (Matroska Tracks, or an ISO media trak). Read before a download by
/// the header probe, never by ffprobe.
/// </summary>
/// <param name="Number">Matroska TrackNumber, or the MP4 track_ID.</param>
/// <param name="Language">Canonical ISO 639-1 code (<see cref="LanguageTag.Normalize"/>); null when untagged, und, mul, zxx or unknown.</param>
/// <param name="RawLanguage">The tag as written (LanguageBCP47 when present, else Language); null when the header has none.
/// Matroska defines an absent Language as "eng", but an untagged track counts as unknown here, never as English.</param>
/// <param name="Source">Who read the track list: null for the file's own header (the header probe), <c>indexer</c> for an
/// index's list of the file's tracks before download (AnimeTosho, <see cref="LanguageHint"/>).</param>
public sealed record MediaTrack(
    int Number,
    MediaTrackKind Kind,
    string? Language,
    string? RawLanguage,
    bool Default,
    bool Enabled,
    bool Forced,
    string? Name,
    string? Codec,
    string? Source = null)
{
    public const string Indexer = "indexer";
}

/// <summary>
/// The one language-code normaliser. Track headers (ISO 639-2/B and /T, BCP 47) and release-name code lists
/// ([ENG], [POR-BR], es-419) all map to one lower-case ISO 639-1 code, so "fre", "fra", "fr-FR" and "fr" compare equal.
/// </summary>
public static class LanguageTag
{
    // ISO 639-2 (bibliographic and terminology forms) to ISO 639-1, plus the common BCP 47 three-letter extras.
    private static readonly Dictionary<string, string> ThreeLetter = Build(
        "aar aa", "abk ab", "afr af", "aka ak", "alb sq", "sqi sq", "amh am", "ara ar", "arg an", "arm hy", "hye hy",
        "asm as", "ava av", "aym ay", "aze az", "bak ba", "bam bm", "baq eu", "eus eu", "bel be", "ben bn", "bis bi",
        "bos bs", "bre br", "bul bg", "bur my", "mya my", "cat ca", "cha ch", "che ce", "chi zh", "zho zh", "chv cv",
        "cor kw", "cos co", "cre cr", "cze cs", "ces cs", "dan da", "div dv", "dut nl", "nld nl", "dzo dz", "eng en",
        "epo eo", "est et", "ewe ee", "fao fo", "fij fj", "fin fi", "fre fr", "fra fr", "fry fy", "ful ff", "geo ka",
        "kat ka", "ger de", "deu de", "gla gd", "gle ga", "glg gl", "glv gv", "gre el", "ell el", "grn gn", "guj gu",
        "hat ht", "hau ha", "heb he", "her hz", "hin hi", "hmo ho", "hrv hr", "hun hu", "ibo ig", "ice is", "isl is",
        "ido io", "iii ii", "iku iu", "ile ie", "ina ia", "ind id", "ipk ik", "ita it", "jav jv", "jpn ja", "kal kl",
        "kan kn", "kas ks", "kau kr", "kaz kk", "khm km", "kik ki", "kin rw", "kir ky", "kom kv", "kon kg", "kor ko",
        "kua kj", "kur ku", "lao lo", "lat la", "lav lv", "lim li", "lin ln", "lit lt", "ltz lb", "lub lu", "lug lg",
        "mac mk", "mkd mk", "mah mh", "mal ml", "mao mi", "mri mi", "mar mr", "may ms", "msa ms", "mlg mg", "mlt mt",
        "mon mn", "nau na", "nav nv", "nbl nr", "nde nd", "ndo ng", "nep ne", "nno nn", "nob nb", "nor no", "nya ny",
        "oci oc", "oji oj", "ori or", "orm om", "oss os", "pan pa", "per fa", "fas fa", "pli pi", "pol pl", "por pt",
        "pus ps", "que qu", "roh rm", "rum ro", "ron ro", "run rn", "rus ru", "sag sg", "san sa", "sin si", "slo sk",
        "slk sk", "slv sl", "sme se", "smo sm", "sna sn", "snd sd", "som so", "sot st", "spa es", "srd sc", "srp sr",
        "ssw ss", "sun su", "swa sw", "swe sv", "tah ty", "tam ta", "tat tt", "tel te", "tgk tg", "tgl tl", "tha th",
        "tib bo", "bod bo", "tir ti", "ton to", "tsn tn", "tso ts", "tuk tk", "tur tr", "twi tw", "uig ug", "ukr uk",
        "urd ur", "uzb uz", "ven ve", "vie vi", "vol vo", "wel cy", "cym cy", "wln wa", "wol wo", "xho xh", "yid yi",
        "yor yo", "zha za", "zul zu",
        // Not in ISO 639-1 but plainly one of its languages for this purpose.
        "yue zh", "cmn zh", "fil tl", "scc sr", "scr hr");

    private static readonly HashSet<string> TwoLetter = [.. ThreeLetter.Values];

    /// <summary>Unknown on purpose: undetermined, several, no language, uncoded.</summary>
    private static readonly HashSet<string> Unknown = ["und", "mul", "zxx", "mis"];

    /// <summary>
    /// "jpn", "ja", "ja-JP", "en-US", "zh-Hant", "pt-BR", "es-419", "fre" and "FRE" give "ja", "ja", "ja", "en", "zh",
    /// "pt", "es", "fr", "fr". Null for empty, und, mul, zxx, private-use and codes this table doesn't know: a tag that
    /// can't be read is unknown, never English.
    /// </summary>
    public static string? Normalize(string? tag)
    {
        if (string.IsNullOrWhiteSpace(tag)) return null;
        var text = tag.Trim().TrimEnd('\0').Replace('_', '-').ToLowerInvariant();
        var dash = text.IndexOf('-');
        var primary = dash < 0 ? text : text[..dash];
        if (primary.Length is < 2 or > 3 || Unknown.Contains(primary)) return null;
        foreach (var c in primary)
            if (c is < 'a' or > 'z') return null;
        if (primary.Length == 2) return primary == "jp" ? "ja" : TwoLetter.Contains(primary) ? primary : null;
        return ThreeLetter.GetValueOrDefault(primary);
    }

    private static Dictionary<string, string> Build(params string[] pairs)
    {
        var map = new Dictionary<string, string>(pairs.Length, StringComparer.Ordinal);
        foreach (var pair in pairs) map[pair[..3]] = pair[4..];
        return map;
    }
}
