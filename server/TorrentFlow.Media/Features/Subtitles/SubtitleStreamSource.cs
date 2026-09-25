using System.Net;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Hosting.Server;
using Microsoft.AspNetCore.Hosting.Server.Features;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Media.Features.Subtitles;

/// <summary>
/// A private, short-lived seekable input for ffmpeg. Pipes cannot implement demuxer
/// seeks; copying an entire torrent to scratch would defeat bounded extraction.
/// </summary>
internal sealed class SubtitleStreamSource(WebApplication app, string url) : IAsyncDisposable
{
    public string Url { get; } = url;

    public static async Task<SubtitleStreamSource> OpenAsync(
        ITorrentEngine engine, string hash, string path, CancellationToken ct)
    {
        var builder = WebApplication.CreateSlimBuilder(new WebApplicationOptions { Args = [] });
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        var app = builder.Build();
        var token = Guid.NewGuid().ToString("N");
        app.MapMethods("/" + token, ["GET", "HEAD"], async (HttpContext context) =>
        {
            var stream = await engine.OpenFileStreamAsync(hash, path, context.RequestAborted);
            return Results.Stream(stream, "application/octet-stream", enableRangeProcessing: true);
        });
        try
        {
            await app.StartAsync(ct);
            var addresses = app.Services.GetRequiredService<IServer>().Features.Get<IServerAddressesFeature>()!;
            return new(app, addresses.Addresses.Single() + "/" + token);
        }
        catch
        {
            await app.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        try { await app.StopAsync(timeout.Token); }
        finally { await app.DisposeAsync(); }
    }
}
