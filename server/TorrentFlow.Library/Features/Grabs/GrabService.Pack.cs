using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Core.Text;
using TorrentFlow.Data;
using TorrentFlow.Library.Features.Common;
using TorrentFlow.Library.Features.Watchlist;

namespace TorrentFlow.Library.Features.Grabs;

/// <summary>A season pack admission: the chosen file indexes, the bytes of the pieces they touch, and the queue position.</summary>
internal sealed record PackSelection(IReadOnlyList<int> Files, long ReserveBytes, string QueueKey);

/// <param name="Claimed">Episode number to the pack file index it now owns.</param>
/// <param name="Detail">What happened, for the activity log and the wanted list.</param>
public sealed record SeasonPackOutcome(string? InfoHash, IReadOnlyDictionary<int, int> Claimed, string Detail, string? Title = null);

public sealed partial class GrabService
{
    /// <summary>
    /// Season pack fallback (docs/season-pack-fallback.md, v1). Runs the same stages as the single-episode grab
    /// (<see cref="Prepare"/> for identity and settings, <see cref="SearchRung"/>, the work identity check,
    /// <see cref="Eligible"/>, then <see cref="Send"/> for admission) with a pack query, a file-list verifier and a
    /// chosen file set. Every pack is inspected before anything is admitted; only files that map to a still-missing
    /// episode are claimed (compare-and-set) and downloaded.
    /// </summary>
    /// <param name="targets">Missing episode number to its wanted target key; only these may be claimed.</param>
    public async Task<SeasonPackOutcome> SeasonPack(GrabInput input, int season, IReadOnlyDictionary<int, string> targets, int maxProbes,
        CancellationToken ct)
    {
        if (targets.Count == 0) return new(null, new Dictionary<int, int>(), "nothing missing");
        var query = $"{Apostrophes.Normalize(input.Title)} S{season:00}";
        await using var db = await factory.CreateDbContextAsync(ct);
        var (prepared, settings, floor, refusal) = await Prepare(db, input with { Cursor = new EpisodeCursor(season, targets.Keys.Min()) }, query, ct);
        if (refusal != null) return new(null, new Dictionary<int, int>(), refusal.Message);
        input = prepared with { Cursor = null };
        var accepted = (input.Aliases ?? []).Prepend(input.Title).SelectMany(EpisodeLadder.AliasTitleForms).ToList();
        var candidates = new List<(TorrentResult Release, LadderRung Rung)>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var refused = false;
        foreach (var rung in EpisodeLadder.BuildPackRungs(input.Title, season, input.MediaType, input.Aliases, floor))
        {
            var (raw, failure) = await SearchRung(input, rung, floor, applyMaxSize: false, ct);
            refused |= failure != null || raw.Sources.Any(s => s.Error != null);
            var packs = raw.Results.Where(r => EpisodeLadder.ReleaseMatchesWork(r, accepted, null) && EpisodeRejections.IsPackFor(r, season) &&
                r.Seeders >= 1 && !string.IsNullOrEmpty(r.Magnet ?? r.TorrentUrl ?? r.InfoHash));
            foreach (var pack in Eligible(input, floor, packs, applyMaxSize: false))
                if (seen.Add(EpisodeLadder.CandidateKey(pack))) candidates.Add((pack, rung));
        }
        // The English rule: Pass packs are probed first, Unknown ones only when no healthy Pass pack exists, Fail ones never.
        // A pack an index listed (AnimeTosho tracks, an apibay file list) is judged like an inspected one: only its files that
        // map to missing episodes, each with its own sidecars and tracks. Otherwise its name decides.
        var before = candidates.ToDictionary(c => EpisodeLadder.CandidateKey(c.Release), c => ListedCall(input, c.Release, season, targets.Keys),
            StringComparer.Ordinal);
        EnglishVerdict Listed((TorrentResult Release, LadderRung Rung) c) => before[EpisodeLadder.CandidateKey(c.Release)].Verdict;
        candidates = candidates.Where(c => Listed(c) != EnglishVerdict.Fail).OrderBy(Listed).ToList();
        var healthyPass = candidates.Any(c => Listed(c) == EnglishVerdict.Pass && c.Release.Seeders >= LanguageHold.HealthySeeders);
        if (healthyPass) candidates = candidates.Where(c => Listed(c) == EnglishVerdict.Pass).ToList();
        var notes = new List<string>();
        (TorrentResult Release, EngineInspectResult Files, PackFileMapping Map, LadderRung Rung, LanguageCall Call)? best = null;
        foreach (var (candidate, rung) in candidates.Take(Math.Max(1, maxProbes)))
        {
            var inspected = await engine.InspectAsync(new(candidate.Magnet, candidate.TorrentUrl, candidate.InfoHash, candidate.Title), ct);
            if (!inspected.Ok) { notes.Add($"{candidate.Title}: {inspected.Failure}"); continue; }
            var files = inspected.Files.Select(f => new PackFile(f.Index, f.Path, f.Length, f.Offset)).ToList();
            var map = SeasonPackFiles.Map(files, season, targets.Keys.ToArray());
            // The caller's single-release size limit applies to each chosen file, never to the whole pack.
            if (map.Ok && input.Constraints?.MaxSizeBytes is { } max)
                map = map with { Episodes = map.Episodes.Where(e => files[e.Value].Length <= max).ToDictionary() };
            // A pack stands in for every missing episode, so each mapped file is judged with only its own subtitle and audio
            // files and the tracks an index listed for it, and the worst one is the pack's call (docs/release-language.md).
            // Unmapped files (extras, a creditless OP) never count. The name alone decides only when no file maps: once the
            // episodes' files are known, they speak for the pack (a VOSTFR-named pack whose episodes carry English sidecars
            // passes), and a hint about the whole torrent never overrides them.
            var call = PackCall(input, candidate, files, map.Episodes.Values);
            logger?.LogInformation("Season pack {Title} ({Hash}): {Mapped} of {Missing} missing episodes map; {Language}; {Rejection} {Notes}",
                candidate.Title, inspected.Hash, map.Episodes.Count, targets.Count, call.Label, map.Rejection ?? "", string.Join("; ", map.Notes.Take(8)));
            if (!map.Ok || map.Episodes.Count == 0) { notes.Add($"{candidate.Title}: {map.Rejection ?? "no_episodes"}"); continue; }
            if (call.Verdict == EnglishVerdict.Fail || healthyPass && call.Verdict != EnglishVerdict.Pass)
            {
                notes.Add($"{candidate.Title}: {call.English.Reason}");
                continue;
            }
            if (best == null || call.Verdict < best.Value.Call.Verdict ||
                best.Value.Call.Verdict == call.Verdict && map.Episodes.Count > best.Value.Map.Episodes.Count)
                best = (candidate, inspected, map, rung, call);
            if (call.Verdict == EnglishVerdict.Pass && map.Episodes.Count == targets.Count) break;
        }
        if (best is not { } chosen)
        {
            var detail = candidates.Count == 0
                ? refused ? "season pack search refused by a site" : "no season packs found"
                : $"{Math.Min(candidates.Count, Math.Max(1, maxProbes))} season packs checked, none usable ({string.Join("; ", notes.Take(4))})";
            return new(null, new Dictionary<int, int>(), detail);
        }
        var hash = chosen.Files.Hash!;
        var inspectedFiles = chosen.Files.Files.Select(f => new PackFile(f.Index, f.Path, f.Length, f.Offset)).ToList();
        var claimed = await ClaimAsync(db, hash, chosen.Map.Episodes, targets, inspectedFiles, ct);
        if (claimed.Count == 0) return new(null, claimed, "every episode the pack covers was taken meanwhile");
        // The selection and reservation come from what was really claimed, not from what the pack could cover. Each claimed
        // episode downloads with its own subtitle and audio files (VideoSidecars), so they are kept with it.
        var listed = inspectedFiles.Select(f => (f.Index, f.Path, f.Length)).ToList();
        var kept = claimed.Values.SelectMany(index => VideoSidecars.Of(listed.First(f => f.Index == index), listed).Select(f => f.Index).Prepend(index))
            .Distinct().Order().ToArray();
        var selection = new PackSelection(kept, SeasonPackFiles.PieceSpanBytes(inspectedFiles, chosen.Files.PieceLength, kept),
            new EpisodeCursor(season, claimed.Keys.Min()).QueueKey);
        var sent = await Send(db, settings!, input, query, chosen.Release with { InfoHash = hash }, null, relaxed: false, ct, selection,
            new(SendContext.RungLabel(chosen.Rung), chosen.Call));
        if (!sent.Ok || !string.Equals(sent.InfoHash, hash, StringComparison.OrdinalIgnoreCase))
        {
            await ReleaseClaimsAsync(db, hash, ct);
            return new(null, new Dictionary<int, int>(), $"season pack {chosen.Release.Title} could not start: {sent.Message}");
        }
        return new(hash, claimed, $"downloading {claimed.Count} missing episode{(claimed.Count == 1 ? "" : "s")} from season pack {chosen.Release.Title}",
            chosen.Release.Title);
    }

    /// <summary>
    /// A season pack's language call from a file list (the torrent's own after inspection, an index's before): the worst
    /// of the files mapped to missing episodes, each judged with only its own sidecars (<see cref="VideoSidecars.Of"/>) and
    /// the tracks an index listed for it (<see cref="LanguageHint.TracksFor"/>), as the engine judges the files. Unmapped
    /// files never count. No mapped file: the release's own call (its name, or what an index told about the torrent).
    /// </summary>
    private static LanguageCall PackCall(GrabInput input, TorrentResult pack, IReadOnlyList<PackFile> files, IEnumerable<int> mapped)
    {
        var selected = mapped.ToHashSet();
        if (selected.Count == 0) return Judge(input, pack);
        var list = files.Select(f => (f.Index, f.Path, f.Length)).ToList();
        return LanguageCall.From(ReleaseLanguage.JudgeRelease(WantOf(input), pack.Title, pack.Category, list, selected,
            index => pack.LanguageHint?.TracksFor(list.First(f => f.Index == index).Path)));
    }

    /// <summary>A pack's call before inspection: an index's file list mapped like an inspected one, else the release's own call.</summary>
    private static LanguageCall ListedCall(GrabInput input, TorrentResult pack, int season, IEnumerable<int> missing)
    {
        if (pack.LanguageHint is not { Files.Count: > 0 } hint) return Judge(input, pack);
        var files = hint.Files.Select((f, i) => new PackFile(i, f.Path, f.Size, 0)).ToList();
        return PackCall(input, pack, files, SeasonPackFiles.Map(files, season, missing.ToArray()).Episodes.Values);
    }

    /// <summary>
    /// Compare-and-set claim: an episode is taken only while its target is still wanted ("queued", no transfer). A
    /// target something else started meanwhile is left alone and its file is not downloaded.
    /// </summary>
    private static async Task<Dictionary<int, int>> ClaimAsync(TorrentFlowDbContext db, string hash, IReadOnlyDictionary<int, int> episodes,
        IReadOnlyDictionary<int, string> targets, IReadOnlyList<PackFile> files, CancellationToken ct)
    {
        var claimed = new Dictionary<int, int>();
        var now = DateTime.UtcNow;
        await using var tx = await db.Database.BeginTransactionAsync(ct);
        foreach (var (episode, index) in episodes)
        {
            if (!targets.TryGetValue(episode, out var key)) continue;
            var path = files[index].Path;
            var rows = await db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.TargetKey == key && t.Status == "queued" && t.InfoHash == null)
                .ExecuteUpdateAsync(s => s.SetProperty(t => t.InfoHash, hash).SetProperty(t => t.FileIndex, index)
                    .SetProperty(t => t.FilePath, path).SetProperty(t => t.Status, "downloading").SetProperty(t => t.Progress, 0)
                    .SetProperty(t => t.Error, (string?)null).SetProperty(t => t.UpdatedAt, now), ct);
            if (rows > 0) claimed[episode] = index;
        }
        await tx.CommitAsync(ct);
        return claimed;
    }

    /// <summary>Whole-pack failure: every episode the pack had not finished goes back to the wanted queue.</summary>
    public async Task<int> ReleasePackClaimsAsync(string hash, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await ReleaseClaimsAsync(db, hash, ct);
    }

    private static Task<int> ReleaseClaimsAsync(TorrentFlowDbContext db, string hash, CancellationToken ct) =>
        db.AcquisitionTargets.Where(t => t.UserId == LocalUser.Id && t.InfoHash == hash && t.FileIndex != null && t.Status != "downloaded")
            .ExecuteUpdateAsync(s => s.SetProperty(t => t.InfoHash, (string?)null).SetProperty(t => t.FileIndex, (int?)null)
                .SetProperty(t => t.FilePath, (string?)null).SetProperty(t => t.Status, "queued").SetProperty(t => t.Progress, 0)
                .SetProperty(t => t.UpdatedAt, DateTime.UtcNow), ct);
}
