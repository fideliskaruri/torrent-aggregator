using System.Collections.Immutable;
using System.Text;
using TorrentFlow.Domain;

namespace TorrentFlow.Plan;

public sealed partial class ReleasePlanner : IPlan
{
    private sealed record Option(Candidate Candidate, TargetRow? Target,
        ImmutableArray<SelectedFile> Files, long? PieceLength, int ResolutionClass,
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
            { Refuse("invalid_hash", "This source has no valid torrent hash."); continue; }
            if (!raw && (input.Work is null || !Identity(parsed.Title, input.Work)))
            { Refuse("wrong_work", "The source name does not match this title's catalog names."); continue; }
            if (!raw && input.Work!.Work.Kind == WorkKind.Film &&
                (parsed.Kind != ReleaseKind.Movie || parsed.Pack || !parsed.Episodes.IsEmpty || !parsed.AbsoluteNumbers.IsEmpty))
            { Refuse("wrong_kind", "This is not a single-film source."); continue; }
            if (!raw && input.Work!.Work.Kind == WorkKind.Film &&
                parsed.Year is { } year && input.Work.Work.Year is { } expected && year != expected)
            {
                Refuse("wrong_year", $"The source is from {year}; this film was released in {expected}.");
                var knownFiles = release.Files;
                if (knownFiles is { } list && FileEligibility.Safety(list, false) is { } fileProblem)
                    Refuse(fileProblem.Code, fileProblem.Text);
                continue;
            }
            if (parsed.Unsafe || parsed.Sample || parsed.Cam || parsed.Kind == ReleaseKind.Other && !raw)
            { Refuse("junk_release", "This source is a sample, camera recording, or non-feature video."); continue; }
            if (!raw && targets.Length > 0 && targets.All(t => !LanguageAllowed(parsed, AudioLanguage(input))))
            {
                foreach (var target in targets)
                    Refuse("foreign_language", LanguageRejection(AudioLanguage(input)),
                        target.Id);
                continue;
            }
            var files = release.Files;
            if (files is null || files.Value.IsDefaultOrEmpty)
            { Refuse("metadata_required", "A complete file list is needed before selecting this source."); continue; }
            var pack = parsed.Pack || parsed.Kind is ReleaseKind.SeasonPack or ReleaseKind.MultiSeason or ReleaseKind.CompleteSeries;
            var safety = FileEligibility.Safety(files.Value, pack);
            if (safety is { } problem) { Refuse(problem.Code, problem.Text); continue; }
            if (input.Blocks.Any(b => b.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase) &&
                (b.WorkKey is null || b.WorkKey == input.Work?.Work.WorkKey) && (b.Until is null || b.Until > input.Now)))
            { Refuse("blocked_hash", "This source is blocked for this title or for every title."); continue; }
            var metadata = input.FileMetadata.FirstOrDefault(m => m.Hash.Equals(release.Id, StringComparison.OrdinalIgnoreCase));
            var videos = files.Value.Where(f => FileEligibility.IsVideo(f) && !FileEligibility.IsExtra(f)).ToArray();
            if (!raw && targets.Length == 0)
            { Refuse("no_targets", "No catalog items were requested for this source."); continue; }
            if (raw)
            {
                if (parsed.ClearlyForeign || parsed.Foreign == ForeignStatus.Yes)
                { Refuse("foreign_language", "This source clearly identifies a foreign language."); continue; }
                var selected = input.OwnerSelectedFiles.IsDefaultOrEmpty ? videos.Select(f => f.Index).ToHashSet() :
                    input.OwnerSelectedFiles.ToHashSet();
                if (selected.Any(i => !files.Value.Any(f => f.Index == i)) ||
                    !videos.Any(f => selected.Contains(f.Index)))
                { Refuse("no_selected_video", "Select at least one video using valid file indices."); continue; }
                var selection = files.Value.Where(f => selected.Contains(f.Index)).Select(f =>
                    new SelectedFile(null, f.Index, FileEligibility.IsVideo(f) ? FileRole.Video :
                        FileEligibility.SidecarRole(f) ?? FileRole.Unwanted)).ToImmutableArray();
                options.Add(new(candidate, null, selection, metadata?.PieceLength, 0, 0,
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
                { Refuse("owner_pick", "The owner chose a different source for this item.", target.Id); continue; }
                var ownerPick = target.PickedReleaseHash == release.Id;
                if (!ownerPick && target.MinListedSeeders is { } minimum &&
                    (candidate.TrustedSeeders ?? -1) < minimum)
                { Refuse("minimum_seeders", "This source does not meet the rule's minimum seed count.", target.Id); continue; }
                if (target.WorkId != input.Work!.Work.Id)
                { Refuse("wrong_target_work", "The target belongs to a different title.", target.Id); continue; }
                var owned = input.Owned.Where(o => o.WorkId == target.WorkId && o.EpisodeId == target.EpisodeId)
                    .SelectMany(o => o.Videos).Where(v => v.Role == FileRole.Video &&
                        (v.Status is FilePresence.Present or FilePresence.Offline ||
                         v.Status == FilePresence.Missing && v.MissingConfirmedAt is null)).ToArray();
                if (owned.Length > 0)
                { Refuse("already_owned", "This item is already in your library.", target.Id); continue; }
                if (target.State == TargetState.Removed || target.IsPaused() ||
                    target.State == TargetState.Done && target.Kind == TargetKind.Acquire)
                { Refuse("inactive_target", "This item is not asking for a download.", target.Id); continue; }
                var episode = input.Work.Episodes.FirstOrDefault(e => e.Id == target.EpisodeId);
                var season = input.Work.Seasons.FirstOrDefault(s => s.Id == episode?.SeasonId);
                if (target.EpisodeId is not null && (episode?.MappingStatus != MappingStatus.Confirmed || season?.MappingStatus != MappingStatus.Confirmed))
                { Refuse("mapping_unconfirmed", "The catalog has not confirmed this episode's numbering.", target.Id); continue; }
                if (pack && (season is null || !Finished(input.Work, season, input.Now)))
                { Refuse("season_unfinished", "A season pack is only selected when every episode has aired.", target.Id); continue; }
                if (!pack && episode is not null && !Coordinates(parsed, episode, season!, input.Work))
                { Refuse("wrong_episode", "The source numbers do not identify this exact episode.", target.Id); continue; }
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
                var fileResolution = parsed.Quality.Resolution ??
                    (fileParses.All(p => p?.Quality.Resolution is not null) ? fileParses.Min(p => p!.Quality.Resolution) : null);
                var resolution = parsed.Quality.Resolution;
                if (!ownerPick && floor is not null && (resolution is null || resolution < floor))
                { Refuse("quality_floor", $"This item requires at least {floor}p.", target.Id); continue; }
                var language = AudioLanguage(input);
                if (!LanguageAllowed(parsed, language) || fileParses.Any(p => p is not null && !LanguageAllowed(p, language)))
                { Refuse("foreign_language", LanguageRejection(language), target.Id); continue; }
                var runtime = episode?.RuntimeMinutes ?? input.Work.Work.RuntimeMinutes;
                var cap = target.MaxBytes ?? preference?.MaxBytesPerItem;
                var selection = SelectFiles(target.Id, kept, files.Value, metadata, input.Work);
                var selectedIndices = selection.Select(f => f.FileIndex).ToHashSet();
                var bytes = files.Value.Where(f => selectedIndices.Contains(f.Index)).Aggregate(0d, (sum, f) => sum + f.Bytes);
                if (!ownerPick && cap is not null && bytes > cap)
                { Refuse("size_cap", "The selected item's video exceeds your size limit.", target.Id); continue; }
                var implausible = kept.Any(f => ownerPick ? f.Bytes < 1024 * 1024 : !Plausible(f.Bytes, runtime, fileResolution));
                if (implausible)
                { Refuse("implausible_size", "The video's size is not plausible for its runtime and quality.", target.Id); continue; }
                options.Add(new(candidate, target, selection, metadata?.PieceLength,
                    resolution == preferred ? 0 : resolution > preferred ? 1 : resolution is not null ? 2 : 3,
                    resolution is null ? int.MaxValue : Math.Abs(resolution.Value - preferred),
                    SourceRank(parsed.Quality.Source), resolution));
            }
        }
        return Select(input, targets, options, rejections);
    }


}
