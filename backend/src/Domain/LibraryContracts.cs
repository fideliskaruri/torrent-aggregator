using System.Collections.Immutable;

namespace TorrentFlow.Domain;

// Placement/inventory is independently usable before the filing and scan executor is built.
public interface ILibraryPlacement
{
    Task<PlacementResult> PlaceAsync(PlacementInput input, CancellationToken cancellationToken);
    Task<ImmutableArray<OwnedItem>> OwnedAsync(TargetScope scope, CancellationToken cancellationToken);
    Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken cancellationToken);
    Task<LibraryRootResult> AddRootAsync(LibraryRootInput input, CancellationToken cancellationToken);
    Task<LibraryRootResult> CheckRootAsync(string id, CancellationToken cancellationToken);
    Task<LibraryRootResult> ConfigureRootAsync(string id, LibraryRootConfiguration input, CancellationToken cancellationToken);
    Task<LibraryRootResult> RemoveRootAsync(string id, CancellationToken cancellationToken);
    Task<Failure?> RecordAsync(MediaFileRow file, WorkFolderRow? folder, CancellationToken cancellationToken);
    Task<int> PruneMissingAsync(DateTimeOffset now, CancellationToken cancellationToken);
}

public interface ILibraryRepository
{
    Task<ImmutableArray<StorageRootRow>> RootsAsync(CancellationToken cancellationToken);
    Task<ImmutableArray<MediaFileRow>> MediaAsync(string? workId, CancellationToken cancellationToken);
    Task<ImmutableArray<WorkFolderRow>> FoldersAsync(CancellationToken cancellationToken);
    Task<ImmutableArray<DownloadFileRow>> BindingsAsync(CancellationToken cancellationToken);
    Task<ImmutableDictionary<string, long>> ReservationsAsync(CancellationToken cancellationToken);
    Task<bool> SaveRootAsync(StorageRootRow root, long? expectedVersion, CancellationToken cancellationToken);
    Task<bool> SaveRootCheckAsync(StorageRootRow root, long expectedVersion,
        ImmutableArray<MediaFileRow> media, CancellationToken cancellationToken);
    Task<bool> RemoveRootAsync(string id, long expectedVersion, CancellationToken cancellationToken);
    Task<bool> RecordAsync(MediaFileRow file, WorkFolderRow? folder, CancellationToken cancellationToken);
    Task<int> PruneMissingAsync(DateTimeOffset before, CancellationToken cancellationToken);
}

public sealed record LibraryRootInput(string Path, ImmutableArray<LibraryKind> Kinds, int Priority,
    long ReserveBytes, LibraryFolders? Folders = null, long? MaxAllocatedBytes = null, bool Confirmed = false);
public sealed record LibraryRootResult(StorageRootRow? Root, Failure? Failure);
public sealed record LibraryRootConfiguration(int Priority, long ReserveBytes, bool Enabled,
    ImmutableArray<LibraryKind> Kinds, long ExpectedVersion, bool ConfirmIdentity = false, long? MaxAllocatedBytes = null);

// Only this projection crosses HTTP. Origin is deliberately not part of the public contract.
public sealed record LibraryMediaView(string Id, string WorkId, string? EpisodeId, string? RootId,
    string Path, long Bytes, int? Resolution, string? Source, FilePresence Status,
    string? DownloadId, DateTimeOffset AddedAt, DateTimeOffset? LastSeenAt);
public sealed record LibraryOwnedView(string WorkId, string? EpisodeId, int? Resolution,
    string Label, ImmutableArray<LibraryMediaView> Files);
