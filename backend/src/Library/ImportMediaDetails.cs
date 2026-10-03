namespace TorrentFlow.Library;

internal sealed record ImportMediaDetails(int? Width, int? Height, double? RuntimeSeconds, string? Error)
{
    internal static Task<ImportMediaDetails> ReadAsync(string path, CancellationToken ct)
    {
        ct.ThrowIfCancellationRequested();
        try
        {
            var details = VideoDimensions.ReadDetails(path);
            if (details.RuntimeSeconds is > 0 && double.IsFinite(details.RuntimeSeconds.Value))
                return Task.FromResult(new ImportMediaDetails(details.Width, details.Height, details.RuntimeSeconds, null));
            return Task.FromResult(new ImportMediaDetails(details.Width, details.Height, null,
                "The video runtime could not be read. Check the file or pick the title yourself."));
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        { }
        return Task.FromResult(new ImportMediaDetails(null, null, null,
            "The video runtime could not be read. Check the file or pick the title yourself."));
    }
}
