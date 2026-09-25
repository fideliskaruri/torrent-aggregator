using TorrentFlow.Core.Torrents;

namespace TorrentFlow.Core.Tests;

public sealed class PublicTrackersTests : IDisposable
{
    private const string Hash = "08ada5a7a6183aae1e09d831df6748d566095a10";

    public void Dispose() => PublicTrackers.Reset();

    private static string[] Valid(int n) => Enumerable.Range(1, n).Select(i => $"udp://tracker{i}.example.org:{1000 + i}/announce").ToArray();

    [Fact]
    public void DefaultIsTheBundledBestList()
    {
        Assert.Equal(15, PublicTrackers.Default.Length);
        Assert.Equal("udp://tracker.opentrackr.org:1337/announce", PublicTrackers.Default[0]);
        Assert.DoesNotContain(PublicTrackers.Default, t => t.Contains("openbittorrent", StringComparison.Ordinal) || t.Contains("tiny-vps", StringComparison.Ordinal));
        Assert.Equal(PublicTrackers.Default, PublicTrackers.Current);
    }

    [Fact]
    public void UpdateKeepsOnlyValidDistinctAnnounceUrls()
    {
        string[] input =
        [
            "  udp://a.example.org:80/announce  ", "udp://a.example.org:80/announce", "UDP://A.EXAMPLE.ORG:80/announce",
            "http://b.example.org/announce", "https://c.example.org/announce", "wss://d.example.org/announce",
            "ftp://e.example.org/announce", "not a url", "/relative/announce", "", "udp://f.example.org:6969/announce",
            "udp://g.example.org:6969/announce",
        ];

        Assert.True(PublicTrackers.Update(input));
        Assert.Equal(
            ["udp://a.example.org:80/announce", "http://b.example.org/announce", "https://c.example.org/announce",
             "udp://f.example.org:6969/announce", "udp://g.example.org:6969/announce"],
            PublicTrackers.Current);
    }

    [Fact]
    public void UpdateIgnoresListsWithFewerThanFiveValidTrackers()
    {
        Assert.False(PublicTrackers.Update([.. Valid(4), "garbage", "ws://x.example.org/announce"]));
        Assert.False(PublicTrackers.Update(null));
        Assert.False(PublicTrackers.Update([]));
        Assert.Equal(PublicTrackers.Default, PublicTrackers.Current);
    }

    [Fact]
    public void UpdateCapsAtThirty()
    {
        Assert.True(PublicTrackers.Update(Valid(50)));
        Assert.Equal(PublicTrackers.MaxTrackers, PublicTrackers.Current.Count);
        Assert.Equal(Valid(30), PublicTrackers.Current);
    }

    [Fact]
    public void WidenMagnetAppendsCurrentTrackersWithoutDuplicatingOwn()
    {
        var magnet = $"magnet:?xt=urn:btih:{Hash}&dn=x&tr={Uri.EscapeDataString(PublicTrackers.Default[0])}";

        var widened = PublicTrackers.WidenMagnet(magnet);

        var trackers = PublicTrackers.TrackersOf(widened);
        Assert.StartsWith(magnet, widened, StringComparison.Ordinal);
        Assert.Equal(PublicTrackers.Default.Length, trackers.Count);
        Assert.Equal(PublicTrackers.Default.Order(), trackers.Order());
    }

    [Fact]
    public void WidenMagnetUsesTheRefreshedList()
    {
        PublicTrackers.Update(Valid(6));
        var widened = PublicTrackers.WidenMagnet($"magnet:?xt=urn:btih:{Hash}");
        Assert.Equal(Valid(6), PublicTrackers.TrackersOf(widened));
    }

    [Fact]
    public void WidenMagnetLeavesPrivateOrLocalOnlyMagnetsAlone()
    {
        foreach (var tracker in new[] { "http://192.168.1.5:8080/announce", "http://10.0.0.2/announce", "http://127.0.0.1:9/announce", "http://localhost:1/announce", "http://nas.local/announce", "http://172.20.0.1/announce" })
        {
            var magnet = $"magnet:?xt=urn:btih:{Hash}&tr={Uri.EscapeDataString(tracker)}";
            Assert.Equal(magnet, PublicTrackers.WidenMagnet(magnet));
        }
    }

    [Fact]
    public void WidenMagnetWidensMixedPublicAndLocalTrackers()
    {
        var magnet = $"magnet:?xt=urn:btih:{Hash}&tr={Uri.EscapeDataString("http://192.168.1.5/announce")}&tr={Uri.EscapeDataString("udp://tracker.example.org:1/announce")}";
        Assert.Equal(2 + PublicTrackers.Default.Length, PublicTrackers.TrackersOf(PublicTrackers.WidenMagnet(magnet)).Count);
    }

    [Fact]
    public void WidenMagnetHonoursAnExplicitList()
    {
        var widened = PublicTrackers.WidenMagnet($"magnet:?xt=urn:btih:{Hash}", ["udp://only.example.org:1/announce"]);
        Assert.Equal(["udp://only.example.org:1/announce"], PublicTrackers.TrackersOf(widened));
    }

    [Fact]
    public void BuildMagnetEncodesNameAndDeduplicatesTrackers()
    {
        var magnet = PublicTrackers.BuildMagnet(Hash, "A & B", ["udp://a.example.org:1/announce", "udp://a.example.org:1/announce", "http://b.example.org/announce"]);
        Assert.Equal($"magnet:?xt=urn:btih:{Hash}&dn=A%20%26%20B&tr=udp%3A%2F%2Fa.example.org%3A1%2Fannounce&tr=http%3A%2F%2Fb.example.org%2Fannounce", magnet);
        Assert.Equal($"magnet:?xt=urn:btih:{Hash}", PublicTrackers.BuildMagnet(Hash, null, null));
    }
}
