using System.Collections.Immutable;
using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Threading.Channels;
using TorrentFlow.Domain;
using TorrentFlow.Engine;

namespace TorrentFlow.Check;

public sealed class SwarmCheck(IEngine engine, ICheckRepository repository, CheckOptions options) : ICheck
{
    private readonly object sync = new();
    private readonly Dictionary<string, Flight> flights = [];
    private readonly List<Flight> queue = [];
    private int active, background, peak;
    private long probes, shared, cacheHits;

    public CheckDiagnostics Diagnostics
    {
        get { lock (sync) return new(active, background, queue.Count, flights.Count, peak, probes, shared, cacheHits); }
    }

    public async IAsyncEnumerable<SwarmEvidence> ProbeAsync(ImmutableArray<ProbeRequest> requests,
        [EnumeratorCancellation] CancellationToken ct)
    {
        await foreach (var result in ProbeStreamAsync(Input(requests, ct), ct)) yield return result;
    }

    private static async IAsyncEnumerable<ProbeRequest> Input(ImmutableArray<ProbeRequest> requests,
        [EnumeratorCancellation] CancellationToken ct)
    {
        foreach (var request in requests) { ct.ThrowIfCancellationRequested(); yield return request; }
        await Task.CompletedTask;
    }

    public async IAsyncEnumerable<SwarmEvidence> ProbeStreamAsync(IAsyncEnumerable<ProbeRequest> requests,
        [EnumeratorCancellation] CancellationToken ct)
    {
        using var lifetime = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var output = Channel.CreateBounded<SwarmEvidence>(64);
        var producer = ProduceAsync();
        try
        {
            await foreach (var result in output.Reader.ReadAllAsync(ct)) yield return result;
            await producer;
        }
        finally
        {
            await lifetime.CancelAsync();
            try { await producer; } catch (OperationCanceledException) when (lifetime.IsCancellationRequested) { }
        }

        async Task ProduceAsync()
        {
            var pending = new List<Task>();
            Exception? failure = null;
            try
            {
                await foreach (var request in requests.WithCancellation(lifetime.Token))
                {
                    pending.Add(DeliverAsync(request));
                    if (pending.Count >= 128)
                    {
                        await await Task.WhenAny(pending);
                        pending.RemoveAll(t => t.IsCompletedSuccessfully);
                    }
                }
                await Task.WhenAll(pending);
            }
            catch (Exception ex) { failure = ex; await lifetime.CancelAsync(); }
            finally
            {
                try { await Task.WhenAll(pending); } catch (Exception ex) { failure ??= ex; }
                output.Writer.TryComplete(failure);
            }
        }
        async Task DeliverAsync(ProbeRequest request) =>
            await output.Writer.WriteAsync(await CheckAsync(request, lifetime.Token), lifetime.Token);
    }

    private async Task<SwarmEvidence> CheckAsync(ProbeRequest request, CancellationToken ct)
    {
        var hash = MonoTorrentEngine.NormalizeHash(request.Candidate.Release.Magnet ?? request.Candidate.Release.Id);
        if (hash != request.Candidate.Release.Id) throw new ArgumentException("Release hash and magnet disagree.");
        if (!request.ForceFresh)
        {
            var cached = (await repository.LoadAsync([hash], ct)).FirstOrDefault();
            if (cached is { Band: HealthBand.Unknown } && request.WantedTarget &&
                cached.ExpiresAt > cached.CheckedAt.AddMinutes(options.UnknownMinutes))
                cached = cached with { ExpiresAt = cached.CheckedAt.AddMinutes(options.UnknownMinutes) };
            if (cached is not null && cached.ExpiresAt > DateTimeOffset.UtcNow)
            {
                lock (sync) cacheHits++;
                return cached with { FromCache = true };
            }
        }
        Flight flight;
        lock (sync)
        {
            if (flights.TryGetValue(hash, out var existing))
            {
                flight = existing;
                shared++;
                if (request.Lane == PriorityLane.Owner) flight.Owner = true;
                flight.Wanted |= request.WantedTarget;
                flight.RetainAdmission |= request.RetainAdmission;
            }
            else
            {
                flight = new(request);
                flights.Add(hash, flight);
                queue.Add(flight);
                _ = ExpireQueuedAsync(flight);
            }
            flight.Waiters++;
            Pump();
        }
        try { return await flight.Completion.Task.WaitAsync(ct); }
        finally
        {
            lock (sync)
            {
                if (--flight.Waiters == 0 && !flight.Completion.Task.IsCompleted) flight.Cancellation.Cancel();
            }
        }
    }

    private async Task ExpireQueuedAsync(Flight flight)
    {
        await Task.Delay(TimeSpan.FromSeconds(Math.Max(1, options.QueueWaitSeconds)));
        lock (sync)
        {
            if (!queue.Remove(flight)) return;
            flights.Remove(flight.Request.Candidate.Release.Id);
            flight.Completion.TrySetResult(Unknown(flight, "Probe queue wait expired without measuring the swarm.",
                flight.Enqueued.Elapsed));
            flight.Cancellation.Dispose();
        }
    }

    private void Pump()
    {
        while (active < Math.Clamp(options.Slots, 1, 10))
        {
            var next = queue.FirstOrDefault(f => f.Owner) ??
                (background < Math.Clamp(options.BackgroundSlots, 1, 2) ? queue.FirstOrDefault() : null);
            if (next is null) break;
            queue.Remove(next);
            next.Background = !next.Owner;
            active++;
            if (next.Background) background++;
            peak = Math.Max(peak, active);
            _ = RunAsync(next);
        }
    }

    private async Task RunAsync(Flight flight)
    {
        // Yield before I/O so publishing the flight always precedes execution.
        await Task.Yield();
        try { flight.Completion.TrySetResult(await MeasureAsync(flight)); }
        catch (OperationCanceledException) { flight.Completion.TrySetCanceled(); }
        catch (Exception ex) { flight.Completion.TrySetException(ex); }
        finally
        {
            lock (sync)
            {
                flights.Remove(flight.Request.Candidate.Release.Id);
                active--;
                if (flight.Background) background--;
                Pump();
            }
            flight.Cancellation.Dispose();
        }
    }

    private async Task<SwarmEvidence> MeasureAsync(Flight flight)
    {
        var ct = flight.Cancellation.Token;
        var settings = await repository.SettingsAsync(ct);
        var window = TimeSpan.FromSeconds(Math.Clamp(settings.CheckWindowSeconds, 4, 60));
        var queueBudget = TimeSpan.FromSeconds(Math.Max(1, options.QueueWaitSeconds));
        ProbeAttachment? attachment = null;
        ProbeHandle? handle = null;
        var retained = false;
        var attachmentClock = Stopwatch.StartNew();
        var queueWait = flight.Enqueued.Elapsed;
        try
        {
            while (flight.Enqueued.Elapsed < queueBudget)
            {
                queueWait = flight.Enqueued.Elapsed;
                attachmentClock.Restart();
                using var attachmentDeadline = CancellationTokenSource.CreateLinkedTokenSource(ct);
                attachmentDeadline.CancelAfter(window);
                try { attachment = await engine.AttachProbeAsync(flight.Request.Candidate, attachmentDeadline.Token); }
                catch (OperationCanceledException) when (!ct.IsCancellationRequested)
                { return Unknown(flight, "No attachment or metadata arrived within the observation budget.", queueWait); }
                if (attachment.Handle is not null || attachment.Failure?.Code != "probe_capacity") break;
                await Task.Delay(100, ct);
            }
            if (attachment?.Handle is not { } attached)
                return Unknown(flight, attachment?.Failure?.Code == "probe_capacity"
                    ? "Probe capacity wait expired without measuring the swarm."
                    : attachment?.Failure?.Message ?? "Probe capacity wait expired.", queueWait) with
                    { Persistable = attachment?.Failure?.Code != "owned_hash" };
            handle = attached;
            lock (sync) probes++;
            var remaining = window - attachmentClock.Elapsed;
            if (remaining <= TimeSpan.Zero) return Unknown(flight, "Attachment consumed the observation window.", queueWait);
            var measured = await engine.ObserveProbeAsync(handle, remaining, ct);
            handle = measured.AdmissionHandle ?? handle;
            var band = measured.FromLiveTransfer || measured.Files is null ? HealthBand.Unknown :
                measured.BytesDelivered > 0 && measured.ByteSendingPeers > 0
                    ? measured.Window.TotalSeconds >= options.MinimumGoodSeconds &&
                      measured.BytesDelivered >= settings.GoodBytes &&
                      measured.BytesDelivered / measured.Window.TotalSeconds >= settings.GoodBytesPerSecond
                        ? HealthBand.Good : HealthBand.Weak
                    : measured.ByteSendingPeers == 0 && measured.PeersPresentThroughoutWindow &&
                      measured.Window.TotalSeconds >= options.MinimumGoodSeconds &&
                      measured.Window >= remaining ? HealthBand.Dead : HealthBand.Unknown;
            retained = flight.RetainAdmission && measured.AdmissionHandle is not null &&
                band is HealthBand.Good or HealthBand.Weak;
            var now = DateTimeOffset.UtcNow;
            return measured with
            {
                Band = band, QueueWait = queueWait,
                ProbeVersion = band == HealthBand.Unknown ? options.ProbeVersion : CheckVersion.For(settings, options),
                Reason = band switch
                {
                    HealthBand.Good => "Hash-valid payload and byte-sending peers meet the measured rate threshold.",
                    HealthBand.Weak => "Hash-valid payload arrived below the Good threshold.",
                    HealthBand.Dead => "Connected peers persisted through the full window but delivered no valid payload.",
                    _ => measured.FromLiveTransfer || measured.Files is null || measured.Window < remaining ? measured.Reason :
                        "No hash-valid payload arrived; peer or transport uncertainty prevents a Dead verdict.",
                },
                CheckedAt = now,
                ExpiresAt = now.Add(band == HealthBand.Unknown && flight.Wanted
                    ? TimeSpan.FromMinutes(options.UnknownMinutes) : TimeSpan.FromHours(options.VerdictHours)),
                AdmissionHandle = retained ? measured.AdmissionHandle : null,
                Persistable = measured.Persistable && !ct.IsCancellationRequested,
            };
        }
        catch (Exception ex) when (ex is HttpRequestException or IOException or InvalidOperationException)
        { return Unknown(flight, "The swarm could not be judged: " + ex.Message, flight.Enqueued.Elapsed); }
        finally
        {
            if (handle is not null && (!retained || ct.IsCancellationRequested))
                await engine.ReleaseProbeAsync(handle, CancellationToken.None);
        }
    }

    private SwarmEvidence Unknown(Flight flight, string reason, TimeSpan wait)
    {
        var now = DateTimeOffset.UtcNow;
        return new(flight.Request.Candidate.Release.Id, HealthBand.Unknown, flight.Request.Candidate.Release.Files,
            0, 0, 0, 0, TimeSpan.Zero, null, reason, now,
            now.AddMinutes(flight.Wanted ? options.UnknownMinutes : options.VerdictHours * 60),
            false, true, null) { QueueWait = wait, ProbeVersion = options.ProbeVersion };
    }

    public Task<ImmutableArray<SwarmEvidence>> LoadAsync(ImmutableArray<string> hashes, CancellationToken ct) =>
        repository.LoadAsync(hashes, ct);
    public Task<ImmutableArray<SwarmEvidence>> RecentAsync(int limit, CancellationToken ct) =>
        repository.RecentAsync(limit, ct);

    private sealed class Flight(ProbeRequest request)
    {
        public ProbeRequest Request { get; } = request;
        public bool Owner { get; set; } = request.Lane == PriorityLane.Owner;
        public bool Wanted { get; set; } = request.WantedTarget;
        public bool RetainAdmission { get; set; } = request.RetainAdmission;
        public bool Background { get; set; }
        public int Waiters { get; set; }
        public Stopwatch Enqueued { get; } = Stopwatch.StartNew();
        public CancellationTokenSource Cancellation { get; } = new();
        public TaskCompletionSource<SwarmEvidence> Completion { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
    }
}
