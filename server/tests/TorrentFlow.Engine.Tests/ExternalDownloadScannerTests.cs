using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Options;
using MonoTorrent;
using MonoTorrent.BEncoding;
using TorrentFlow.Engine.Settings;

namespace TorrentFlow.Engine.Tests;

public sealed class ExternalDownloadScannerTests
{
    internal static ExternalDownloadScanner Scanner(string root) => new(
        Options.Create(new ExternalDownloadScanOptions { ScanRoot = root }), NullLogger<ExternalDownloadScanner>.Instance);

    internal static byte[] TorrentBytes(string name, byte[] payload) => new BEncodedDictionary
    {
        ["info"] = new BEncodedDictionary
        {
            ["name"] = new BEncodedString(name), ["length"] = new BEncodedNumber(payload.Length),
            ["piece length"] = new BEncodedNumber(16384), ["pieces"] = new BEncodedString(SHA1.HashData(payload)),
        },
    }.Encode();

    internal static string WriteFixture(string root, string source, bool missing = false, bool partial = false)
    {
        var payload = Encoding.UTF8.GetBytes("original torrent payload");
        var name = source + " fixture.mkv";
        var metadata = TorrentBytes(name, payload);
        var hash = Torrent.Load(metadata).InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
        var save = Path.Combine(root, "original-data", source);
        Directory.CreateDirectory(save);
        if (!missing) File.WriteAllBytes(Path.Combine(save, name), partial ? payload[..5] : payload);
        var folder = source switch
        {
            "qBittorrent" => Path.Combine(root, source, "BT_backup"),
            "Transmission" => Path.Combine(root, "transmission", "torrents"),
            "Deluge" => Path.Combine(root, "deluge", "state"),
            _ => Path.Combine(root, source),
        };
        Directory.CreateDirectory(folder);
        File.WriteAllBytes(Path.Combine(folder, hash + ".torrent"), metadata);
        if (source == "qBittorrent")
            File.WriteAllBytes(Path.Combine(folder, hash + ".fastresume"), new BEncodedDictionary { ["qBt-savePath"] = new BEncodedString(save) }.Encode());
        else if (source == "Transmission")
        {
            var resume = Path.Combine(root, "transmission", "resume");
            Directory.CreateDirectory(resume);
            File.WriteAllBytes(Path.Combine(resume, "fixture." + hash + ".resume"), new BEncodedDictionary { ["destination"] = new BEncodedString(save) }.Encode());
        }
        else if (source == "Deluge")
            File.WriteAllBytes(Path.Combine(folder, "torrents.fastresume"), new BEncodedDictionary
            {
                [hash] = new BEncodedString(new BEncodedDictionary { ["save_path"] = new BEncodedString(save) }.Encode()),
            }.Encode());
        else
            File.WriteAllBytes(Path.Combine(folder, "resume.dat"), new BEncodedDictionary
            {
                [hash + ".torrent"] = new BEncodedDictionary { ["path"] = new BEncodedString(Path.Combine(save, name)) },
            }.Encode());
        return hash;
    }

    [Theory]
    [InlineData("qBittorrent")]
    [InlineData("Transmission")]
    [InlineData("uTorrent")]
    [InlineData("BitTorrent")]
    [InlineData("Deluge")]
    public async Task NativeResumeFormatFindsOriginalPathAndLeavesSourceUntouched(string source)
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var hash = WriteFixture(root, source);
            var before = Directory.GetFiles(root, "*", SearchOption.AllDirectories).ToDictionary(p => p, File.ReadAllBytes);
            var scan = await Scanner(root).ScanAsync();
            Assert.Empty(scan.Warnings);
            var candidate = Assert.Single(scan.Candidates);
            Assert.Equal(hash, candidate.Hash);
            Assert.Equal(Path.Combine(root, "original-data", source), candidate.SavePath);
            Assert.True(candidate.Complete);
            Assert.True(candidate.DataExists);
            Assert.NotNull(candidate.TorrentBytes);
            foreach (var (path, bytes) in before) Assert.Equal(bytes, File.ReadAllBytes(path));
            Assert.Equal(before.Count, Directory.GetFiles(root, "*", SearchOption.AllDirectories).Length);
            Assert.DoesNotContain("torrentBytes", JsonSerializer.Serialize(candidate, new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        }
        finally { Directory.Delete(root, true); }
    }

    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public async Task DistinguishesMissingAndPartialData(bool missing, bool partial)
    {
        var root = EngineHarness.NewRoot();
        try
        {
            WriteFixture(root, "qBittorrent", missing, partial);
            var candidate = Assert.Single((await Scanner(root).ScanAsync()).Candidates);
            Assert.Equal(!missing, candidate.DataExists);
            Assert.False(candidate.Complete);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task MetadataLessMagnetPreservesPrivateTrackerAndMissingState()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var folder = Path.Combine(root, "qBittorrent", "BT_backup");
            Directory.CreateDirectory(folder);
            var magnet = EngineHarness.Magnet(73) + "&tr=" + Uri.EscapeDataString("https://private.example/announce?passkey=fixture");
            File.WriteAllBytes(Path.Combine(folder, EngineHarness.Hash(73) + ".fastresume"), new BEncodedDictionary
            {
                ["qBt-savePath"] = new BEncodedString(Path.Combine(root, "missing")),
                ["magnet"] = new BEncodedString(magnet), ["name"] = new BEncodedString("Pending metadata"),
            }.Encode());
            var candidate = Assert.Single((await Scanner(root).ScanAsync()).Candidates);
            Assert.Equal(magnet, candidate.Magnet);
            Assert.False(candidate.DataExists);
            Assert.Null(candidate.TorrentBytes);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task MalformedEntriesAndDeepBencodeDoNotDiscardValidSources()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            WriteFixture(root, "qBittorrent");
            var folder = Path.Combine(root, "qBittorrent", "BT_backup");
            File.WriteAllText(Path.Combine(folder, "bad.torrent"), "not bencode");
            File.WriteAllText(Path.Combine(folder, "deep.fastresume"), new string('l', 100) + new string('e', 100));
            File.WriteAllBytes(Path.Combine(folder, "bad.fastresume"), Encoding.UTF8.GetBytes("d3:keyiNOT-INTEGERee"));
            var scan = await Scanner(root).ScanAsync();
            Assert.Single(scan.Candidates);
            Assert.True(scan.Warnings.Count >= 3);
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task LegacyPrismaDatabaseReadsWalWithoutChangingSourceAndSkipsRemovedRows()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var folder = Path.Combine(root, "nextjs");
            Directory.CreateDirectory(folder);
            var path = Path.Combine(folder, "dev.db");
            await using var db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
            await db.OpenAsync();
            await using var command = db.CreateCommand();
            command.CommandText = """
                PRAGMA journal_mode=WAL;
                CREATE TABLE EngineTorrent(hash TEXT,name TEXT,savePath TEXT,magnet TEXT,status TEXT,sizeBytes INTEGER,progress REAL);
                INSERT INTO EngineTorrent VALUES($hash,'Legacy fixture',$save,$magnet,'paused',42,0);
                INSERT INTO EngineTorrent VALUES($other,'Removed fixture',$save,$magnet,'removed',42,0);
                """;
            command.Parameters.AddWithValue("$hash", EngineHarness.Hash(88));
            command.Parameters.AddWithValue("$other", EngineHarness.Hash(89));
            command.Parameters.AddWithValue("$save", Path.Combine(root, "old-save"));
            command.Parameters.AddWithValue("$magnet", EngineHarness.Magnet(88));
            await command.ExecuteNonQueryAsync();
            static byte[] ReadShared(string file)
            {
                using var input = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                using var bytes = new MemoryStream();
                input.CopyTo(bytes);
                return bytes.ToArray();
            }
            var before = new[] { "", "-wal", "-shm" }.Where(s => File.Exists(path + s)).ToDictionary(s => s, s => ReadShared(path + s));
            var candidate = Assert.Single((await Scanner(root).ScanAsync()).Candidates);
            Assert.Equal("TorrentFlow Next.js", candidate.Source);
            Assert.Equal(EngineHarness.Hash(88), candidate.Hash);
            foreach (var (suffix, bytes) in before) Assert.Equal(bytes, ReadShared(path + suffix));
        }
        finally { Directory.Delete(root, true); }
    }

    [Fact]
    public async Task MultiFileLayoutUsesTheOriginalContainingDirectory()
    {
        var root = EngineHarness.NewRoot();
        try
        {
            var files = new BEncodedList();
            foreach (var name in new[] { "one.mkv", "two.mkv" })
                files.Add(new BEncodedDictionary { ["length"] = new BEncodedNumber(3), ["path"] = new BEncodedList { new BEncodedString(name) } });
            var metadata = new BEncodedDictionary
            {
                ["info"] = new BEncodedDictionary { ["name"] = new BEncodedString("Pack"), ["files"] = files,
                    ["piece length"] = new BEncodedNumber(16384), ["pieces"] = new BEncodedString(SHA1.HashData("abcabc"u8)) },
            }.Encode();
            var hash = Torrent.Load(metadata).InfoHashes.V1OrV2.ToHex().ToLowerInvariant();
            var save = Path.Combine(root, "data");
            Directory.CreateDirectory(Path.Combine(save, "Pack"));
            File.WriteAllText(Path.Combine(save, "Pack", "one.mkv"), "abc");
            File.WriteAllText(Path.Combine(save, "Pack", "two.mkv"), "abc");
            var backup = Path.Combine(root, "qBittorrent", "BT_backup");
            Directory.CreateDirectory(backup);
            File.WriteAllBytes(Path.Combine(backup, hash + ".torrent"), metadata);
            File.WriteAllBytes(Path.Combine(backup, hash + ".fastresume"), new BEncodedDictionary { ["save_path"] = new BEncodedString(save) }.Encode());
            var candidate = Assert.Single((await Scanner(root).ScanAsync()).Candidates);
            Assert.Equal(save, candidate.SavePath);
            Assert.True(candidate.CreateContainingDirectory);
            Assert.True(candidate.DataExists);
            Assert.True(candidate.Complete);
        }
        finally { Directory.Delete(root, true); }
    }
}
