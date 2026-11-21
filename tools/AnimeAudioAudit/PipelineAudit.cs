using System.Collections.Concurrent;
using System.Collections.Immutable;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading.Channels;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;
using TorrentFlow.Domain;
using TorrentFlow.Find;
using TorrentFlow.Parser;
using TorrentFlow.Plan;
using TorrentFlow.Store;
using TorrentFlow.Targets;

internal static class PipelineAudit
{
    internal static async Task RunAsync(WorkSnapshot work, TargetRow target,
        Func<char, string, int, int, Candidate> release)
    {
        var english = release('a', "English Dub", 5, 1080);
        var japanese = release('b', "Japanese Audio English Subs", 500, 1080);
        var unknown = release('c', "", 1000, 1080);
        var dual = release('d', "Dual Audio", 20, 1080);
        var sources = ImmutableArray.Create(new SourceResult("fixture", SourceOutcome.Success, [], null, null, TimeSpan.Zero));
        CandidateBatch Batch(params Candidate[] candidates) => new("fixture", 1, [.. candidates], sources, true,
            SearchNamePhase.English, SourceTier.Fallback) { Queries = [new("query", "fixture", SearchNamePhase.English,
                SourceTier.Fallback, false, false, sources[0])] };
        async Task<DiscoveryResult> Discover(CandidateBatch batch, string? failedHash = null, string? language = "en")
        {
            if (failedHash is not null) batch = batch with { Candidates = [.. batch.Candidates.Select(c =>
                c.Release.Id == failedHash ? c with { Release = c.Release with { Files = null } } : c)] };
            var engine = DispatchProxy.Create<IEngine, ProbeEngine>();
            ((ProbeEngine)(object)engine).FailedHash = failedHash;
            var registry = new ProbeRegistry(engine, NullLogger<ProbeRegistry>.Instance);
            var find = new FixtureFind(batch);
            return await new DiscoveryPlan(find, new ReleasePlanner(), engine, registry).RunAsync(work,
                new(work.Work.Id, ["episode"], false), new(720, 1080, language, null, null), PriorityLane.Owner,
                false, CancellationToken.None, actualTargets: [target]);
        }
        void Pick(string label, DiscoveryResult result, Candidate expected)
        {
            if (result.Plan.Assignments.SingleOrDefault()?.Hash != expected.Release.Id)
                throw new Exception(label + ": unexpected source: " + string.Join(",", result.Plan.Assignments.Select(a => a.Hash)));
            Console.WriteLine("PASS " + label);
        }
        void Wait(string label, DiscoveryResult result)
        {
            if (!result.Plan.Assignments.IsEmpty) throw new Exception(label + ": downloaded before exhaustion");
            Console.WriteLine("PASS " + label);
        }
        Pick("pipeline prefers healthy English over Japanese and unknown", await Discover(Batch(japanese, unknown, english)), english);
        Pick("auto is English-first for anime", await Discover(Batch(japanese, english), language: "auto"), english);
        Pick("Japanese last resort after successful exhausted search", await Discover(Batch(japanese)), japanese);
        Wait("unknown language is never selected as Japanese fallback", await Discover(Batch(unknown)));
        Wait("unconfirmed dual audio prevents Japanese fallback", await Discover(Batch(dual, japanese)));
        Wait("unknown language with no seed count prevents Japanese fallback",
            await Discover(Batch(unknown with { ConservativeListedSeeders = null }, japanese)));
        Pick("unknown language with zero seeds cannot conceal a healthy English release",
            await Discover(Batch(unknown with { ConservativeListedSeeders = 0 }, english)), english);
        Pick("zero-seed unresolved language permits healthy Japanese fallback",
            await Discover(Batch(unknown with { ConservativeListedSeeders = 0 }, japanese)), japanese);
        Pick("explicit Japanese preference still selects a Japanese release",
            await Discover(Batch(japanese), language: "ja"), japanese);
        Pick("explicit French preference still selects a French release",
            await Discover(Batch(release('f', "French Audio", 30, 1080)), language: "fr"),
            release('f', "French Audio", 30, 1080));
        Pick("any preference still selects an unresolved dual release",
            await Discover(Batch(dual), language: "any"), dual);
        Pick("zero-seed English permits healthy Japanese fallback", await Discover(Batch(english with { ConservativeListedSeeders = 0 }, japanese)), japanese);
        Wait("unknown English swarm does not prove English unavailable",
            await Discover(Batch(english with { ConservativeListedSeeders = null }, japanese)));
        Wait("unresolved English metadata prevents fallback", await Discover(Batch(english, japanese), english.Release.Id));
        Wait("incomplete search prevents fallback", await Discover(Batch(japanese) with { Complete = false }));
        Wait("early-stopped search prevents fallback", await Discover(Batch(japanese) with { EarlyStopped = true }));
        Wait("a request budget cap prevents fallback", await Discover(Batch(japanese) with { RequestBudgetExhausted = true }));
        foreach (var outcome in new[] { SourceOutcome.Failed, SourceOutcome.TimedOut, SourceOutcome.Partial,
                     SourceOutcome.Busy, SourceOutcome.CoolingDown })
        {
            var failed = sources[0] with { Outcome = outcome, Complete = false };
            Wait(outcome + " does not authorize Japanese fallback", await Discover(Batch(japanese) with
                { Queries = [new("query", "fixture", SearchNamePhase.English, SourceTier.Fallback, false, false, failed)] }));
        }
        var truncated = sources[0] with { Diagnostics = new("fixture", TimeSpan.Zero, 1, 200, null, 80, true) };
        Wait("truncated results do not prove exhaustive search", await Discover(Batch(japanese) with
            { Queries = [new("query", "fixture", SearchNamePhase.English, SourceTier.Fallback, false, false, truncated)] }));
        Wait("other foreign audio is not Japanese fallback", await Discover(Batch(release('e', "Russian Audio", 30, 1080))));
        var secondEpisode = work.Episodes[0] with { Id = "episode2", Number = 2, AbsoluteNumber = 2 };
        var seasonWork = work with { Episodes = [work.Episodes[0], secondEpisode],
            Seasons = [work.Seasons[0] with { ExpectedEpisodeCount = 2 }] };
        var secondTarget = target with { Id = "target2", EpisodeId = secondEpisode.Id };
        var secondName = japanese.Release.Name.Replace("S01E01", "S01E02");
        var secondJapanese = japanese with { Release = japanese.Release with
            { Name = secondName, Parsed = new ReleaseParser(2026).Parse(secondName),
                Files = [new(0, "Example Show S01E02.mkv", 500_000_000, 0)] } };
        var seasonEngine = DispatchProxy.Create<IEngine, ProbeEngine>();
        var seasonDiscovery = new DiscoveryPlan(new FixtureFind(Batch(unknown, secondJapanese)), new ReleasePlanner(),
            seasonEngine, new(seasonEngine, NullLogger<ProbeRegistry>.Instance));
        var season = await seasonDiscovery.RunAsync(seasonWork, new(work.Work.Id, ["episode", "episode2"], false),
            new(720, 1080, "auto", null, null), PriorityLane.Owner, false, CancellationToken.None,
            actualTargets: [target, secondTarget]);
        if (season.Plan.Assignments.SingleOrDefault()?.TargetIds.Single() != secondTarget.Id ||
            !season.Plan.UncoveredTargetIds.SequenceEqual([target.Id]))
            throw new InvalidOperationException("An unresolved first episode must not authorize fallback for that episode or block the second.");
        Console.WriteLine("PASS Japanese fallback applies only to episodes whose English search was exhausted");
        await RealFindAsync(work, target, english, japanese);
    }

    private static async Task RealFindAsync(WorkSnapshot work, TargetRow target, Candidate english, Candidate japanese)
    {
        work = work with { Names = work.Names.Add(new WorkNameRow { Id = "original-name", WorkId = work.Work.Id,
            Value = "Alternative Show", NormalizedValue = "alternative show", Label = NameLabel.Romaji,
            Ordinal = 1, Authoritative = true }) };
        var path = Path.GetFullPath(Path.Combine("artifacts", "anime-audio-tests", Guid.NewGuid().ToString("N")));
        Directory.CreateDirectory(path);
        var services = new ServiceCollection();
        services.AddLogging();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            { ["TorrentFlow:Find:OwnerRequestLimit"] = "2" }).Build());
        services.AddSingleton<IHostApplicationLifetime, FixtureLifetime>();
        services.AddStore(Path.Combine(path, "test.db"));
        services.AddFindSources();
        var fixture = new FixtureSources(english, japanese);
        services.AddSingleton<ISources>(fixture);
        await using var provider = services.BuildServiceProvider();
        var factory = provider.GetRequiredService<IDbContextFactory<TorrentFlowDbContext>>();
        await using (var db = await factory.CreateDbContextAsync())
        {
            await db.Database.EnsureCreatedAsync();
            var settings = new[] { SourceTier.Core, SourceTier.Fallback, SourceTier.OptIn }.Select((tier, index) =>
                new SourceSettings("fixture" + index, true, tier, index, "public", "fixture", null, [], ["anime"],
                    6000, 2, 0, ImmutableDictionary<string, string>.Empty, null)).ToImmutableArray();
            var json = new JsonSerializerOptions(JsonSerializerDefaults.Web);
            json.Converters.Add(new JsonStringEnumConverter(JsonNamingPolicy.CamelCase));
            db.Settings.Add(new SettingRow { Id = "sources", SchemaVersion = 1, Revision = 1,
                UpdatedAt = DateTimeOffset.UtcNow, Value = JsonSerializer.SerializeToElement(settings, json) });
            await db.SaveChangesAsync();
        }
        var find = provider.GetRequiredService<IFind>();
        var engine = DispatchProxy.Create<IEngine, ProbeEngine>();
        var discovery = new DiscoveryPlan(find, new ReleasePlanner(), engine,
            new(engine, NullLogger<ProbeRegistry>.Instance));
        var result = await discovery.RunAsync(work, new(work.Work.Id, ["episode"], false),
            new(720, 1080, "en", null, null), PriorityLane.Owner, false, CancellationToken.None, actualTargets: [target]);
        if (result.Plan.Assignments.SingleOrDefault()?.Hash != english.Release.Id)
            throw new Exception("real Find→Plan pipeline missed English in enabled opt-in source");
        if (!fixture.Calls.Any(c => c.Source == "fixture0") || !fixture.Calls.Any(c => c.Source == "fixture1") ||
            !fixture.Calls.Any(c => c.Source == "fixture2") || !fixture.Calls.Any(c => c.Query.Contains("English dub")) ||
            !fixture.Calls.Any(c => c.Query.Contains("dual audio")) || fixture.Peak > 2 || fixture.Calls.Count <= 2)
            throw new Exception("source/query coverage or bounded fanout failed");
        Console.WriteLine($"PASS real Find→metadata→Plan searches all enabled tiers and dub variants: {fixture.Calls.Count} calls, peak {fixture.Peak} (limit 2)");
        var feedback = Channel.CreateUnbounded<SearchFeedback>();
        CandidateBatch? last = null;
        var request = new SearchRequest("feedback-audit", work, new(work.Work.Id, ["episode"], false),
            new(720, 1080, "en", null, null), PriorityLane.Owner, SearchNamePhase.English, [], 0, 0)
            { ProvisionalGood = true };
        await foreach (var batch in find.SearchAsync(request, feedback.Reader.ReadAllAsync(), CancellationToken.None))
        {
            last = batch;
            feedback.Writer.TryWrite(new(batch.PoolRevision, ["episode"], false, true, false) { HasHealthyRelease = true });
        }
        feedback.Writer.TryComplete();
        if (last is null || last.EarlyStopped || last.ProvisionalStopped ||
            !last.Candidates.Any(c => c.Release.Id == english.Release.Id) ||
            !last.Queries.Any(q => q.NamePhase == SearchNamePhase.Original))
            throw new Exception("coverage/provisional feedback prematurely ended the English audio search");
        Console.WriteLine("PASS provisional seeds and early-stop feedback cannot skip original-name English searches");
    }
}

internal sealed class FixtureFind(CandidateBatch batch) : IFind
{
    public Task<CandidateBatch> SelectAsync(SearchRequest request, string hash, CancellationToken cancellationToken, bool ownerPick = false) => Task.FromResult(batch);
    public async IAsyncEnumerable<CandidateBatch> SearchAsync(SearchRequest request, IAsyncEnumerable<SearchFeedback> feedback,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellationToken)
    { await Task.Yield(); yield return batch; }
    public Task<RawSearchResult> SearchRawAsync(RawSearchQuery query, CancellationToken cancellationToken) => throw new NotSupportedException();
}

public class ProbeEngine : DispatchProxy
{
    public string? FailedHash { get; set; }
    public ImmutableArray<TorrentFile> Files { get; set; } =
        [new(0, "Example Show S01E01.mkv", 500_000_000, 0)];
    public ConcurrentBag<string> Requested { get; } = [];

    protected override object? Invoke(MethodInfo? method, object?[]? args) => method?.Name switch
    {
        nameof(IEngine.AttachProbeAsync) => Probe((Candidate)args![0]!),
        nameof(IEngine.ReleaseProbeAsync) => Task.CompletedTask,
        _ => throw new NotSupportedException(method?.Name)
    };

    private Task<ProbeAttachment> Probe(Candidate candidate)
    {
        Requested.Add(candidate.Release.Id);
        return Task.FromResult(candidate.Release.Id == FailedHash
            ? new ProbeAttachment(null, null, new("metadata_unavailable", "fixture", null, false))
            : new ProbeAttachment(null, candidate.Release.Parsed.Pack ? Files : [Files[0]], null));
    }
}

internal sealed class FixtureLifetime : IHostApplicationLifetime
{
    public CancellationToken ApplicationStarted => CancellationToken.None;
    public CancellationToken ApplicationStopping => CancellationToken.None;
    public CancellationToken ApplicationStopped => CancellationToken.None;
    public void StopApplication() { }
}

internal sealed class FixtureSources(Candidate english, Candidate japanese) : ISources
{
    internal ConcurrentBag<(string Source, string Query)> Calls { get; } = [];
    private int active;
    internal int Peak;
    public async Task<SourceResult> SearchAsync(SourceSettings source, SourceQuery query, CancellationToken cancellationToken)
    {
        Calls.Add((source.Id, query.Query));
        var count = Interlocked.Increment(ref active);
        if (count > Peak) Peak = count;
        try { await Task.Delay(5, cancellationToken); }
        finally { Interlocked.Decrement(ref active); }
        var candidate = source.Tier == SourceTier.OptIn && query.Query.Contains("Alternative Show") &&
            query.Query.Contains("English dub") ? english : japanese;
        return new(source.Id, SourceOutcome.Success,
            [new(candidate.Release.Name, candidate.Release.Id, 500_000_000, candidate.TrustedSeeders, null,
                source.Id, null, null, null, DateTimeOffset.UtcNow, [])], null, null, TimeSpan.Zero);
    }
    public Task<SourceResult> TestAsync(SourceSettings source, CancellationToken cancellationToken) => throw new NotSupportedException();
}
