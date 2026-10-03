using System.Collections.Immutable;

namespace TorrentFlow.Domain;

/// <summary>Hash-bound file parsing supplied by composition, not performed by the pure planner.</summary>
public sealed record PlanFileMetadata(string Hash, long? PieceLength,
    ImmutableDictionary<int, ParsedRelease> ParsedFiles)
{
    public ImmutableDictionary<int, ParsedRelease> ParsedDirectories { get; init; } =
        ImmutableDictionary<int, ParsedRelease>.Empty;
}
