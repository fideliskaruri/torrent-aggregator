using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Net;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Xml.Linq;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Domain;
using TorrentFlow.Find;
using TorrentFlow.Store;
using TorrentFlow.Targets;

internal static class SourceAudioAudit
{
    private const string T3Hash = "07d77fa13ec33dd235557934e60ee523356a354b";
    private const string T3Name = "Classroom.of.the.Elite.S01.CUSTOM.MULTi.1080p.BluRay.x264-T3KASHi";
    private const string YuraHash = "39de3b8c3c615d7548a73d68c4c956eae30b2428";
    private const string YuraName = "Classroom.of.the.Elite.S01.1080p.BluRay.10-Bit.Dual-Audio.FLAC5.1.x265-YURASUKA (Youkoso Jitsuryoku Shijou Shugi no Kyoushitsu e)";
    private const string ApiBayHash = "a9fe1f26ca2bf5ca21524350587d8e8e447a4190";
    private const string ApiBayName = "Classroom of the Elite English Dub 1080p Season 1";
    private const string JapaneseHash = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string SubtitleHash = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    internal static async Task RunAsync(WorkSnapshot work, TargetRow target)
    {
        work = work with
        {
            Names = [work.Names[0] with { Value = "Classroom of the Elite", NormalizedValue = "classroom of the elite" }],
            Seasons = [work.Seasons[0] with { ExpectedEpisodeCount = 12 }],
            Episodes = [work.Episodes[0], .. Enumerable.Range(2, 11).Select(n =>
                work.Episodes[0] with { Id = "episode" + n, Number = n, AbsoluteNumber = n })],
        };
        var calls = new ConcurrentBag<string>();
        var builder = WebApplication.CreateSlimBuilder();
        builder.Logging.ClearProviders();
        builder.WebHost.ConfigureKestrel(options => options.Listen(IPAddress.Loopback, 0));
        await using var app = builder.Build();
        app.MapGet("/{mode}/", (string mode, string q) => Results.Content(Feed(mode, q), "application/rss+xml"));
        app.MapGet("/{mode}/q.php", (string mode, string q) => (mode == "apibay" && q.Contains("Season 1") || mode == "late-detail")
            ? Results.Json(new[] { new { name = ApiBayName, info_hash = mode == "late-detail" ? T3Hash : ApiBayHash,
                size = "11000000000", seeders = "1" } })
            : Results.Json(Array.Empty<object>()));
        app.MapGet("/{mode}/view/{id}", (string mode, int id) =>
        {
            calls.Add(mode + "/" + id);
            return Detail(mode, id);
        });
        await app.StartAsync();
        var root = app.Urls.Single();

        var all = await Discover("both");
        var selected = all.Result.Plan.Assignments.SingleOrDefault();
        Require(selected?.Hash == YuraHash && selected.Files.Single().FileIndex == 0,
            selected is not null ? "exact YURASUKA season listing maps only the wanted episode" :
            "expected YURASUKA assignment. Find: " + string.Join(", ", all.Result.Find.Queries
                .Select(q => $"{q.Result.Outcome}:{q.Result.Error}")) +
            ". Candidates: " + string.Join(", ", all.Result.Find.Candidates.Select(c =>
                $"{c.Release.Name}:{AnimeAudioPolicy.Match(c)}")) +
            ". Find rejections: " + string.Join(", ", all.Result.Find.Rejections.Select(r => r.Explanation)) +
            ". Plan rejections: " + string.Join(", ", all.Result.Plan.Rejections.Select(r => r.Explanation)));
        Require(Audio(all.Result, YuraHash) == AnimeAudioMatch.English &&
            Audio(all.Result, T3Hash) == AnimeAudioMatch.Other &&
            all.Result.Find.Candidates.Single(c => c.Release.Id == T3Hash).Release.Name == T3Name &&
            !all.Engine.Requested.Contains(T3Hash),
            "exact Nyaa pages classify English/Japanese and French/Japanese before probing");
        Require(all.Result.Find.Candidates.Single(c => c.Release.Id == YuraHash).Release.TotalBytes ==
            12 * 950_000_000L, "probed size and verified audio evidence travel with the selected release");
        Require(calls.Count(call => call == "both/1495607") == 1 &&
            calls.Count(call => call == "both/1733389") == 1, "duplicate search traces do not repeat detail requests");

        var fallback = await Discover("fallback");
        Require(fallback.Result.Plan.Assignments.Single().Hash == JapaneseHash,
            "Japanese fallback uses an explicitly Japanese listing after the French/Japanese one is excluded");
        Require(Audio(fallback.Result, JapaneseHash) == AnimeAudioMatch.Japanese,
            "an inline English subtitle label does not override an explicit Japanese audio field");
        var otherOnly = await Discover("foreign");
        Require(otherOnly.Result.Plan.Assignments.IsEmpty &&
            Audio(otherOnly.Result, T3Hash) == AnimeAudioMatch.Other, "French/Japanese alone stays unassigned");

        foreach (var mode in new[] { "http-failure", "wrong-hash", "subtitle-only", "unknown-track", "truncated",
                     "unspecified-track", "blank-track", "unrecognized-track", "per-episode-audio", "multiple-mediainfo-files",
                     "connected-unknown-track", "single-episode-scope", "scene-episode-scope" })
        {
            var attempt = await Discover(mode);
            Require(attempt.Result.Plan.Assignments.IsEmpty, mode + " cannot establish English absence");
        }
        foreach (var mode in new[] { "inline-cc", "negated-dub", "inline-commentary", "commentary-track", "mediainfo-commentary",
                     "numbered-commentary", "parenthetical-commentary" })
        {
            var attempt = await Discover(mode);
            Require(Audio(attempt.Result, SubtitleHash) == AnimeAudioMatch.Japanese, mode + " preserves the Japanese audio claim alone");
        }
        var positive = await Discover("bounded-bilingual");
        Require(Audio(positive.Result, SubtitleHash) == AnimeAudioMatch.English &&
            positive.Result.Plan.Assignments.SingleOrDefault()?.Hash == SubtitleHash,
            "a Japanese and English track list retains its explicit English dialogue");
        var late = await Discover("late-detail");
        Require(late.Result.Plan.Assignments.IsEmpty && Audio(late.Result, T3Hash) == AnimeAudioMatch.Other &&
            calls.Count(call => call == "late-detail/1733389") == 1,
            "a Nyaa observation first seen on the second search overrides earlier English evidence for the same hash");
        var direct = await Discover("apibay");
        Require(direct.Result.Plan.Assignments.Single().Hash == ApiBayHash,
            "APiBay English Dub pack survives strict identity, coordinates and file mapping");
        var capped = await Discover("capped");
        Require(capped.Result.Plan.Assignments.IsEmpty && calls.Count(call => call.StartsWith("capped/")) == 12 &&
            capped.Result.Find.Candidates.Any(c => c.AudioDetailUnavailable),
            "the detail budget leaves uninspected candidates unresolved and prevents fallback");
        var picked = await Discover("both", picked: T3Hash);
        Require(picked.Result.Plan.Assignments.Single().Hash == T3Hash,
            "explicit owner source selection preserves its existing language behavior");
        Require(calls.Count(call => call == "both/1733389") == 2,
            "manual selection does not start a second detailed lookup");

        async Task<(DiscoveryResult Result, ProbeEngine Engine)> Discover(string mode, string? picked = null)
        {
            var dir = Path.GetFullPath(Path.Combine("artifacts", "anime-audio-tests", Guid.NewGuid().ToString("N")));
            Directory.CreateDirectory(dir);
            var services = new ServiceCollection();
            services.AddLogging();
            services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
            services.AddSingleton<IHostApplicationLifetime, FixtureLifetime>();
            services.AddStore(Path.Combine(dir, "test.db"));
            services.AddFindSources();
            services.AddPlanModule();
            await using var provider = services.BuildServiceProvider();
            var factory = provider.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
            await using (var db = await factory.CreateDbContextAsync())
            {
                await db.Database.EnsureCreatedAsync();
                var sourceIds = mode == "late-detail" ? new[] { "apibay", "nyaa" } : new[] { mode == "apibay" ? "apibay" : "nyaa" };
                var settings = sourceIds.Select(id => new SourceSettings(id, true, SourceTier.Core, 0, "public", id, root + "/" + mode,
                    [], ["anime"], 6000, 6, 0, ImmutableDictionary<string, string>.Empty, null)).ToArray();
                var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
                json.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
                db.Settings.Add(new SettingRow { Id = "sources", SchemaVersion = 1, Revision = 1,
                    UpdatedAt = DateTimeOffset.UtcNow, Value = JsonSerializer.SerializeToElement(settings, json) });
                await db.SaveChangesAsync();
            }
            var engine = DispatchProxy.Create<IEngine, ProbeEngine>();
            var probe = (ProbeEngine)(object)engine;
            probe.Files = [.. Enumerable.Range(1, 12).Select(n =>
                new TorrentFile(n - 1, $"Classroom.of.the.Elite.S01E{n:00}.1080p.BluRay.Dual-Audio.x265-YURASUKA.mkv",
                    950_000_000, (n - 1) * 950_000_000L))];
            var discovery = new DiscoveryPlan(provider.GetRequiredService<IFind>(), provider.GetRequiredService<IPlan>(),
                engine, new(engine, NullLogger<ProbeRegistry>.Instance));
            var scope = new TargetScope(work.Work.Id, ["episode"], false);
            ImmutableArray<TargetRow> targets = [target with { PickedReleaseHash = picked }];
            if (mode == "late-detail")
            {
                probe.Files = [probe.Files[0]];
                scope = scope with { EpisodeIds = scope.EpisodeIds.Add("episode2") };
                targets = targets.Add(target with { Id = "target2", EpisodeId = "episode2" });
            }
            if (picked is not null)
            {
                // Save observed releases through the real search path, then use the stored owner-pick lookup.
                await discovery.RunAsync(work, scope, new(720, 1080, "en", null, null),
                    PriorityLane.Owner, false, CancellationToken.None, actualTargets: [target]);
            }
            var result = await discovery.RunAsync(work, scope, new(720, 1080, "en", null, null),
                PriorityLane.Owner, false, CancellationToken.None, actualTargets: targets);
            return (result, probe);
        }
    }

    private static AnimeAudioMatch Audio(DiscoveryResult result, string hash) =>
        AnimeAudioPolicy.Match(result.Find.Candidates.Single(candidate => candidate.Release.Id == hash));

    private static void Require(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
        Console.WriteLine("PASS " + message);
    }

    private static string Feed(string mode, string query)
    {
        XNamespace nyaa = "https://nyaa.si/xmlns/nyaa";
        XElement Row(string name, string hash, int id, int seeds, string category) =>
            new("item", new XElement("title", name), new XElement(nyaa + "infoHash", hash),
                new XElement("guid", $"https://nyaa.si/view/{id}"), new XElement(nyaa + "seeders", seeds),
                new XElement(nyaa + "categoryId", category), new XElement(nyaa + "size", "11 GiB"));
        var rows = new List<XElement> { Row(T3Name, T3Hash, 1733389, 100, "1_3") };
        if (mode == "late-detail" && !query.Contains("S01E02", StringComparison.OrdinalIgnoreCase))
            rows.Clear();
        if (mode == "both")
            rows.Add(Row(YuraName, YuraHash, 1495607, 56, "1_2"));
        if (mode is not ("both" or "foreign" or "late-detail"))
            rows.Add(Row("Classroom of the Elite S01E01 1080p Japanese Audio", JapaneseHash, 123, 25, "1_2"));
        if (mode is "subtitle-only" or "wrong-hash" or "unknown-track" or "http-failure" or
            "inline-cc" or "negated-dub" or "inline-commentary" or "commentary-track" or "mediainfo-commentary" or
            "unspecified-track" or "blank-track" or "unrecognized-track" or "per-episode-audio" or "multiple-mediainfo-files" or
            "connected-unknown-track" or "single-episode-scope" or "scene-episode-scope" or
            "numbered-commentary" or "parenthetical-commentary" or "bounded-bilingual")
        {
            var scope = mode is "single-episode-scope" or "scene-episode-scope" ? "S01" : "S01E01";
            rows.Add(Row($"Classroom of the Elite {scope} 1080p Dual Audio", SubtitleHash, 456, 40, "1_2"));
        }
        if (mode == "capped")
            rows.AddRange(Enumerable.Range(500, 13).Select(n =>
                Row("Classroom of the Elite S01E01 1080p Dual Audio", n.ToString("x40"), n, 40, "1_2")));
        if (mode == "truncated")
            rows.AddRange(Enumerable.Range(0, 73).Select(n =>
                Row("Other Title S01E01 1080p", n.ToString("x40"), 500 + n, 15, "1_2")));
        return new XElement("rss", new XAttribute(XNamespace.Xmlns + "nyaa", nyaa),
            new XElement("channel", rows)).ToString();
    }

    private static IResult Detail(string mode, int id)
    {
        if (mode == "http-failure" && id == 456) return Results.StatusCode(502);
        var (hash, description) = id switch
        {
            1733389 => (T3Hash, "    AUDIO 1................: Francais - Crunchyroll\n    AUDIO 2................: Japonais - BluRay Japonais\n    SUB 1..................: FR Forced"),
            1495607 => (YuraHash, "Video\nLanguage : Japanese\n\nAudio #1\nFormat : FLAC\nLanguage : English\n\nAudio #2\nFormat : FLAC\nLanguage : Japanese\n\nText #1\nLanguage : English"),
            123 => (JapaneseHash, "Audio: Japanese (English subtitles)"),
            456 when mode == "wrong-hash" => (YuraHash, "Audio: English"),
            456 when mode == "unknown-track" => (SubtitleHash, "Audio #1: Japanese\nAudio #2: AAC\nSubtitles: English"),
            456 when mode == "unspecified-track" => (SubtitleHash, "Audio: Japanese / Undetermined"),
            456 when mode == "blank-track" => (SubtitleHash, "Audio 1: Japanese\nAudio 2: "),
            456 when mode == "unrecognized-track" => (SubtitleHash, "Audio: Japanese / Swedish"),
            456 when mode == "connected-unknown-track" => (SubtitleHash, "Audio: Japanese and undetermined"),
            456 when mode == "per-episode-audio" => (SubtitleHash, "Episodes 01-06\nAudio: English\nEpisodes 07-12\nAudio: Japanese"),
            456 when mode == "single-episode-scope" => (SubtitleHash, "Episode 1\nAudio: English"),
            456 when mode == "scene-episode-scope" => (SubtitleHash, "S01E01\nAudio: English"),
            456 when mode == "multiple-mediainfo-files" => (SubtitleHash,
                "General\nComplete name: E01.mkv\n\nAudio\nLanguage: English\n\nGeneral\nComplete name: E02.mkv\n\nAudio\nLanguage: Japanese"),
            456 when mode == "inline-cc" => (SubtitleHash, "Audio: Japanese (English CC)"),
            456 when mode == "negated-dub" => (SubtitleHash, "Audio: Japanese (no English dub)"),
            456 when mode == "inline-commentary" => (SubtitleHash, "Audio: Japanese (English commentary)"),
            456 when mode == "commentary-track" => (SubtitleHash, "Audio: Japanese\nAudio: English commentary only"),
            456 when mode == "numbered-commentary" => (SubtitleHash, "Audio: Japanese\nAudio: English 2.0 commentary only"),
            456 when mode == "parenthetical-commentary" => (SubtitleHash, "Audio: Japanese and English [Director Commentary]"),
            456 when mode == "bounded-bilingual" => (SubtitleHash, "Audio: Japanese FLAC 2.0 (native) and English AAC 5.1"),
            456 when mode == "mediainfo-commentary" => (SubtitleHash,
                "Audio #1\nLanguage: Japanese\n\nAudio #2\nLanguage: English\nTitle: English Commentary"),
            456 => (SubtitleHash, "Text #1\nLanguage : English\n\nSubtitles: English"),
            >= 500 and < 513 when mode == "capped" => (id.ToString("x40"), "Audio: French"),
            _ => throw new InvalidOperationException("Unexpected detail lookup " + id),
        };
        var encoded = WebUtility.HtmlEncode(description).Replace("\n", "&#10;");
        return Results.Content($"""
            <div class="row"><div>Info hash:</div><div><kbd>{hash}</kbd></div></div>
            <div markdown-text class="panel-body" id="torrent-description">{encoded}</div>
            <div id="comments">Audio #1: English</div>
            """, "text/html");
    }
}
