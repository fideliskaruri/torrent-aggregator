using System.Collections.Immutable;

namespace TorrentFlow.Domain;

/// <summary>Store's narrow cache port. Check reads; the orchestrator commits returned evidence.</summary>
public interface ICheckRepository
{
    Task<ImmutableArray<SwarmEvidence>> LoadAsync(ImmutableArray<string> hashes, CancellationToken ct);
    Task<ImmutableArray<SwarmEvidence>> RecentAsync(int limit, CancellationToken ct);
    Task SaveAsync(Candidate candidate, SwarmEvidence evidence, CancellationToken ct);
    Task<EngineSettings> SettingsAsync(CancellationToken ct);
}

public sealed record CheckOptions
{
    public int Slots { get; init; } = 10;
    public int BackgroundSlots { get; init; } = 2;
    public int QueueWaitSeconds { get; init; } = 60;
    public int MinimumGoodSeconds { get; init; } = 4;
    public int VerdictHours { get; init; } = 6;
    public int UnknownMinutes { get; init; } = 45;
    public int ProbeVersion { get; init; } = 2;
}

public sealed record CheckDiagnostics(int Active, int BackgroundActive, int Queued, int Flights,
    int PeakActive, long PhysicalProbes, long SharedWaiters, long CacheHits);

public static class CheckVersion
{
    public static int For(EngineSettings settings, CheckOptions options)
    {
        Span<byte> input = stackalloc byte[32];
        System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(input, settings.GoodBytes);
        System.Buffers.Binary.BinaryPrimitives.WriteInt64LittleEndian(input[8..], settings.GoodBytesPerSecond);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(input[16..], settings.CheckWindowSeconds);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(input[20..], options.MinimumGoodSeconds);
        System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(input[24..], options.ProbeVersion);
        input[28..].Clear();
        var digest = System.Security.Cryptography.SHA256.HashData(input);
        return System.Buffers.Binary.BinaryPrimitives.ReadInt32LittleEndian(digest) & int.MaxValue;
    }
}
