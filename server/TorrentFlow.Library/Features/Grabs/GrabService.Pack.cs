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
        // Preferred and neutral packs are probed first; backups and clashes only stand in when none of those maps.
        candidates = candidates.OrderBy(c => Judge(input, c.Release).HeldBack ? 1 : 0).ToList();
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
            // A pack stands in for every missing episode, so each mapped file is judged with its own subtitle and audio
            // files, and the worst one is the pack's call (docs/release-language.md).
            var paths = files.Select(f => f.Path).ToList();
            var call = map.Episodes.Values.Select(index => Judge(input, candidate, ReleaseLanguage.WithSidecars(files[index].Path, paths,
                map.Episodes.Count == 1))).Prepend(Judge(input, candidate)).MaxBy(c => c.Fit)!;
            logger?.LogInformation("Season pack {Title} ({Hash}): {Mapped} of {Missing} missing episodes map; {Language}; {Rejection} {Notes}",
                candidate.Title, inspected.Hash, map.Episodes.Count, targets.Count, call.Label, map.Rejection ?? "", string.Join("; ", map.Notes.Take(8)));
            if (!map.Ok || map.Episodes.Count == 0) { notes.Add($"{candidate.Title}: {map.Rejection ?? "no_episodes"}"); continue; }
            if (best == null || best.Value.Call.HeldBack && !call.HeldBack ||
                best.Value.Call.HeldBack == call.HeldBack && map.Episodes.Count > best.Value.Map.Episodes.Count)
                best = (candidate, inspected, map, rung, call);
            if (!call.HeldBack && map.Episodes.Count == targets.Count) break;
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
        // The selection and reservation come from what was really claimed, not from what the pack could cover.
        var selection = new PackSelection(claimed.Values.Order().ToArray(),
            SeasonPackFiles.PieceSpanBytes(inspectedFiles, chosen.Files.PieceLength, claimed.Values),
            new EpisodeCursor(season, claimed.Keys.Min()).QueueKey);
        var held = chosen.Call.HeldBack;
        var sent = await Send(db, settings!, input, query, chosen.Release with { InfoHash = hash }, null, relaxed: false, ct, selection,
            new(SendContext.RungLabel(chosen.Rung), chosen.Call, Fallback: held, Missing: held ? MissingLanguage(input) : null));
        if (!sent.Ok || !string.Equals(sent.InfoHash, hash, StringComparison.OrdinalIgnoreCase))
        {
            await ReleaseClaimsAsync(db, hash, ct);
            return new(null, new Dictionary<int, int>(), $"season pack {chosen.Release.Title} could not start: {sent.Message}");
        }
        return new(hash, claimed, $"downloading {claimed.Count} missing episode{(claimed.Count == 1 ? "" : "s")} from season pack {chosen.Release.Title}",
            chosen.Release.Title);
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
