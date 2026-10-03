using System.Collections.Immutable;

namespace TorrentFlow.Domain;

/// <summary>In: release or path name. Out: normalized parse/hash. Never: I/O, catalog lookup, ranking or state writes.</summary>
public interface IParser
{
    ParsedRelease Parse(string releaseName);
    string? NormalizeInfoHash(string hashOrMagnet);
}

/// <summary>In: complete metadata, targets, pool, ownership, blocks and evidence. Out: assignments and every rejection. Never: I/O, search, probe, add or persist.</summary>
public interface IPlan
{
    PlanResult Choose(PlanInput input);
}

/// <summary>In: provider identity/query and catalog refresh commands. Out: labelled work, seasons, dates and catalog rows. Never: torrents, guesses from release names or filesystem writes.</summary>
public interface IMetadata
{
    Task<MetadataResult> ResolveAsync(MetadataQuery query, CancellationToken cancellationToken);
    Task<MetadataResult> GetWorkAsync(string workId, bool refresh, CancellationToken cancellationToken);
    Task<CatalogResult> SearchAsync(CatalogQuery query, CancellationToken cancellationToken);
    Task<BrowseResult> BrowseAsync(BrowseQuery query, CancellationToken cancellationToken);
    Task<MetadataExtras?> ExtrasAsync(MetadataQuery query, int? season, CancellationToken cancellationToken);
    Task<BrowseRail?> RecommendAsync(ImmutableArray<string> seedWorkIds, CancellationToken cancellationToken);
    Task<MetadataResult> ChangeLinkAsync(LinkCommand command, CancellationToken cancellationToken);
    Task RefreshAsync(DateTimeOffset now, CancellationToken cancellationToken);
}

/// <summary>In: raw query/category/identity, lane and deadline. Out: source listings and explicit outcome. Never: episode parsing, health, ranking, tracker scraping or inline retries.</summary>
public interface ISources
{
    void PromoteSearch(string flightId);
    void ForgetSearch(string flightId);
    Task<SourceResult> SearchAsync(string sourceId, SourceQuery query, CancellationToken cancellationToken);
    Task<SourceResult> TestAsync(string sourceId, CancellationToken cancellationToken);
    IAsyncEnumerable<SourceResult> SearchStreamAsync(string sourceId, SourceQuery query,
        CancellationToken cancellationToken);
}

/// <summary>In: work/scope/policy and coordinator coverage feedback. Out: hash-deduped incremental candidate pools. Never: judge swarm health, pick releases, call Engine or own Target state.</summary>
public interface IFind
{
    IAsyncEnumerable<CandidateBatch> SearchAsync(SearchRequest request,
        IAsyncEnumerable<SearchFeedback> feedback, CancellationToken cancellationToken);
    Task<RawSearchResult> SearchRawAsync(RawSearchQuery query, CancellationToken cancellationToken);
}

/// <summary>In: hash candidates and priority lane. Out: measured verdict/file lists. Never: choose releases, retain downloads, attach a second live-hash manager or persist caller-aborted/live measurements.</summary>
public interface ICheck
{
    IAsyncEnumerable<SwarmEvidence> ProbeAsync(ImmutableArray<ProbeRequest> requests, CancellationToken cancellationToken);
    IAsyncEnumerable<SwarmEvidence> ProbeStreamAsync(IAsyncEnumerable<ProbeRequest> requests, CancellationToken cancellationToken);
    CheckDiagnostics Diagnostics { get; }
    Task<ImmutableArray<SwarmEvidence>> LoadAsync(ImmutableArray<string> hashes, CancellationToken cancellationToken);
    Task<ImmutableArray<SwarmEvidence>> RecentAsync(int limit, CancellationToken cancellationToken);
}

/// <summary>In: probe capabilities, bound paths, durable selections and Run/Stop decisions. Out: exact live files and safe filing permits. Never: admission policy, work lookup, naming, deleting or Target writes.</summary>
public interface IEngine
{
    Task<ProbeAttachment> AttachProbeAsync(Candidate candidate, CancellationToken cancellationToken);
    Task<SwarmEvidence> ObserveProbeAsync(ProbeHandle handle, TimeSpan window, CancellationToken cancellationToken);
    Task ReleaseProbeAsync(ProbeHandle handle, CancellationToken cancellationToken);
    Task<EngineResult> ClaimAdmissionAsync(EngineAdmissionClaim claim, CancellationToken cancellationToken);
    Task ReleaseAdmissionClaimAsync(string token, CancellationToken cancellationToken);
    Task<EngineResult> AdmitFromProbeAsync(ProbeHandle handle, EngineAdmission admission, CancellationToken cancellationToken);
    Task<MetadataWaitAttachment> AttachMetadataWaitAsync(MetadataWaitRequest request, CancellationToken cancellationToken);
    Task<MetadataWaitAttachment> ObserveMetadataWaitAsync(string token, CancellationToken cancellationToken);
    Task ReleaseMetadataWaitAsync(string token, CancellationToken cancellationToken);
    Task<EngineResult> StartAsync(EngineAdmission admission, CancellationToken cancellationToken);
    Task<EngineResult> SetIntentAsync(string downloadId, bool run, CancellationToken cancellationToken);
    Task<EngineResult> SelectAsync(string downloadId, ImmutableArray<FileBinding> files, CancellationToken cancellationToken);
    Task<EngineDrainResult> DetachAsync(string downloadId, CancellationToken cancellationToken);
    Task<EngineFilingPermit> PrepareFilingAsync(EngineFilingRequest request, CancellationToken cancellationToken);
    Task<EngineFilingPermit> PrepareDeleteAsync(EngineDeleteRequest request, CancellationToken cancellationToken);
    Task<EngineResult> CompleteFilingAsync(EngineFilingPermit permit, bool published, CancellationToken cancellationToken);
    Task ApplyQueueAsync(EngineQueuePolicy policy, CancellationToken cancellationToken);
    Task UpdateSettingsAsync(EngineSettings settings, CancellationToken cancellationToken);
    Task<ImmutableArray<EngineEvent>> ReadEventsAsync(CancellationToken cancellationToken);
    Task<ImmutableArray<EngineSnapshot>> SnapshotAsync(CancellationToken cancellationToken);
    Task RecoverAsync(ImmutableArray<DownloadRow> downloads, ImmutableArray<DownloadFileRow> files, CancellationToken cancellationToken);
}

/// <summary>In: target/file mapping, roots and explicit import/delete confirmations. Out: final/partial bindings, verified inventory and bounded file operations. Never: torrent search/download, selection/ranking policy or Target state writes.</summary>
public interface ILibrary
{
    Task<ImmutableArray<OwnedItem>> OwnedAsync(TargetScope scope, CancellationToken cancellationToken);
    Task<PlacementResult> PlaceAsync(PlacementInput input, CancellationToken cancellationToken);
    Task<FilingResult> FileAsync(FilingRequest request, CancellationToken cancellationToken);
    Task<ScanResult> ScanAsync(ScanRequest request, CancellationToken cancellationToken);
    Task<FilingResult> ImportAsync(ImportCommand command, CancellationToken cancellationToken);
    Task<DeletionPlan> PreviewDeleteAsync(LibraryCommand command, CancellationToken cancellationToken);
    Task<FilingResult> ExecuteAsync(LibraryCommand command, CancellationToken cancellationToken);
    Task<FilingResult> AdvanceOperationAsync(FileOperationRow operation, FileExecutionProof proof,
        CancellationToken cancellationToken);
    Task<FilingResult> RecoverOperationsAsync(DateTimeOffset now, CancellationToken cancellationToken);
    Task<FolderResult> BrowseFoldersAsync(FolderQuery query, CancellationToken cancellationToken);
    Task<RecoveryResult> RecoveryAsync(RecoveryQuery query, CancellationToken cancellationToken);
    Task<UntrackedFilesResult> UntrackedFilesAsync(UntrackedFilesQuery query, CancellationToken cancellationToken);
    Task<UntrackedDeleteResult> PlanUntrackedDeleteAsync(UntrackedDeleteCommand command, CancellationToken cancellationToken);
    Task<BackfillEstimate> BackfillEstimateAsync(BackfillEstimateInput input, CancellationToken cancellationToken);
}

/// <summary>In: typed bounded row queries and owner-scoped CAS transactions. Out: immutable rows/atomic commit result. Never: network, filesystem effects, business decisions, IQueryable or EF entity leakage.</summary>
public interface IStore
{
    Task<ImmutableArray<TRow>> ReadAsync<TRow>(StoreQuery query, CancellationToken cancellationToken) where TRow : StoreRow;
    Task<CommitResult> CommitAsync(StoreCommit commit, CancellationToken cancellationToken);
}

/// <summary>In: authorized owner/request/rule actions, worker ticks and engine events. Out: accepted intent, one target state and read models. Never: duplicate search/ranking/file algorithms or persisted live progress.</summary>
public interface ITargets
{
    Task<AcceptedAction> AcceptAsync(TargetCommand command, CancellationToken cancellationToken);
    Task<AcceptedAction> AddRawAsync(RawAddCommand command, CancellationToken cancellationToken);
    Task<AcceptedAction> RequestAsync(RequestCommand command, CancellationToken cancellationToken);
    Task<SystemResult> SystemAsync(SystemCommand command, CancellationToken cancellationToken);
    Task<TargetReadModel> ReadAsync(TargetReadQuery query, CancellationToken cancellationToken);
    Task<ReleaseReadResult> ReleasesAsync(ReleaseReadQuery query, CancellationToken cancellationToken);
    Task<ReleaseReadResult> AlternativesAsync(ReleaseReadQuery query, CancellationToken cancellationToken);
    Task<ReleaseReadResult> PlanDryRunAsync(ReleaseReadQuery query, CancellationToken cancellationToken);
    Task<RawSearchResult> SearchRawAsync(RawSearchQuery query, CancellationToken cancellationToken);
    Task<FolderResult> BrowseFoldersAsync(FolderQuery query, CancellationToken cancellationToken);
    Task<RecoveryResult> RecoveryAsync(RecoveryQuery query, CancellationToken cancellationToken);
    Task<UntrackedFilesResult> UntrackedFilesAsync(UntrackedFilesQuery query, CancellationToken cancellationToken);
    Task<UntrackedDeleteResult> DeleteUntrackedAsync(UntrackedDeleteCommand command, CancellationToken cancellationToken);
    Task<BackfillEstimate> BackfillEstimateAsync(BackfillQuery query, CancellationToken cancellationToken);
    Task<FilingResult> LibraryAsync(LibraryCommand command, CancellationToken cancellationToken);
    Task<WorkerResult> TickAsync(WorkerTick tick, CancellationToken cancellationToken);
    Task ObserveAsync(ImmutableArray<EngineSnapshot> snapshots, CancellationToken cancellationToken);
    Task RecoverAsync(CancellationToken cancellationToken);
}

/// <summary>In: validated HTTP call and trusted actor. Out: unchanged captured HTTP status/JSON contract. Never: business decisions, direct SQL/EF, torrent/file logic or trusting caller-supplied role.</summary>
public interface IApi
{
    Task<ApiReply> HandleAsync(ApiCall call, CancellationToken cancellationToken);
}
