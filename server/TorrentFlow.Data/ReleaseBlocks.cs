using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Data;

/// <summary>Why a listed release is blocked, for the pickers. Serializes as <c>blocked: { reason, at, message }</c>.</summary>
public sealed record ReleaseBlockInfo(string Reason, DateTime At, string Message);

/// <summary>
/// The release blocklist, the one rule for "don't pick this release again" (docs/audio-language-plan.md 6.4.5).
/// A block is per user and info hash, so it holds wherever the same torrent turns up; the work key and scope it was
/// blocked under are kept for listing and for per-work reads. Automatic picks skip blocked releases. The pickers list
/// them last and never recommend them, and a hand pick with "Use it anyway" still downloads one (and lifts its block).
/// Blocks have no link to works or downloads, so removing a download or a title keeps them.
/// Writers: a swap blocks the release it replaces; a release that fails the video check is blocked, and so is an
/// automatic pick whose files or header showed no English. Name-only language calls, hand picks and send failures (no
/// peers, timeouts, disk) never block.
/// </summary>
public static class ReleaseBlocks
{
    /// <summary>The owner replaced it with Find another source.</summary>
    public const string Replaced = "replaced";

    /// <summary>It wasn't a real video: the finished download failed the check, or its file list already showed it.</summary>
    public const string FailedVideoCheck = "failed_video_check";

    /// <summary>The check after add (its file list or its header) showed no English audio or subtitles (docs/release-language.md).</summary>
    public const string NoEnglish = "no_english";

    /// <summary>Turned down before it reached the library: the promotion gate rejected it, or the owner chose Find another on a held release.</summary>
    public const string Rejected = "rejected";

    public const string FromSwap = "swap";
    public const string FromLanguageCheck = "language_check";
    public const string FromVideoCheck = "video_check";
    public const string FromPromotion = "promotion";
    public const string FromMigration = "migrated";

    /// <summary>The refusal when a blocked release is picked by hand without "Use it anyway".</summary>
    public const string UseAnywayMessage = "You blocked this release before. Choose Use it anyway to download it.";

    /// <summary>What the owner reads next to a blocked release.</summary>
    public static string Message(string reason) => reason switch
    {
        Replaced => "You replaced this release before.",
        FailedVideoCheck => "This release failed the video check before.",
        NoEnglish => "This release had no English audio or subtitles.",
        Rejected => "This release was turned down before it reached your library.",
        _ => "You blocked this release before.",
    };

    public static ReleaseBlockInfo Info(ReleaseBlock block) => new(block.Reason, block.CreatedAt, Message(block.Reason));

    /// <summary>
    /// Blocks a release for its user, or refreshes the existing block (the latest reason wins). Idempotent. Tracks the
    /// change; the caller's save writes it, so a block commits together with the change that caused it.
    /// </summary>
    public static async Task BlockAsync(TorrentFlowDbContext db, ReleaseBlock block, CancellationToken ct)
    {
        block.Hash = Key(block.Hash);
        block.ReplacedBy = block.ReplacedBy is null ? null : Key(block.ReplacedBy);
        var existing = await db.ReleaseBlocks.FindAsync(new object?[] { block.UserId, block.Hash }, ct);
        if (existing is null)
        {
            db.ReleaseBlocks.Add(block);
            return;
        }
        existing.WorkKey = block.WorkKey;
        existing.Scope = block.Scope;
        existing.Reason = block.Reason;
        existing.Title = block.Title ?? existing.Title;
        existing.Source = block.Source ?? existing.Source;
        existing.ReplacedBy = block.ReplacedBy;
        existing.Origin = block.Origin;
        existing.CreatedAt = block.CreatedAt;
    }

    /// <summary>Lifts a block. Returns the removed block, or null when there was none. Tracks the change; the caller saves.</summary>
    public static async Task<ReleaseBlock?> UnblockAsync(TorrentFlowDbContext db, string userId, string hash, CancellationToken ct)
    {
        var existing = await db.ReleaseBlocks.FindAsync(new object?[] { userId, Key(hash) }, ct);
        if (existing is not null) db.ReleaseBlocks.Remove(existing);
        return existing;
    }

    /// <summary>
    /// The hashes this user blocked for a work, for the ladder readers. Leave <paramref name="scope"/> null to match by
    /// hash across the whole work: the same episode can carry different keys depending on the season-shape source.
    /// </summary>
    public static async Task<HashSet<string>> BlockedHashesAsync(TorrentFlowDbContext db, string userId, string workKey, string? scope, CancellationToken ct)
    {
        var query = db.ReleaseBlocks.AsNoTracking().Where(b => b.UserId == userId && b.WorkKey == workKey);
        if (scope is not null) query = query.Where(b => b.Scope == scope);
        return (await query.Select(b => b.Hash).ToListAsync(ct)).ToHashSet(StringComparer.OrdinalIgnoreCase);
    }

    /// <summary>
    /// Every hash this user blocked, for automatic picks: a block is per user and hash, so it holds wherever the same
    /// torrent turns up (an episode search can return a blocked season pack of the same work).
    /// </summary>
    public static async Task<HashSet<string>> BlockedHashesAsync(TorrentFlowDbContext db, string userId, CancellationToken ct) =>
        (await db.ReleaseBlocks.AsNoTracking().Where(b => b.UserId == userId).Select(b => b.Hash).ToListAsync(ct))
            .ToHashSet(StringComparer.OrdinalIgnoreCase);

    /// <summary>The blocks among <paramref name="hashes"/>, by hash (any case), for display.</summary>
    public static async Task<Dictionary<string, ReleaseBlock>> GetAsync(TorrentFlowDbContext db, string userId, IEnumerable<string> hashes, CancellationToken ct)
    {
        var keys = hashes.Where(h => !string.IsNullOrWhiteSpace(h)).Select(Key).Distinct().ToList();
        if (keys.Count == 0) return new(StringComparer.OrdinalIgnoreCase);
        return await db.ReleaseBlocks.AsNoTracking().Where(b => b.UserId == userId && keys.Contains(b.Hash))
            .ToDictionaryAsync(b => b.Hash, StringComparer.OrdinalIgnoreCase, ct);
    }

    /// <summary>
    /// The work a download was last grabbed or swapped for, when its row has no work: its own block, or the block of the
    /// release it replaced, then the older swap attempts.
    /// </summary>
    public static async Task<string?> WorkKeyForAsync(TorrentFlowDbContext db, string userId, string hash, CancellationToken ct)
    {
        var key = Key(hash);
        return await db.ReleaseBlocks.AsNoTracking()
                .Where(b => b.UserId == userId && (b.Hash == key || b.ReplacedBy == key) && b.WorkKey != "")
                .OrderByDescending(b => b.CreatedAt).Select(b => b.WorkKey).FirstOrDefaultAsync(ct)
            ?? await db.ReleaseAttempts.AsNoTracking().Where(a => a.UserId == userId && a.Hash == key)
                .OrderByDescending(a => a.TriedAt).Select(a => a.WorkKey).FirstOrDefaultAsync(ct);
    }

    /// <summary>
    /// The name and site a release was grabbed under: its newest grab job, else its newest history row. Torrent metadata
    /// can rename a release to an opaque payload name, so this is its real identity. Null when neither exists.
    /// </summary>
    public static async Task<(string Title, string? Source)?> GrabbedAsync(TorrentFlowDbContext db, string userId, string hash, CancellationToken ct)
    {
        var key = Key(hash);
        var grabbed = await db.GrabJobs.AsNoTracking().Where(j => j.UserId == userId && j.InfoHash == key)
                .OrderByDescending(j => j.CreatedAt).Select(j => new { j.Title, j.Source }).FirstOrDefaultAsync(ct)
            ?? await db.DownloadHistories.AsNoTracking().Where(h => h.UserId == userId && h.InfoHash == key)
                .OrderByDescending(h => h.CreatedAt).Select(h => new { h.Title, h.Source }).FirstOrDefaultAsync(ct);
        return grabbed is null ? null : (grabbed.Title, grabbed.Source);
    }

    /// <summary>The engine's hash key: trimmed and lower-case.</summary>
    private static string Key(string hash) => hash.Trim().ToLowerInvariant();
}
