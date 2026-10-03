using System.Reflection;
using System.Text.Json;

var assembly = Assembly.LoadFrom(@"D:\code\memtest\bin-mkv\TorrentFlow.Library.dll");
var reader = assembly.GetType("TorrentFlow.Library.VideoDimensions", true)!
    .GetMethod("ReadDetails", BindingFlags.Static | BindingFlags.NonPublic)!;
var native = assembly.GetType("TorrentFlow.Library.NativeContainerDetails", true)!;
var rows = new List<object>();
foreach (var path in args)
{
    var result = ((int? Width, int? Height, double? RuntimeSeconds))reader.Invoke(null, [path])!;
    long? readBytes = null, furthestRead = null;
    var extension = Path.GetExtension(path);
    if (extension is ".mkv" or ".webm" or ".avi")
    {
        using var stream = new MeasuredStream(path);
        native.GetMethod(extension == ".avi" ? "Avi" : "Matroska", BindingFlags.Static | BindingFlags.NonPublic)!
            .Invoke(null, [stream]);
        readBytes = stream.ReadBytes;
        furthestRead = stream.FurthestRead;
    }
    rows.Add(new { path, result.Width, result.Height, result.RuntimeSeconds, readBytes, furthestRead });
}
Console.WriteLine(JsonSerializer.Serialize(rows, new JsonSerializerOptions { WriteIndented = true }));

sealed class MeasuredStream(string path) : FileStream(path, FileMode.Open, FileAccess.Read)
{
    public long ReadBytes { get; private set; }
    public long FurthestRead { get; private set; }
    public override int Read(Span<byte> buffer)
    {
        var count = base.Read(buffer);
        ReadBytes += count;
        FurthestRead = Math.Max(FurthestRead, Position);
        return count;
    }
    public override int ReadByte()
    {
        var value = base.ReadByte();
        if (value >= 0) ReadBytes++;
        FurthestRead = Math.Max(FurthestRead, Position);
        return value;
    }
}
