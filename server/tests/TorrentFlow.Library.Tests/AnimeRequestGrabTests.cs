using System.Net;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using TorrentFlow.Api.Requests;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;
using TorrentFlow.Library.Features.Grabs;
using TorrentFlow.Metadata;
using TorrentFlow.Metadata.Artwork;
using TorrentFlow.Metadata.Providers;
using TorrentFlow.Metadata.Recommend;
using TorrentFlow.Metadata.Title;

namespace TorrentFlow.Library.Tests;

public sealed class AnimeRequestGrabTests
{
    [Theory]
    [InlineData("Frieren", "154587", "FINISHED", 3, null, 3)]
    [InlineData("One Piece", "21", "RELEASING", 12, 3, 2)]
    [InlineData("Attack on Titan", "16498", "FINISHED", 3, null, 3)]
    [InlineData("Future Anime", "99", "NOT_YET_RELEASED", 12, 1, 0)]
    [InlineData("Unknown Anime", "100", "RELEASING", 12, null, 0)]
    public async Task NullDatedAniListEpisodesUseProviderAiringEvidence(string title, string id, string status,
        int count, int? next, int expected)
    {
        using var host = new LibraryHost();
        using var client = host.CreateClient();
        await host.Settings();
        host.Engine.AddResult = add => new(true, "Started", Hash: add.InfoHash);
        host.Search.Respond = o => new()
        {
            Query = o.Query,
            Results = [FakeSearch.Release($"{title} S01E{o.Filters!.Episode:00} 1080p") with { InfoHash = o.Filters.Episode!.Value.ToString("x40") }]
        };
        var http = new HttpFactory(new Handler(JsonSerializer.Serialize(new
        {
            data = new { Media = new { id = int.Parse(id), title = new { english = title }, format = "TV", status, episodes = count,
                nextAiringEpisode = next == null ? null : new { episode = next } } }
        })));
        var options = Options.Create(new MetadataOptions());
        var time = TimeProvider.System;
        var tmdb = new TmdbClient(http, options, time);
        var anilist = new AniListClient(http, time);
        var keyless = new KeylessClients(http);
        var extras = new TitleExtrasService(tmdb, anilist, keyless, new ArtworkResolver(tmdb, anilist, keyless, options, time),
            new RecommendationService(http, tmdb, null!, time, NullLogger<RecommendationService>.Instance),
            time, NullLogger<TitleExtrasService>.Instance);
        var grabber = new RequestGrabber(host.Services.GetRequiredService<GrabService>(), extras, time,
            host.Services.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>());
        var outcome = await grabber.GrabAsync(new MediaRequest
        {
            Id = "request", Title = title, Provider = "anilist", ProviderId = id, MediaType = "anime",
            Scope = MediaRequestScope.Seasons, Seasons = "[1]", WorkKey = ReleaseSelection.WorkKey(title)
        }, default);
        Assert.Equal(expected, host.Engine.Adds.Count);
        if (expected > 0)
        {
            Assert.All(host.Engine.Adds, add => Assert.Equal("request", add.Lane));
            Assert.Null(outcome.Problem);
        }
        else Assert.Contains("No aired episodes", outcome.Problem);
    }

    private sealed class Handler(string json) : HttpMessageHandler
    {
        protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken ct) =>
            Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) { Content = new StringContent(json) });
    }
    private sealed class HttpFactory(HttpMessageHandler handler) : IHttpClientFactory
    {
        public HttpClient CreateClient(string name) => new(handler, false);
    }
}
