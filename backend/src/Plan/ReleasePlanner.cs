using System.Collections.Immutable;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Plan;

public sealed class ReleasePlanner : IPlan
{
    private sealed record Option(Candidate Candidate, SwarmEvidence? Evidence, HealthBand Band,
        TargetRow? Target, ImmutableArray<SelectedFile> Files, long? PieceLength, int ResolutionClass,
        int ResolutionDistance, int Source, int? Resolution);

    public PlanResult Choose(PlanInput input)
    {
        var rejections = new List<Rejection>();
        var options = new List<Option>();
        var targets = input.Targets.DistinctBy(t => t.Id).ToArray();
        var raw = input.Mode == AcquisitionMode.ExplicitRaw;
        foreach (var candidate in input.Pool.DistinctBy(c => c.Release.Id, StringComparer.OrdinalIgnoreCase))
        {
            var release = candidate.Release;
            var parsed = release.Parsed;
            void Refuse(string code, string text, string? target = null) =>
                rejections.Add(new(release.Id, target, code, text));
            if (release.Id.Length != 40 || release.Id.Any(c => !char.IsAsciiHexDigit(c)))
            { Refuse("invalid_hash", "This release has no valid torrent hash."); continue; }
            if (!raw && (input.Work is null || !Identity(parsed.Title, input.Work)))
            { Refuse("wrong_work", "The release name does not match this title's catalog names."); continue; }
            if (!raw && input.Work!.Work.Kind == WorkKind.Film &&
                (parsed.Kind != ReleaseKind.Movie || parsed.Pack || !parsed.Episodes.IsEmpty || !parsed.AbsoluteNumbers.IsEmpty))
            { Refuse("wrong_kind", "This is not a single film release."); continue; }
            if (!raw && input.Work!.Work.Kind == WorkKind.Film &&
                parsed.Year is { } year && input.Work.Work.Year is { } expected && year != expected)
            {
                Refuse("wrong_year", $"The release year is {year}; this film was released in {expected}.");
                var knownFiles = input.Evidence.Where(e => e.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(e => e.CheckedAt).FirstOrDefault()?.Files ?? release.Files;
                if (knownFiles is { } list && FileEligibility.Safety(list, false) is { } fileProblem)
                    Refuse(fileProblem.Code, fileProblem.Text);
                continue;
            }
            if (parsed.Unsafe || parsed.Sample || parsed.Cam || parsed.Kind == ReleaseKind.Other && !raw)
            { Refuse("junk_release", "This release is a sample, camera recording, or non-feature release."); continue; }
            var evidence = input.Evidence.Where(e => e.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(e => e.CheckedAt).FirstOrDefault();
            var files = evidence?.Files ?? release.Files;
            if (files is null || files.Value.IsDefaultOrEmpty)
            { Refuse("metadata_required", "A complete file list is needed before selecting this release."); continue; }
            var pack = parsed.Pack || parsed.Kind is ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries;
            var safety = FileEligibility.Safety(files.Value, pack);
            if (safety is { } problem) { Refuse(problem.Code, problem.Text); continue; }
            if (input.Blocks.Any(b => b.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase) &&
                (b.WorkKey is null || b.WorkKey == input.Work?.Work.WorkKey) && (b.Until is null || b.Until > input.Now)))
            { Refuse("blocked_hash", "This release is blocked for this title or for every title."); continue; }
            var band = evidence is not null && evidence.CheckedAt <= input.Now && evidence.ExpiresAt > input.Now
                ? evidence.Band : HealthBand.Unknown;
            if (band == HealthBand.Dead) { Refuse("dead_swarm", "The measured swarm delivered no valid data."); continue; }
            if (band == HealthBand.Unknown && !input.QueriesExhausted)
            { Refuse("unknown_deferred", "Other names and sources must be tried before a release with unknown health."); continue; }
            var metadata = input.FileMetadata.FirstOrDefault(m => m.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase));
            var videos = files.Value.Where(f => FileEligibility.IsVideo(f) && !FileEligibility.IsExtra(f)).ToArray();
            if (!raw && targets.Length == 0)
            { Refuse("no_targets", "No catalog items were requested for this release."); continue; }
            if (raw)
            {
                if (parsed.ClearlyForeign || parsed.Foreign == ForeignStatus.Yes)
                { Refuse("foreign_language", "This release clearly identifies a foreign language."); continue; }
                var selected = input.OwnerSelectedFiles.IsDefaultOrEmpty ? videos.Select(f => f.Index).ToHashSet() :
                    input.OwnerSelectedFiles.ToHashSet();
                if (selected.Any(i => !files.Value.Any(f => f.Index == i)) ||
                    !videos.Any(f => selected.Contains(f.Index)))
                { Refuse("no_selected_video", "Select at least one video using valid file indices."); continue; }
                var selection = files.Value.Where(f => selected.Contains(f.Index)).Select(f =>
                    new SelectedFile(null, f.Index, FileEligibility.IsVideo(f) ? FileRole.Video :
                        FileEligibility.SidecarRole(f) ?? FileRole.Unwanted)).ToImmutableArray();
                options.Add(new(candidate, evidence, band, null, selection, metadata?.PieceLength, 0, 0,
                    SourceRank(parsed.Quality.Source), parsed.Quality.Resolution));
                continue;
            }
            var mapped = MapFiles(input.Work!, files.Value, metadata, parsed, pack);
            if (mapped.Fatal is { } fatal) { Refuse(fatal.Code, fatal.Text); continue; }
            var wantedSeasons = targets.Select(t => input.Work!.Episodes.FirstOrDefault(e => e.Id == t.EpisodeId)?.SeasonId)
                .Where(id => id is not null).Distinct().ToArray();
            if (pack && wantedSeasons.Length == 1 && metadata is not null &&
                input.Work!.Seasons.FirstOrDefault(s => s.Id == wantedSeasons[0]) is { } requestedSeason &&
                videos.Any(v => metadata.ParsedFiles.TryGetValue(v.Index, out var fp) && fp.Seasons.Any(s => s != requestedSeason.Number)))
            { Refuse("other_season_file", "The pack contains videos from a different season."); continue; }
            foreach (var target in targets)
            {
                if (target.PickedReleaseHash is { } picked && picked != release.Id)
                { Refuse("owner_pick", "The owner chose a different release for this item.", target.Id); continue; }
                if (target.MinListedSeeders is { } minimum &&
                    (evidence?.ScrapedSeeders ?? candidate.TrustedSeeders ?? -1) < minimum)
                { Refuse("minimum_seeders", "This release does not meet the rule's minimum seed count.", target.Id); continue; }
                if (target.WorkId != input.Work!.Work.Id)
                { Refuse("wrong_target_work", "The target belongs to a different title.", target.Id); continue; }
                var owned = input.Owned.Where(o => o.WorkId == target.WorkId && o.EpisodeId == target.EpisodeId)
                    .SelectMany(o => o.Videos).Where(v => v.Role == FileRole.Video &&
                        (v.Status is FilePresence.Present or FilePresence.Offline ||
                         v.Status == FilePresence.Missing && v.MissingConfirmedAt is null)).ToArray();
                if (target.Kind == TargetKind.Acquire && owned.Length > 0)
                { Refuse("already_owned", "This item is already in your library.", target.Id); continue; }
                if (target.State is TargetState.Removed or TargetState.Paused || target.State == TargetState.Done && target.Kind == TargetKind.Acquire)
                { Refuse("inactive_target", "This item is not asking for a download.", target.Id); continue; }
                var episode = input.Work.Episodes.FirstOrDefault(e => e.Id == target.EpisodeId);
                var season = input.Work.Seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
                if (target.EpisodeId is not null && (episode?.MappingStatus != MappingStatus.Confirmed || season?.MappingStatus != MappingStatus.Confirmed))
                { Refuse("mapping_unconfirmed", "The catalog has not confirmed this episode's numbering.", target.Id); continue; }
                if (pack && (season is null || !Finished(input.Work, season, input.Now)))
                { Refuse("season_unfinished", "A season pack is only selected when every episode has aired.", target.Id); continue; }
                if (!pack && episode is not null && !Coordinates(parsed, episode, season!, input.Work))
                { Refuse("wrong_episode", "The release numbers do not identify this exact episode.", target.Id); continue; }
                if (!pack && episode is not null && metadata is not null && videos.Any(v =>
                    metadata.ParsedFiles.TryGetValue(v.Index, out var fp) &&
                    (!fp.Seasons.IsEmpty || !fp.Episodes.IsEmpty || !fp.AbsoluteNumbers.IsEmpty || !fp.Ranges.IsEmpty) &&
                    !Coordinates(fp, episode, season!, input.Work)))
                { Refuse("wrong_file_episode", "The video's numbers do not identify this exact episode.", target.Id); continue; }
                TorrentFile[] kept;
                if (episode is null)
                {
                    var largest = videos.OrderByDescending(v => v.Bytes).FirstOrDefault();
                    kept = largest is null ? [] : videos.Where(v => (double)v.Bytes * 2 >= largest.Bytes).ToArray();
                }
                else if (pack) kept = mapped.Files.TryGetValue(episode.Id, out var video) ? [video] : [];
                else kept = videos.Length == 1 ? videos : mapped.Files.TryGetValue(episode.Id, out var single) ? [single] : [];
                if (kept.Length == 0)
                { Refuse("file_mapping_uncertain", "There is no unique video file for this item.", target.Id); continue; }
                var preference = input.Preference?.WorkId == target.WorkId ? input.Preference : null;
                var floor = target.ResolutionFloor ?? preference?.ResolutionFloor;
                var preferred = target.PreferredResolution ?? preference?.PreferredResolution ?? floor ?? 1080;
                var fileParses = kept.Select(f => metadata?.ParsedFiles.GetValueOrDefault(f.Index)).ToArray();
                var resolution = parsed.Quality.Resolution ??
                    (fileParses.All(p => p?.Quality.Resolution is not null) ? fileParses.Min(p => p!.Quality.Resolution) : null);
                if (floor is not null && (resolution is null || resolution < floor))
                { Refuse("quality_floor", $"This item requires at least {floor}p.", target.Id); continue; }
                if (target.Kind == TargetKind.Replace)
                {
                    var best = owned.Select(v => v.Resolution ?? 0).DefaultIfEmpty(0).Max();
                    if (owned.Length == 0 || resolution is null || best == 0 ||
                        (target.ReplacementMode == ReplacementMode.Upgrade ? resolution <= best : resolution < best))
                    { Refuse("replacement_quality", "A replacement must retain the existing quality; an upgrade must improve it.", target.Id); continue; }
                }
                var language = target.AudioLanguage ?? preference?.AudioLanguage ?? input.Work.Work.OriginalLanguage;
                if (!LanguageAllowed(parsed, language) || fileParses.Any(p => p is not null && !LanguageAllowed(p, language)))
                { Refuse("foreign_language", "This release clearly identifies a different audio language.", target.Id); continue; }
                var runtime = episode?.RuntimeMinutes ?? input.Work.Work.RuntimeMinutes;
                var cap = target.MaxBytes ?? preference?.MaxBytesPerItem;
                var selection = SelectFiles(target.Id, kept, files.Value, metadata, input.Work);
                var selectedIndices = selection.Select(f => f.FileIndex).ToHashSet();
                var bytes = files.Value.Where(f => selectedIndices.Contains(f.Index)).Aggregate(0d, (sum, f) => sum + f.Bytes);
                if (cap is not null && bytes > cap)
                { Refuse("size_cap", "The selected item's video exceeds your size limit.", target.Id); continue; }
                var implausible = kept.Any(f => !Plausible(f.Bytes, runtime, resolution));
                if (implausible)
                { Refuse("implausible_size", "The video's size is not plausible for its runtime and quality.", target.Id); continue; }
                options.Add(new(candidate, evidence, band, target, selection, metadata?.PieceLength,
                    resolution == preferred ? 0 : resolution > preferred ? 1 : resolution is not null ? 2 : 3,
                    resolution is null ? int.MaxValue : Math.Abs(resolution.Value - preferred),
                    SourceRank(parsed.Quality.Source), resolution));
            }
        }
        return Select(input, targets, options, rejections);
    }

    private static PlanResult Select(PlanInput input, TargetRow[] targets, List<Option> options, List<Rejection> rejections)
    {
        var missing = targets.Where(t => !(t.Kind == TargetKind.Acquire && input.Owned.Any(o =>
                o.WorkId == t.WorkId && o.EpisodeId == t.EpisodeId && o.Videos.Any(v => v.Role == FileRole.Video &&
                    (v.Status is FilePresence.Present or FilePresence.Offline ||
                     v.Status == FilePresence.Missing && v.MissingConfirmedAt is null)))))
            .Select(t => t.Id).ToHashSet(StringComparer.Ordinal);
        var picked = new List<Option>();
        while (options.Count > 0)
        {
            var eligible = options.Where(o => o.Target is null || missing.Contains(o.Target.Id)).ToArray();
            if (eligible.Length == 0) break;
            var seasonCover = input.Work?.Work.Kind == WorkKind.Series && eligible.Any(o =>
                o.Candidate.Release.Parsed.Pack || o.Candidate.Release.Parsed.Kind is
                    ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries);
            var best = eligible.OrderBy(o => BandRank(o.Band))
                .ThenByDescending(o => o.Band == HealthBand.Unknown ? 0 : o.Evidence?.ByteSendingPeers ?? 0)
                .ThenByDescending(o => o.Band == HealthBand.Unknown ? 0 : Delivery(o.Evidence))
                .ThenBy(o => o.ResolutionClass).ThenBy(o => o.ResolutionDistance).ThenByDescending(o => o.Source)
                .ThenByDescending(o => Coverage(o, eligible))
                .ThenBy(o => seasonCover ? Reservation(o, eligible) : 0)
                .ThenByDescending(o => o.Candidate.Observations.Select(v => v.UploadedAt).Max())
                .ThenByDescending(o => o.Candidate.ConservativeListedSeeders ?? -1)
                .ThenBy(o => o.Candidate.Release.Id, StringComparer.Ordinal).First();
            // Choose the best option for an item. The next pass considers the remaining scope,
            // so a pack's weaker per-item policy never displaces a stronger single.
            picked.Add(best);
            if (best.Target is null) break;
            missing.Remove(best.Target.Id);
            options.Remove(best);
        }
        foreach (var option in options.Where(o => o.Target is null || !missing.Contains(o.Target.Id)))
            if (!picked.Contains(option))
                rejections.Add(new(option.Candidate.Release.Id, option.Target?.Id,
                    option.Band == HealthBand.Unknown && picked.Any(p => p.Target?.Id == option.Target?.Id && p.Band != HealthBand.Unknown)
                        ? "healthier_alternative" : "lower_ranked",
                    "Another eligible release has stronger health or a better quality and coverage fit."));
        var assignments = picked.GroupBy(o => o.Candidate.Release.Id, StringComparer.OrdinalIgnoreCase).Select(g =>
        {
            var first = g.First();
            var files = g.SelectMany(o => o.Files).Distinct().ToImmutableArray();
            var torrentFiles = first.Evidence?.Files ?? first.Candidate.Release.Files ?? [];
            var text = first.Band == HealthBand.Unknown
                ? input.UnknownFallbackReason ?? "Safe files and all alternatives exhausted. Waiting for seeders."
                : $"{first.Band} measured health ({first.Evidence?.ByteSendingPeers ?? 0} byte-sending peers, {Delivery(first.Evidence):0} bytes/s); " +
                  (first.Resolution is { } resolution ? $"{resolution}p quality fit ({QualityFit(first.ResolutionClass)}); " : "quality not stated; ") +
                  $"{first.Candidate.Release.Parsed.Quality.Source ?? "source not stated"}; {g.Count()} missing item(s) covered.";
            return new Assignment(g.Key, [.. g.Where(o => o.Target is not null).Select(o => o.Target!.Id)],
                files, FileEligibility.Reservation(torrentFiles, files.Select(f => f.FileIndex), first.PieceLength), text);
        }).ToImmutableArray();
        foreach (var target in targets.Where(t => missing.Contains(t.Id)))
            rejections.Add(new("", target.Id, "uncovered_item",
                "No eligible release was selected for this item. Review the release reasons or try again later."));
        return new(assignments, [.. rejections], [.. targets.Where(t => missing.Contains(t.Id)).Select(t => t.Id)]);

        int Coverage(Option o, Option[] available) => available.Where(x => SameRank(o, x) &&
            x.Candidate.Release.Id == o.Candidate.Release.Id).Select(x => x.Target?.Id).Distinct().Count();
        long Reservation(Option o, Option[] available)
        {
            var selection = available.Where(x => SameRank(o, x) && x.Candidate.Release.Id == o.Candidate.Release.Id)
                .SelectMany(x => x.Files).Select(f => f.FileIndex);
            return FileEligibility.Reservation(o.Evidence?.Files ?? o.Candidate.Release.Files ?? [], selection, o.PieceLength);
        }
    }

    private static bool SameRank(Option a, Option b) => a.Band == b.Band &&
        a.ResolutionClass == b.ResolutionClass && a.ResolutionDistance == b.ResolutionDistance && a.Source == b.Source;
    private static string QualityFit(int fit) => fit switch
        { 0 => "preferred", 1 => "nearest above preferred", 2 => "below preferred, no better eligible option", _ => "not stated" };
    private static int BandRank(HealthBand band) => band switch { HealthBand.Good => 0, HealthBand.Weak => 1, _ => 2 };
    private static double Delivery(SwarmEvidence? e) => e is null || e.Window.TotalSeconds <= 0 ? 0 : e.BytesDelivered / e.Window.TotalSeconds;
    private static int SourceRank(string? source) => source?.ToLowerInvariant().Replace("-", "").Replace(" ", "") switch
        { "remux" => 6, "bluray" or "bdrip" => 5, "webdl" => 4, "webrip" => 3, "hdtv" => 2, "dvdrip" or "dvd" => 1, _ => 0 };
    private static bool Identity(string title, WorkSnapshot work)
    {
        var normalized = Normalize(title);
        return normalized.Length > 0 && work.Names.Where(n => n.Authoritative &&
            (n.LinkId is null || work.Links.Any(l => l.Id == n.LinkId && l.Status == LinkStatus.Verified)))
            .Any(n => Normalize(n.Value) == normalized);
    }
    private static string Normalize(string value) => string.Concat(value.Normalize(NormalizationForm.FormKC)
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
            if (pack && parsed.Seasons.Any(s => !release.Seasons.IsEmpty && !release.Seasons.Contains(s)))
                return new([], ("other_season_file", "The pack contains videos from a different season."));
            var matches = work.Episodes.Where(e => e.MappingStatus == MappingStatus.Confirmed &&
                work.Seasons.FirstOrDefault(s => s.Id == e.SeasonId) is { MappingStatus: MappingStatus.Confirmed } season &&
                Coordinates(parsed, e, season, work)).ToArray();
            // Seasonless pack videos need a catalog-proven absolute map, not an inferred S1.
            if (pack && parsed.Seasons.IsEmpty &&
                (parsed.AbsoluteNumbers.Length != 1 || matches.Length != 1 || matches[0].AbsoluteNumber != parsed.AbsoluteNumbers[0]))
                continue;
            if (matches.Length != 1) continue;
            if (!found.TryGetValue(matches[0].Id, out var list)) found[matches[0].Id] = list = [];
            list.Add(file);
        }
        return new(found.Where(p => p.Value.Count == 1).ToDictionary(p => p.Key, p => p.Value[0]), null);
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
    private static bool LanguageAllowed(ParsedRelease parsed, string? desired)
    {
        if (!parsed.ClearlyForeign && parsed.Foreign != ForeignStatus.Yes) return true;
        var wanted = Language(desired ?? "en");
        var markers = parsed.LanguageMarkers.Select(Language).ToArray();
        return markers.Contains(wanted) || markers.Contains("multi") && markers.Contains("en");
    }
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
