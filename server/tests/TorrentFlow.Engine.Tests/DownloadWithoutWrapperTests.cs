using Microsoft.EntityFrameworkCore;
using MonoTorrent;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine.Tests;

/// <summary>
/// Downloads write into their own stage folder (<c>&lt;download root&gt;\.staging\&lt;hash&gt;</c>, docs/english-gates-plan.md
/// section 1), never into the season folder: the owner's <c>www.UIndex.org    -    Rick and Morty S01E0N ...</c> wrappers
/// only ever exist there, and the layout drops them when the files are promoted.
/// </summary>
public sealed class DownloadWithoutWrapperTests
{
    private static async Task<(byte[] Bytes, Torrent Torrent, string Hash, string Magnet)> ReleaseAsync(string sourceRoot, int e, string note)
    {
        var src = Path.Combine(sourceRoot, $"www.UIndex.org    -    Rick and Morty S01E0{e} 1080p BluRay x265");
        Directory.CreateDirectory(src);
        await File.WriteAllBytesAsync(Path.Combine(src, $"Rick and Morty S01E0{e} 1080p BluRay x265.mkv"), Enumerable.Repeat((byte)e, 200_000).ToArray());
        await File.WriteAllTextAsync(Path.Combine(src, "www.UIndex.org.txt"), note);
        var bytes = (await new TorrentCreator { PieceLength = 64 * 1024 }.CreateAsync(new TorrentFileSource(src))).Encode();
        var torrent = Torrent.Load(bytes);
        var hash = torrent.InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        return (bytes, torrent, hash, $"magnet:?xt=urn:btih:{hash}&dn={Uri.EscapeDataString(torrent.Name)}");
    }

    private static async Task<bool> AddAsync(RealEngineHarness h, (byte[] Bytes, Torrent Torrent, string Hash, string Magnet) r) =>
        (await h.Engine.AddAsync(new EngineAddRequest { Name = r.Torrent.Name, Magnet = r.Magnet, TorrentBytes = r.Bytes, Purpose = "keep", WorkId = "show" })).Ok;

    [Fact]
    public async Task EpisodesDownloadIntoTheirOwnStageFolderAndNothingReachesTheSaveFolder()
    {
        var root = EngineHarness.NewRoot();
        var downloads = Path.Combine(root, "downloads");
        var first = await ReleaseAsync(Path.Combine(root, "source"), 1, "first");
        var second = await ReleaseAsync(Path.Combine(root, "source"), 2, "second!");
        await using var h = await RealEngineHarness.CreateAsync(root, cap: 2);

        Assert.True(await AddAsync(h, first));
        Assert.True(await AddAsync(h, second));

        // Same file names (the site note) never collide: each release writes in a stage folder of its own.
        string Staged((byte[] Bytes, Torrent Torrent, string Hash, string Magnet) r, string p) =>
            Path.GetFullPath(Path.Combine(downloads, ".staging", r.Hash, r.Torrent.Name, p));
        Assert.All(h.Backend.Get(first.Hash)!.Files, f => Assert.Equal(Staged(first, f.Path), Path.GetFullPath(f.FullPath)));
        Assert.All(h.Backend.Get(second.Hash)!.Files, f => Assert.Equal(Staged(second, f.Path), Path.GetFullPath(f.FullPath)));
        Assert.True(File.GetAttributes(Path.Combine(downloads, ".staging")).HasFlag(FileAttributes.Hidden));
        Assert.True(File.Exists(Path.Combine(downloads, ".staging", ".ignore")));
        Assert.Empty(Directory.EnumerateFileSystemEntries(downloads).Where(p => Path.GetFileName(p) != ".staging"));
    }
}