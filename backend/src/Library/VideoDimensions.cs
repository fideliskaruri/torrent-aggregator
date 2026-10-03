using System.Buffers.Binary;
using System.Text;

namespace TorrentFlow.Library;

internal static class VideoDimensions
{
    private readonly record struct Box(string Kind, long Data, long End);

    internal static (int? Width, int? Height) Read(string path)
    {
        var details = ReadDetails(path);
        return (details.Width, details.Height);
    }

    internal static (int? Width, int? Height, double? RuntimeSeconds) ReadDetails(string path)
    {
        using var stream = File.OpenRead(path);
        Span<byte> signature = stackalloc byte[12];
        if (stream.Length < signature.Length) return (null, null, null);
        stream.ReadExactly(signature);
        if (BinaryPrimitives.ReadUInt32BigEndian(signature) == 0x1a45dfa3)
            return NativeContainerDetails.Matroska(stream);
        if (signature[..4].SequenceEqual("RIFF"u8) && signature[8..].SequenceEqual("AVI "u8))
            return NativeContainerDetails.Avi(stream);
        Span<byte> type = stackalloc byte[4];
        Span<byte> dimensions = stackalloc byte[8];
        double? runtime = null;
        int? videoWidth = null, videoHeight = null;
        foreach (var moov in Boxes(stream, 0, stream.Length).Where(b => b.Kind == "moov"))
        {
            foreach (var header in Boxes(stream, moov.Data, moov.End).Where(b => b.Kind == "mvhd"))
            {
                if (header.End - header.Data < 20) continue;
                stream.Position = header.Data;
                var version = stream.ReadByte();
                var offset = version == 0 ? 12 : version == 1 ? 20 : -1;
                var length = version == 1 ? 12 : 8;
                if (offset < 0 || header.End - header.Data < offset + length) continue;
                var timing = new byte[12];
                stream.Position = header.Data + offset;
                stream.ReadExactly(timing.AsSpan(0, length));
                var scale = BinaryPrimitives.ReadUInt32BigEndian(timing);
                var duration = version == 1 ? BinaryPrimitives.ReadUInt64BigEndian(timing.AsSpan(4)) :
                    BinaryPrimitives.ReadUInt32BigEndian(timing.AsSpan(4));
                if (scale > 0 && duration > 0 && duration != uint.MaxValue && duration != ulong.MaxValue)
                    runtime = (double)duration / scale;
            }
            foreach (var track in Boxes(stream, moov.Data, moov.End).Where(b => b.Kind == "trak"))
            {
                var children = Boxes(stream, track.Data, track.End).ToArray();
                var video = false;
                foreach (var mdia in children.Where(b => b.Kind == "mdia"))
                    foreach (var handler in Boxes(stream, mdia.Data, mdia.End).Where(b => b.Kind == "hdlr" && b.End - b.Data >= 12))
                    {
                        stream.Position = handler.Data + 8;
                        stream.ReadExactly(type);
                        video |= type.SequenceEqual("vide"u8);
                    }
                if (!video) continue;
                foreach (var header in children.Where(b => b.Kind == "tkhd" && b.End - b.Data >= 84))
                {
                    stream.Position = header.Data;
                    var version = stream.ReadByte();
                    var offset = version == 0 ? 76 : version == 1 ? 88 : -1;
                    if (offset < 0 || header.End - header.Data < offset + 8) continue;
                    stream.Position = header.Data + offset;
                    stream.ReadExactly(dimensions);
                    var width = (int)(BinaryPrimitives.ReadUInt32BigEndian(dimensions) >> 16);
                    var height = (int)(BinaryPrimitives.ReadUInt32BigEndian(dimensions[4..]) >> 16);
                    if (videoWidth is null && width is > 0 and <= 32768 && height is > 0 and <= 32768)
                    { videoWidth = width; videoHeight = height; }
                }
            }
        }
        return (videoWidth, videoHeight, videoWidth is null ? null : runtime);
    }

    private static IEnumerable<Box> Boxes(FileStream stream, long start, long end)
    {
        var header = new byte[16];
        for (long position = start, count = 0; position <= end - 8 && count < 4096; count++)
        {
            stream.Position = position;
            stream.ReadExactly(header.AsSpan(0, 8));
            long size = BinaryPrimitives.ReadUInt32BigEndian(header);
            var head = 8;
            if (size == 1)
            {
                if (end - position < 16) yield break;
                stream.ReadExactly(header.AsSpan(8, 8));
                var large = BinaryPrimitives.ReadUInt64BigEndian(header.AsSpan(8));
                if (large > long.MaxValue) yield break;
                size = (long)large;
                head = 16;
            }
            else if (size == 0) size = end - position;
            if (size < head || size > end - position) yield break;
            yield return new(Encoding.ASCII.GetString(header, 4, 4), position + head, position + size);
            position += size;
        }
    }

    internal static int? Resolution(int? width, int? height) =>
        width >= 3840 || height >= 2160 ? 2160 : width >= 1920 || height >= 1080 ? 1080 :
        width >= 1280 || height >= 720 ? 720 : width >= 854 || height >= 480 ? 480 : height;
}
