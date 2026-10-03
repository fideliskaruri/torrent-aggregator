using TorrentFlow.Store;
using TorrentFlow.Library;

try
{
    string Option(string name) => args.SkipWhile(a => a != name).Skip(1).FirstOrDefault()
        ?? throw new ArgumentException($"Missing {name}.");
    await LegacyConverter.ConvertAsync(Option("--from"), Option("--to"),
        args.Contains("--path-map") ? Option("--path-map") : null,
        path => (LibraryPaths.Volume(path), LibraryPaths.PhysicalKey(path)));
    return 0;
}
catch (Exception error)
{
    Console.Error.WriteLine(error.Message);
    return 1;
}
