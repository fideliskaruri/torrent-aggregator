using System.Threading.Channels;

namespace TorrentFlow.Library.Features.Automation;

public sealed class AutomationWake
{
    private readonly Channel<bool> _channel = Channel.CreateBounded<bool>(new BoundedChannelOptions(1)
    {
        FullMode = BoundedChannelFullMode.DropWrite, SingleReader = true,
    });

    public void Wake() => _channel.Writer.TryWrite(true);

    public async Task Wait(TimeSpan delay, CancellationToken ct)
    {
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
        timeout.CancelAfter(delay);
        try { await _channel.Reader.ReadAsync(timeout.Token); }
        catch (OperationCanceledException) when (!ct.IsCancellationRequested) { }
    }
}
