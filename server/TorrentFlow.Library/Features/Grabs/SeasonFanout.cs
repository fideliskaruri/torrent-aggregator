using System.Text.Json.Serialization;

namespace TorrentFlow.Library.Features.Grabs;

public sealed record EpisodeTransfer(int Episode, string Status,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? InfoHash,
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)] string? Error,
    GrabFailure? Failure = null);
public sealed record GrabResult(bool Ok, string Message)
{
    public string? Query { get; init; }
    public string? Title { get; init; }
    public string? InfoHash { get; init; }
    public string? Magnet { get; init; }
    public string? Source { get; init; }
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
    public GrabFailure? Failure { get; init; }
    [JsonIgnore]
    public bool HuntMiss { get; init; }
    [JsonIgnore]
    public bool Skipped { get; init; }
}
public sealed record SeasonFanoutResult(IReadOnlyList<EpisodeTransfer> Transfers, IReadOnlyList<int> CoveredEpisodes, object? Storage);

public static class SeasonFanout
{
    public const int Concurrency = 4;
    public static async Task<SeasonFanoutResult> Run(IEnumerable<int> episodes,
        Func<int, Func<Task>, Task<GrabResult>> grab, CancellationToken ct = default,
        int concurrency = Concurrency, Func<EpisodeTransfer, Task>? settled = null)
    {
        var wanted = episodes.Where(x => x > 0).Distinct().Order().ToArray();
        var transfers = new EpisodeTransfer[wanted.Length];
        var results = new GrabResult?[wanted.Length];
        var next = -1;
        async Task Worker()
        {
            int index;
            while ((index = Interlocked.Increment(ref next)) < wanted.Length)
            {
                var i = index;
                try
                {
                    ct.ThrowIfCancellationRequested();
                    Task BeforeSend()
                    {
                        ct.ThrowIfCancellationRequested();
                        // Queue admission owns the download cap and episode ordering. A slow search or
                        // metadata lookup for one episode must not block other ready episodes.
                        return Task.CompletedTask;
                    }
                    var result = await grab(wanted[i], BeforeSend);
                    results[i] = result;
                    transfers[i] = new(wanted[i], result.Ok ? result.Queued ? "queued" : "downloading" : "failed",
                        result.Ok ? result.InfoHash : null, result.Ok ? null : result.Message, result.Failure);
                }
                catch (Exception error) when (!ct.IsCancellationRequested)
                {
                    var failure = GrabFailure.FromException(error);
                    transfers[i] = new(wanted[i], "failed", null, error.Message, failure);
                }
                // Each episode is reported the moment it settles, not when the whole season is done.
                if (settled != null && transfers[i] != null) await settled(transfers[i]);
            }
        }
        await Task.WhenAll(Enumerable.Range(0, Math.Min(Math.Max(1, concurrency), wanted.Length)).Select(_ => Worker()));
        return new(transfers, transfers.Where(x => x.Status != "failed").Select(x => x.Episode).ToArray(), results.FirstOrDefault(x => x?.Storage != null)?.Storage);
    }
}
