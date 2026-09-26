using Microsoft.EntityFrameworkCore;
using MonoTorrent;
using TorrentFlow.Core.Contracts.Engine;

namespace TorrentFlow.Engine.Tests;

/// <summary>
/// Downloads write without their release folder, as the Next.js engine did: the owner's
/// <c>www.UIndex.org    -    Rick and Morty S01E0N ...</c> wrappers never appear in the season folder.
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
    public async Task EpisodesDownloadStraightIntoTheSaveFolderAndOnlyATakenPathStaysInTheReleaseFolder()
    {
        var root = EngineHarness.NewRoot();
        var downloads = Path.Combine(root, "downloads");
        var first = await ReleaseAsync(Path.Combine(root, "source"), 1, "first");
        var second = await ReleaseAsync(Path.Combine(root, "source"), 2, "second!");
        await using var h = await RealEngineHarness.CreateAsync(root, cap: 2);

        Assert.True(await AddAsync(h, first));
        Assert.True(await AddAsync(h, second));

        var one = h.Backend.Get(first.Hash)!;
        var two = h.Backend.Get(second.Hash)!;
        string Flat(string p) => Path.GetFullPath(Path.Combine(downloads, p));
        Assert.All(one.Files, f => Assert.Equal(Flat(f.Path), Path.GetFullPath(f.FullPath)));
        var video = two.Files.Single(f => f.Path.EndsWith(".mkv"));
        Assert.Equal(Flat(video.Path), Path.GetFullPath(video.FullPath));
        // The site note is the first torrent's path: this one writes it in its own release folder.
        var note = two.Files.Single(f => f.Path.EndsWith(".txt"));
        Assert.Equal(Path.GetFullPath(Path.Combine(downloads, second.Torrent.Name, note.Path)), Path.GetFullPath(note.FullPath));
    }
}