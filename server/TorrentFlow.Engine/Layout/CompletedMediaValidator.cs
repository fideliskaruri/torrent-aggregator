using Microsoft.Extensions.Logging;
using TorrentFlow.Core;

namespace TorrentFlow.Engine.Layout;

internal enum MediaVerdict { Valid, Invalid, Unreadable }

/// <param name="Reason">What decided it, for the log. Never shown to the owner.</param>
internal sealed record MediaCheck(MediaVerdict Verdict, string Reason)
{
    public static readonly MediaCheck Valid = new(MediaVerdict.Valid, "real video");
}

/// <summary>What the first bytes of a file say it is.</summary>
internal enum ContainerKind { Video, Archive, Program, Zero, Unknown }

/// <summary>
/// File signatures. A video file has to start the way one of the formats the app treats as video starts; an archive or
/// a program wearing a video name, and a file of nothing but zeros, do not.
/// </summary>
internal static class ContainerSniffer
{
    private static readonly string[] IsoBoxes = ["ftyp", "moov", "mdat", "free", "skip", "wide", "pnot", "uuid", "styp", "sidx", "moof"];

    public static ContainerKind Classify(ReadOnlySpan<byte> head, long length)
    {
        if (length == 0 || head.IsEmpty) return ContainerKind.Zero;
        // No video starts with these, so they are checked first and a chance match further in can never hide them.
        if (IsArchive(head)) return ContainerKind.Archive;
        if (IsProgram(head)) return ContainerKind.Program;
        if (IsVideo(head)) return ContainerKind.Video;
        if (IsDiscImage(head)) return ContainerKind.Archive;
        return head.IndexOfAnyExcept((byte)0) < 0 ? ContainerKind.Zero : ContainerKind.Unknown;
    }

    private static bool IsVideo(ReadOnlySpan<byte> h) =>
        h.StartsWith((ReadOnlySpan<byte>)[0x1A, 0x45, 0xDF, 0xA3])                      // Matroska, WebM
        || IsIsoMedia(h)                                                               // MP4, M4V, MOV
        || h.Length >= 12 && h.StartsWith("RIFF"u8) && (h[8..12].SequenceEqual("AVI "u8) || h[8..12].SequenceEqual("CDXA"u8))
        || h.StartsWith((ReadOnlySpan<byte>)[0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11]) // ASF (WMV)
        || h.StartsWith("FLV"u8)
        || IsTransportStream(h)                                                        // MPEG-TS, M2TS
        || IsProgramStream(h);                                                         // MPEG-PS (VOB, MPG), MPEG video

    private static bool IsIsoMedia(ReadOnlySpan<byte> h)
    {
        if (h.Length < 8) return false;
        Span<char> type = stackalloc char[4];
        for (var i = 0; i < 4; i++) type[i] = (char)h[4 + i];
        foreach (var box in IsoBoxes)
            if (type.SequenceEqual(box)) return true;
        return false;
    }

    /// <summary>Three sync bytes one packet apart, starting in the first 1 KiB: 188-byte TS, 192-byte M2TS, 204-byte TS.</summary>
    private static bool IsTransportStream(ReadOnlySpan<byte> h)
    {
        foreach (var size in (ReadOnlySpan<int>)[188, 192, 204])
            for (var start = 0; start < 1024 && start + 2 * size < h.Length; start++)
                if (h[start] == 0x47 && h[start + size] == 0x47 && h[start + 2 * size] == 0x47) return true;
        return false;
    }

    /// <summary>A pack header or a video sequence header, after any zero stuffing.</summary>
    private static bool IsProgramStream(ReadOnlySpan<byte> h)
    {
        var first = h.IndexOfAnyExcept((byte)0);
        return first >= 2 && first + 1 < h.Length && h[first] == 0x01 && h[first + 1] is 0xBA or 0xB3;
    }

    private static bool IsArchive(ReadOnlySpan<byte> h) =>
        h.StartsWith("Rar!"u8)
        || h.StartsWith((ReadOnlySpan<byte>)[0x50, 0x4B, 0x03, 0x04]) || h.StartsWith((ReadOnlySpan<byte>)[0x50, 0x4B, 0x05, 0x06])
        || h.StartsWith((ReadOnlySpan<byte>)[0x50, 0x4B, 0x07, 0x08])
        || h.StartsWith((ReadOnlySpan<byte>)[0x37, 0x7A, 0xBC, 0xAF, 0x27, 0x1C])               // 7z
        || h.StartsWith((ReadOnlySpan<byte>)[0x1F, 0x8B])                                       // gzip
        || h.StartsWith("BZh"u8)
        || h.StartsWith((ReadOnlySpan<byte>)[0xFD, 0x37, 0x7A, 0x58, 0x5A, 0x00])               // xz
        || h.StartsWith((ReadOnlySpan<byte>)[0x28, 0xB5, 0x2F, 0xFD])                           // zstd
        || h.StartsWith("MSCF"u8);                                                              // cab

    private static bool IsProgram(ReadOnlySpan<byte> h) =>
        h.StartsWith("MZ"u8)                                                                    // Windows
        || h.StartsWith((ReadOnlySpan<byte>)[0x7F, 0x45, 0x4C, 0x46])                           // ELF
        || h.StartsWith((ReadOnlySpan<byte>)[0xFE, 0xED, 0xFA, 0xCE]) || h.StartsWith((ReadOnlySpan<byte>)[0xFE, 0xED, 0xFA, 0xCF])
        || h.StartsWith((ReadOnlySpan<byte>)[0xCE, 0xFA, 0xED, 0xFE]) || h.StartsWith((ReadOnlySpan<byte>)[0xCF, 0xFA, 0xED, 0xFE])
        || h.StartsWith((ReadOnlySpan<byte>)[0xCA, 0xFE, 0xBA, 0xBE]);                          // Mach-O

    /// <summary>ISO 9660: "CD001" in the first volume descriptor, after the 32 KiB system area.</summary>
    private static bool IsDiscImage(ReadOnlySpan<byte> h) => h.Length >= 0x8006 && h[0x8001..0x8006].SequenceEqual("CD001"u8);
}

/// <summary>
/// The check a finished download passes before it counts as downloaded (docs/api-open-file.md, "Checking downloads"),
/// built in: no process, no ffprobe. In order, any failure ends it:
/// <list type="number">
/// <item>no program file anywhere in the release (<see cref="MediaFileRules.IsDangerous"/>, every file);</item>
/// <item>not only archives, and</item>
/// <item>at least one video among the kept files;</item>
/// <item>each kept video starts like a video container, not an archive or a program;</item>
/// <item>no kept video is zero-filled (empty, or its first 64 KiB and three 4 KiB samples are all zeros);</item>
/// <item>the largest kept video is at least 1 MiB, so a sample-sized fake does not pass.</item>
/// </list>
/// Only kept files are read: a season pack's skipped neighbours are partial and already deleted. A file that cannot
/// be read is tried again; if it still cannot, the answer is <see cref="MediaVerdict.Unreadable"/>, never a guess.
/// </summary>
internal sealed class CompletedMediaValidator(ILogger<CompletedMediaValidator> logger)
{
    public const string InvalidCompletedMediaMessage =
        "This download wasn't a real video file, so TorrentFlow is looking for another release.";
    /// <summary>What a rejected row said while ffprobe did the check; still recognised so that release is not picked again.</summary>
    public const string LegacyInvalidMessage =
        "The downloaded release did not contain playable video. TorrentFlow will choose another release.";
    public const string UncheckedMessage =
        "Couldn't check this download. Close any app using its files, then press Retry to check it again.";

    private const int HeadBytes = 64 * 1024;
    private const int SampleBytes = 4 * 1024;
    private const long TinyVideoBytes = 1024 * 1024;
    private static readonly TimeSpan[] RetryDelays = [TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(2)];

    /// <summary>One authoritative filename rule for content the app treats as video (<see cref="MediaFileRules.IsVideo"/>).</summary>
    public static bool IsSupportedVideoFileName(string name) => MediaFileRules.IsVideo(name);

    /// <param name="releaseFiles">Every file of the release, by its torrent path, kept or not.</param>
    /// <param name="keptFiles">Full paths of the files the download kept, on disk.</param>
    public async Task<MediaCheck> ValidateAsync(IReadOnlyCollection<string> releaseFiles, IReadOnlyList<string> keptFiles, CancellationToken ct)
    {
        switch (MediaFileRules.Check(releaseFiles, keptFiles))
        {
            case MediaFileProblem.Dangerous: return Invalid("a program file is part of the release");
            case MediaFileProblem.ArchiveOnly: return Invalid("only archives, no video");
            case MediaFileProblem.NoVideo: return Invalid("no video file");
        }

        long largest = 0;
        foreach (var file in keptFiles.Where(MediaFileRules.IsVideo))
        {
            var name = Path.GetFileName(file);
            var sample = await ReadAsync(file, ct);
            if (sample.Error is { } error) return new MediaCheck(MediaVerdict.Unreadable, $"{name} could not be read: {error}");
            switch (ContainerSniffer.Classify(sample.Head, sample.Length))
            {
                case ContainerKind.Video: break;
                case ContainerKind.Archive: return Invalid($"{name} is an archive");
                case ContainerKind.Program: return Invalid($"{name} is a program");
                case ContainerKind.Zero when sample.AllZero: return Invalid($"{name} is zero-filled");
                default: return Invalid($"{name} does not start like a video");
            }
            largest = Math.Max(largest, sample.Length);
        }
        return largest < TinyVideoBytes ? Invalid($"the largest video is only {largest} bytes") : MediaCheck.Valid;
    }

    private static MediaCheck Invalid(string reason) => new(MediaVerdict.Invalid, reason);

    private sealed record FileSample(byte[] Head, long Length, bool AllZero, string? Error);

    private async Task<FileSample> ReadAsync(string path, CancellationToken ct)
    {
        for (var attempt = 0; ; attempt++)
        {
            try
            {
                return await ReadOnceAsync(path, ct);
            }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                if (attempt >= RetryDelays.Length)
                {
                    logger.LogWarning(ex, "[content-layout] could not read {Path} to check it", path);
                    return new FileSample([], 0, false, ex.Message);
                }
                await Task.Delay(RetryDelays[attempt], ct);
            }
        }
    }

    /// <summary>The first 64 KiB; when those are all zeros, also 4 KiB at a quarter, half and three quarters in.</summary>
    private static async Task<FileSample> ReadOnceAsync(string path, CancellationToken ct)
    {
        await using var stream = new FileStream(path, new FileStreamOptions
        {
            Mode = FileMode.Open, Access = FileAccess.Read, Share = FileShare.ReadWrite | FileShare.Delete,
            Options = FileOptions.Asynchronous, BufferSize = 0,
        });
        var length = stream.Length;
        var head = new byte[(int)Math.Min(HeadBytes, length)];
        await stream.ReadExactlyAsync(head, ct);
        var allZero = head.AsSpan().IndexOfAnyExcept((byte)0) < 0;
        if (allZero && length > head.Length)
        {
            var buffer = new byte[SampleBytes];
            foreach (var at in new[] { length / 4, length / 2, length * 3 / 4 })
            {
                stream.Position = at;
                var read = await stream.ReadAtLeastAsync(buffer, (int)Math.Min(SampleBytes, length - at), throwOnEndOfStream: false, ct);
                if (buffer.AsSpan(0, read).IndexOfAnyExcept((byte)0) < 0) continue;
                allZero = false;
                break;
            }
        }
        return new FileSample(head, length, allZero, null);
    }
}
