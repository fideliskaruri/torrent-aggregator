using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Media.Common;
using TorrentFlow.Media.Probing;

namespace TorrentFlow.Media.Playback;

/// <summary>Port of PreRankTarget (src/lib/prewarm/types.ts).</summary>
public sealed record PlaybackTarget(string Title, string? MediaType = "tv", int? Year = null, int? Season = null, int? Episode = null, int? PreferredResolution = null);

public sealed record ReleaseShape(int? Resolution, int SourceTier, string SourceLabel, string? Codec, string? Audio, string Playability);

public sealed record CandidateListing
{
    public required string InfoHash { get; init; }
    public required string Title { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public int? Resolution { get; init; }
    public int SourceTier { get; init; }
    public required string SourceLabel { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public long? SizeBytes { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? SizeLabel { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Codec { get; init; }
    [JsonIgnore(Condition = JsonIgnoreCondition.Never)] public string? Audio { get; init; }
    public required string Playability { get; init; }
    public int Seeders { get; init; }
    public bool IsCurrent { get; init; }
    public required string Verdict { get; init; }
}

public sealed record SourceOption(string InfoHash, string Title, int Seeders);

public sealed record FailoverCandidate(TorrentResult Release, string InfoHash);

public sealed record FailoverSession(string ContentKey, IReadOnlyList<string> Tried, string? Current, string Status, string? PinnedHash)
{
    public static FailoverSession Create(string key) => new(key, [], null, "active", null);

    public FailoverSession Commit(string hash)
    {
        var h = hash.ToLowerInvariant();
        return this with { Tried = Tried.Contains(h) ? Tried : [.. Tried, h], Current = h };
    }

    public FailoverSession Pin(string hash) => Commit(hash) with { Status = "active", PinnedHash = hash.ToLowerInvariant() };
}

/// <summary>A PlaybackActionOutcome / PlaybackNarration as the TS narration.ts union serialises it.</summary>
public sealed record FailoverResult(string Kind, FailoverSession Session, Dictionary<string, object?> Narration, FailoverCandidate? Candidate);

/// <summary>Ports of candidates.ts, failover.ts and the selection helpers of prerank.ts / quality.ts.</summary>
public static partial class Releases
{
    public static readonly HashSet<int> SupportedResolutions = [480, 720, 1080, 2160];

    public static int? Unit(double? v) => v is { } d && double.IsFinite(d) && d >= 1 ? (int)Math.Truncate(d) : null;

    public static string PreRankKey(PlaybackTarget t) =>
        $"{MediaFiles.NormalizeTitle(t.Title)}|S{Unit(t.Season)?.ToString() ?? "X"}E{Unit(t.Episode)?.ToString() ?? "X"}";

    public static string? ReleaseInfoHash(TorrentResult r) =>
        (r.InfoHash is { Length: > 0 } ? InfoHashes.Normalize(r.InfoHash) : null) ?? InfoHashes.FromMagnet(r.Magnet);

    private static readonly (Regex Re, int Value)[] ResolutionPatterns =
    [
        (new Regex(@"\b(?:4kto1080p)\b", RegexOptions.IgnoreCase), 1080),
        (new Regex(@"\b(?:2160p|3840x2160|uhd|4k[-_. ]?(?:uhd|hevc|bd|h ?265)|(?:uhd|hevc|bd|h ?265)[-_. ]4k)\b", RegexOptions.IgnoreCase), 2160),
        (new Regex(@"\[4k\]", RegexOptions.IgnoreCase), 2160),
        (new Regex(@"\b(?:1080p|1920x1080|1440p|fhd|1080i)\b", RegexOptions.IgnoreCase), 1080),
        (new Regex(@"\b(?:720p|1280x720|960p)\b", RegexOptions.IgnoreCase), 720),
        (new Regex(@"\b(?:576p|576i)\b", RegexOptions.IgnoreCase), 576),
        (new Regex(@"\b(?:480p|480i|640x480|848x480)\b", RegexOptions.IgnoreCase), 480),
        (new Regex(@"\b(?:360p|240p)\b", RegexOptions.IgnoreCase), 360),
    ];

    public static int? ParseResolution(string title)
    {
        if (string.IsNullOrEmpty(title)) return null;
        var t = UnderscoreDot().Replace(title, " ");
        foreach (var (re, value) in ResolutionPatterns) if (re.IsMatch(t)) return value;
        return null;
    }

    public static bool MeetsResolutionFloor(string title, int? minimum) =>
        Unit(minimum) is not { } floor || ParseResolution(title) is { } r && r >= floor;

    private static readonly (Regex Re, int Tier, string Label)[] SourcePatterns =
    [
        (new Regex(@"\b(?:blu[-_. ]?ray|bluray|bdrip|brrip|bd[-_. ]?remux|remux|uhdbd)\b", RegexOptions.IgnoreCase), 3, "BluRay"),
        (new Regex(@"\b(?:web[-_. ]?rip|webrip)\b", RegexOptions.IgnoreCase), 2, "WEBRip"),
        (new Regex(@"\b(?:web[-_. ]?dl|webdl)\b", RegexOptions.IgnoreCase), 3, "WEB-DL"),
        (new Regex(@"\b(?:hdtv|pdtv|sdtv|dsr|dvbs?[-_. ]?rip|tvrip)\b", RegexOptions.IgnoreCase), 1, "HDTV"),
    ];

    public static int ParseSourceTier(string title)
    {
        if (string.IsNullOrEmpty(title)) return 2;
        var t = UnderscoreDot().Replace(title, " ");
        foreach (var (re, tier, _) in SourcePatterns) if (re.IsMatch(t)) return tier;
        var web = BareWeb().Match(t);
        if (web.Success)
        {
            var anchor = MetadataAnchor().Match(t);
            if (anchor.Success && anchor.Index < web.Index) return 3;
        }
        return 2;
    }

    public static string SourceLabel(string title)
    {
        var t = UnderscoreDot().Replace(title ?? "", " ");
        foreach (var (re, _, label) in SourcePatterns) if (re.IsMatch(t)) return label;
        return "Unknown";
    }

    public static string? ParseCodec(string title)
    {
        var t = UnderscoreDot().Replace(title ?? "", " ");
        if (Regex.IsMatch(t, @"\b(?:x265|h[.\s]?265|hevc)\b", RegexOptions.IgnoreCase)) return "HEVC";
        if (Regex.IsMatch(t, @"\b(?:x264|h[.\s]?264|avc)\b", RegexOptions.IgnoreCase)) return "H.264";
        if (Regex.IsMatch(t, @"\bav1\b", RegexOptions.IgnoreCase)) return "AV1";
        return null;
    }

    public static string? ParseAudio(string title)
    {
        var t = UnderscoreDot().Replace(title ?? "", " ");
        if (Regex.IsMatch(t, @"\batmos\b", RegexOptions.IgnoreCase)) return "Atmos";
        if (Regex.IsMatch(t, @"\btruehd\b", RegexOptions.IgnoreCase)) return "TrueHD";
        if (Regex.IsMatch(t, @"\bdts(?:[-\s]?hd)?(?:[-\s]?ma)?\b", RegexOptions.IgnoreCase)) return "DTS";
        if (Regex.IsMatch(t, @"\b(?:ddp|dd\+|e[-\s]?ac[-\s]?3|eac3)\b", RegexOptions.IgnoreCase)) return "DDP";
        if (Regex.IsMatch(t, @"\b(?:dd|ac[-\s]?3)\b", RegexOptions.IgnoreCase)) return "DD";
        if (Regex.IsMatch(t, @"\baac\b", RegexOptions.IgnoreCase)) return "AAC";
        return null;
    }

    private static string? InferContainer(string title)
    {
        var lower = title.ToLowerInvariant();
        var spaced = Regex.Replace(lower, "[._-]", " ");
        if (Regex.IsMatch(lower, @"\.(?:mkv)(?:\b|$)") || Regex.IsMatch(spaced, @"\bmkv\b")) return "matroska";
        if (Regex.IsMatch(lower, @"\.(?:mp4|m4v|mov)(?:\b|$)") || Regex.IsMatch(spaced, @"\b(?:mp4|m4v|mov)\b")) return "mp4";
        if (Regex.IsMatch(lower, @"\.(?:webm)(?:\b|$)") || Regex.IsMatch(spaced, @"\bwebm\b")) return "webm";
        if (Regex.IsMatch(lower, @"\.(?:avi)(?:\b|$)") || Regex.IsMatch(spaced, @"\bavi\b")) return "avi";
        return null;
    }

    private static string? InferVideoCodec(string title)
    {
        var t = Regex.Replace(title, "[._-]", " ");
        if (Regex.IsMatch(t, @"\b(?:hevc|x265|h\s*265|hvc1|hev1)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("hevc");
        if (Regex.IsMatch(t, @"\b(?:h\s*264|x264|avc1?|avc)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("h264");
        if (Regex.IsMatch(t, @"\bav1\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("av1");
        if (Regex.IsMatch(t, @"\bvp9\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("vp9");
        if (Regex.IsMatch(t, @"\bvp8\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("vp8");
        if (Regex.IsMatch(t, @"\b(?:vc\s*1|vc1)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("vc1");
        if (Regex.IsMatch(t, @"\b(?:xvid|divx)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("mpeg4");
        return null;
    }

    private static string? InferAudioCodec(string title)
    {
        var t = Regex.Replace(title, "[._-]", " ");
        if (Regex.IsMatch(t, @"\b(?:true\s*hd|truehd|mlp)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("truehd");
        if (Regex.IsMatch(t, @"\bdts(?:\s*(?:hd|ma|x))?\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("dts");
        if (Regex.IsMatch(t, @"\b(?:e\s*ac\s*3|eac3|ec\s*3|ddp|dd\+|dolby\s*digital\s*plus)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("eac3");
        if (Regex.IsMatch(t, @"\b(?:ac\s*3|ac3|dd|dolby\s*digital)\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("ac3");
        if (Regex.IsMatch(t, @"\baac\d?(?:\s*\d)?\b|\bmp4a\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("aac");
        if (Regex.IsMatch(t, @"\bflac\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("flac");
        if (Regex.IsMatch(t, @"\bopus\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("opus");
        if (Regex.IsMatch(t, @"\bmp3\b", RegexOptions.IgnoreCase)) return ProbeShape.NormalizeCodecName("mp3");
        return null;
    }

    private static ProbeResult InferredProbe(string container, string? video, string? audio)
    {
        var streams = new List<ProbeStream>();
        if (video is not null) streams.Add(new ProbeStream { Index = streams.Count, CodecType = "video", Codec = video, Channels = null });
        if (audio is not null) streams.Add(new ProbeStream { Index = streams.Count, CodecType = "audio", Codec = audio, Channels = 2 });
        return new ProbeResult(container, null, streams);
    }

    /// <summary>Port of quality.ts directPlayableFromTitle: true likely direct, false known obstacle, null unknown.</summary>
    public static bool? DirectPlayableFromTitle(string title)
    {
        var container = InferContainer(title);
        var video = InferVideoCodec(title);
        var audio = InferAudioCodec(title);
        if (container is null && video is null && audio is null) return null;
        var caps = Capabilities.Default;
        if (container is not null && !Capabilities.SupportsContainer(caps, container)) return false;
        if (container is null)
            return Decide.DecidePlayback(InferredProbe("mp4", video, audio), caps).Rung == "direct" ? null : false;
        if (video is null || audio is null)
            return Decide.DecidePlayback(InferredProbe(container, video, audio), caps).Rung == "direct" ? null : false;
        return Decide.DecidePlayback(InferredProbe(container, video, audio), caps).Rung == "direct";
    }

    public static string Playability(string title) => DirectPlayableFromTitle(title) switch
    {
        true => "direct",
        false => "transcode",
        null => "unknown",
    };

    public static ReleaseShape DescribeReleaseShape(string title) =>
        new(ParseResolution(title), ParseSourceTier(title), SourceLabel(title), ParseCodec(title), ParseAudio(title), Playability(title));

    /// <summary>rankResultsForTarget simplified: applies the preferred-resolution hard floor, keeping the producer's order.</summary>
    public static List<TorrentResult> RankForTarget(IEnumerable<TorrentResult> results, PlaybackTarget target) =>
        Unit(target.PreferredResolution) is null ? [.. results] : [.. results.Where(r => MeetsResolutionFloor(r.Title, target.PreferredResolution))];

    public static bool IsMovie(string? mediaType) => mediaType?.Trim().ToLowerInvariant() is "movie" or "film";

    /// <summary>A lightweight filterReleasesForWork: the release's normalised title must start with the work's.</summary>
    public static List<TorrentResult> FilterForWork(IEnumerable<TorrentResult> pool, string title, int? year)
    {
        var want = MediaFiles.NormalizeTitle(title);
        return [.. pool.Where(r =>
        {
            var name = MediaFiles.NormalizeTitle(r.Title);
            if (want.Length == 0 || !name.StartsWith(want, StringComparison.Ordinal)) return false;
            if (year is not { } y) return true;
            var years = YearRe().Matches(r.Title).Select(m => int.Parse(m.Value, System.Globalization.CultureInfo.InvariantCulture)).ToList();
            return years.Count == 0 || years.Any(v => Math.Abs(v - y) <= 1);
        })];
    }

    public static TorrentResult? SelectBestRelease(IReadOnlyList<TorrentResult> results, PlaybackTarget target, Func<TorrentResult, string>? verdictOf = null)
    {
        var season = Unit(target.Season);
        var episode = Unit(target.Episode);
        var usable = RankForTarget(results, target).Where(r => r.Magnet is { Length: > 0 } && r.Seeders > 0 && ReleaseInfoHash(r) is not null).ToList();
        if (usable.Count == 0) return null;
        var ordered = verdictOf is null ? usable : OrderByVerdict(usable, verdictOf);
        if (season is null || episode is null)
            return (IsMovie(target.MediaType) ? FilterForWork(ordered, target.Title, target.Year) : ordered).FirstOrDefault();
        return ordered.FirstOrDefault(r =>
        {
            var (s, e, pack) = EpisodeOf(r);
            return !pack && s == season && e == episode;
        });
    }

    internal static (int? Season, int? Episode, bool SeasonPack) EpisodeOf(TorrentResult r)
    {
        if (r.Episode is { } ep) return (ep.Season, ep.Episode, ep.IsSeasonPack);
        var parsed = Episodes.Parse(r.Title);
        return (parsed.Season, parsed.Episode, parsed.IsSeasonPack);
    }

    public static int VerdictTier(string verdict) => verdict switch { "good" => 0, "unknown" => 1, "weak" => 2, "dead" => 3, _ => 1 };

    public static List<TorrentResult> OrderByVerdict(IReadOnlyList<TorrentResult> results, Func<TorrentResult, string> verdictOf) =>
        [.. results.Select((r, i) => (r, i, tier: VerdictTier(verdictOf(r)))).OrderBy(x => x.tier).ThenBy(x => x.i).Select(x => x.r)];

    public static List<TorrentResult> PrioritizeResolution(IReadOnlyList<TorrentResult> releases, int preferred) =>
        [.. releases.Select((r, i) => (r, i, d: ParseResolution(r.Title) is { } res ? Math.Abs(res - preferred) : double.PositiveInfinity))
            .OrderBy(x => x.d).ThenBy(x => x.i).Select(x => x.r)];

    public static bool CurrentSourceIsBestResolution(IReadOnlyList<TorrentResult> prioritized, string? currentInfoHash)
    {
        var current = InfoHashes.Normalize(currentInfoHash);
        return current is not null && prioritized.Count > 0 && ReleaseInfoHash(prioritized[0]) == current;
    }

    public static List<CandidateListing> ListCandidates(IReadOnlyList<TorrentResult> pool, PlaybackTarget target, string? currentInfoHash, IReadOnlyDictionary<string, string> verdicts)
    {
        var filtered = IsMovie(target.MediaType) ? FilterForWork(pool, target.Title, target.Year) : [.. pool];
        var current = currentInfoHash?.ToLowerInvariant();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var list = new List<CandidateListing>();
        foreach (var r in filtered)
        {
            var hash = ReleaseInfoHash(r);
            if (hash is null || !seen.Add(hash)) continue;
            var shape = DescribeReleaseShape(r.Title);
            list.Add(new CandidateListing
            {
                InfoHash = hash, Title = r.Title, Resolution = shape.Resolution, SourceTier = shape.SourceTier, SourceLabel = shape.SourceLabel,
                SizeBytes = r.SizeBytes, SizeLabel = r.SizeLabel, Codec = shape.Codec, Audio = shape.Audio, Playability = shape.Playability,
                Seeders = r.Seeders, IsCurrent = current is not null && hash == current, Verdict = verdicts.GetValueOrDefault(hash) ?? "unknown",
            });
        }
        return list;
    }

    public static IReadOnlyList<TorrentResult> PreferLiveCandidates(IReadOnlyList<TorrentResult> untried, IReadOnlyDictionary<string, string>? verdicts)
    {
        if (verdicts is null || verdicts.Count == 0) return untried;
        var kept = untried.Where(r => ReleaseInfoHash(r) is not { } h || verdicts.GetValueOrDefault(h) != "dead").ToList();
        return kept.Count == 0 ? untried : kept;
    }

    public static FailoverCandidate? ChooseNextRelease(IReadOnlyList<TorrentResult> results, PlaybackTarget target, IEnumerable<string> tried, IReadOnlyDictionary<string, string>? verdicts = null)
    {
        var triedSet = tried.Select(t => t.ToLowerInvariant()).ToHashSet();
        var untried = results.Where(r => ReleaseInfoHash(r) is { } h && !triedSet.Contains(h)).ToList();
        var best = SelectBestRelease(PreferLiveCandidates(untried, verdicts), target);
        return best is not null && ReleaseInfoHash(best) is { } hash ? new FailoverCandidate(best, hash) : null;
    }

    public static SourceOption SourceOptionFrom(TorrentResult r, string hash) => new(hash, r.Title, Math.Max(0, r.Seeders));

    public static List<SourceOption> ListSourceOptions(IReadOnlyList<TorrentResult> results, IEnumerable<string>? exclude = null)
    {
        var excluded = (exclude ?? []).Select(h => h.ToLowerInvariant()).ToHashSet();
        var seen = new HashSet<string>();
        var list = new List<SourceOption>();
        foreach (var r in results)
        {
            if (ReleaseInfoHash(r) is not { } h || excluded.Contains(h) || !seen.Add(h)) continue;
            list.Add(SourceOptionFrom(r, h));
        }
        return list;
    }

    public static FailoverResult FailOver(FailoverSession session, IReadOnlyList<TorrentResult> results, PlaybackTarget target, string cause = "delivery", IReadOnlyDictionary<string, string>? verdicts = null)
    {
        var candidate = ChooseNextRelease(results, target, session.Tried, verdicts);
        if (candidate is null)
        {
            var candidates = ListSourceOptions(results);
            var seeded = candidates.Count(c => c.Seeders > 0);
            var reason = cause == "playability" ? "no-playable-sources" : candidates.Count > 0 && seeded == 0 ? "no-seeders" : "all-sources-failed";
            return new FailoverResult("exhausted", session with { Status = "exhausted" }, new Dictionary<string, object?>
            {
                ["phase"] = "exhausted", ["cause"] = cause, ["triedCount"] = session.Tried.Count,
                ["outcome"] = new Dictionary<string, object?>
                {
                    ["kind"] = "none-available", ["reason"] = reason, ["triedCount"] = session.Tried.Count,
                    ["totalCandidates"] = candidates.Count, ["seededCandidateCount"] = seeded,
                },
            }, null);
        }
        var alternatives = ListSourceOptions(results, [.. session.Tried, candidate.InfoHash]);
        return new FailoverResult("switch", session.Commit(candidate.InfoHash), new Dictionary<string, object?>
        {
            ["phase"] = "switching", ["cause"] = cause, ["triedCount"] = session.Tried.Count, ["nextName"] = candidate.Release.Title,
            ["outcome"] = new Dictionary<string, object?>
            {
                ["kind"] = "switch-source", ["reason"] = cause, ["selected"] = SourceOptionFrom(candidate.Release, candidate.InfoHash),
                ["alternatives"] = alternatives, ["remainingCount"] = alternatives.Count,
            },
        }, candidate);
    }

    /// <summary>Port of narration.ts describePlayback, returning the {headline, detail?} copy object.</summary>
    public static Dictionary<string, object?> DescribePlayback(IReadOnlyDictionary<string, object?> n)
    {
        var phase = n.GetValueOrDefault("phase") as string;
        var outcome = n.GetValueOrDefault("outcome") as IReadOnlyDictionary<string, object?> ?? n.GetValueOrDefault("outcome") as Dictionary<string, object?>;
        string? Kind() => outcome?.GetValueOrDefault("kind") as string;
        int IntOf(object? v) => v is int i ? i : 0;
        switch (phase)
        {
            case "starting":
                if (Kind() == "wait" && outcome!.GetValueOrDefault("reason") as string == "cold-starting")
                {
                    var peers = IntOf(outcome!.GetValueOrDefault("peerCount"));
                    return new() { ["headline"] = "Still connecting to peers\u2026", ["detail"] = $"{peers} {(peers == 1 ? "peer" : "peers")} found; waiting for the first video pieces." };
                }
                return new() { ["headline"] = IntOf(n.GetValueOrDefault("attempt")) <= 1 ? "Starting playback\u2026" : "Trying another source\u2026" };
            case "playing":
                return new() { ["headline"] = "Playing" };
            case "switching":
            {
                var name = n.GetValueOrDefault("nextName") as string;
                var target = name is not null ? $"Switching to \u201c{name}\u201d." : "Switching to another release.";
                var headline = n.GetValueOrDefault("cause") as string == "playability"
                    ? "Your device can\u2019t play this one \u2014 trying another\u2026" : "This source stalled \u2014 trying another\u2026";
                var remaining = IntOf(outcome?.GetValueOrDefault("remainingCount"));
                var suffix = Kind() == "switch-source" && remaining > 0 ? $" {remaining} other {(remaining == 1 ? "release" : "releases")} remain." : "";
                return new() { ["headline"] = headline, ["detail"] = target + suffix };
            }
            case "exhausted":
            {
                var count = Math.Max(1, IntOf(n.GetValueOrDefault("triedCount")));
                var sources = count == 1 ? "the only source" : $"all {count} sources";
                var none = Kind() == "none-available" && outcome!.GetValueOrDefault("reason") as string == "no-seeders" ? " No seeders were found for any release of this episode." : "";
                var playability = n.GetValueOrDefault("cause") as string == "playability";
                return new()
                {
                    ["headline"] = playability ? "Couldn\u2019t play this \u2014 nothing your device supports right now" : "Couldn\u2019t start this \u2014 no working source right now",
                    ["detail"] = playability
                        ? $"We tried {sources} we could find and none were ones your device can play. Try again later."
                        : $"We tried {sources} we could find and none were delivering. Try again later.{none}",
                };
            }
            default:
                return new() { ["headline"] = "The source you chose has stalled", ["detail"] = "It isn\u2019t delivering right now. Pick another quality to switch, or keep waiting." };
        }
    }

    /// <summary>The cached ranked pool for a target (engine-deps.ts rankedResultsFromCache).</summary>
    public static List<TorrentResult> ResultsFromPayload(string payload)
    {
        try
        {
            using var doc = JsonDocument.Parse(payload);
            if (!doc.RootElement.TryGetProperty("results", out var results) || results.ValueKind != JsonValueKind.Array) return [];
            var list = new List<TorrentResult>();
            foreach (var r in results.EnumerateArray())
            {
                try { if (r.Deserialize<TorrentResult>(PayloadJson) is { } tr) list.Add(tr); }
                catch (JsonException) { }
            }
            return list;
        }
        catch (JsonException) { return []; }
    }

    private static readonly JsonSerializerOptions PayloadJson = new(JsonSerializerDefaults.Web)
    {
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    [GeneratedRegex("[._]")] private static partial Regex UnderscoreDot();
    [GeneratedRegex(@"\bweb\b", RegexOptions.IgnoreCase)] private static partial Regex BareWeb();
    [GeneratedRegex(@"\b(?:19|20)\d{2}\b|\b\d{3,4}[pi]\b", RegexOptions.IgnoreCase)] private static partial Regex MetadataAnchor();
    [GeneratedRegex(@"\b(?:19|20)\d{2}\b")] private static partial Regex YearRe();
}
