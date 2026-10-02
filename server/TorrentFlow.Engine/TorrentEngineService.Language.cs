using System.Collections.Concurrent;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core;
using TorrentFlow.Core.Contracts.Engine;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Engine.Client;
using TorrentFlow.Engine.Layout;
using TorrentFlow.Engine.Queue;

namespace TorrentFlow.Engine;

/// <summary>
/// The English check after add (docs/release-language.md). A transfer added with a language check carries an
/// <see cref="EngineLanguageState"/>: once its file list is known the tick reads it, and what the list leaves open goes to
/// the header probe through a small bounded queue. A fail on an automatic pick stops the transfer, blocks the release and
/// hands its wanted items back so the finder picks again; a probe that can't finish keeps it as "English not confirmed".
/// Hand picks are never checked.
/// </summary>
internal sealed partial class TorrentEngineService
{
    private const int ProbeQueueSize = 8;
    private const int ProbeFiles = 3;

    private readonly Channel<string> _probeQueue = Channel.CreateBounded<string>(new BoundedChannelOptions(ProbeQueueSize)
        { FullMode = BoundedChannelFullMode.Wait, SingleReader = true });
    private readonly ConcurrentDictionary<string, byte> _probing = new(StringComparer.Ordinal);
    private int _probeWorker;

    /// <summary>
    /// Runs the file-list check for a loaded transfer whose file list just arrived, and requeues a probe a restart
    /// dropped. Returns the reason when it has no English, else null (the row's state is updated in place).
    /// </summary>
    private string? CheckLanguageOnMetadata(EngineTorrent row, BackendSnapshot live)
    {
        if (EngineLanguageState.Read(row.LanguageCheckJson) is not { } state) return null;
        if (state.State == EngineLanguageState.Probing)
        {
            if (!_probing.ContainsKey(row.Hash)) QueueProbe(row);
            return null;
        }
        if (state.State != EngineLanguageState.Pending) return null;

        var verdict = FileListLanguage(live.Files.Select(f => (f.Index, f.Path, f.Length)), state.Want, state.Name ?? row.Name,
            state.SourceCategory, SelectionOf(row));
        logger.LogInformation("[builtin-engine] English check {Hash} ({Name}) from its file list: {Verdict} ({Reason})",
            row.Hash, row.Name, verdict.English.Verdict, verdict.English.Reason);
        if (verdict.English.Verdict == EnglishVerdict.Fail)
        {
            row.LanguageCheckJson = (state with { State = EngineLanguageState.Failed, Reason = verdict.English.Reason }).Write();
            return verdict.English.Reason;
        }
        if (verdict.English.Confirmed)
        {
            row.LanguageCheckJson = (state with { State = EngineLanguageState.Passed, Reason = verdict.English.Reason }).Write();
            return null;
        }
        row.LanguageCheckJson = (state with { State = EngineLanguageState.Probing, Reason = verdict.English.Reason }).Write();
        QueueProbe(row);
        return null;
    }

    /// <summary>
    /// Startup: a finished row (parked or downloaded) that is not loaded again can't finish its check, since the probe
    /// queue lives in memory and the tick only reads loaded rows. Its pending or probing check is settled once as
    /// unconfirmed ("check interrupted"); nothing is downloaded again. Unfinished rows keep theirs: the check runs
    /// when they load.
    /// </summary>
    private void SettleInterruptedLanguageChecks(IEnumerable<EngineTorrent> rows)
    {
        foreach (var row in rows)
        {
            if (row.Status != EngineTorrentStatus.Parked && !IsDownloaded(row)) continue;
            if (EngineLanguageState.Read(row.LanguageCheckJson) is not { State: EngineLanguageState.Pending or EngineLanguageState.Probing } state)
                continue;
            row.LanguageCheckJson = (state with { State = EngineLanguageState.Unconfirmed, Reason = "check interrupted" }).Write();
            logger.LogInformation("[builtin-engine] English check {Hash} ({Name}) was interrupted while {Status}; kept as not confirmed",
                row.Hash, row.Name, row.Status);
        }
    }

    /// <summary>Queues the header probe; a full queue keeps the transfer as unconfirmed rather than waiting.</summary>
    private void QueueProbe(EngineTorrent row)
    {
        if (!_probing.TryAdd(row.Hash, 0)) return;
        if (_probeQueue.Writer.TryWrite(row.Hash))
        {
            if (Interlocked.Exchange(ref _probeWorker, 1) == 0) _ = Task.Run(ProbeLoopAsync);
            return;
        }
        _probing.TryRemove(row.Hash, out _);
        if (EngineLanguageState.Read(row.LanguageCheckJson) is { } state)
            row.LanguageCheckJson = (state with { State = EngineLanguageState.Unconfirmed, Reason = "the header check was busy" }).Write();
    }

    private async Task ProbeLoopAsync()
    {
        await foreach (var hash in _probeQueue.Reader.ReadAllAsync())
        {
            try { await ProbeLanguageAsync(hash); }
            // Shutting down is not a failure: the row stays probing and the next start queues it again.
            catch (Exception ex) when (ex is OperationCanceledException or ObjectDisposedException)
            {
                logger.LogInformation("The English header check for {Hash} stopped: {Why}", hash, ex.Message);
            }
            catch (Exception ex)
            {
                // Settled once as unconfirmed, so a probe that keeps throwing is not retried every tick.
                logger.LogWarning(ex, "The English header check for {Hash} failed", hash);
                try { await SettleLanguageAsync(hash, null, "the header check failed"); }
                catch (Exception settle) { logger.LogWarning(settle, "Recording the failed English check for {Hash} failed", hash); }
            }
            finally { _probing.TryRemove(hash, out _); }
        }
    }

    /// <summary>Reads the main videos' headers (bounded by <see cref="HeaderProbeBudget.Default"/>) and settles the check.</summary>
    private async Task ProbeLanguageAsync(string hash)
    {
        EngineLanguageState? state;
        IReadOnlySet<int>? selection;
        string name;
        await using (var db = await dbFactory.CreateDbContextAsync())
        {
            var row = await db.EngineTorrents.AsNoTracking().FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash);
            state = EngineLanguageState.Read(row?.LanguageCheckJson);
            if (row is null || state is not { State: EngineLanguageState.Probing }) return;
            selection = SelectionOf(row);
            name = state.Name ?? row.Name;
        }

        var live = backend.Get(hash);
        var bytes = LoadTorrentFile(hash);
        if (live is null || bytes is null)
        {
            await SettleLanguageAsync(hash, state with { State = EngineLanguageState.Unconfirmed, Reason = "its file list could not be read" });
            return;
        }
        var list = live.Files.Select(f => (f.Index, f.Path, f.Length)).ToList();
        var main = MainVideos(list, selection).OrderByDescending(f => f.Length).Take(ProbeFiles).ToList();
        if (main.Count == 0)
        {
            await SettleLanguageAsync(hash, state with { State = EngineLanguageState.Unconfirmed, Reason = "no video to check" });
            return;
        }

        var result = await backend.ProbeHeadersAsync(bytes, main.Select(f => f.Index).ToList(), HeaderProbeBudget.Default,
            CancellationToken.None, alongside: true);
        var read = result.Files.Where(f => f.Scan.Unchecked is null && f.Scan.Tracks.Count > 0).ToList();
        if (read.Count > 0)
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            foreach (var file in read) await HeaderProbeCache.SaveAsync(db, hash, file, Now, CancellationToken.None);
        }
        // Only a finished probe settles it: one file read and another timed out stays unconfirmed, whatever the read one says.
        if (!result.Checked)
        {
            var why = result.Unchecked ?? "only part of it could be read";
            logger.LogInformation("[builtin-engine] English header check {Hash} ({Name}) could not finish ({Read} of {Files} file(s) read): {Why}",
                hash, name, read.Count, main.Count, why);
            await SettleLanguageAsync(hash, state with { State = EngineLanguageState.Unconfirmed, Reason = why });
            return;
        }

        var paths = list.Select(f => f.Path).ToList();
        var verdict = read.Select(f => ReleaseLanguage.Judge(state.Want, ReleaseLanguage.WithHeader(
                ReleaseLanguage.Detect(name, state.SourceCategory, ReleaseLanguage.WithSidecars(f.Path, paths, main.Count == 1)), f.Scan.Tracks)))
            .MaxBy(v => (v.English.Verdict, v.Fit));
        logger.LogInformation("[builtin-engine] English header check {Hash} ({Name}): {Verdict} ({Reason}) from {Files} file(s)",
            hash, name, verdict?.English.Verdict.ToString() ?? "unread", verdict?.English.Reason ?? result.Unchecked, read.Count);
        await SettleLanguageAsync(hash, verdict?.English.Verdict switch
        {
            EnglishVerdict.Fail => state with { State = EngineLanguageState.Failed, Reason = verdict.English.Reason },
            EnglishVerdict.Pass => state with { State = EngineLanguageState.Passed, Reason = verdict.English.Reason },
            _ => state with { State = EngineLanguageState.Unconfirmed, Reason = verdict?.English.Reason ?? result.Unchecked },
        });
    }

    /// <summary>
    /// Writes the probe's outcome (or, with no <paramref name="state"/>, unconfirmed for <paramref name="unconfirmedWhy"/>).
    /// A fail stops, blocks and releases a transfer that is still loaded. The tick never parks a transfer while it is probing,
    /// so a fail can't land on a finished one; if it ever does, the files stay in the library and the release is only blocked.
    /// </summary>
    private async Task SettleLanguageAsync(string hash, EngineLanguageState? state, string? unconfirmedWhy = null)
    {
        EngineTorrentFailedEventArgs? stopped = null;
        using (await LockHashAsync(hash, CancellationToken.None))
        {
            await using var db = await dbFactory.CreateDbContextAsync();
            var row = await db.EngineTorrents.FirstOrDefaultAsync(r => r.UserId == LocalUser.Id && r.Hash == hash);
            if (row is null || EngineLanguageState.Read(row.LanguageCheckJson) is not { State: EngineLanguageState.Probing } probing) return;
            state ??= probing with { State = EngineLanguageState.Unconfirmed, Reason = unconfirmedWhy };
            row.LanguageCheckJson = state.Write();
            // A parked row still loaded (its detach failed) has not been laid out yet, so it is stopped like a download.
            if (state.State == EngineLanguageState.Failed && (row.Status is EngineTorrentStatus.Downloading or EngineTorrentStatus.Queued
                || row.Status == EngineTorrentStatus.Parked && backend.Get(hash) is not null))
            {
                await FailLanguageAsync(db, row, state.Reason ?? "no English audio or subtitles", CancellationToken.None);
                stopped = new(row.Hash, row.Name, row.Origin);
            }
            else if (state.State == EngineLanguageState.Failed)
            {
                logger.LogWarning("[builtin-engine] {Hash} ({Name}) has no English but is already {Status}; kept, release blocked",
                    row.Hash, row.Name, row.Status);
                await CompletedLayoutFinalizer.BlockFailedCheckAsync(db, row, Now, CancellationToken.None, ReleaseBlocks.NoEnglish,
                    ReleaseBlocks.FromLanguageCheck);
            }
            await db.SaveChangesAsync();
            if (stopped is not null)
            {
                try { await backend.RemoveAsync(hash); }
                catch (Exception ex) { logger.LogWarning(ex, "Detaching {Hash} failed", hash); }
                _startedAt.TryRemove(hash, out _);
            }
        }
        if (stopped is null) return;
        RaiseFailed(stopped);
        await PromoteAsync(CancellationToken.None);
    }

    /// <summary>Marks the row failed, blocks the release (reason no English) and hands its wanted items back.</summary>
    private async Task FailLanguageAsync(TorrentFlowDbContext db, EngineTorrent row, string reason, CancellationToken ct)
    {
        var message = $"No English audio or subtitles ({reason}). TorrentFlow stopped it and will look for another release.";
        logger.LogWarning("[builtin-engine] stopped {Hash} ({Name}): {Message}", row.Hash, row.Name, message);
        row.Status = EngineTorrentStatus.Error;
        row.Error = message;
        row.ClearForced();
        row.UpdatedAt = Now;
        await CompletedLayoutFinalizer.BlockFailedCheckAsync(db, row, Now, ct, ReleaseBlocks.NoEnglish, ReleaseBlocks.FromLanguageCheck);
        await CompletedLayoutFinalizer.ReleaseTargetsAsync(db, row.Hash, message, Now, ct);
    }
}
