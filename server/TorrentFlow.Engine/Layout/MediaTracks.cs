using System.Buffers.Binary;
using System.Numerics;
using System.Text;
using TorrentFlow.Core;

namespace TorrentFlow.Engine.Layout;

/// <summary>What a video file's header says about its tracks.</summary>
/// <param name="Container">mkv, webm, mp4, mov or unknown.</param>
/// <param name="Unchecked">Why <paramref name="Tracks"/> can't be trusted (<see cref="MediaTracks"/> reasons); null when they can.</param>
/// <param name="BytesRead">Bytes the reader handed over.</param>
/// <param name="Reads">Range reads asked of the reader.</param>
internal sealed record MediaTrackScan(string Container, IReadOnlyList<MediaTrack> Tracks, string? Unchecked, long BytesRead, int Reads)
{
    public static MediaTrackScan Skipped(string reason, string container = "unknown") => new(container, [], reason, 0, 0);
}

/// <summary>The most a scan may ask of its reader. A scan that would go over stops unchecked.</summary>
internal sealed record MediaTrackBudget(long MaxBytes, int MaxReads)
{
    public static MediaTrackBudget Default { get; } = new(32L << 20, 12);
}

/// <summary>
/// Reads the track list (kind, language, default, enabled, forced, name) from a Matroska/WebM or ISO media (MP4, M4V,
/// MOV) header over a random-access reader, so a caller holding only some of a file (the header probe, which fetches
/// pieces on demand) asks for exactly the ranges the header needs. The track list does not have to sit at the start:
/// Matroska's SeekHead is followed to a Tracks element written after the clusters, and ISO boxes are walked by their
/// headers past the media data to a moov at the end of the file. Never throws for bad data: anything it can't read
/// comes back unchecked with a reason.
/// </summary>
internal static class MediaTracks
{
    public const string UnknownContainer = "unknown container";
    public const string Malformed = "malformed header";
    public const string Compressed = "compressed header";
    public const string NotFound = "tracks not found";
    public const string ByteBudget = "byte budget";
    public const string ReadBudget = "read budget";
    public const string Cancelled = "cancelled";
    public const string ReadFailed = "read failed";

    private const int HeadBytes = 1 << 20;
    private const int ChunkBytes = 256 << 10;
    /// <summary>A Tracks element, EBML header, SeekHead or moov larger than this is not a header worth reading.</summary>
    private const int MaxElementBytes = 16 << 20;
    private const int MaxElements = 4096;

    private const long EbmlId = 0x1A45DFA3, DocTypeId = 0x4282, SegmentId = 0x18538067, SeekHeadId = 0x114D9B74;
    private const long SeekId = 0x4DBB, SeekIdId = 0x53AB, SeekPositionId = 0x53AC, TracksId = 0x1654AE6B, ClusterId = 0x1F43B675;
    private const long TrackEntryId = 0xAE, TrackNumberId = 0xD7, TrackTypeId = 0x83, LanguageId = 0x22B59C, LanguageBcp47Id = 0x22B59D;
    private const long FlagDefaultId = 0x88, FlagEnabledId = 0xB9, FlagForcedId = 0x55AA, NameId = 0x536E, CodecIdId = 0x86;

    /// <param name="read">Returns the bytes at [offset, offset + count), fewer only at the end of the file.</param>
    public static async Task<MediaTrackScan> ScanAsync(long fileLength,
        Func<long, int, CancellationToken, ValueTask<ReadOnlyMemory<byte>>> read, MediaTrackBudget budget, CancellationToken ct)
    {
        var source = new Source(fileLength, read, budget);
        var container = "unknown";
        try
        {
            if (fileLength < 16) return source.Result(container, [], Malformed);
            var head = await source.GetAsync(0, (int)Math.Min(16, fileLength), ct, HeadBytes);
            List<MediaTrack> tracks;
            if (ContainerSniffer.IsMatroska(head.Span))
            {
                container = "mkv";
                (container, tracks) = await ScanMatroskaAsync(source, ct);
            }
            else if (ContainerSniffer.IsIsoMedia(head.Span))
            {
                container = "mp4";
                (container, tracks) = await ScanIsoAsync(source, ct);
            }
            else return source.Result(container, [], UnknownContainer);
            return tracks.Count == 0 ? source.Result(container, [], NotFound) : source.Result(container, tracks, null);
        }
        catch (ScanStop stop) { return source.Result(container, [], stop.Reason); }
        catch (OperationCanceledException) { return source.Result(container, [], Cancelled); }
        // The reader's own failures arrive as ScanStop(ReadFailed); anything else is the data contradicting itself.
        catch (Exception) { return source.Result(container, [], Malformed); }
    }

    // ------------------------------------------------------------------ Matroska

    private static async Task<(string, List<MediaTrack>)> ScanMatroskaAsync(Source src, CancellationToken ct)
    {
        var ebml = await ReadElementAsync(src, 0, ct);
        if (ebml is not { Id: EbmlId, Size: >= 0 and <= 4096 }) throw new ScanStop(Malformed);
        var container = "mkv";
        foreach (var (id, data) in Children(await src.GetAsync(ebml.Value.DataStart, (int)ebml.Value.Size, ct)))
            if (id == DocTypeId && Text(data) == "webm") container = "webm";

        var segment = await ReadElementAsync(src, ebml.Value.End, ct);
        if (segment is not { Id: SegmentId } seg || seg.Size >= 0 && seg.End > src.Length) throw new ScanStop(Malformed);
        var segmentEnd = seg.Size < 0 ? src.Length : seg.End;

        var tracksAt = new List<long>();
        var seekHeads = new Queue<long>();
        var seenSeekHeads = new HashSet<long>();
        var pos = seg.DataStart;
        for (var count = 0; pos < segmentEnd && count < MaxElements; count++)
        {
            if (await ReadElementAsync(src, pos, ct) is not { } el) break;
            if (el.Id == TracksId) return (container, await ReadTracksAsync(src, el, ct));
            if (el.Id == ClusterId) break;
            if (el.Id == SeekHeadId && seenSeekHeads.Add(el.Start))
            {
                await ReadSeekHeadAsync(src, el, seg.DataStart, tracksAt, seekHeads, ct);
                // The SeekHead says where Tracks is: go there instead of walking the elements in between.
                foreach (var at in tracksAt)
                    if (at > pos && await TracksAtAsync(src, at, ct) is { } found) return (container, found);
            }
            if (el.Size < 0 || el.End > segmentEnd) throw new ScanStop(Malformed);
            pos = el.End;
        }

        // Tracks wasn't before the first cluster: only the SeekHead (or one it points to) can say where it is.
        for (var hops = 0; ; hops++)
        {
            foreach (var at in tracksAt)
                if (await TracksAtAsync(src, at, ct) is { } found) return (container, found);
            tracksAt.Clear();
            if (hops >= 3 || !seekHeads.TryDequeue(out var next)) break;
            if (!seenSeekHeads.Add(next)) continue;
            if (await ReadElementAsync(src, next, ct) is { Id: SeekHeadId } more)
                await ReadSeekHeadAsync(src, more, seg.DataStart, tracksAt, seekHeads, ct);
        }
        throw new ScanStop(NotFound);
    }

    private static async Task<List<MediaTrack>?> TracksAtAsync(Source src, long at, CancellationToken ct) =>
        at < src.Length && await ReadElementAsync(src, at, ct) is { Id: TracksId } el ? await ReadTracksAsync(src, el, ct) : null;

    private static async Task ReadSeekHeadAsync(Source src, Element seekHead, long segmentData, List<long> tracksAt,
        Queue<long> seekHeads, CancellationToken ct)
    {
        if (seekHead.Size is < 0 or > MaxElementBytes || seekHead.End > src.Length) throw new ScanStop(Malformed);
        foreach (var (id, seek) in Children(await src.GetAsync(seekHead.DataStart, (int)seekHead.Size, ct)))
        {
            if (id != SeekId) continue;
            long target = 0, position = -1;
            foreach (var (childId, data) in Children(seek))
            {
                if (childId == SeekIdId) target = UInt(data);
                else if (childId == SeekPositionId) position = UInt(data);
            }
            if (position < 0 || segmentData + position >= src.Length) continue;
            if (target == TracksId) tracksAt.Add(segmentData + position);
            else if (target == SeekHeadId) seekHeads.Enqueue(segmentData + position);
        }
    }

    private static async Task<List<MediaTrack>> ReadTracksAsync(Source src, Element tracks, CancellationToken ct)
    {
        if (tracks.Size is < 0 or > MaxElementBytes || tracks.End > src.Length) throw new ScanStop(Malformed);
        var list = new List<MediaTrack>();
        foreach (var (id, entry) in Children(await src.GetAsync(tracks.DataStart, (int)tracks.Size, ct)))
            if (id == TrackEntryId && TrackEntry(entry) is { } track) list.Add(track);
        return list;
    }

    private static MediaTrack? TrackEntry(ReadOnlyMemory<byte> entry)
    {
        long number = 0, type = 0;
        string? language = null, bcp47 = null, name = null, codec = null;
        bool isDefault = true, enabled = true, forced = false;
        foreach (var (id, data) in Children(entry))
        {
            switch (id)
            {
                case TrackNumberId: number = UInt(data); break;
                case TrackTypeId: type = UInt(data); break;
                case LanguageId: language = Text(data); break;
                case LanguageBcp47Id: bcp47 = Text(data); break;
                case FlagDefaultId when data.Length > 0: isDefault = UInt(data) != 0; break;
                case FlagEnabledId when data.Length > 0: enabled = UInt(data) != 0; break;
                case FlagForcedId when data.Length > 0: forced = UInt(data) != 0; break;
                case NameId: name = Text(data); break;
                case CodecIdId: codec = Text(data); break;
            }
        }
        MediaTrackKind? kind = type switch { 1 => MediaTrackKind.Video, 2 => MediaTrackKind.Audio, 0x11 => MediaTrackKind.Subtitle, _ => null };
        if (kind is null) return null;
        // LanguageBCP47 replaces Language when present. An absent Language stays null: Matroska reads it as "eng", but an
        // untagged track is unknown here.
        var raw = string.IsNullOrEmpty(bcp47) ? string.IsNullOrEmpty(language) ? null : language : bcp47;
        return new MediaTrack((int)Math.Min(number, int.MaxValue), kind.Value, LanguageTag.Normalize(raw), raw,
            isDefault, enabled, forced, string.IsNullOrEmpty(name) ? null : name, string.IsNullOrEmpty(codec) ? null : codec);
    }

    private readonly record struct Element(long Id, long Start, long DataStart, long Size)
    {
        /// <summary>-1 for an unknown-size element (all ones), which only a Segment or Cluster may be.</summary>
        public long End => Size < 0 ? -1 : DataStart + Size;
    }

    /// <summary>The element header at <paramref name="pos"/>; null at the end of the file.</summary>
    private static async Task<Element?> ReadElementAsync(Source src, long pos, CancellationToken ct)
    {
        if (pos < 0) throw new ScanStop(Malformed);
        var available = (int)Math.Min(12, src.Length - pos);
        if (available < 2) return null;
        var bytes = (await src.GetAsync(pos, available, ct)).Span;
        if (!TryVint(bytes, keepMarker: true, out var id, out var idWidth, out _) || idWidth > 4) throw new ScanStop(Malformed);
        if (!TryVint(bytes[idWidth..], keepMarker: false, out var size, out var sizeWidth, out var unknown)) throw new ScanStop(Malformed);
        return new Element(id, pos, pos + idWidth + sizeWidth, unknown ? -1 : size);
    }

    /// <summary>The children of a master element held in memory. Every child must fit inside its parent.</summary>
    private static List<(long Id, ReadOnlyMemory<byte> Data)> Children(ReadOnlyMemory<byte> data)
    {
        var list = new List<(long, ReadOnlyMemory<byte>)>();
        var pos = 0;
        while (pos < data.Length)
        {
            var span = data.Span[pos..];
            if (!TryVint(span, keepMarker: true, out var id, out var idWidth, out _) || idWidth > 4
                || !TryVint(span[idWidth..], keepMarker: false, out var size, out var sizeWidth, out var unknown) || unknown)
                throw new ScanStop(Malformed);
            var start = pos + idWidth + sizeWidth;
            if (size > data.Length - start) throw new ScanStop(Malformed);
            list.Add((id, data.Slice(start, (int)size)));
            pos = start + (int)size;
        }
        return list;
    }

    /// <summary>An EBML variable-length integer: the leading zero bits of the first byte give its width.</summary>
    private static bool TryVint(ReadOnlySpan<byte> s, bool keepMarker, out long value, out int width, out bool unknown)
    {
        value = 0;
        unknown = false;
        width = s.IsEmpty || s[0] == 0 ? 0 : BitOperations.LeadingZeroCount((uint)s[0]) - 23;
        if (width is < 1 or > 8 || s.Length < width) return false;
        var mask = 0xFF >> width;
        var allOnes = (s[0] & mask) == mask;
        value = keepMarker ? s[0] : s[0] & mask;
        for (var i = 1; i < width; i++)
        {
            value = (value << 8) | s[i];
            allOnes &= s[i] == 0xFF;
        }
        unknown = !keepMarker && allOnes;
        return true;
    }

    private static long UInt(ReadOnlyMemory<byte> data)
    {
        if (data.Length > 8) throw new ScanStop(Malformed);
        long value = 0;
        foreach (var b in data.Span) value = (value << 8) | b;
        return value;
    }

    private static string Text(ReadOnlyMemory<byte> data) => Encoding.UTF8.GetString(data.Span).TrimEnd('\0').Trim();

    // ------------------------------------------------------------------ ISO media

    private readonly record struct Box(string Type, long Start, long DataStart, long End)
    {
        public long Size => End - DataStart;
    }

    private static async Task<(string, List<MediaTrack>)> ScanIsoAsync(Source src, CancellationToken ct)
    {
        var container = "mp4";
        long pos = 0;
        for (var count = 0; pos + 8 <= src.Length && count < MaxElements; count++)
        {
            var box = await ReadBoxAsync(src, pos, src.Length, ct);
            if (pos == 0 && box.Type == "ftyp" && box.Size >= 4
                && Encoding.ASCII.GetString((await src.GetAsync(box.DataStart, 4, ct)).Span) == "qt  ")
                container = "mov";
            // Top-level boxes are walked by their headers only: an mdat is skipped, never read, so a moov written after
            // the media data costs one read at its offset.
            if (box.Type == "moov") return (container, await ReadMoovAsync(src, box, ct));
            pos = box.End;
        }
        throw new ScanStop(NotFound);
    }

    private static async Task<List<MediaTrack>> ReadMoovAsync(Source src, Box moov, CancellationToken ct)
    {
        // Usually small: one read brings the whole of it in, and the walk below then reads from memory.
        if (moov.Size <= MaxElementBytes && src.CanAfford(moov.Size)) await src.GetAsync(moov.DataStart, (int)moov.Size, ct);
        var tracks = new List<MediaTrack>();
        await foreach (var child in ChildBoxesAsync(src, moov, ct))
        {
            if (child.Type == "cmov") throw new ScanStop(Compressed);
            if (child.Type == "trak" && await ReadTrakAsync(src, child, ct) is { } track) tracks.Add(track);
        }
        // ISO media has no default flag: players start the first enabled track of each kind.
        var seen = new HashSet<MediaTrackKind>();
        return tracks.Select(t => t with { Default = t.Enabled && seen.Add(t.Kind) }).ToList();
    }

    private static async Task<MediaTrack?> ReadTrakAsync(Source src, Box trak, CancellationToken ct)
    {
        var number = 0;
        var enabled = true;
        string? handler = null, handlerName = null, raw = null, extended = null;
        await foreach (var child in ChildBoxesAsync(src, trak, ct))
        {
            if (child.Type == "tkhd")
            {
                var d = (await src.GetAsync(child.DataStart, (int)Math.Min(child.Size, 32), ct)).Span;
                if (d.Length < 24) throw new ScanStop(Malformed);
                enabled = (d[3] & 1) != 0;
                number = (int)Math.Min(BinaryPrimitives.ReadUInt32BigEndian(d[(d[0] == 1 ? 20 : 12)..]), int.MaxValue);
            }
            else if (child.Type == "mdia")
            {
                await foreach (var part in ChildBoxesAsync(src, child, ct))
                {
                    switch (part.Type)
                    {
                        case "mdhd":
                        {
                            var d = (await src.GetAsync(part.DataStart, (int)Math.Min(part.Size, 36), ct)).Span;
                            var at = d.Length > 0 && d[0] == 1 ? 32 : 20;
                            if (d.Length < at + 2) throw new ScanStop(Malformed);
                            raw = PackedLanguage(BinaryPrimitives.ReadUInt16BigEndian(d[at..]));
                            break;
                        }
                        case "hdlr":
                        {
                            var d = (await src.GetAsync(part.DataStart, (int)Math.Min(part.Size, 256), ct)).Span;
                            if (d.Length < 12) throw new ScanStop(Malformed);
                            handler = Encoding.ASCII.GetString(d[8..12]);
                            if (d.Length > 24) handlerName = CString(d[24..]);
                            break;
                        }
                        case "elng":
                        {
                            var d = (await src.GetAsync(part.DataStart, (int)Math.Min(part.Size, 64), ct)).Span;
                            if (d.Length > 4) extended = CString(d[4..]);
                            break;
                        }
                    }
                }
            }
        }
        MediaTrackKind? kind = handler switch
        {
            "vide" => MediaTrackKind.Video,
            "soun" => MediaTrackKind.Audio,
            "subt" or "sbtl" or "text" or "clcp" => MediaTrackKind.Subtitle,
            _ => null,
        };
        if (kind is null) return null;
        var tag = string.IsNullOrEmpty(extended) ? raw : extended;
        return new MediaTrack(number, kind.Value, LanguageTag.Normalize(tag), tag, false, enabled, false, handlerName, null);
    }

    /// <summary>
    /// mdhd's ISO 639-2/T code: three 5-bit letters offset by 0x60. 0 is unset; values under 0x400 are QuickTime's
    /// Macintosh language numbers, kept as written and read as unknown.
    /// </summary>
    private static string? PackedLanguage(ushort packed)
    {
        if (packed == 0) return null;
        if (packed < 0x400) return $"mac {packed}";
        Span<char> code = [(char)(((packed >> 10) & 0x1F) + 0x60), (char)(((packed >> 5) & 0x1F) + 0x60), (char)((packed & 0x1F) + 0x60)];
        foreach (var c in code)
            if (c is < 'a' or > 'z') return null;
        return new string(code);
    }

    /// <summary>A NUL-terminated string; a QuickTime Pascal string's length byte is dropped with the other control characters.</summary>
    private static string? CString(ReadOnlySpan<byte> d)
    {
        var end = d.IndexOf((byte)0);
        var text = new string(Encoding.UTF8.GetString(end < 0 ? d : d[..end]).Where(c => !char.IsControl(c)).ToArray()).Trim();
        return text.Length == 0 ? null : text;
    }

    private static async IAsyncEnumerable<Box> ChildBoxesAsync(Source src, Box parent,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var pos = parent.DataStart;
        for (var count = 0; pos + 8 <= parent.End; count++)
        {
            if (count >= MaxElements) throw new ScanStop(Malformed);
            var box = await ReadBoxAsync(src, pos, parent.End, ct);
            yield return box;
            pos = box.End;
        }
    }

    private static async Task<Box> ReadBoxAsync(Source src, long pos, long parentEnd, CancellationToken ct)
    {
        var d = (await src.GetAsync(pos, (int)Math.Min(16, parentEnd - pos), ct)).Span;
        if (d.Length < 8) throw new ScanStop(Malformed);
        foreach (var c in d[4..8])
            if (c is (< 0x20 or > 0x7E) and not 0xA9) throw new ScanStop(Malformed);
        var type = Encoding.Latin1.GetString(d[4..8]);
        long size = BinaryPrimitives.ReadUInt32BigEndian(d);
        var header = 8;
        if (size == 1)
        {
            if (d.Length < 16) throw new ScanStop(Malformed);
            size = (long)Math.Min(BinaryPrimitives.ReadUInt64BigEndian(d[8..]), long.MaxValue);
            header = 16;
        }
        else if (size == 0) size = parentEnd - pos;
        if (size < header || size > parentEnd - pos) throw new ScanStop(Malformed);
        return new Box(type, pos, pos + header, pos + size);
    }

    // ------------------------------------------------------------------ reads within the budget

    private sealed class ScanStop(string reason) : Exception(reason)
    {
        public string Reason { get; } = reason;
    }

    /// <summary>
    /// The reader behind a budget. Each miss fetches at least a chunk, so headers that sit close together cost one read;
    /// ranges already fetched are served from memory and cost nothing.
    /// </summary>
    private sealed class Source(long length, Func<long, int, CancellationToken, ValueTask<ReadOnlyMemory<byte>>> read, MediaTrackBudget budget)
    {
        private readonly List<(long Start, ReadOnlyMemory<byte> Data)> _chunks = [];
        public long Length { get; } = length;
        public long BytesRead { get; private set; }
        public int Reads { get; private set; }

        public bool CanAfford(long bytes) => Reads < budget.MaxReads && BytesRead + bytes <= budget.MaxBytes;

        public MediaTrackScan Result(string container, List<MediaTrack> tracks, string? reason) => new(container, tracks, reason, BytesRead, Reads);

        public async ValueTask<ReadOnlyMemory<byte>> GetAsync(long offset, int count, CancellationToken ct, int prefetch = ChunkBytes)
        {
            if (offset < 0 || count < 0 || offset > Length - count) throw new ScanStop(Malformed);
            foreach (var (start, data) in _chunks)
                if (offset >= start && offset + count <= start + data.Length) return data.Slice((int)(offset - start), count);
            if (Reads >= budget.MaxReads) throw new ScanStop(ReadBudget);
            var want = (int)Math.Min(Math.Max(count, prefetch), Math.Min(Length - offset, budget.MaxBytes - BytesRead));
            if (want < count) throw new ScanStop(ByteBudget);
            Reads++;
            ReadOnlyMemory<byte> got;
            try { got = await read(offset, want, ct); }
            catch (Exception ex) when (ex is not OperationCanceledException) { throw new ScanStop(ReadFailed); }
            BytesRead += got.Length;
            if (got.Length < count) throw new ScanStop(ReadFailed);
            _chunks.Add((offset, got));
            return got[..count];
        }
    }
}
