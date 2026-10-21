using System.Collections.Immutable;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Plan;

public sealed partial class ReleasePlanner
{
    public PlanShortlist Shortlist(PlanInput input)
    {
        var targets = input.Targets.DistinctBy(t => t.Id).ToArray();
        var accepted = new List<Candidate>();
        var rejections = new List<Rejection>();
        foreach (var candidate in input.Pool.DistinctBy(c => c.Release.Id, StringComparer.OrdinalIgnoreCase))
        {
            var common = CandidateNameRejection(candidate, input);
            if (common is not null)
            {
                rejections.Add(common);
                continue;
            }
            if (input.Mode == AcquisitionMode.ExplicitRaw || targets.Length == 0)
            {
                accepted.Add(candidate);
                continue;
            }
            var eligible = false;
            foreach (var target in targets)
            {
                var rejection = TargetNameRejection(candidate, target, input);
                if (rejection is null) eligible = true;
                else rejections.Add(rejection);
            }
            if (eligible) accepted.Add(candidate);
        }
        if (accepted.Any(c => c.TrustedSeeders is > 0))
            accepted = [.. accepted.Where(c => c.TrustedSeeders is > 0)];
        var ordered = accepted.OrderBy(c => QualityClass(c))
            .ThenBy(c => QualityDistance(c))
            .ThenByDescending(c => c.TrustedSeeders ?? 0)
            .ThenByDescending(c => SourceRank(c.Release.Parsed.Quality.Source))
            .ThenByDescending(c => targets.Count(t => TargetNameRejection(c, t, input) is null))
            .ThenByDescending(c => c.Observations.IsEmpty ? DateTimeOffset.MinValue :
                c.Observations.Max(o => o.UploadedAt))
            .ThenBy(c => c.Release.Id, StringComparer.Ordinal).ToImmutableArray();
        return new(ordered, [.. rejections]);

        int QualityClass(Candidate c)
        {
            var resolution = c.Release.Parsed.Quality.Resolution;
            var preferred = targets.Select(t => t.PreferredResolution).FirstOrDefault(q => q is not null) ??
                input.Preference?.PreferredResolution ?? 1080;
            return resolution == preferred ? 0 : resolution > preferred ? 1 : resolution is not null ? 2 : 3;
        }
        int QualityDistance(Candidate c)
        {
            var resolution = c.Release.Parsed.Quality.Resolution;
            var preferred = targets.Select(t => t.PreferredResolution).FirstOrDefault(q => q is not null) ??
                input.Preference?.PreferredResolution ?? 1080;
            return resolution is null ? int.MaxValue : Math.Abs(resolution.Value - preferred);
        }
    }

    private static Rejection? CandidateNameRejection(Candidate candidate, PlanInput input)
    {
        var release = candidate.Release;
        var parsed = release.Parsed;
        if (release.Id.Length != 40 || release.Id.Any(c => !char.IsAsciiHexDigit(c)))
            return new(release.Id, null, "invalid_hash", "This source has no valid torrent hash.");
        if (input.Mode == AcquisitionMode.ExplicitRaw)
            return parsed.ClearlyForeign || parsed.Foreign == ForeignStatus.Yes
                ? new(release.Id, null, "foreign_language", "This source clearly identifies a foreign language.")
                : null;
        if (input.Work is null || !Identity(parsed.Title, input.Work) &&
            !(parsed.Pack && Identity(PackTitleSuffix.Replace(parsed.Title, ""), input.Work)))
            return new(release.Id, null, "wrong_work", "The source name does not match this title's catalog names.");
        if (input.Work.Work.Kind == WorkKind.Film && (parsed.Kind != ReleaseKind.Movie || parsed.Pack ||
            !parsed.Episodes.IsEmpty || !parsed.AbsoluteNumbers.IsEmpty))
            return new(release.Id, null, "wrong_kind", "This is not a single-film source.");
        if (input.Work.Work.Kind == WorkKind.Film && parsed.Year is { } year &&
            input.Work.Work.Year is { } expected && year != expected)
            return new(release.Id, null, "wrong_year", $"The source is from {year}; this film was released in {expected}.");
        if (parsed.Unsafe || parsed.Sample || parsed.Cam || parsed.Kind == ReleaseKind.Other)
            return new(release.Id, null, "junk_release", "This source is a sample, camera recording, or non-feature video.");
        if (input.Blocks.Any(b => b.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase) &&
            (b.WorkKey is null || b.WorkKey == input.Work.Work.WorkKey) && (b.Until is null || b.Until > input.Now)))
            return new(release.Id, null, "blocked_hash", "This source is blocked for this title or for every title.");
        return null;
    }

    private static Rejection? TargetNameRejection(Candidate candidate, TargetRow target, PlanInput input)
    {
        if (input.Work is null || target.WorkId != input.Work.Work.Id)
            return new(candidate.Release.Id, target.Id, "wrong_target_work", "The target belongs to a different title.");
        if (target.PickedReleaseHash is { } picked && picked != candidate.Release.Id)
            return new(candidate.Release.Id, target.Id, "owner_pick", "The owner chose a different source for this item.");
        var ownerPick = target.PickedReleaseHash == candidate.Release.Id;
        if (!ownerPick && target.MinListedSeeders is { } minimum && (candidate.TrustedSeeders ?? -1) < minimum)
            return new(candidate.Release.Id, target.Id, "minimum_seeders", "This source does not meet the rule's minimum seed count.");
        if (target.State == TargetState.Removed || target.IsPaused() ||
            target.State == TargetState.Done && target.Kind == TargetKind.Acquire)
            return new(candidate.Release.Id, target.Id, "inactive_target", "This item is not asking for a download.");
        if (input.Owned.Any(o => o.WorkId == target.WorkId && o.EpisodeId == target.EpisodeId &&
            o.Videos.Any(v => v.Role == FileRole.Video &&
                (v.Status is FilePresence.Present or FilePresence.Offline ||
                 v.Status == FilePresence.Missing && v.MissingConfirmedAt is null))))
            return new(candidate.Release.Id, target.Id, "already_owned", "This item is already in your library.");
        var parsed = candidate.Release.Parsed;
        var language = AudioLanguage(input);
        if (!LanguageAllowed(parsed, language))
            return new(candidate.Release.Id, target.Id, "foreign_language", LanguageRejection(language));
        var pack = parsed.Pack || parsed.Kind is ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries;
        var episode = input.Work.Episodes.FirstOrDefault(e => e.Id == target.EpisodeId);
        var season = input.Work.Seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
        if (episode is not null && (episode.MappingStatus != MappingStatus.Confirmed ||
            season?.MappingStatus != MappingStatus.Confirmed))
            return new(candidate.Release.Id, target.Id, "mapping_unconfirmed", "The catalog has not confirmed this episode's numbering.");
        if (pack && (season is null || !Finished(input.Work, season, input.Now)))
            return new(candidate.Release.Id, target.Id, "season_unfinished", "A season pack is only selected when every episode has aired.");
        if (!pack && episode is not null && !Coordinates(parsed, episode, season!, input.Work))
            return new(candidate.Release.Id, target.Id, "wrong_episode", "The source numbers do not identify this exact episode.");
        var floor = target.ResolutionFloor ?? input.Preference?.ResolutionFloor;
        if (!ownerPick && floor is not null && (parsed.Quality.Resolution is not { } resolution || resolution < floor))
            return new(candidate.Release.Id, target.Id, "quality_floor", $"This item requires at least {floor}p.");
        return null;
    }

    // "ATLANTIS: Complete", "Show - The Complete TV Series". Only tried after the raw title fails,
    // so shows really named "... Batch" or "The Collection" still match.
    private static readonly System.Text.RegularExpressions.Regex PackTitleSuffix = new(
        @"[\s:,.-]*(?:\bthe\s+)?\b(?:complete(?:\s+(?:tv\s+|cartoon\s+)?(?:series|seasons?|collection|box\s*set))?|full\s+series|tv\s+series|box\s*set|batch|collection)\s*$",
        System.Text.RegularExpressions.RegexOptions.IgnoreCase | System.Text.RegularExpressions.RegexOptions.CultureInvariant);

    private static bool Identity(string title, WorkSnapshot work)
    {
        var normalized = Normalize(title);
        return normalized.Length > 0 && work.Names.Where(n => n.Authoritative &&
            (n.LinkId is null || work.Links.Any(l => l.Id == n.LinkId && l.Status == LinkStatus.Verified)))
            .Any(n => Normalize(n.Value) == normalized);
    }
    private static string Normalize(string value) => string.Concat(value.Replace("&", " and ", StringComparison.Ordinal)
        .Normalize(NormalizationForm.FormKC)
        .Where(char.IsLetterOrDigit)).ToLowerInvariant();
    private static bool Finished(WorkSnapshot work, SeasonRow season, DateTimeOffset now)
    {
        var episodes = work.Episodes.Where(e => e.SeasonId == season.Id).ToArray();
        return season.MappingStatus == MappingStatus.Confirmed && season.ExpectedEpisodeCount is > 0 &&
            episodes.Length == season.ExpectedEpisodeCount && episodes.All(e => e.MappingStatus == MappingStatus.Confirmed &&
                e.AirPrecision != DatePrecision.Unknown && e.AirAt is not null && e.AirAt <= now);
    }
    private static bool Coordinates(ParsedRelease parsed, EpisodeRow episode, SeasonRow season, WorkSnapshot work)
    {
        if (parsed.Pack || parsed.Episodes.Length > 1 || parsed.AbsoluteNumbers.Length > 1 ||
            !parsed.EpisodeRanges.IsEmpty || !parsed.AbsoluteRanges.IsEmpty || !parsed.Ranges.IsEmpty) return false;
        if (parsed.Seasons.Length == 1 && parsed.Episodes.Length == 1)
            return parsed.Seasons[0] == season.Number && parsed.Episodes[0] == episode.Number;
        if (!parsed.Seasons.IsEmpty) return false;
        if (parsed.AbsoluteNumbers.Length == 1 && episode.AbsoluteNumber == parsed.AbsoluteNumbers[0])
            return work.Episodes.Count(e => e.AbsoluteNumber == episode.AbsoluteNumber && e.MappingStatus == MappingStatus.Confirmed) == 1;
        return season.Number == 1 && parsed.Episodes.Length == 1 && parsed.Episodes[0] == episode.Number;
    }
    private sealed record Mapping(Dictionary<string, TorrentFile> Files, (string Code, string Text)? Fatal);
    private static Mapping MapFiles(WorkSnapshot work, ImmutableArray<TorrentFile> files,
        PlanFileMetadata? metadata, ParsedRelease release, bool pack)
    {
        var found = new Dictionary<string, List<TorrentFile>>();
        foreach (var file in files.Where(f => FileEligibility.IsVideo(f) && !FileEligibility.IsExtra(f)))
        {
            if (metadata is null || !metadata.ParsedFiles.TryGetValue(file.Index, out var parsed)) continue;
            if (parsed.Sample || parsed.SpecialType is not null || parsed.Unsafe || parsed.Episodes.Length > 1 ||
                parsed.AbsoluteNumbers.Length > 1 || !parsed.Ranges.IsEmpty ||
                !parsed.EpisodeRanges.IsEmpty || !parsed.AbsoluteRanges.IsEmpty) continue;
            var directory = metadata.ParsedDirectories.GetValueOrDefault(file.Index);
            if (pack && parsed.ThreeDigitSceneEpisode &&
                (parsed.Seasons.Length != 1 ||
                 !release.Seasons.Contains(parsed.Seasons[0]) &&
                 directory?.Seasons.Contains(parsed.Seasons[0]) != true))
                continue;
            if (pack && !parsed.ThreeDigitSceneEpisode &&
                parsed.Seasons.Any(s => !release.Seasons.IsEmpty && !release.Seasons.Contains(s)))
                return new([], ("other_season_file", "The pack contains videos from a different season."));
            var mapped = InheritPackSeason(parsed, directory, work, pack);
            var matches = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
                work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId) is { MappingStatus: MappingStatus.Confirmed } season &&
                Coordinates(mapped, e, season, work)).ToArray();
            // Seasonless pack videos need a catalog-proven absolute map, not an inferred S1.
            if (pack && parsed.Seasons.IsEmpty && mapped.Seasons.IsEmpty &&
                (parsed.AbsoluteNumbers.Length != 1 || matches.Length != 1 || matches[0].AbsoluteNumber != parsed.AbsoluteNumbers[0]))
                continue;
            if (matches.Length != 1) continue;
            if (!found.TryGetValue(matches[0].Id, out var list)) found[matches[0].Id] = list = [];
            list.Add(file);
        }
        return new(found.Where(p => p.Value.Count == 1).ToDictionary(p => p.Key, p => p.Value[0]), null);
    }

    private static ParsedRelease InheritPackSeason(ParsedRelease parsed, ParsedRelease? directory,
        WorkSnapshot work, bool pack)
    {
        if (!pack || !parsed.Seasons.IsEmpty || directory?.Seasons.Length != 1 ||
            !parsed.EpisodeRanges.IsEmpty || !parsed.AbsoluteRanges.IsEmpty || !parsed.Ranges.IsEmpty)
            return parsed;
        var hasEpisode = parsed.Episodes.Length == 1 && parsed.AbsoluteNumbers.IsEmpty;
        var hasAbsolute = parsed.Episodes.IsEmpty && parsed.AbsoluteNumbers.Length == 1;
        if (!hasEpisode && !hasAbsolute) return parsed;
        var number = hasEpisode ? parsed.Episodes[0] : parsed.AbsoluteNumbers[0];
        var seasonNumber = directory.Seasons[0];
        var season = work.Seasons.FirstOrDefault(s => s.Number == seasonNumber);
        if (hasAbsolute && work.Work.Anime == true &&
            season?.ExpectedEpisodeCount is { } count && number > count)
            return parsed;
        return parsed with
        {
            Seasons = [seasonNumber],
            Episodes = [number],
            AbsoluteNumbers = [],
        };
    }
    private static ImmutableArray<SelectedFile> SelectFiles(string target, TorrentFile[] kept,
        ImmutableArray<TorrentFile> all, PlanFileMetadata? metadata, WorkSnapshot work)
    {
        var result = kept.Select(f => new SelectedFile(target, f.Index, FileRole.Video)).ToList();
        var videos = all.Where(f => FileEligibility.IsVideo(f) && !FileEligibility.IsExtra(f)).ToArray();
        foreach (var sidecar in all.Where(f => FileEligibility.SidecarRole(f) is not null))
        {
            var (folder, stem) = FileEligibility.Split(sidecar);
            var named = videos.Where(v =>
            {
                var (vf, vs) = FileEligibility.Split(v);
                if (folder.StartsWith(vf, StringComparison.OrdinalIgnoreCase) &&
                    (FileEligibility.SameStem(stem, vs) || folder[vf.Length..].Split('/').Any(segment =>
                        segment.Equals(vs, StringComparison.OrdinalIgnoreCase)))) return true;
                if (metadata is null || !metadata.ParsedFiles.TryGetValue(sidecar.Index, out var sp) ||
                    !metadata.ParsedFiles.TryGetValue(v.Index, out var vp)) return false;
                var directory = metadata.ParsedDirectories.GetValueOrDefault(sidecar.Index);
                return work.Episodes.Any(e => work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId) is { } s &&
                    (Coordinates(sp, e, s, work) || directory is not null && Coordinates(directory, e, s, work)) &&
                    Coordinates(vp, e, s, work));
            }).ToArray();
            var aloneInFolder = videos.Where(v =>
            {
                var (vf, _) = FileEligibility.Split(v);
                if (!folder.StartsWith(vf, StringComparison.OrdinalIgnoreCase)) return false;
                var segments = folder[vf.Length..].Split('/', StringSplitOptions.RemoveEmptyEntries);
                return (segments.Length == 0 || segments[0].Equals("Subs", StringComparison.OrdinalIgnoreCase) ||
                    segments[0].Equals("Sub", StringComparison.OrdinalIgnoreCase) ||
                    segments[0].Equals("Subtitles", StringComparison.OrdinalIgnoreCase)) &&
                    videos.Count(other => FileEligibility.Split(other).Folder.StartsWith(vf, StringComparison.OrdinalIgnoreCase)) == 1;
            }).ToArray();
            if (named.Length == 1 && kept.Any(v => v.Index == named[0].Index) ||
                named.Length == 0 && aloneInFolder.Length == 1 && kept.Any(v => v.Index == aloneInFolder[0].Index) ||
                named.Length == 0 && videos.Length == 1 && kept.Any(v => v.Index == videos[0].Index))
                result.Add(new(target, sidecar.Index, FileEligibility.SidecarRole(sidecar)!.Value));
        }
        return [.. result];
    }
    private static bool Plausible(long bytes, int? runtime, int? resolution)
    {
        if (bytes < 1024 * 1024) return false;
        if (runtime is not > 0) return true;
        var mbps = bytes * 8d / (runtime.Value * 60d * 1_000_000);
        var minimum = resolution >= 2160 ? 1 : resolution >= 1080 ? .5 : resolution >= 720 ? .3 : .1;
        return mbps >= minimum && mbps <= 100;
    }
    private static string AudioLanguage(PlanInput input) =>
        !string.IsNullOrWhiteSpace(input.AudioLanguage) &&
        !input.AudioLanguage.Equals("auto", StringComparison.OrdinalIgnoreCase)
            ? input.AudioLanguage : "en";

    private static bool LanguageAllowed(ParsedRelease parsed, string? desired)
    {
        if (string.Equals(desired?.Trim(), "any", StringComparison.OrdinalIgnoreCase)) return true;
        if (!parsed.ClearlyForeign && parsed.Foreign != ForeignStatus.Yes) return true;
        var wanted = Language(desired ?? "en");
        var markers = parsed.LanguageMarkers.Select(Language).ToArray();
        return markers.Contains(wanted) || markers.Contains("multi") || markers.Contains("dual");
    }
    private static string LanguageRejection(string desired) => Language(desired) == "en"
        ? "This source explicitly identifies non-English audio. Choose an English, DUAL/MULTI, or unmarked source."
        : "This source clearly identifies a different audio language. Choose a source in your selected language.";
    private static string Language(string marker) => marker.Trim().ToLowerInvariant() switch
    {
        "english" or "eng" => "en", "russian" or "rus" or "lostfilm" => "ru",
        "french" or "fre" or "fra" or "vostfr" or "vf" or "truefrench" => "fr",
        "japanese" or "jpn" or "jp" or "jap" or "raw" or "raws" => "ja",
        "spanish" or "spa" or "esp" or "castellano" => "es", "german" or "ger" or "deu" or "deutsch" => "de",
        "italian" or "ita" => "it", "korean" or "kor" => "ko", "portuguese" or "por" or "ptbr" or "pt br" or "dublado" => "pt",
        "hindi" or "hin" => "hi", "tamil" or "tam" => "ta", "telugu" or "tel" => "te",
        "polish" or "pol" or "pl" => "pl", "dutch" or "dut" => "nl", "turkish" or "tur" => "tr",
        "ukrainian" or "ukr" => "uk", "arabic" or "ara" => "ar",
        "mandarin" or "chinese" or "cantonese" => "zh", _ => marker.Trim().ToLowerInvariant()
    };
}
