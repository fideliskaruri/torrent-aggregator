using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Xunit.Abstractions;

namespace TorrentFlow.Search.Tests;

[CollectionDefinition(nameof(UdpTimingCollection), DisableParallelization = true)]
public sealed class UdpTimingCollection;

// Real UDP sockets with sub-second retry budgets: run alone so a busy CI runner can't starve them.
[Collection(nameof(UdpTimingCollection))]
public sealed class TrackerScraperTests(ITestOutputHelper output)
{
    private const string Hash = "08ada5a7a6183aae1e09d831df6748d566095a10";
    private static readonly TimeSpan Budget = TimeSpan.FromSeconds(2);

    private static TrackerScraper Scraper(params string[] trackers) =>
        new(new UnusedHttpFactory(), NullLogger<TrackerScraper>.Instance, trackers);

    [Fact]
    public async Task Udp_parses_counts_and_normalizes_deduplicated_hashes()
    {
        await using var tracker = new UdpTracker(_ => new(123456, 789, 456789, 1));
        using var scraper = Scraper(tracker.Url);
        var result = await scraper.ScrapeAsync([Hash.ToUpperInvariant(), Hash], Budget);
        Assert.Equal(new ScrapeCount(123456, 789, 456789, 1), Assert.Single(result).Value);
        Assert.Equal(Hash, Assert.Single(result).Key);
        Assert.Equal(1, tracker.Connects);
        Assert.Equal([1], tracker.BatchSizes.ToArray());
    }

    [Fact]
    public async Task Udp_batches_at_74_and_preserves_hash_order()
    {
        var hashes = Enumerable.Range(1, 160).Select(i => i.ToString("x40")).ToArray();
        await using var tracker = new UdpTracker(hash => new(Convert.ToInt32(hash[^4..], 16), 5, 9, 1));
        using var scraper = Scraper(tracker.Url);
        var result = await scraper.ScrapeAsync(hashes, Budget);
        Assert.Equal(160, result.Count);
        Assert.Equal([74, 74, 12], tracker.BatchSizes.ToArray());
        foreach (var hash in hashes) Assert.Equal(Convert.ToInt32(hash[^4..], 16), result[hash].Seeders);
        Assert.Equal(1, tracker.Connects);
    }

    [Fact]
    public async Task Merges_independent_maxima_and_counts_trackers_once()
    {
        await using var first = new UdpTracker(_ => new(20, 2, 40, 1));
        await using var second = new UdpTracker(_ => new(10, 8, 50, 1));
        using var scraper = Scraper(first.Url, second.Url, first.Url);
        var result = await scraper.ScrapeAsync([Hash], Budget);
        Assert.Equal(new ScrapeCount(20, 8, 50, 2), result[Hash]);
    }

    [Fact]
    public async Task Budget_returns_partial_results_when_another_tracker_is_silent()
    {
        await using var fast = new UdpTracker(_ => new(31, 7, 99, 1));
        await using var silent = new UdpTracker(_ => null);
        using var scraper = Scraper(fast.Url, silent.Url);
        var elapsed = Stopwatch.StartNew();
        var result = await scraper.ScrapeAsync([Hash], TimeSpan.FromMilliseconds(1000));
        Assert.Equal(new ScrapeCount(31, 7, 99, 1), result[Hash]);
        Assert.InRange(elapsed.ElapsedMilliseconds, 200, 3000);
        Assert.Equal(2, silent.Scrapes);
    }

    [Fact]
    public async Task Budget_preserves_completed_batches_from_the_same_tracker()
    {
        var hashes = Enumerable.Range(1, 80).Select(i => i.ToString("x40")).ToArray();
        await using var tracker = new UdpTracker(hash => hash == hashes[74] ? null : new(1, 2, 3, 1));
        using var scraper = Scraper(tracker.Url);
        var result = await scraper.ScrapeAsync(hashes, TimeSpan.FromMilliseconds(300));
        Assert.Equal(74, result.Count);
        Assert.All(hashes[..74], hash => Assert.True(result.ContainsKey(hash)));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(2)]
    public async Task Error_action_is_ignored_and_does_not_invent_zero_counts(int action)
    {
        await using var tracker = new UdpTracker(_ => new(1, 2, 3, 1), errorAction: action);
        using var scraper = Scraper(tracker.Url);
        Assert.Empty(await scraper.ScrapeAsync([Hash], Budget));
    }

    [Fact]
    public async Task Invalid_hashes_are_ignored_before_network_io()
    {
        await using var tracker = new UdpTracker(_ => new(1, 2, 3, 1));
        using var scraper = Scraper(tracker.Url);
        Assert.Empty(await scraper.ScrapeAsync(["", "abc", new string('z', 40), new string('a', 64), null!], Budget));
        Assert.Equal(0, tracker.Connects);
        var result = await scraper.ScrapeAsync(["bad", Hash, " " + Hash], Budget);
        Assert.Single(result);
        Assert.Equal([1], tracker.BatchSizes.ToArray());
    }

    [Fact]
    public async Task Cache_hit_avoids_network_and_connection_is_reused_for_new_hashes()
    {
        await using var tracker = new UdpTracker(_ => new(1, 2, 3, 1));
        using var scraper = Scraper(tracker.Url);
        var initial = await scraper.ScrapeAsync([Hash], Budget);
        Assert.Equal(initial[Hash], (await scraper.ScrapeAsync([Hash.ToUpperInvariant()], Budget))[Hash]);
        Assert.Equal(1, tracker.Scrapes);
        Assert.Single(await scraper.ScrapeAsync([new string('a', 40)], Budget));
        Assert.Equal(2, tracker.Scrapes);
        Assert.Equal(1, tracker.Connects);
    }

    [Fact]
    public async Task Cache_is_bounded_and_evicts_oldest_hash()
    {
        await using var tracker = new UdpTracker(_ => new(1, 2, 3, 1));
        using var scraper = Scraper(tracker.Url);
        var hashes = Enumerable.Range(1, 5001).Select(i => i.ToString("x40")).ToArray();
        Assert.Equal(5001, (await scraper.ScrapeAsync(hashes, TimeSpan.FromSeconds(10))).Count);
        var requests = tracker.Scrapes;
        Assert.Single(await scraper.ScrapeAsync([hashes[^1]], Budget));
        Assert.Equal(requests, tracker.Scrapes);
        Assert.Single(await scraper.ScrapeAsync([hashes[0]], Budget));
        Assert.Equal(requests + 1, tracker.Scrapes);
    }

    [Fact]
    public async Task Retransmits_once_and_ignores_short_mismatched_and_truncated_packets()
    {
        await using var tracker = new UdpTracker(_ => new(12, 34, 56, 1), dropFirst: true, sendMalformed: true);
        using var scraper = Scraper(tracker.Url);
        var result = await scraper.ScrapeAsync([Hash], TimeSpan.FromSeconds(5));
        Assert.Equal(new ScrapeCount(12, 34, 56, 1), result[Hash]);
        Assert.Equal(2, tracker.Connects);
        Assert.Equal(2, tracker.Scrapes);
    }

    [Fact]
    public async Task Concurrent_calls_are_isolated_and_reuse_the_tracker_connection()
    {
        await using var tracker = new UdpTracker(hash => new(Convert.ToInt32(hash[^4..], 16), 0, 0, 1));
        using var scraper = Scraper(tracker.Url);
        var tasks = Enumerable.Range(1, 20).Select(async i =>
        {
            var hash = i.ToString("x40");
            var result = await scraper.ScrapeAsync([hash], Budget);
            Assert.Equal(i, result[hash].Seeders);
        });
        await Task.WhenAll(tasks);
        Assert.Equal(1, tracker.Connects);
    }

    [Fact]
    public async Task Caller_cancellation_is_propagated_and_zero_budget_does_not_send()
    {
        await using var tracker = new UdpTracker(_ => null);
        using var scraper = Scraper(tracker.Url);
        Assert.Empty(await scraper.ScrapeAsync([Hash], TimeSpan.Zero));
        Assert.Equal(0, tracker.Connects);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(100));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => scraper.ScrapeAsync([Hash], Budget, cancellation.Token));
    }

    [Fact]
    public async Task Http_decodes_binary_hash_keys_and_keeps_query_parameters()
    {
        var bytes = Encoding.ASCII.GetBytes("d5:filesd20:")
            .Concat(Convert.FromHexString(Hash))
            .Concat(Encoding.ASCII.GetBytes("d8:completei123e10:downloadedi456e10:incompletei78eeee")).ToArray();
        using var http = new FakeHttp(request =>
        {
            Assert.Equal("/passkey/scrape.php", request.RequestUri!.AbsolutePath);
            Assert.Contains("token=abc&info_hash=", request.RequestUri.Query);
            Assert.Contains("%AD", request.RequestUri.Query, StringComparison.OrdinalIgnoreCase);
            return new(HttpStatusCode.OK) { Content = new ByteArrayContent(bytes) };
        });
        using var scraper = new TrackerScraper(http, NullLogger<TrackerScraper>.Instance,
            ["https://tracker.test/passkey/announce.php?token=abc"]);
        var result = await scraper.ScrapeAsync([Hash, new string('f', 40)], Budget);
        Assert.Equal(new ScrapeCount(123, 78, 456, 1), Assert.Single(result).Value);
        Assert.Single(http.Requests);
    }

    [Theory]
    [InlineData("d14:failure reason6:deniede")]
    [InlineData("d5:filesd20:short")]
    [InlineData("d5:filesdeetrailing")]
    [InlineData("9999999999999999999999999999999999:x")]
    [InlineData("")]
    public async Task Http_malformed_and_error_responses_return_no_counts(string body)
    {
        using var http = new FakeHttp(_ => new(HttpStatusCode.OK) { Content = new StringContent(body) });
        using var scraper = new TrackerScraper(http, NullLogger<TrackerScraper>.Instance, ["http://tracker.test/announce"]);
        Assert.Empty(await scraper.ScrapeAsync([Hash], Budget));
    }

    [Fact]
    public async Task Http_trackers_without_announce_are_skipped()
    {
        using var scraper = Scraper("https://tracker.test/tracker?announce=1");
        Assert.Empty(await scraper.ScrapeAsync([Hash], Budget));
    }

    [NetworkFact]
    [Trait("Category", "Network")]
    public async Task Public_trackers_legal_torrents_smoke()
    {
        var hashes = new Dictionary<string, string>
        {
            [Hash] = "Sintel",
            ["dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c"] = "Big Buck Bunny",
            ["209c8226b299b308beaf2b9cd3fb49212dbd13ec"] = "Tears of Steel"
        };
        using var services = new ServiceCollection().AddHttpClient().BuildServiceProvider();
        using var scraper = new TrackerScraper(services.GetRequiredService<IHttpClientFactory>(), NullLogger<TrackerScraper>.Instance);
        var elapsed = Stopwatch.StartNew();
        var result = await scraper.ScrapeAsync(hashes.Keys.ToArray(), TimeSpan.FromMilliseconds(2500));
        output.WriteLine($"Elapsed: {elapsed.ElapsedMilliseconds} ms");
        foreach (var (hash, title) in hashes)
            output.WriteLine(result.TryGetValue(hash, out var count)
                ? $"{title}: seeders={count.Seeders}, leechers={count.Leechers}, completed={count.Completed}, trackers={count.TrackersAnswered}"
                : $"{title}: no tracker answered (unknown counts)");
        Assert.True(elapsed.Elapsed < TimeSpan.FromSeconds(4));
    }

    private sealed class NetworkFactAttribute : FactAttribute
    {
        public NetworkFactAttribute()
        {
            if (Environment.GetEnvironmentVariable("TF_NETWORK_TESTS") != "1")
                Skip = "Set TF_NETWORK_TESTS=1 to query public trackers.";
        }
    }

    private sealed class UnusedHttpFactory : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => throw new InvalidOperationException("HTTP must not be used");
    }

    private sealed class UdpTracker : IAsyncDisposable
    {
        private const long ConnectionId = 0x123456789abcdef;
        private readonly UdpClient _socket = new(new IPEndPoint(IPAddress.Loopback, 0));
        private readonly CancellationTokenSource _stop = new();
        private readonly Task _loop;
        private readonly Func<string, ScrapeCount?> _counts;
        private readonly int? _errorAction;
        private readonly bool _dropFirst;
        private readonly bool _sendMalformed;
        private IPEndPoint? _client;
        private int _connects;
        private int _scrapes;
        public int Connects => Volatile.Read(ref _connects);
        public int Scrapes => Volatile.Read(ref _scrapes);
        public ConcurrentQueue<int> BatchSizes { get; } = new();
        public string Url => $"udp://127.0.0.1:{((IPEndPoint)_socket.Client.LocalEndPoint!).Port}/announce";

        public UdpTracker(Func<string, ScrapeCount?> counts, int? errorAction = null, bool dropFirst = false, bool sendMalformed = false)
        {
            _counts = counts;
            _errorAction = errorAction;
            _dropFirst = dropFirst;
            _sendMalformed = sendMalformed;
            _loop = RunAsync();
        }

        private async Task RunAsync()
        {
            try
            {
                while (!_stop.IsCancellationRequested)
                {
                    var packet = await _socket.ReceiveAsync(_stop.Token);
                    var request = packet.Buffer;
                    Assert.True(request.Length >= 16);
                    var action = BinaryPrimitives.ReadInt32BigEndian(request.AsSpan(8));
                    var transaction = BinaryPrimitives.ReadInt32BigEndian(request.AsSpan(12));
                    byte[] response;
                    if (action == 0)
                    {
                        Assert.Equal(0x41727101980, BinaryPrimitives.ReadInt64BigEndian(request));
                        _client = packet.RemoteEndPoint;
                        var attempt = Interlocked.Increment(ref _connects);
                        if (_dropFirst && attempt == 1) continue;
                        response = new byte[16];
                        BinaryPrimitives.WriteInt64BigEndian(response.AsSpan(8), ConnectionId);
                    }
                    else
                    {
                        Assert.Equal(2, action);
                        Assert.Equal(ConnectionId, BinaryPrimitives.ReadInt64BigEndian(request));
                        Assert.Equal(_client, packet.RemoteEndPoint);
                        Assert.Equal(0, (request.Length - 16) % 20);
                        var count = (request.Length - 16) / 20;
                        Assert.InRange(count, 1, 74);
                        BatchSizes.Enqueue(count);
                        var attempt = Interlocked.Increment(ref _scrapes);
                        if (_dropFirst && attempt == 1) continue;
                        var counts = Enumerable.Range(0, count)
                            .Select(i => _counts(Convert.ToHexString(request.AsSpan(16 + i * 20, 20)).ToLowerInvariant())).ToArray();
                        if (counts.Any(value => value is null)) continue;
                        response = new byte[8 + 12 * count];
                        for (var i = 0; i < count; i++)
                        {
                            BinaryPrimitives.WriteInt32BigEndian(response.AsSpan(8 + i * 12), counts[i]!.Seeders);
                            BinaryPrimitives.WriteInt32BigEndian(response.AsSpan(12 + i * 12), counts[i]!.Completed);
                            BinaryPrimitives.WriteInt32BigEndian(response.AsSpan(16 + i * 12), counts[i]!.Leechers);
                        }
                    }
                    BinaryPrimitives.WriteInt32BigEndian(response, action);
                    BinaryPrimitives.WriteInt32BigEndian(response.AsSpan(4), transaction);
                    if (_errorAction == action)
                    {
                        response = response[..8];
                        BinaryPrimitives.WriteInt32BigEndian(response, 3);
                    }
                    if (_sendMalformed)
                    {
                        await _socket.SendAsync(new byte[3], packet.RemoteEndPoint, _stop.Token);
                        var mismatched = (byte[])response.Clone();
                        BinaryPrimitives.WriteInt32BigEndian(mismatched.AsSpan(4), unchecked(transaction + 1));
                        await _socket.SendAsync(mismatched, packet.RemoteEndPoint, _stop.Token);
                        await _socket.SendAsync(response[..^1], packet.RemoteEndPoint, _stop.Token);
                    }
                    await _socket.SendAsync(response, packet.RemoteEndPoint, _stop.Token);
                }
            }
            catch (OperationCanceledException) when (_stop.IsCancellationRequested) { }
        }

        public async ValueTask DisposeAsync()
        {
            await _stop.CancelAsync();
            await _loop;
            _socket.Dispose();
            _stop.Dispose();
        }
    }
}
