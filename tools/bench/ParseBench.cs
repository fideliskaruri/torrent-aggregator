using System.Diagnostics;
using System.Globalization;
using System.Text.Json;
using TorrentFlow.Domain;
using TorrentFlow.Parser;

internal static class ParseBench
{
    private static readonly string[] GateFields = ["kind", "seasons", "episodes", "resolution", "foreign", "unsafe"];
    private static readonly string[] Fields = [.. GateFields, "year", "source_type", "codec", "group"];

    public static int Run(string[] args)
    {
        if (args.Contains("--help"))
        {
            Console.WriteLine("dotnet run --project tools\\bench -c Release -- parse [--corpus file] [--iterations 10] [--stress] [--json file]");
            Console.WriteLine("Inspection only: parse --name \"release\" or parse --hash \"hash/magnet\" (does not run the corpus gate).");
            Console.WriteLine("Exit 0: six fields pass >=99.5% overall and 100% hand. Exit 1: gate fails. Exit 2: malformed input/options.");
            return 0;
        }
        try
        {
            if (args.Length == 2 && args[0] is "--name" or "--hash")
            {
                var inspect = new ReleaseParser(DateTime.UtcNow.Year + 2);
                Console.WriteLine(args[0] == "--hash" ? inspect.NormalizeInfoHash(args[1]) ?? "invalid" :
                    JsonSerializer.Serialize(inspect.Parse(args[1]), new JsonSerializerOptions
                    {
                        WriteIndented = true,
                        Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() }
                    }));
                Console.WriteLine("Inspection only; corpus gate not run.");
                return 0;
            }
            string? corpus = null;
            string? jsonPath = null;
            var iterations = 10;
            var stress = false;
            for (var i = 0; i < args.Length; i++)
                switch (args[i])
                {
                    case "--corpus": corpus = Path.GetFullPath(args[++i]); break;
                    case "--json": jsonPath = Path.GetFullPath(args[++i]); break;
                    case "--iterations": iterations = int.Parse(args[++i], CultureInfo.InvariantCulture); break;
                    case "--stress": stress = true; break;
                    default: throw new ArgumentException($"Unknown parse option: {args[i]}");
                }
            if (iterations is < 1 or > 1000) throw new ArgumentException("--iterations must be 1..1000.");
            corpus ??= FindCorpus();
            var lines = File.ReadAllLines(corpus);
            if (lines.Length < 2) throw new InvalidDataException("Corpus requires a header and at least one row.");
            var header = lines[0].Split('\t');
            foreach (var required in Fields.Concat(["name", "labelled_by"]))
                if (!header.Contains(required)) throw new InvalidDataException($"Missing corpus column: {required}.");
            var rows = lines.Skip(1).Select((line, index) =>
            {
                var values = line.Split('\t');
                if (values.Length != header.Length) throw new InvalidDataException($"Row {index + 2}: invalid field count.");
                var data = header.Zip(values).ToDictionary(p => p.First, p => p.Second);
                if (data["labelled_by"] is not ("hand" or "auto"))
                    throw new InvalidDataException($"Row {index + 2}: labelled_by must be hand or auto.");
                return (Line: index + 2, Data: data);
            }).ToArray();
            if (rows.Length == 0) throw new InvalidDataException("Empty corpus.");
            var parser = new ReleaseParser(DateTime.UtcNow.Year + 2);
            foreach (var row in rows) parser.Parse(row.Data["name"]);
            var results = new ParsedRelease[rows.Length];
            var timer = Stopwatch.StartNew();
            for (var round = 0; round < iterations; round++)
                for (var i = 0; i < rows.Length; i++) results[i] = parser.Parse(rows[i].Data["name"]);
            timer.Stop();
            var mismatches = new List<Mismatch>();
            var accuracy = new List<Accuracy>();
            foreach (var field in Fields)
            {
                var correct = 0;
                var handCorrect = 0;
                var handTotal = 0;
                for (var i = 0; i < rows.Length; i++)
                {
                    var row = rows[i];
                    var expected = Canonical(field, row.Data[field]);
                    var actual = Canonical(field, Value(results[i], field));
                    var hand = row.Data["labelled_by"] == "hand";
                    if (hand) handTotal++;
                    if (actual == expected) { correct++; if (hand) handCorrect++; }
                    else mismatches.Add(new(row.Line, row.Data["name"], field, row.Data[field],
                        Value(results[i], field), hand ? "hand" : "auto"));
                }
                accuracy.Add(new(field, correct, rows.Length, handCorrect, handTotal));
            }
            Console.WriteLine($"Corpus: {corpus}");
            Console.WriteLine("field          overall                 hand");
            foreach (var a in accuracy)
                Console.WriteLine($"{a.Field,-14} {a.Correct,4}/{a.Total} {100.0 * a.Correct / a.Total,7:F3}%    {a.HandCorrect,4}/{a.HandTotal} {100.0 * a.HandCorrect / a.HandTotal,7:F3}%");
            Console.WriteLine($"Time: {timer.Elapsed.TotalMilliseconds:F2} ms / {iterations} passes ({rows.Length * iterations / timer.Elapsed.TotalSeconds:F0} names/s; {timer.Elapsed.TotalMilliseconds / iterations:F2} ms/pass). Includes parsing only, after one warmup pass.");
            double? stressMilliseconds = null;
            if (stress)
            {
                var adversarial = new[]
                {
                    new string('[', ReleaseParser.MaximumNameLength),
                    new string('-', ReleaseParser.MaximumNameLength),
                    string.Concat(Enumerable.Repeat("S01E01 ", 2000)),
                    string.Concat(Enumerable.Repeat("[0001-9999] ", 1000)),
                    new string('a', ReleaseParser.MaximumNameLength - 8) + ".mkv.exe"
                };
                var clock = Stopwatch.StartNew();
                foreach (var name in adversarial) parser.Parse(name);
                clock.Stop();
                stressMilliseconds = clock.Elapsed.TotalMilliseconds;
                Console.WriteLine($"Adversarial parse: {adversarial.Length} names, up to {ReleaseParser.MaximumNameLength} characters, {stressMilliseconds:F2} ms total; no backtracking engine or exceptions.");
            }
            var gated = mismatches.Where(m => GateFields.Contains(m.Field)).ToArray();
            Console.WriteLine($"Gate mismatches: {gated.Length}; all reported fields: {mismatches.Count}. First 50:");
            foreach (var m in gated.Take(50))
                Console.WriteLine($"line {m.Line} [{m.LabelledBy}] {m.Field}: expected '{m.Expected}', got '{m.Actual}' | {m.Name}");
            var pass = accuracy.Where(a => GateFields.Contains(a.Field))
                .All(a => a.HandCorrect == a.HandTotal && (double)a.Correct / a.Total >= .995);
            Console.WriteLine(pass ? "PASS" : "FAIL");
            if (jsonPath is not null)
            {
                Directory.CreateDirectory(Path.GetDirectoryName(jsonPath)!);
                File.WriteAllText(jsonPath, JsonSerializer.Serialize(new
                {
                    Corpus = corpus, Iterations = iterations, ParseMilliseconds = timer.Elapsed.TotalMilliseconds,
                    NamesPerSecond = rows.Length * iterations / timer.Elapsed.TotalSeconds,
                    StressMilliseconds = stressMilliseconds, GatePassed = pass, Accuracy = accuracy, Mismatches = mismatches
                }, new JsonSerializerOptions { WriteIndented = true }));
            }
            return pass ? 0 : 1;
        }
        catch (Exception e) { Console.Error.WriteLine($"Parse bench stopped: {e.Message}"); return 2; }
    }

    private static string FindCorpus()
    {
        for (var path = new DirectoryInfo(Environment.CurrentDirectory); path is not null; path = path.Parent)
        {
            var candidate = Path.Combine(path.FullName, "backend", "corpus", "names.tsv");
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException("Run from the repository or pass --corpus.");
    }

    private static string Value(ParsedRelease parsed, string field) => field switch
    {
        "kind" => parsed.Kind switch
        {
            ReleaseKind.SeasonPack => "season_pack", ReleaseKind.MultiSeason => "multi_season",
            ReleaseKind.CompleteSeries => "complete_series", var value => value.ToString().ToLowerInvariant()
        },
        "seasons" => string.Join(",", parsed.Seasons),
        "episodes" => string.Join(",", parsed.Episodes.Select(n => $"{n}")
            .Concat(parsed.EpisodeRanges.Select(r => $"{r.First}-{r.Last}"))
            .Concat(parsed.AbsoluteNumbers.Select(n => $"a{n}"))
            .Concat(parsed.AbsoluteRanges.Select(r => $"a{r.First}-a{r.Last}"))),
        "resolution" => parsed.Quality.Resolution?.ToString(CultureInfo.InvariantCulture) ?? "unknown",
        "foreign" => parsed.Foreign.ToString().ToLowerInvariant(),
        "unsafe" => parsed.Unsafe ? "yes" : "no",
        "year" => parsed.Year?.ToString(CultureInfo.InvariantCulture) ?? "",
        "source_type" => parsed.Quality.Source ?? "unknown",
        "codec" => parsed.Quality.Codec ?? "unknown",
        "group" => parsed.Group ?? "",
        _ => throw new ArgumentOutOfRangeException(nameof(field))
    };

    private static string Canonical(string field, string value)
    {
        if (field is not ("seasons" or "episodes")) return value;
        var values = new SortedSet<string>(StringComparer.Ordinal);
        foreach (var coordinate in value.Split(',', StringSplitOptions.RemoveEmptyEntries))
        {
            var range = coordinate.Split('-');
            var prefix = coordinate.StartsWith('a') ? "a" : "";
            if (range.Length == 2 && int.TryParse(range[0].TrimStart('a'), out var first) &&
                int.TryParse(range[1].TrimStart('a'), out var last) && last >= first && last - first <= 10000)
                for (var number = first; number <= last; number++) values.Add(prefix + number);
            else values.Add(coordinate);
        }
        return string.Join(",", values);
    }

    private sealed record Mismatch(int Line, string Name, string Field, string Expected, string Actual, string LabelledBy);
    private sealed record Accuracy(string Field, int Correct, int Total, int HandCorrect, int HandTotal);
}
