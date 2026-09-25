using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Configuration;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Api.Tests;

public sealed class ContainerHostingTests(HostFactory factory) : IClassFixture<HostFactory>
{
    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    public async Task ContainerCapabilitiesAndFolderOverride(string flag, bool container)
    {
        using var configured = factory.WithWebHostBuilder(builder => builder
            .UseSetting("DOTNET_RUNNING_IN_CONTAINER", flag)
            .UseSetting("TorrentFlow:DefaultDownloadDirectory", "/media")
            .UseSetting("TorrentFlow:DisplayPathMappings:0:ContainerPath", "/media")
            .UseSetting("TorrentFlow:DisplayPathMappings:0:HostPath", @"\\NAS\media"));
        using var client = configured.CreateClient();
        using var features = JsonDocument.Parse(await client.GetStringAsync("/api/features"));
        Assert.Equal(container, features.RootElement.GetProperty("runningInContainer").GetBoolean());
        Assert.Equal(!container, features.RootElement.GetProperty("openFolder").GetBoolean());
        Assert.Equal(@"\\NAS\media", features.RootElement.GetProperty("displayPathMappings")[0].GetProperty("hostPath").GetString());
        using var settings = JsonDocument.Parse(await client.GetStringAsync("/api/settings/client"));
        Assert.Equal("/media", settings.RootElement.GetProperty("defaults").GetProperty("baseDownloadPath").GetString());
        Assert.False(settings.RootElement.GetProperty("settings").GetProperty("setupComplete").GetBoolean());
        if (container)
        {
            using var response = await client.PostAsJsonAsync("/api/settings/open-folder", new { path = "/media" });
            Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
            Assert.Contains("openFolderDisabled", await response.Content.ReadAsStringAsync());
        }
    }

    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    public void UnconfiguredDefaultRemainsNative(string? value)
    {
        var config = new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
        {
            ["TorrentFlow:DefaultDownloadDirectory"] = value,
        }).Build();
        Assert.Equal(Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads", "TorrentFlow"), ClientSettingsStore.DefaultDownloadDir(config));
    }
}
