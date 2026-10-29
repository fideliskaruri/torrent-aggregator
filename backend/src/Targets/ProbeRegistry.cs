using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public sealed class ProbeRegistry(IEngine engine, ILogger<ProbeRegistry> logger) : IHostedService
{
    private static readonly TimeSpan ProbeTimeout = TimeSpan.FromSeconds(60);
    private readonly object sync = new();
    private readonly SemaphoreSlim slots = new(6, 6);
    private readonly Dictionary<string, Entry> entries = new(StringComparer.Ordinal);
    private bool stopping;

    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public ProbeTicket Start(Candidate candidate)
    {
        lock (sync)
        {
            if (stopping) throw new InvalidOperationException("Metadata probes are shutting down.");
            var id = Guid.NewGuid().ToString("N");
            var entry = new Entry(id, candidate, new CancellationTokenSource(ProbeTimeout));
            entries.Add(id, entry);
            entry.Completion = RunAsync(entry);
            return new(id, entry.Completion);
        }
    }

    public async Task<ProbeAttachment> TakeAsync(ProbeTicket ticket)
    {
        var attachment = await ticket.Completion.ConfigureAwait(false);
        lock (sync)
        {
            if (!entries.TryGetValue(ticket.Id, out var entry) || entry.Abandoned)
                throw new InvalidOperationException("The metadata probe is no longer available.");
            entries.Remove(ticket.Id);
            entry.Cancellation.Dispose();
            entry.Attachment = null;
        }
        return attachment;
    }

    public async Task AbandonAsync(ProbeTicket ticket)
    {
        ProbeHandle? handle = null;
        lock (sync)
        {
            if (!entries.TryGetValue(ticket.Id, out var entry)) return;
            entry.Abandoned = true;
            if (entry.Completion.IsCompleted)
            {
                handle = entry.Attachment?.Handle;
                entry.Attachment = null;
                entries.Remove(ticket.Id);
                entry.Cancellation.Dispose();
            }
        }
        if (handle is not null) await ReleaseAsync(handle);
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        Task[] pending;
        lock (sync)
        {
            stopping = true;
            foreach (var entry in entries.Values)
            {
                entry.Abandoned = true;
                entry.Cancellation.Cancel();
            }
            pending = [.. entries.Values.Select(entry => entry.Completion)];
        }

        await Task.WhenAll(pending).ConfigureAwait(false);

        ProbeHandle[] handles;
        lock (sync)
        {
            handles = [.. entries.Values.Select(entry => entry.Attachment?.Handle).OfType<ProbeHandle>()];
            foreach (var entry in entries.Values) entry.Cancellation.Dispose();
            entries.Clear();
        }
        foreach (var handle in handles) await ReleaseAsync(handle);
    }

    private async Task<ProbeAttachment> RunAsync(Entry entry)
    {
        await Task.Yield();
        ProbeAttachment result;
        try
        {
            await slots.WaitAsync(entry.Cancellation.Token).ConfigureAwait(false);
            try
            {
                result = await engine.AttachProbeAsync(entry.Candidate, entry.Cancellation.Token)
                    .ConfigureAwait(false);
            }
            finally { slots.Release(); }
        }
        catch (OperationCanceledException) when (entry.Cancellation.IsCancellationRequested)
        {
            result = new(null, null, new("metadata_timeout",
                "Torrent metadata did not arrive before the probe deadline.", null, false));
        }
        catch (Exception ex)
        {
            logger.LogWarning(ex, "Metadata probe failed for {Hash}", entry.Candidate.Release.Id);
            result = new(null, null, new("metadata_probe_failed",
                "Torrent metadata could not be read.", null, false));
        }

        ProbeHandle? release = null;
        lock (sync)
        {
            entry.Attachment = result;
            if (entry.Abandoned || stopping)
            {
                release = entry.Attachment?.Handle;
                entry.Attachment = null;
                entries.Remove(entry.Id);
                entry.Cancellation.Dispose();
            }
        }
        if (release is not null) await ReleaseAsync(release);
        return result;
    }

    private async Task ReleaseAsync(ProbeHandle handle)
    {
        try { await engine.ReleaseProbeAsync(handle, CancellationToken.None).ConfigureAwait(false); }
        catch (Exception ex) { logger.LogWarning(ex, "Could not release metadata probe for {Hash}", handle.Hash); }
    }

    private sealed class Entry(string id, Candidate candidate, CancellationTokenSource cancellation)
    {
        public string Id { get; } = id;
        public Candidate Candidate { get; } = candidate;
        public CancellationTokenSource Cancellation { get; } = cancellation;
        public Task<ProbeAttachment> Completion { get; set; } = Task.FromResult(new ProbeAttachment(null, null, null));
        public ProbeAttachment? Attachment { get; set; }
        public bool Abandoned { get; set; }
    }
}

public sealed record ProbeTicket(string Id, Task<ProbeAttachment> Completion);
