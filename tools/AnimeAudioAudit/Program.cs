using System.Collections.Immutable;
using TorrentFlow.Domain;
using TorrentFlow.Parser;
using TorrentFlow.Plan;

var now = DateTimeOffset.UtcNow;
var parser = new ReleaseParser(2026);
var planner = new ReleasePlanner();
var work = new WorkSnapshot(new WorkRow { Id = "work", WorkKey = "anime:test", Kind = WorkKind.Series,
    Format = WorkFormat.Series, Anime = true, OriginalLanguage = "ja", Genres = [],
    ReleasePrecision = DatePrecision.Day, CreatedAt = now, UpdatedAt = now, Version = 0 },
    [new WorkNameRow { Id = "name", WorkId = "work", Value = "Example Show", NormalizedValue = "example show",
        Label = NameLabel.English, Ordinal = 0, Authoritative = true }], [],
    [new SeasonRow { Id = "season", WorkId = "work", Number = 1, MappingStatus = MappingStatus.Confirmed,
        ExpectedEpisodeCount = 1, CreatedAt = now, UpdatedAt = now, Version = 0 }],
    [new EpisodeRow { Id = "episode", SeasonId = "season", Number = 1, AbsoluteNumber = 1,
        MappingStatus = MappingStatus.Confirmed, AirAt = now.AddDays(-30), AirPrecision = DatePrecision.Day,
        CreatedAt = now, UpdatedAt = now, Version = 0 }]);
var target = new TargetRow { Id = "target", WorkId = "work", EpisodeId = "episode", Kind = TargetKind.Acquire,
    State = TargetState.Searching, ResolutionFloor = 720, PreferredResolution = 1080, DownloadNow = true,
    CreatedBy = "owner", Origin = IntentOrigin.Owner, SubstantiveMisses = 0, CreatedAt = now, UpdatedAt = now, Version = 0 };
Candidate Release(char hash, string audio, int seeds, int resolution = 1080) {
    var name = $"Example Show S01E01 {resolution}p WEB-DL {audio}";
    return new(new ReleaseRow { Id = new string(hash, 40), Name = name, Parsed = parser.Parse(name),
        Files = [new(0, "Example Show S01E01.mkv", 500_000_000, 0)],
        FirstSeenAt = now, LastSeenAt = now },
        [new ReleaseObservationRow { Id = "obs" + hash, Hash = new string(hash, 40), SourceId = "test",
            Query = "Example Show", ListedSeeders = seeds, ObservedAt = now, UploadedAt = now, WebSeeds = [] }], seeds);
}
PlanInput Input(params Candidate[] pool) => new(work, AcquisitionMode.Catalog, [], [target], [.. pool], [], [], now)
    { AudioLanguage = "en" };
var failures = 0;
void Test(string name, Action test) {
    try { test(); Console.WriteLine("PASS " + name); }
    catch (Exception e) { failures++; Console.WriteLine("FAIL " + name + ": " + e.Message); }
}
void Equal<T>(T expected, T actual) { if (!EqualityComparer<T>.Default.Equals(expected, actual))
    throw new Exception($"expected {expected}; got {actual}"); }
var english = Release('a', "English Dub", 5);
var unknown = Release('b', "", 500);
Test("Stable 0.4.1 is an update from installed audit.8", () => Equal(true,
    TorrentFlow.Api.Desktop.ReleaseVersion.IsNewer("0.4.1", "0.4.1-audit.8")));
Test("English beats higher-seeded unknown in shortlist", () =>
    Equal(english.Release.Id, planner.Shortlist(Input(unknown, english)).Candidates[0].Release.Id));
Test("English beats higher-seeded unknown in final assignment", () =>
    Equal(english.Release.Id, planner.Choose(Input(unknown, english)).Assignments.Single().Hash));
Test("English subtitles do not claim English audio", () => {
    var subbed = Release('c', "Japanese Audio English Subs", 500);
    Equal(english.Release.Id, planner.Choose(Input(subbed, english)).Assignments.Single().Hash);
});
Test("Quality floor still applies to English", () => {
    var low = Release('d', "English Dub", 50, 480);
    Equal(0, planner.Shortlist(Input(low)).Candidates.Length);
});
Test("Unknown audio is withheld before fallback", () => Equal(0, planner.Choose(Input(unknown)).Assignments.Length));
Test("English wins over higher resolution within the hard floor", () =>
    Equal(english.Release.Id, planner.Choose(Input(Release('b', "", 500, 2160), english)).Assignments.Single().Hash));
Test("Any-language preference preserves unrestricted selection", () =>
    Equal(unknown.Release.Id, planner.Choose(Input(unknown, english) with { AudioLanguage = "any" }).Assignments.Single().Hash));
Test("Non-anime selection is unchanged", () =>
    Equal(unknown.Release.Id, planner.Choose(Input(unknown, english) with
        { Work = work with { Work = work.Work with { Anime = false } } }).Assignments.Single().Hash));
Test("Explicit Japanese preference remains available", () =>
    Equal(true, !AnimeAudioPolicy.EnglishFirst(work, "ja")));
foreach (var label in new[] { "English Subs", "ENG SUB", "English Subbed", "English (Subtitles)", "Subs: English", "Multi Subs" })
    Test(label + " is not English audio", () => Equal(true, AnimeAudioPolicy.Rank(Release('c', label, 10).Release.Parsed) > 0));
Test("Explicit English dual audio is preferred", () => Equal(0,
    AnimeAudioPolicy.Rank(Release('c', "Dual Audio Japanese English", 10).Release.Parsed)));
Test("Spanish/Japanese dual is not presumed English", () => Equal(-1,
    AnimeAudioPolicy.Rank(Release('c', "Dual Audio Spanish Japanese", 10).Release.Parsed)));
Test("Minimum seed preference is retained", () => Equal(0,
    planner.Shortlist(Input(english) with { Targets = [target with { MinListedSeeders = 10 }] }).Candidates.Length));
try { await PipelineAudit.RunAsync(work, target, (hash, audio, seeds, resolution) => Release(hash, audio, seeds, resolution)); }
catch (Exception e) { failures++; Console.WriteLine("FAIL pipeline: " + e); }
Environment.ExitCode = failures == 0 ? 0 : 1;

