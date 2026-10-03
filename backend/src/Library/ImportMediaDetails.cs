using System.ComponentModel;
using System.Diagnostics;
using System.Globalization;
using System.Text.Json;

namespace TorrentFlow.Library;

internal sealed record ImportMediaDetails(int? Width, int? Height, double? RuntimeSeconds, string? Error)
{
    internal static async Task<ImportMediaDetails> ReadAsync(string path, CancellationToken ct)
    {
        try
        {
            var details = VideoDimensions.ReadDetails(path);
            if (details.RuntimeSeconds is > 0 && double.IsFinite(details.RuntimeSeconds.Value))
                return new(details.Width, details.Height, details.RuntimeSeconds, null);
            using var process = new Process
            {
                StartInfo = new("ffprobe")
                {
                    UseShellExecute = false, CreateNoWindow = true,
                    RedirectStandardOutput = true, RedirectStandardError = true,
                },
            };
            foreach (var argument in new[] { "-v", "error", "-select_streams", "v:0", "-show_entries",
                "stream=duration,width,height:format=duration", "-of", "json", path })
                process.StartInfo.ArgumentList.Add(argument);
            try { process.Start(); }
            catch (Win32Exception)
            { return new(details.Width, details.Height, null, "The runtime could not be read. Install ffprobe or pick the title yourself."); }
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(ct);
            timeout.CancelAfter(TimeSpan.FromSeconds(8));
            var output = process.StandardOutput.ReadToEndAsync(timeout.Token);
            var errors = process.StandardError.ReadToEndAsync(timeout.Token);
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) when (!ct.IsCancellationRequested)
            {
                if (!process.HasExited) process.Kill(true);
                return new(details.Width, details.Height, null, "Reading this file took too long. Pick the title yourself.");
            }
            catch (OperationCanceledException)
            {
                if (!process.HasExited) process.Kill(true);
                throw;
            }
            await errors;
            if (process.ExitCode == 0)
            {
                using var json = JsonDocument.Parse(await output);
                if (json.RootElement.TryGetProperty("streams", out var streams) && streams.GetArrayLength() > 0)
                {
                    var video = streams[0];
                    double? seconds = Seconds(video);
                    if (seconds is null && json.RootElement.TryGetProperty("format", out var format)) seconds = Seconds(format);
                    if (seconds is > 0 && double.IsFinite(seconds.Value))
                        return new(video.TryGetProperty("width", out var width) ? width.GetInt32() : details.Width,
                            video.TryGetProperty("height", out var height) ? height.GetInt32() : details.Height, seconds, null);
                }
            }
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException)
        { }
        return new(null, null, null, "The video runtime could not be read. Check the file or pick the title yourself.");
    }

    private static double? Seconds(JsonElement element) =>
        element.TryGetProperty("duration", out var value) &&
        double.TryParse(value.ToString(), CultureInfo.InvariantCulture, out var seconds) ? seconds : null;
}
