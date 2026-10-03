using System.Collections.Immutable;

namespace TorrentFlow.Domain;

public sealed record ImportScanInput(string Path);
public sealed record ImportCandidate(string WorkId, string Title, int? Year, WorkKind Kind,
    string? EpisodeId, int? Season, int? Episode, string WorkKey);
public sealed record ImportSidecar(string Path, long Bytes, DateTimeOffset MtimeUtc);
public sealed record ImportReviewItem(string Id, string Path, long Bytes, DateTimeOffset MtimeUtc,
    ParsedRelease Parsed, ImmutableArray<ParsedRelease> Parents, ImportConfidence Group,
    ImmutableArray<ImportCandidate> Candidates, ImmutableArray<ImportSidecar> Sidecars,
    bool AlreadyInLibrary, string? Message);
public sealed record ImportScanView(string Id, string Path, string State, int Total, int Scanned,
    ImmutableArray<ImportReviewItem> Items, string? Error);
public sealed record ImportSelection(string ItemId, string WorkId, string? EpisodeId);
public sealed record ImportConfirmInput(ImmutableArray<ImportSelection> Items);
public sealed record ImportItemResult(string ItemId, string? Path, bool Imported, string? Error,
    bool AlreadyInLibrary = false);
public sealed record ImportConfirmResult(ImmutableArray<ImportItemResult> Items);
public sealed record ImportRescanResult(string RootId, bool Online, int Present, int Offline,
    int Missing, int Dropped, string? Message);
