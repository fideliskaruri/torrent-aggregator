using TorrentFlow.Engine.Layout;

namespace TorrentFlow.Engine.Tests;

/// <summary>What a re-add may reuse from <c>layout-manifest.json</c>.</summary>
public sealed class LayoutManifestStoreTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "tf-manifest-" + Guid.NewGuid().ToString("N"));

    public LayoutManifestStoreTests() => Directory.CreateDirectory(_root);

    public void Dispose()
    {
        try { Directory.Delete(_root, recursive: true); } catch (IOException) { }
    }

    private string Touch(string rel)
    {
        var path = Path.GetFullPath(Path.Combine(_root, rel));
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllText(path, "x");
        return path;
    }

    private string ManifestPath => Path.Combine(_root, "layout-manifest.json");

    [Fact]
    public void IndexedPathsAreReusedOnlyWhileEveryRecordedFileIsOnDisk()
    {
        var video = Touch("Season 01/S01E01.mkv");
        var sample = Touch("Season 01/Sample/R/sample.mkv");
        var store = new CompletedLayoutManifestStore(ManifestPath);
        store.Remember("ABC", _root, [video, null, sample]);

        Assert.Equal([video, null, sample], new CompletedLayoutManifestStore(ManifestPath).IndexedPaths("abc", _root));
        Assert.False(store.CanReuseFlatLayout("abc", _root, out _));

        File.Delete(sample);
        Assert.Null(store.IndexedPaths("abc", _root));
    }

    [Fact]
    public void AnEntryFromBeforeIndexedPathsStillReusesItsFlatLayout()
    {
        var video = Touch("S01E01.mkv");
        File.WriteAllText(ManifestPath,
            $$"""[{"hash":"abc","savePath":{{System.Text.Json.JsonSerializer.Serialize(_root)}},"files":[{{System.Text.Json.JsonSerializer.Serialize(video)}}]}]""");
        var store = new CompletedLayoutManifestStore(ManifestPath);

        Assert.Null(store.IndexedPaths("abc", _root));
        Assert.True(store.CanReuseFlatLayout("abc", _root, out var files));
        Assert.Equal([video], files);
    }
}
