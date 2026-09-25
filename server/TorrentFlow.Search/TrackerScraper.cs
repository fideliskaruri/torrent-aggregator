using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using Microsoft.Extensions.Logging;

namespace TorrentFlow.Search;

public sealed record ScrapeCount(int Seeders, int Leechers, int Completed, int TrackersAnswered);

public interface ITrackerScraper
{
    Task<IReadOnlyDictionary<string, ScrapeCount>> ScrapeAsync(
        IReadOnlyCollection<string> infoHashes, TimeSpan budget, CancellationToken ct = default);
}

public sealed class TrackerScraper : ITrackerScraper, IDisposable
{
    private static readonly string[] DefaultTrackers =
    [
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://open.demonii.com:1337/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://explodie.org:6969/announce",
        "udp://tracker.qu.ax:6969/announce"
    ];
    private const int BatchSize = 74;
    private const int CacheLimit = 5000;
    private const int QuorumTrackers = 3;
    private static readonly TimeSpan QuorumGrace = TimeSpan.FromMilliseconds(250);
    private readonly IHttpClientFactory _http;
    private readonly ILogger<TrackerScraper> _logger;
    private readonly Tracker[] _trackers;
    private readonly object _cacheLock = new();
    private readonly Dictionary<string, CacheEntry> _cache = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _cacheOrder = new();

    public TrackerScraper(IHttpClientFactory http, ILogger<TrackerScraper> logger)
        : this(http, logger, DefaultTrackers) { }

    public TrackerScraper(IHttpClientFactory http, ILogger<TrackerScraper> logger, IReadOnlyCollection<string> trackers)
    {
        _http = http;
        _logger = logger;
        _trackers = trackers.Select(value => Uri.TryCreate(value, UriKind.Absolute, out var uri) ? uri : null)
            .OfType<Uri>().Where(uri => uri.Scheme is "udp" or "http" or "https")
            .Distinct().Select(uri => new Tracker(uri)).ToArray();
    }

    public async Task<IReadOnlyDictionary<string, ScrapeCount>> ScrapeAsync(
        IReadOnlyCollection<string> infoHashes, TimeSpan budget, CancellationToken ct = default)
    {
        ct.ThrowIfCancellationRequested();
        var result = new Dictionary<string, ScrapeCount>(StringComparer.Ordinal);
        if (budget <= TimeSpan.Zero) return result;
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
        deadline.CancelAfter(budget);
        var pending = new List<string>();
        lock (_cacheLock)
        {
            foreach (var hash in infoHashes.Where(IsHash).Select(hash => hash.ToLowerInvariant()).Distinct())
            {
                if (_cache.TryGetValue(hash, out var entry))
                {
                    if (entry.Expires > DateTimeOffset.UtcNow)
                    {
                        result[hash] = entry.Count;
                        continue;
                    }
                    _cache.Remove(hash);
                    _cacheOrder.Remove(entry.Node);
                }
                pending.Add(hash);
            }
        }
        if (pending.Count == 0) return result;
        var gate = new object();
        var finished = false;
        void Accept(string hash, ScrapeCount count)
        {
            lock (gate)
            {
                if (finished) return;
                result[hash] = result.TryGetValue(hash, out var prior)
                    ? new(Math.Max(prior.Seeders, count.Seeders), Math.Max(prior.Leechers, count.Leechers),
                        Math.Max(prior.Completed, count.Completed), prior.TrackersAnswered + 1)
                    : count;
            }
        }
        var retryDelay = TimeSpan.FromMilliseconds(Math.Max(1, Math.Min(400, budget.TotalMilliseconds / 3)));
        // Some public trackers are always down; once a quorum has answered, the rest get a short grace, not the whole budget.
        var quorum = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var answered = 0;
        var tasks = _trackers.Select(async tracker =>
        {
            var any = false;
            try { await QueryAsync(tracker, pending.ToArray(), retryDelay, (hash, count) => { any = true; Accept(hash, count); }, deadline.Token).ConfigureAwait(false); }
            catch (Exception e) when (e is not OperationCanceledException) { _logger.LogDebug(e, "Scrape of {Tracker} failed", tracker.Uri.GetLeftPart(UriPartial.Authority)); }
            if (any && Interlocked.Increment(ref answered) >= QuorumTrackers) quorum.TrySetResult();
        }).ToArray();
        try
        {
            var enough = quorum.Task.ContinueWith(_ => Task.Delay(QuorumGrace, deadline.Token), TaskScheduler.Default).Unwrap();
            await Task.WhenAny(Task.WhenAll(tasks), enough).WaitAsync(deadline.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (deadline.IsCancellationRequested) { }
        finally
        {
            lock (gate) finished = true;
            await deadline.CancelAsync().ConfigureAwait(false);
        }
        ct.ThrowIfCancellationRequested();
        lock (_cacheLock)
        {
            foreach (var hash in pending)
            {
                if (!result.TryGetValue(hash, out var count)) continue;
                if (_cache.Remove(hash, out var previous)) _cacheOrder.Remove(previous.Node);
                while (_cache.Count >= CacheLimit && _cacheOrder.First is { } oldest)
                {
                    _cache.Remove(oldest.Value);
                    _cacheOrder.RemoveFirst();
                }
                _cache[hash] = new(count, DateTimeOffset.UtcNow.AddMinutes(10), _cacheOrder.AddLast(hash));
            }
        }
        return result;
    }

    private async Task QueryAsync(Tracker tracker, string[] hashes, TimeSpan retryDelay,
        Action<string, ScrapeCount> accept, CancellationToken ct)
    {
        try
        {
            if (tracker.Uri.Scheme != "udp")
            {
                await QueryHttpAsync(tracker.Uri, hashes, accept, ct).ConfigureAwait(false);
                return;
            }
            await tracker.Gate.WaitAsync(ct).ConfigureAwait(false);
            try
            {
                var socket = await GetSocketAsync(tracker, ct).ConfigureAwait(false);
                if (socket is null) return;
                if (tracker.ConnectionExpires <= DateTimeOffset.UtcNow)
                {
                    var request = Request(0x41727101980, 0, 0);
                    var response = await ExchangeAsync(socket, request, 0, 16, retryDelay, ct).ConfigureAwait(false);
                    tracker.ConnectionId = BinaryPrimitives.ReadInt64BigEndian(response.AsSpan(8));
                    tracker.ConnectionExpires = DateTimeOffset.UtcNow.AddSeconds(60);
                }
                foreach (var batch in hashes.Chunk(BatchSize))
                {
                    var request = Request(tracker.ConnectionId, 2, batch.Length * 20);
                    for (var i = 0; i < batch.Length; i++)
                        Convert.FromHexString(batch[i]).CopyTo(request, 16 + i * 20);
                    var response = await ExchangeAsync(socket, request, 2, 8 + batch.Length * 12, retryDelay, ct).ConfigureAwait(false);
                    for (var i = 0; i < batch.Length; i++)
                    {
                        var seeders = BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(8 + i * 12));
                        var completed = BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(12 + i * 12));
                        var leechers = BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(16 + i * 12));
                        if (seeders >= 0 && completed >= 0 && leechers >= 0)
                            accept(batch[i], new(seeders, leechers, completed, 1));
                    }
                }
            }
            catch
            {
                tracker.ConnectionExpires = default;
                throw;
            }
            finally { tracker.Gate.Release(); }
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Tracker scrape failed for {Tracker}", tracker.Uri.GetLeftPart(UriPartial.Authority));
        }
    }

    private async Task<UdpClient?> GetSocketAsync(Tracker tracker, CancellationToken ct)
    {
        if (tracker.Socket is not null) return tracker.Socket;
        if (tracker.DnsRetryAfter > DateTimeOffset.UtcNow) return null;
        using var dnsTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        dnsTimeout.CancelAfter(TimeSpan.FromMilliseconds(750));
        try
        {
            var addresses = await Dns.GetHostAddressesAsync(tracker.Uri.DnsSafeHost, dnsTimeout.Token).ConfigureAwait(false);
            var address = addresses.OrderBy(ip => ip.AddressFamily == AddressFamily.InterNetwork ? 0 : 1).FirstOrDefault();
            if (address is null) throw new SocketException((int)SocketError.HostNotFound);
            var socket = new UdpClient(address.AddressFamily);
            try { socket.Connect(new IPEndPoint(address, tracker.Uri.Port)); }
            catch { socket.Dispose(); throw; }
            tracker.Socket = socket;
            return socket;
        }
        catch (Exception ex) when (ex is SocketException || ex is OperationCanceledException && !ct.IsCancellationRequested)
        {
            tracker.DnsRetryAfter = DateTimeOffset.UtcNow.AddMinutes(5);
            _logger.LogDebug(ex, "Tracker DNS failed for {Host}", tracker.Uri.DnsSafeHost);
            return null;
        }
    }

    private async Task<byte[]> ExchangeAsync(UdpClient socket, byte[] request, int action, int minimumLength,
        TimeSpan retryDelay, CancellationToken ct)
    {
        var transaction = BinaryPrimitives.ReadInt32BigEndian(request.AsSpan(12));
        for (var attempt = 0; attempt < 2; attempt++)
        {
            await socket.SendAsync(request, ct).ConfigureAwait(false);
            using var receiveTimeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            if (attempt == 0) receiveTimeout.CancelAfter(retryDelay);
            try
            {
                while (true)
                {
                    var response = (await socket.ReceiveAsync(receiveTimeout.Token).ConfigureAwait(false)).Buffer;
                    if (response.Length < 8 || BinaryPrimitives.ReadInt32BigEndian(response.AsSpan(4)) != transaction)
                    {
                        _logger.LogDebug("Ignoring short or unmatched tracker packet");
                        continue;
                    }
                    var responseAction = BinaryPrimitives.ReadInt32BigEndian(response);
                    if (responseAction == 3) throw new IOException("Tracker returned an error response");
                    if (responseAction == action && response.Length >= minimumLength) return response;
                    _logger.LogDebug("Ignoring unexpected or truncated tracker response");
                }
            }
            catch (OperationCanceledException) when (attempt == 0 && !ct.IsCancellationRequested) { }
        }
        throw new TimeoutException("Tracker did not answer");
    }

    private async Task QueryHttpAsync(Uri tracker, string[] hashes, Action<string, ScrapeCount> accept, CancellationToken ct)
    {
        var path = tracker.AbsolutePath;
        var announce = path.LastIndexOf("/announce", StringComparison.Ordinal);
        if (announce < 0) return;
        var builder = new UriBuilder(tracker) { Path = path[..announce] + "/scrape" + path[(announce + 9)..], Fragment = "" };
        using var client = _http.CreateClient("TorrentFlow.Indexers");
        foreach (var batch in hashes.Chunk(BatchSize))
        {
            var query = string.Join("&", batch.Select(hash => "info_hash=" +
                string.Concat(Convert.FromHexString(hash).Select(value => $"%{value:X2}"))));
            builder.Query = string.IsNullOrEmpty(tracker.Query) ? query : tracker.Query[1..] + "&" + query;
            using var response = await client.GetAsync(builder.Uri, HttpCompletionOption.ResponseHeadersRead, ct).ConfigureAwait(false);
            response.EnsureSuccessStatusCode();
            await using var stream = await response.Content.ReadAsStreamAsync(ct).ConfigureAwait(false);
            using var body = new MemoryStream();
            var buffer = new byte[8192];
            int read;
            while ((read = await stream.ReadAsync(buffer, ct).ConfigureAwait(false)) != 0)
            {
                if (body.Length + read > 1024 * 1024) throw new InvalidDataException("Scrape response too large");
                body.Write(buffer, 0, read);
            }
            if (new Bencode(body.ToArray()).Decode() is not Dictionary<string, object> root ||
                !root.TryGetValue("files", out var filesValue) || filesValue is not Dictionary<string, object> files)
                throw new InvalidDataException("Missing scrape files dictionary");
            foreach (var hash in batch)
            {
                if (files.TryGetValue(Encoding.Latin1.GetString(Convert.FromHexString(hash)), out var value) &&
                    value is Dictionary<string, object> counts &&
                    ReadCount(counts, "complete") is { } seeders &&
                    ReadCount(counts, "incomplete") is { } leechers &&
                    ReadCount(counts, "downloaded") is { } completed)
                    accept(hash, new(seeders, leechers, completed, 1));
            }
        }
    }

    private static int? ReadCount(Dictionary<string, object> values, string key) =>
        values.TryGetValue(key, out var value) && value is long count && count is >= 0 and <= int.MaxValue ? (int)count : null;

    private static bool IsHash(string? value) =>
        value is { Length: 40 } && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f' or >= 'A' and <= 'F');

    private static byte[] Request(long connection, int action, int payloadLength)
    {
        var request = new byte[16 + payloadLength];
        BinaryPrimitives.WriteInt64BigEndian(request, connection);
        BinaryPrimitives.WriteInt32BigEndian(request.AsSpan(8), action);
        RandomNumberGenerator.Fill(request.AsSpan(12, 4));
        return request;
    }

    public void Dispose()
    {
        foreach (var tracker in _trackers) tracker.Socket?.Dispose();
    }

    private sealed class Tracker(Uri uri)
    {
        public Uri Uri { get; } = uri;
        public SemaphoreSlim Gate { get; } = new(1, 1);
        public UdpClient? Socket { get; set; }
        public long ConnectionId { get; set; }
        public DateTimeOffset ConnectionExpires { get; set; }
        public DateTimeOffset DnsRetryAfter { get; set; }
    }

    private sealed record CacheEntry(ScrapeCount Count, DateTimeOffset Expires, LinkedListNode<string> Node);

    private sealed class Bencode(byte[] data)
    {
        private int _position;
        private int _nodes;

        public object Decode()
        {
            var value = Read(0);
            if (_position != data.Length) throw new InvalidDataException("Trailing bencode");
            return value;
        }

        private object Read(int depth)
        {
            if (depth > 32 || ++_nodes > 50000 || _position >= data.Length)
                throw new InvalidDataException("Invalid bencode limits");
            var marker = data[_position];
            if (marker == (byte)'i')
            {
                var start = ++_position;
                while (_position < data.Length && data[_position] != (byte)'e') _position++;
                if (_position == data.Length || !long.TryParse(Encoding.ASCII.GetString(data, start, _position - start),
                        NumberStyles.AllowLeadingSign, CultureInfo.InvariantCulture, out var number))
                    throw new InvalidDataException("Invalid bencode integer");
                _position++;
                return number;
            }
            if (marker is (byte)'d' or (byte)'l')
            {
                _position++;
                var dictionary = new Dictionary<string, object>(StringComparer.Ordinal);
                var list = new List<object>();
                while (_position < data.Length && data[_position] != (byte)'e')
                {
                    if (marker == (byte)'d')
                    {
                        var key = Read(depth + 1) as byte[] ?? throw new InvalidDataException("Invalid bencode key");
                        dictionary.Add(Encoding.Latin1.GetString(key), Read(depth + 1));
                    }
                    else list.Add(Read(depth + 1));
                }
                if (_position == data.Length) throw new InvalidDataException("Unterminated bencode collection");
                _position++;
                return marker == (byte)'d' ? dictionary : list;
            }
            var length = 0;
            var digits = 0;
            while (_position < data.Length && data[_position] is >= (byte)'0' and <= (byte)'9')
            {
                length = checked(length * 10 + data[_position++] - (byte)'0');
                digits++;
            }
            if (digits == 0 || _position >= data.Length || data[_position++] != (byte)':' || length > data.Length - _position)
                throw new InvalidDataException("Invalid bencode string");
            var bytes = data.AsSpan(_position, length).ToArray();
            _position += length;
            return bytes;
        }
    }
}
