using System.Buffers.Binary;

namespace TorrentFlow.Library;

internal static class NativeContainerDetails
{
    private const uint Segment = 0x18538067, Info = 0x1549a966, Tracks = 0x1654ae6b, Cluster = 0x1f43b675;
    private readonly record struct Element(uint Id, long Data, long End, bool Unknown);

    internal static (int? Width, int? Height, double? RuntimeSeconds) Matroska(FileStream stream)
    {
        var remaining = 4096;
        long position = 0;
        while (ReadElement(stream, ref position, stream.Length, ref remaining) is { } outer)
        {
            if (outer.Id != Segment)
            {
                if (outer.Unknown) break;
                continue;
            }
            double scale = 1_000_000;
            double? duration = null;
            int? width = null, height = null;
            var sawInfo = false;
            var sawTracks = false;
            var segmentPosition = outer.Data;
            while (ReadElement(stream, ref segmentPosition, outer.End, ref remaining) is { } child)
            {
                // Metadata precedes clusters. Never walk packets or seek through the payload.
                if (child.Id == Cluster) break;
                if (child.Id == Info)
                {
                    var cursor = child.Data;
                    while (ReadElement(stream, ref cursor, child.End, ref remaining) is { } entry)
                    {
                        if (entry.Id == 0x2ad7b1)
                            scale = Unsigned(stream, entry) is { } ticks && ticks > 0 ? ticks : double.NaN;
                        else if (entry.Id == 0x4489) duration = Floating(stream, entry);
                        if (entry.Unknown) break;
                    }
                    sawInfo = true;
                }
                else if (child.Id == Tracks)
                {
                    var cursor = child.Data;
                    while (ReadElement(stream, ref cursor, child.End, ref remaining) is { } track)
                    {
                        if (track.Id == 0xae && !track.Unknown)
                        {
                            var video = false;
                            int? trackWidth = null, trackHeight = null;
                            var trackCursor = track.Data;
                            while (ReadElement(stream, ref trackCursor, track.End, ref remaining) is { } entry)
                            {
                                if (entry.Id == 0x83) video = Unsigned(stream, entry) == 1;
                                else if (entry.Id == 0xe0 && !entry.Unknown)
                                {
                                    var videoCursor = entry.Data;
                                    while (ReadElement(stream, ref videoCursor, entry.End, ref remaining) is { } field)
                                    {
                                        if (field.Id == 0xb0) trackWidth = Dimension(Unsigned(stream, field));
                                        else if (field.Id == 0xba) trackHeight = Dimension(Unsigned(stream, field));
                                        if (field.Unknown) break;
                                    }
                                }
                                if (entry.Unknown) break;
                            }
                            if (video && width is null && trackWidth is not null && trackHeight is not null)
                            { width = trackWidth; height = trackHeight; }
                        }
                        if (track.Unknown) break;
                    }
                    sawTracks = true;
                }
                if (sawInfo && sawTracks || child.Unknown) break;
            }
            var seconds = duration * (scale / 1_000_000_000);
            return (width, height, seconds is > 0 && double.IsFinite(seconds.Value) ? seconds : null);
        }
        return (null, null, null);
    }

    private static Element? ReadElement(FileStream stream, ref long position, long end, ref int remaining)
    {
        if (remaining-- <= 0 || position >= end) return null;
        stream.Position = position;
        if (!Vint(stream, end, true, out var id, out _) || id > uint.MaxValue ||
            !Vint(stream, end, false, out var size, out var unknown)) return null;
        var data = stream.Position;
        if (!unknown && size > (ulong)(end - data)) return null;
        var next = unknown ? end : data + (long)size;
        position = next;
        return new((uint)id, data, next, unknown);
    }

    private static bool Vint(FileStream stream, long end, bool identifier, out ulong value, out bool unknown)
    {
        value = 0;
        unknown = false;
        if (stream.Position >= end) return false;
        var first = stream.ReadByte();
        var length = 1;
        var marker = 0x80;
        while (marker > 0 && (first & marker) == 0) { marker >>= 1; length++; }
        if (marker == 0 || length > (identifier ? 4 : 8) || end - stream.Position < length - 1) return false;
        value = (ulong)(identifier ? first : first & (marker - 1));
        for (var i = 1; i < length; i++) value = value << 8 | (byte)stream.ReadByte();
        unknown = !identifier && value == (1UL << (length * 7)) - 1;
        return true;
    }

    private static ulong? Unsigned(FileStream stream, Element element)
    {
        var length = element.End - element.Data;
        if (element.Unknown || length is < 1 or > 8) return null;
        stream.Position = element.Data;
        ulong value = 0;
        for (var i = 0; i < length; i++) value = value << 8 | (byte)stream.ReadByte();
        return value;
    }

    private static double? Floating(FileStream stream, Element element)
    {
        var length = element.End - element.Data;
        if (element.Unknown || length is not (4 or 8)) return null;
        Span<byte> bytes = stackalloc byte[8];
        stream.Position = element.Data;
        stream.ReadExactly(bytes[..(int)length]);
        return length == 4 ? BinaryPrimitives.ReadSingleBigEndian(bytes) : BinaryPrimitives.ReadDoubleBigEndian(bytes);
    }

    private static int? Dimension(ulong? value) => value is > 0 and <= 32768 ? (int)value.Value : null;

    internal static (int? Width, int? Height, double? RuntimeSeconds) Avi(FileStream stream)
    {
        Span<byte> header = stackalloc byte[12];
        Span<byte> main = stackalloc byte[40];
        stream.Position = 0;
        stream.ReadExactly(header);
        var end = Math.Min(stream.Length, 8L + BinaryPrimitives.ReadUInt32LittleEndian(header[4..]));
        var position = 12L;
        var remaining = 4096;
        while (RiffChunk(stream, ref position, end, ref remaining) is { } chunk)
        {
            if (chunk.Id != 0x5453494c || chunk.End - chunk.Data < 4) continue; // LIST
            stream.Position = chunk.Data;
            stream.ReadExactly(header[..4]);
            if (!header[..4].SequenceEqual("hdrl"u8)) break;
            var cursor = chunk.Data + 4;
            while (RiffChunk(stream, ref cursor, chunk.End, ref remaining) is { } field)
            {
                if (field.Id != 0x68697661 || field.End - field.Data < 40) continue; // avih
                stream.Position = field.Data;
                stream.ReadExactly(main);
                var micros = BinaryPrimitives.ReadUInt32LittleEndian(main);
                var frames = BinaryPrimitives.ReadUInt32LittleEndian(main[16..]);
                var seconds = (double)micros * frames / 1_000_000;
                return (Dimension(BinaryPrimitives.ReadUInt32LittleEndian(main[32..])),
                    Dimension(BinaryPrimitives.ReadUInt32LittleEndian(main[36..])), seconds > 0 ? seconds : null);
            }
            break;
        }
        return (null, null, null);
    }

    private static Element? RiffChunk(FileStream stream, ref long position, long end, ref int remaining)
    {
        if (remaining-- <= 0 || end - position < 8) return null;
        Span<byte> header = stackalloc byte[8];
        stream.Position = position;
        stream.ReadExactly(header);
        var size = BinaryPrimitives.ReadUInt32LittleEndian(header[4..]);
        var data = position + 8;
        if (size > end - data) return null;
        position = data + size + (size & 1);
        return new(BinaryPrimitives.ReadUInt32LittleEndian(header), data, data + size, false);
    }
}
