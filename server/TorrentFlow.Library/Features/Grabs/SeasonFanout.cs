using System.Text.Json.Serialization;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record EpisodeTransfer(int Episode, string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? InfoHash,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Error);
public sealed record GrabResult(bool Ok, string Message)
{
    public string? Query { get; init; }
    public string? Title { get; init; }
    public string? InfoHash { get; init; }
    public string? Magnet { get; init; }
    public string? SavePath { get; init; }
    public object? Storage { get; init; }
    public bool Queued { get; init; }
    public int? QueuePosition { get; init; }
    public bool Advanced { get; init; }
    public string? LastEpisode { get; init; }
    public int? CursorSeason { get; init; }
    public int? CursorEpisode { get; init; }
    public string? NextEpisodeHint { get; init; }
    public object? NoReleaseFound { get; init; }
    [JsonIgnore]
    public bool HuntMiss { get; init; }
    [JsonIgnore]
    public bool Skipped { get; init; }
}
public sealed record SeasonFanoutResult(IReadOnlyList<EpisodeTransfer> Transfers, IReadOnlyList<int> CoveredEpisodes, object? Storage);

public static class SeasonFanout
{
    public const int Concurrency = 4;
    public const int OrderWaitMs = 60000;
    public const int SendHoldMs = 10000;
    public static async Task<SeasonFanoutResult> Run(IEnumerable<int> episodes,
        Func<int, Func<Task>, Task<GrabResult>> grab, CancellationToken ct = default,
        int concurrency = Concurrency, int orderWaitMs = OrderWaitMs, int sendHoldMs = SendHoldMs)
    {
        var wanted = episodes.Where(x => x > 0).Distinct().Order().ToArray();
        var passed = wanted.Select(_ => new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously)).ToArray();
        var transfers = new EpisodeTransfer[wanted.Length];
        var results = new GrabResult?[wanted.Length];
        using var timers = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var holds = new List<Task>();
        var next = -1;
        async Task Hold(int i)
        {
            try { await Task.Delay(sendHoldMs, timers.Token); passed[i].TrySetResult(); }
            catch (OperationCanceledException) when (timers.IsCancellationRequested) { }
        }
        async Task Worker()
        {
            int index;
            while ((index = Interlocked.Increment(ref next)) < wanted.Length)
            {
                var i = index;
                try
                {
                    ct.ThrowIfCancellationRequested();
                    async Task BeforeSend()
                    {
                        await Task.WhenAny(Task.WhenAll(passed.Take(i).Select(x => x.Task)), Task.Delay(orderWaitMs, timers.Token));
                        ct.ThrowIfCancellationRequested();
                        lock (holds) holds.Add(Hold(i));
                    }
                    var result = await grab(wanted[i], BeforeSend);
                    results[i] = result;
                    transfers[i] = new(wanted[i], result.Ok ? result.Queued ? "queued" : "downloading" : "failed",
                        result.Ok ? result.InfoHash : null, result.Ok ? null : result.Message);
                }
                catch (Exception error) when (!ct.IsCancellationRequested) { transfers[i] = new(wanted[i], "failed", null, error.Message); }
                finally { passed[i].TrySetResult(); }
            }
        }
        try { await Task.WhenAll(Enumerable.Range(0, Math.Min(Math.Max(1, concurrency), wanted.Length)).Select(_ => Worker())); }
        finally { await timers.CancelAsync(); await Task.WhenAll(holds); }
        return new(transfers, transfers.Where(x => x.Status != "failed").Select(x => x.Episode).ToArray(), results.FirstOrDefault(x => x?.Storage != null)?.Storage);
    }
}
