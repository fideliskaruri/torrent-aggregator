using System.Collections.Immutable;
using System.Text.Json;

namespace TorrentFlow.Domain;

public abstract record StoreRow(string Id);
public sealed record ProviderId(string Provider, string ExternalId, string? ProviderKind);
public sealed record LabelledName(string Value, NameLabel Label, string? LinkId, int Ordinal);
public sealed record MediaTrack(int Index, string Type, string? Language, string? Codec, int? Channels,
    string? Layout, bool? Default, bool? Forced);
public sealed record EpisodeCoordinate(int Season, int Episode, int? AbsoluteNumber);
public sealed record NumberRange(int First, int Last);
public sealed record Quality(int? Resolution, string? Source, string? Codec, string? Hdr);
public sealed record ParsedRelease(string RawName, string Title, int? Year, ImmutableArray<int> Seasons,
    ImmutableArray<int> Episodes, ImmutableArray<int> AbsoluteNumbers, ImmutableArray<NumberRange> Ranges,
    bool Pack, bool MultiSeason, string? SpecialType, Quality Quality, string? Group,
    ImmutableArray<string> LanguageMarkers, bool ClearlyForeign, bool Sample, bool Cam)
{
    public ReleaseKind Kind { get; init; } = ReleaseKind.Other;
    public ForeignStatus Foreign { get; init; } = ForeignStatus.Unknown;
    public bool Unsafe { get; init; }
    public ImmutableArray<NumberRange> EpisodeRanges { get; init; } = [];
    public ImmutableArray<NumberRange> AbsoluteRanges { get; init; } = [];
}
public sealed record TorrentFile(int Index, string RelativePath, long Bytes, long Offset);
public sealed record Rejection(string Hash, string? TargetId, string Code, string Explanation);

public sealed record WorkRow(string Id, string WorkKey, WorkKind Kind, WorkFormat Format, bool? Anime,
    int? Year, string? OriginalLanguage, int? RuntimeMinutes, string? PosterUrl, string? BackdropUrl,
    string? Synopsis, double? Rating, string? RatingSource, ImmutableArray<string> Genres,
    DateTimeOffset? TheatricalAt, DateTimeOffset? DigitalAt, DateTimeOffset? PhysicalAt,
    DatePrecision ReleasePrecision, string? ProviderStatus, string? NumberingVersion,
    DateTimeOffset? RefreshedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record WorkNameRow(string Id, string WorkId, string Value, string NormalizedValue,
    NameLabel Label, string? LinkId, int Ordinal, bool Authoritative, DateTimeOffset? RefreshedAt) : StoreRow(Id);
public sealed record WorkLinkRow(string Id, string WorkId, string Provider, string ExternalId,
    string? ProviderKind, string? SeasonId, string Source, string? MappingVersion, double Confidence,
    LinkStatus Status, bool IsPrimary, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt) : StoreRow(Id);
public sealed record SeasonRow(string Id, string WorkId, int Number, string? Title, string? Overview,
    string? PosterUrl, MappingStatus MappingStatus, string? ProviderEntryId, int? ExpectedEpisodeCount,
    DateTimeOffset? RefreshedAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record EpisodeRow(string Id, string SeasonId, int Number, int? AbsoluteNumber, string? Provider,
    string? ProviderEpisodeId, string? Title, string? Synopsis, string? StillUrl, DateTimeOffset? AirAt,
    DatePrecision AirPrecision, int? RuntimeMinutes, MappingStatus MappingStatus,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record MetadataCacheRow(string Id, CacheKind Kind, string CacheKey, JsonElement Payload,
    DateTimeOffset FetchedAt, DateTimeOffset ExpiresAt, string? Etag, string? LastModified,
    bool Complete, string? Provider) : StoreRow(Id);
public sealed record WorkPreferenceRow(string Id, string WorkId, int? ResolutionFloor, int? PreferredResolution,
    string? AudioLanguage, long? MaxBytesPerItem, string? StorageRootOverrideId,
    DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record TargetRow(string Id, string WorkId, string? EpisodeId, TargetKind Kind, TargetState State,
    TargetState? ResumeState, WaitReason? ReasonCode, string? ReasonText, DateTimeOffset? NextTryAt,
    DateTimeOffset? ExpectedAt, int? ResolutionFloor, int? PreferredResolution, string? AudioLanguage,
    long? MaxBytes, bool OwnerRanked, long Rank, DateTimeOffset? NowAt, string CreatedBy,
    IntentOrigin Origin, string? AutoRuleId, string? ChosenReleaseHash, string? ReplaceMediaFileId,
    ReplacementMode? ReplacementMode, string? BatchId, DateTimeOffset? ClickedAt,
    int SubstantiveMisses, DateTimeOffset? HelpNotifiedAt,
    long PolicyRevision, DateTimeOffset? LeaseUntil, string? LeaseToken,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id)
{
    public TargetPriority Priority { get; init; } = TargetPriority.BackCatalogue;
    public int? MinListedSeeders { get; init; }
    public string? PickedReleaseHash { get; init; }
}
public sealed record RequestScopeData(ImmutableArray<int> Seasons, bool FutureEpisodes);
public sealed record ScopeIntentRow(string Id, string ActorUserId, string WorkId, RequestScope Scope,
    RequestScopeData ScopeData, Policy Policy, bool Now, string BatchId, ScopeIntentState State,
    DateTimeOffset? NextTryAt, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record RawIntentRow(string Id, string ActorUserId, string ReleaseHash, string? DownloadId,
    ImmutableArray<int> SelectedFiles, string? RootId, string? ExplicitDirectory, LibraryKind? ExplicitKind,
    RawDownloadState State, RawDownloadState? ResumeState, WaitReason? ReasonCode, string? ReasonText,
    DateTimeOffset? NextTryAt, DateTimeOffset? NowAt, bool OwnerRanked, long Rank,
    DateTimeOffset? LeaseUntil, string? LeaseToken, string BatchId,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record RequestRow(string Id, string UserId, string WorkId, RequestScope Scope,
    RequestScopeData ScopeData, string? Note, RequestDecision Decision, string? DecisionReason,
    DateTimeOffset? DecidedAt, string? DecidedBy, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record RequestItemRow(string Id, string RequestId, string? EpisodeId, string? TargetId,
    ItemSettlement Settlement, DateTimeOffset? SettledAt, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt) : StoreRow(Id);
public sealed record AutoApproveRuleRow(string Id, string NormalizedEmail, AutoApproveMode Mode,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record FollowRow(string Id, string WorkId, bool Enabled, string? FromEpisodeId,
    DateTimeOffset NewEpisodesSince, DateTimeOffset? LastMaterializedAt,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record WatchItemRow(string Id, string UserId, string WorkId, WatchStatus Status, bool UpgradeWatch,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record UpgradeEvidenceRow(string Id, string WorkId, string? EpisodeId, string? CandidateHash,
    int? Resolution, DateTimeOffset CheckedAt, DateTimeOffset ExpiresAt) : StoreRow(Id);
public sealed record AutoRuleRow(string Id, string UserId, string Name, string Query, string Category,
    int MinListedSeeders, long? MaxBytes, int? ResolutionFloor, ImmutableArray<string> SourceIds,
    bool Enabled, DateTimeOffset? LastRunAt, string? LastMatchHash, int MatchCount,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record ReleaseRow(string Id, string Name, ParsedRelease Parsed, long? TotalBytes,
    string? TorrentUri, string? Magnet, ImmutableArray<TorrentFile>? Files, string? MetadataDigest,
    bool? Private, DateTimeOffset FirstSeenAt, DateTimeOffset LastSeenAt) : StoreRow(Id);
public sealed record ReleaseObservationRow(string Id, string Hash, string SourceId, string? SourceItemId,
    string Query, int? ListedSeeders, int? ListedLeechers, DateTimeOffset? UploadedAt,
    DateTimeOffset ObservedAt, string? TorrentUri, ImmutableArray<string> WebSeeds) : StoreRow(Id);
public sealed record VerdictRow(string Id, HealthBand Band, int ConnectedPeers, int ConnectedSeeders,
    long BytesDelivered, int SampleMilliseconds, int? ScrapedSeeders, string Reason,
    DateTimeOffset CheckedAt, DateTimeOffset ExpiresAt, int ProbeVersion) : StoreRow(Id)
{
    public int ByteSendingPeers { get; init; }
    public ProbePayloadMetrics? ProbeMetrics { get; init; }
}
public sealed record ProbePayloadMetrics(int? PieceLength, long VerifiedPieceBytes, int VerifiedPieces,
    int HashFailures, ImmutableDictionary<string, long> PeerBytesReceived);
public sealed record DecisionEvidence(long PolicyRevision, ImmutableArray<Rejection> Rejections,
    ImmutableArray<int> SelectedFiles, ImmutableArray<SourceResult> SourceErrors);
public sealed record SwapTargetBaseline(string TargetId, long CompletedBytes);
public sealed record SwapDecision(string OldDownloadId, ImmutableArray<string> ReplacementDownloadIds,
    ImmutableArray<string> TargetIds, long OldCompletedBytes,
    ImmutableArray<SwapTargetBaseline> TargetBaselines, DateTimeOffset? GoodSince,
    bool PartialsReleasedForDiskPressure);
public sealed record AttemptRow(string Id, string? TargetId, string? WorkId, string? ReleaseHash,
    string? ActorUserId, AttemptKind Kind, DateTimeOffset StartedAt, DateTimeOffset? EndedAt,
    string? Outcome, string? ReasonCode, string? ReasonText, DecisionEvidence? Decision,
    JsonElement? LegacyContext, string? BatchId, string? DownloadId,
    DateTimeOffset? DeadlineAt, SwapDecision? Swap) : StoreRow(Id);
public sealed record BlockRow(string Id, string Hash, string? WorkKey, string Reason, BlockOrigin Origin,
    string? ReplacedByHash, DateTimeOffset CreatedAt, DateTimeOffset? Until) : StoreRow(Id);
public sealed record SearchCachePayload(ImmutableArray<string> ReleaseHashes, SourceResult SourceResult)
{
    public bool FailureRetryAttempted { get; init; }
}
public sealed record SearchCacheRow(string Id, string NormalizedQuery, string ScopeKey, string SourceId,
    long SourceRevision, long CredentialRevision, int ParserVersion,
    SearchCachePayload Payload, bool Complete, DateTimeOffset CreatedAt, DateTimeOffset ExpiresAt) : StoreRow(Id);
public sealed record DownloadRow(string Id, string Hash, DownloadIntent Intent, string? RootId,
    DateTimeOffset AddedAt, DateTimeOffset? FinishedAt, string AdmissionToken,
    string? ResumeArtifact, string? RawIntentId, long Version) : StoreRow(Id);
public sealed record DownloadTargetRow(string Id, string DownloadId, string TargetId,
    AssociationRole Role, DateTimeOffset CreatedAt) : StoreRow(Id);
public sealed record DownloadFileRow(string Id, string DownloadId, int FileIndex, bool Selected,
    string? TargetId, string? PartialPath, string? FinalPath, string? PhysicalKey,
    string? MediaFileId, FileRole Role, long ExpectedBytes, string? EnginePath, bool Filed) : StoreRow(Id);
public sealed record LibraryFolders(string Movies, string TV, string Anime, string AnimeMovies);
public sealed record StorageRootRow(string Id, string Path, string PhysicalKey, ImmutableArray<LibraryKind> Kinds,
    LibraryFolders LibraryFolders, string VolumeSerial, int Priority, long ReserveBytes, long? MaxAllocatedBytes,
    bool Enabled, bool Online, bool ReviewRequired, DateTimeOffset? LastCheckedAt, string? LastError,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record WorkFolderRow(string Id, string WorkId, string? RootId, string? RelativeItemFolder,
    string? ExternalItemFolder,
    DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt, long Version) : StoreRow(Id);
public sealed record MediaFileRow(string Id, string WorkId, string? EpisodeId, string? RootId,
    string Path, string PhysicalKey, FileRole Role, string? ParentMediaFileId, long Bytes,
    DateTimeOffset MtimeUtc, int? Resolution, string? Source, string? Container, string? VideoCodec,
    string? VideoProfile, int? Width, int? Height, string? Hdr, double? RuntimeSeconds,
    long? BitrateBps, ImmutableArray<MediaTrack> Tracks, MediaOrigin Origin, string? DownloadId,
    int? FileIndex, DateTimeOffset AddedAt, DateTimeOffset? LastSeenAt, DateTimeOffset? MissingSince,
    FilePresence Status, DateTimeOffset? MissingConfirmedAt, DateTimeOffset? VerifiedAt,
    string? ContentDigest, long Version) : StoreRow(Id);
public sealed record FileOperationRow(string Id, FileOperationKind Kind, string? TargetId,
    string? DownloadId, string? MediaFileId, string? SourcePath, string? DestinationPath,
    long? ExpectedBytes, string? ExpectedDigest, FileOperationState State, bool DeleteSource,
    int Attempts, DateTimeOffset? NextTryAt, string? LastError, DateTimeOffset CreatedAt,
    DateTimeOffset UpdatedAt, string? LeaseToken, DateTimeOffset? LeaseUntil,
    FileOperationState? ResumeStage, string? EnginePermitToken) : StoreRow(Id);
public sealed record FilePathClaimRow(string Id, string OperationId, string PhysicalKey,
    DateTimeOffset CreatedAt) : StoreRow(Id);
public sealed record UserRow(string Id, string? NormalizedEmail, string? Name, string? Image,
    UserRole Role, DateTimeOffset CreatedAt, DateTimeOffset UpdatedAt) : StoreRow(Id);
public sealed record NotificationRow(string Id, string UserId, string Kind, string Title,
    string? Body, string? Link, string? DedupeKey, DateTimeOffset CreatedAt, DateTimeOffset? ReadAt,
    bool PushPending, DateTimeOffset? PushAttemptAt, int PushAttempts) : StoreRow(Id);
public sealed record PushSubscriptionRow(string Id, string UserId, string Endpoint, string P256dh,
    string Auth, DateTimeOffset CreatedAt) : StoreRow(Id);
public sealed record SettingRow(string Id, int SchemaVersion, JsonElement Value,
    long Revision, DateTimeOffset UpdatedAt) : StoreRow(Id);

public sealed record WorkSnapshot(WorkRow Work, ImmutableArray<WorkNameRow> Names,
    ImmutableArray<WorkLinkRow> Links, ImmutableArray<SeasonRow> Seasons,
    ImmutableArray<EpisodeRow> Episodes)
{
    public DateTimeOffset? PremiereAt { get; init; }
    public string? ProviderFormat { get; init; }
    public bool? InTheatricalWindow { get; init; }
}
public sealed record Actor(string UserId, UserRole Role, bool TrustedLocal, bool Container);
public sealed record Failure(string Code, string Message, DateTimeOffset? RetryAt, bool NeedsOwner);
public sealed record Policy(int? ResolutionFloor, int? PreferredResolution, string? AudioLanguage,
    long? MaxBytes, string? RootOverrideId, long Revision);
public sealed record TargetScope(string WorkId, ImmutableArray<string> EpisodeIds, bool Film);
public sealed record OwnedItem(string WorkId, string? EpisodeId, ImmutableArray<MediaFileRow> Videos);
public sealed record MetadataQuery(ProviderId? Identity, string? Title, int? Year, WorkKind Kind);
public sealed record MetadataResult(WorkSnapshot? Work, Failure? Failure, bool Complete, bool Stale);
public sealed record CatalogQuery(string Query, string Category, int Limit);
public sealed record CatalogResult(ImmutableArray<WorkSnapshot> Works, bool Partial, bool Stale,
    ImmutableArray<string> FailedProviders);
public sealed record BrowseQuery(string Type, string? Genre, string? UserId);
public sealed record BrowseRail(string Id, string Title, ImmutableArray<WorkSnapshot> Works);
public sealed record BrowseResult(ImmutableArray<BrowseRail> Rails, bool Stale);
public sealed record MetadataExtras(WorkSnapshot Work, string? SeasonId,
    ImmutableArray<WorkSnapshot> Similar, WorkSnapshot? PartOf, int? VoteCount,
    string? Certification, bool Resolved, bool InTheatricalWindow,
    DateTimeOffset? NextHomeReleaseAt, DateTimeOffset GeneratedAt);
public sealed record LinkCommand(string WorkId, string LinkId, bool Reject, long ExpectedWorkVersion);
public sealed record RawRelease(string Name, string Hash, long? Bytes, int? ListedSeeders,
    int? ListedLeechers, string SourceId, string? SourceItemId, string? Magnet, string? TorrentUri,
    DateTimeOffset? UploadedAt, ImmutableArray<string> WebSeeds);
public sealed record SourceQuery(string Query, string Category, ProviderId? Identity,
    PriorityLane Lane, int Limit, DateTimeOffset DeadlineAt, long SourceRevision, long CredentialRevision)
{
    public string? FlightId { get; init; }
    [System.Text.Json.Serialization.JsonIgnore]
    public SourceRequestBudget? RequestBudget { get; init; }
}
public sealed record SourceResult(string SourceId, SourceOutcome Outcome, ImmutableArray<RawRelease> Results,
    DateTimeOffset? RetryAt, string? Error, TimeSpan Elapsed)
{
    public bool Complete { get; init; } = Outcome == SourceOutcome.Success;
    public SourceDiagnostics? Diagnostics { get; init; }
    public DateTimeOffset? CacheExpiresAt { get; init; }
}
public sealed record SourceDiagnostics(string Code, TimeSpan QueueWait, int Requests,
    int? HttpStatus, DateTimeOffset? StartedAt, int Returned, bool Truncated)
{
    public TimeSpan UpstreamElapsed { get; init; }
}
public sealed record Candidate(ReleaseRow Release, ImmutableArray<ReleaseObservationRow> Observations,
    int? ConservativeListedSeeders)
{
    public ImmutableArray<string> CoveredEpisodeIds { get; init; } = [];
    public bool CoversFilm { get; init; }
    public int? ScrapedSeeders { get; init; }
    public int? TrustedSeeders => ScrapedSeeders ?? ConservativeListedSeeders;
}
public sealed record SearchRequest(string SessionId, WorkSnapshot Work, TargetScope Scope,
    Policy Policy, PriorityLane Lane, SearchNamePhase NamePhase, ImmutableArray<string> SourceIds,
    long SourceRevision, long CredentialRevision)
{
    public bool ProvisionalGood { get; init; }
    public bool Exhaust { get; init; }
}
public sealed record SearchFeedback(long PoolRevision, ImmutableArray<string> CoveredEpisodeIds,
    bool FilmCovered, bool Stop, bool NeedFallbackTier)
{
    public bool HasHealthyRelease { get; init; }
    public ImmutableDictionary<string, int> ScrapedSeeders { get; init; } = ImmutableDictionary<string, int>.Empty;
}
public sealed record FindRejection(string Hash, string Name, string SourceId, string Query,
    string Code, string Explanation);
public sealed record FindQueryTrace(string Query, string SourceId, SearchNamePhase NamePhase,
    SourceTier Tier, bool CacheHit, bool SharedInFlight, SourceResult Result);
public sealed record CandidateBatch(string SessionId, long PoolRevision, ImmutableArray<Candidate> Candidates,
    ImmutableArray<SourceResult> Sources, bool Complete, SearchNamePhase NamePhase, SourceTier Tier)
{
    public bool TierComplete { get; init; }
    public ImmutableArray<FindRejection> Rejections { get; init; } = [];
    public ImmutableArray<FindQueryTrace> Queries { get; init; } = [];
    public TimeSpan? FirstCandidateAt { get; init; }
    public TimeSpan Elapsed { get; init; }
    public bool EarlyStopped { get; init; }
    public bool EnglishLabelMissing { get; init; }
    public bool ProvisionalStopped { get; init; }
    public bool CachedPool { get; init; }
    public int SourceRequests { get; init; }
    public int WindowSourceRequests { get; init; }
    public int RequestLimit { get; init; }
    public bool RequestBudgetExhausted { get; init; }
}
public sealed record ProbeRequest(Candidate Candidate, PriorityLane Lane, bool ForceFresh, bool WantedTarget)
{
    public bool RetainAdmission { get; init; }
}
public sealed record SwarmEvidence(string Hash, HealthBand Band, ImmutableArray<TorrentFile>? Files,
    int ConnectedPeers, int ConnectedSeeders, int ByteSendingPeers, long BytesDelivered,
    TimeSpan Window, int? ScrapedSeeders, string Reason, DateTimeOffset CheckedAt,
    DateTimeOffset ExpiresAt, bool FromLiveTransfer, bool Persistable, ProbeHandle? AdmissionHandle)
{
    public bool PeersPresentThroughoutWindow { get; init; }
    public TimeSpan QueueWait { get; init; }
    public bool FromCache { get; init; }
    public int ProbeVersion { get; init; }
    public int? PieceLength { get; init; }
    public long BlockBytesReceived => BytesDelivered;
    public long VerifiedPieceBytes { get; init; }
    public int VerifiedPieces { get; init; }
    public int HashFailures { get; init; }
    public bool PieceVerified => VerifiedPieces > 0;
    public ImmutableDictionary<string, long> PeerBytesReceived { get; init; } = ImmutableDictionary<string, long>.Empty;
}
public sealed record SelectedFile(string? TargetId, int FileIndex, FileRole Role);
public sealed record Assignment(string Hash, ImmutableArray<string> TargetIds,
    ImmutableArray<SelectedFile> Files, long ReservedPieceBytes, string Reason);
public sealed record PlanInput(WorkSnapshot? Work, AcquisitionMode Mode, ImmutableArray<int> OwnerSelectedFiles,
    ImmutableArray<TargetRow> Targets,
    ImmutableArray<Candidate> Pool, ImmutableArray<SwarmEvidence> Evidence,
    ImmutableArray<OwnedItem> Owned, ImmutableArray<BlockRow> Blocks, DateTimeOffset Now)
{
    public string? UnknownFallbackReason { get; init; }
    public bool QueriesExhausted { get; init; }
    public WorkPreferenceRow? Preference { get; init; }
    public ImmutableArray<PlanFileMetadata> FileMetadata { get; init; } = [];
}
public sealed record PlanResult(ImmutableArray<Assignment> Assignments, ImmutableArray<Rejection> Rejections,
    ImmutableArray<string> UncoveredTargetIds);
public sealed record EngineFileSnapshot(int Index, long Bytes, long CompletedBytes, long AllocatedBytes,
    bool Selected, string? PhysicalPath, bool AllTouchingPiecesComplete);
public sealed record EngineSnapshot(string DownloadId, string Hash, bool MetadataAvailable,
    bool Attached, bool Complete, bool StalledMetadata, bool StalledProgress,
    long SelectedBytes, long CompletedSelectedBytes, long BytesPerSecond, int Peers, int Seeders,
    ImmutableArray<EngineFileSnapshot> Files, DateTimeOffset ObservedAt, Failure? Failure)
{
    public bool Active { get; init; }
    public DownloadIntent Intent { get; init; }
    public TimeSpan? Eta { get; init; }
    public long UploadedBytes { get; init; }
}
public sealed record ProbeHandle(string Token, string Hash, bool CreatedByProbe, bool ObservesLiveTransfer,
    DateTimeOffset ExpiresAt);
public sealed record ProbeAttachment(ProbeHandle? Handle, ImmutableArray<TorrentFile>? Files, Failure? Failure);
public sealed record FileBinding(int FileIndex, string AbsolutePath, bool Selected);
public sealed record EngineAdmission(DownloadRow Download, Candidate Candidate,
    ImmutableArray<FileBinding> Files, string AdmissionToken);
public sealed record EngineAdmissionClaim(string Token, string Hash, string DownloadId,
    ProbeHandle? FromProbe, DateTimeOffset ExpiresAt)
{
    public string? SharedSlotDownloadId { get; init; }
}
public sealed record EngineResult(bool Accepted, EngineSnapshot? Snapshot, Failure? Failure);
public sealed record QueueAdmission(string DownloadId, bool Run);
public sealed record EngineQueuePolicy(ImmutableArray<QueueAdmission> Admissions)
{
    // Optional caller-computed ordering. Targets still owns eligibility and durable intent.
    public ImmutableArray<EngineQueueOrder> Order { get; init; } = [];
    public int? MaximumActive { get; init; }
}
public sealed record EngineQueueOrder(string DownloadId, long Rank, TargetPriority Priority, bool Now, bool Eligible);
public sealed record EngineEvent(string DownloadId, string Hash, string Kind, EngineSnapshot Snapshot);
public sealed record EngineFilingRequest(string OperationId, string DownloadId, ImmutableArray<FileBinding> FinalBindings);
public sealed record EngineDeleteRequest(string OperationId, string DownloadId,
    ImmutableArray<int> FileIndices, ImmutableArray<FileBinding> UnwantedBindings);
public sealed record EngineFilingPermit(string Token, string DownloadId, ImmutableArray<int> FileIndices,
    bool Detached, Failure? Failure);
public sealed record EngineDrainResult(string DownloadId, bool Detached, bool WritesDrained, Failure? Failure);
public sealed record FileExecutionProof(EngineFilingPermit? FilingPermit, EngineDrainResult? Drain);
public sealed record MetadataWaitRequest(string TargetId, Candidate Candidate, DateTimeOffset DeadlineAt);
public sealed record MetadataWaitAttachment(ProbeHandle? Handle, string TargetId, string Hash,
    DateTimeOffset DeadlineAt, ImmutableArray<TorrentFile>? Files, Failure? Failure);
public sealed record DownloadWindow(ImmutableArray<DayOfWeek> Days, TimeOnly Start, TimeOnly End,
    int? DownloadBytesPerSecond, int? UploadBytesPerSecond);
public sealed record PlacementInput(WorkSnapshot? Work, ImmutableArray<TargetRow> Targets, Assignment Assignment,
    ImmutableArray<TorrentFile> Files, ImmutableArray<StorageRootRow> Roots,
    ImmutableArray<OwnedItem> Owned, string? ExplicitRootId, string? ExplicitDirectory, LibraryKind? ExplicitKind);
public sealed record PlacementResult(ImmutableArray<DownloadFileRow> Files, string? RootId,
    long ReservedBytes, ImmutableArray<WorkFolderRow> Folders, Failure? Failure);
public sealed record FilingRequest(string DownloadId, ImmutableArray<EngineFileSnapshot> Files,
    EngineFilingPermit? Permit, bool RawImportReview);
public sealed record LibraryChanges(ImmutableArray<MediaFileRow> Media,
    ImmutableArray<DownloadFileRow> DownloadFiles, ImmutableArray<StorageRootRow> Roots,
    ImmutableArray<WorkFolderRow> Folders, ImmutableArray<FileOperationRow> Operations,
    ImmutableArray<FilePathClaimRow> PathClaims, ImmutableArray<string> ReleasedPathClaimIds);
public sealed record FilingResult(LibraryChanges Changes, ImmutableArray<string> CompletedTargetIds,
    Failure? Failure);
public sealed record ScanRequest(ImmutableArray<string> RootIds, string? ExternalFolder);
public sealed record ImportProposal(string Token, string Path, string? WorkId, string? EpisodeId,
    ImportConfidence Confidence, ImmutableArray<string> Sidecars, Failure? Failure);
public sealed record ScanResult(ImmutableArray<ImportProposal> Proposals, LibraryChanges Changes,
    ImmutableArray<string> InaccessiblePaths, bool Complete, ImmutableArray<RootScanEvidence> Roots);
public sealed record RootScanEvidence(string RootId, bool MarkerMatches, bool VolumeMatches,
    int PreviouslyPresentFiles, int VanishedFiles, bool MassVanish, DateTimeOffset ScannedAt);
public sealed record ImportCommand(string Token, ImportMode Mode, string WorkId, string? EpisodeId,
    string? RootId, bool Confirmed);
public sealed record DeletionPlan(string Token, ImmutableArray<string> MediaFileIds,
    ImmutableArray<string> DownloadFileIds, ImmutableArray<string> Paths, long Bytes,
    ImmutableArray<string> ProtectedPaths);
public sealed record LibraryCommand(LibraryAction Action, Actor Actor, string? WorkId,
    ImmutableArray<string> EpisodeIds, string? Token, string? Path, string? RootId,
    bool Confirmed, bool DeleteFiles);
public sealed record TargetCommand(string IdempotencyKey, TargetAction Action, Actor Actor,
    TargetScope Scope, Policy Policy, ImmutableArray<string> TargetIds, long? Rank,
    string? ChoiceToken, bool DeleteFiles, long? ExpectedVersion);
public sealed record RawAddCommand(string IdempotencyKey, Actor Actor, RawRelease Release,
    ImmutableArray<int> SelectedFiles, string? RootId, string? ExplicitDirectory,
    LibraryKind? ExplicitKind, bool Now);
public sealed record RequestCommand(string IdempotencyKey, RequestAction Action, Actor Actor,
    string? RequestId, TargetScope Scope, RequestScope RequestScope, bool FutureEpisodes,
    Policy Policy, string? Note, string? ChoiceToken, long? ExpectedVersion);
public sealed record AcceptedAction(string BatchId, int Queued, int Owned, int Unresolved,
    ImmutableArray<string> TargetIds, Failure? Failure);
public sealed record SystemCommand(SystemArea Area, SystemAction Action, Actor Actor,
    string? Id, string? Section, long? ExpectedRevision, JsonElement? Payload);
public sealed record SystemResult(JsonElement Payload, Failure? Failure);
public sealed record TargetReadQuery(Actor Actor, string? WorkId, string? RequestId,
    ImmutableArray<string> TargetIds, bool IncludeRemoved);
public sealed record TargetReadModel(ImmutableArray<TargetRow> Targets, ImmutableArray<DownloadRow> Downloads,
    ImmutableArray<DownloadTargetRow> Associations, ImmutableArray<DownloadFileRow> DownloadFiles,
    ImmutableArray<MediaFileRow> MediaFiles, ImmutableArray<RequestRow> Requests,
    ImmutableArray<RequestItemRow> RequestItems, ImmutableArray<EngineSnapshot> Live,
    ImmutableArray<RawIntentRow> RawIntents, ImmutableArray<UpgradeEvidenceRow> UpgradeEvidence,
    ImmutableArray<QueuedTransferProjection> QueuedTransfers);
public sealed record QueuedTransferProjection(string Id, string Hash, string TargetId, WaitReason Reason,
    DateTimeOffset? NextTryAt);
public sealed record ReleaseReadQuery(Actor Actor, TargetScope Scope, Policy Policy,
    string? CurrentHash, string? SourceId);
public sealed record ChoiceToken(string Token, string Hash, DateTimeOffset ExpiresAt);
public sealed record ReleaseReadResult(ImmutableArray<Candidate> Pool, ImmutableArray<SwarmEvidence> Verdicts,
    PlanResult Plan, ImmutableArray<ChoiceToken> Choices, Failure? Failure);
public sealed record RawSearchFilters(int? MinSeeders, int? MaxSeeders, long? MinBytes, long? MaxBytes,
    int? Season, int? Episode, string? Resolution, string? Codec, string? ReleaseKind, bool? HasMagnet);
public sealed record RawSearchQuery(Actor Actor, string Query, string Category,
    ImmutableArray<string> SourceIds, int Page, int PageSize, int? Limit,
    bool Enrich, bool Refresh, RawSearchFilters Filters);
public sealed record SourceDescriptor(string Id, string Name, ImmutableArray<string> Categories);
public sealed record RawSearchResult(ImmutableArray<Candidate> Pool, ImmutableArray<SourceResult> Sources,
    ImmutableArray<SourceDescriptor> AvailableSources, long Total, int Page, int PageSize, Failure? Failure);
public sealed record FolderQuery(Actor Actor, string? Path);
public sealed record FolderEntry(string Name, string Path, bool Accessible);
public sealed record FolderResult(string Path, string? Parent, ImmutableArray<FolderEntry> Entries, Failure? Failure);
public sealed record RecoveryQuery(Actor Actor, bool IncludeExternalSources);
public sealed record RecoverySource(string Id, string ClientType, string Path, int Files, Failure? Failure);
public sealed record RecoveryResult(string DataDirectory, string? DownloadDirectory, bool HasMedia,
    ImmutableArray<DownloadRow> Downloads,
    ImmutableArray<RecoverySource> Sources, Failure? Failure);
public sealed record UntrackedFilesQuery(Actor Actor, string? RootId, string? Path);
public sealed record UntrackedFilesResult(ImmutableArray<ImportProposal> Files, bool Complete, Failure? Failure);
public sealed record UntrackedDeleteCommand(Actor Actor, string RelativePath);
public sealed record UntrackedDeleteResult(LibraryChanges Changes, bool Removed, long FreedBytes,
    int FreedFiles, Failure? Failure);
public sealed record BackfillQuery(Actor Actor, string? WatchListItemId, double? FromSeason,
    double? ToSeason, double? EpisodesPerSeason, double? AverageEpisodeGb);
public sealed record BackfillEstimateInput(BackfillQuery Query, string Title, double FromSeason,
    string? RootId);
public sealed record BackfillEstimate(string Title, double FromSeason, double ToSeason, double Seasons,
    double Episodes, double EstimatedBytes, long? FreeBytes, bool CanFit,
    string Message, string? Note, Failure? Failure);
public sealed record WorkerTick(DateTimeOffset Now, int MaxScopes);
public sealed record WorkerResult(int Claimed, int Settled, DateTimeOffset? NextDueAt);
public sealed record StoreQuery(string? Id, string? WorkId, string? TargetId, string? DownloadId,
    string? UserId, string? Hash, string? NormalizedQuery, string? SeasonId, string? RequestId,
    string? RootId, string? SourceId, DateTimeOffset? DueAt,
    DateTimeOffset? Before, string? Cursor, int Limit, StoreOrder Order);
public sealed record RowWrite(StoreRow Row, long? ExpectedVersion, StoreRow? ExpectedRow);
public sealed record RowDelete(StoreTable Table, string Id, long? ExpectedVersion, StoreRow? ExpectedRow);
public sealed record StoreCommit(string IdempotencyKey, StoreOwner Owner, ImmutableArray<RowWrite> Writes,
    ImmutableArray<RowDelete> Deletes)
{
    public LibraryWriteProposal? LibraryProposal { get; init; }
}
public sealed record CommitResult(bool Applied, bool Conflict, ImmutableArray<string> ConflictingIds);
public sealed record ApiCall(string Method, string RoutePattern, ImmutableDictionary<string, string> RouteValues,
    ImmutableDictionary<string, string> Query, JsonElement? Body, Actor Actor);
public sealed record ApiReply(int StatusCode, string ContentType, JsonElement Body);

public sealed record SecretReference(string FileId, long Revision);
public sealed record EngineSettings(int ListenPort, int MaxActiveDownloads, int GlobalPeers, int PerTorrentPeers,
    int HalfOpenConnections, int ProbePeers, long DiskCacheBytes, int OpenFiles,
    bool Dht, bool Pex, bool LocalDiscovery, bool Upnp, bool SetupComplete,
    ProbeScope ProbeScope, ImmutableArray<DownloadWindow> Windows, string TimeZoneId,
    int CheckWindowSeconds, long GoodBytes, long GoodBytesPerSecond,
    int MetadataStallSeconds, int ProgressStallSeconds, long ProgressStallBytes,
    ImmutableArray<string> Trackers, bool VerboseDiagnostics, ExternalClientSettings? ExternalClient);
public sealed record ExternalClientSettings(string Type, string Host, string? Username,
    SecretReference? Password, bool ControlEnabled);
public sealed record SourceSettings(string Id, bool Enabled, SourceTier Tier, int Priority, string Kind,
    string Type, string? BaseUrl, ImmutableArray<string> Mirrors, ImmutableArray<string> Categories,
    int TimeoutMilliseconds, int Concurrency, int StartSpacingMilliseconds,
    ImmutableDictionary<string, string> Options, SecretReference? Credential);
public sealed record MetadataSettings(SecretReference? TmdbCredential, string? FribbUrl,
    ImmutableArray<string> EnabledProviders)
{
    public ImmutableArray<SourceSettings> Sources { get; init; } = [];
}
public sealed record RemoteAccessSettings(bool Enabled, int TunnelPort, string? TeamDomain, string? Audience,
    ImmutableArray<string> OwnerEmails, bool AllowRequesters, string TunnelBindAddress = "127.0.0.1");
public sealed partial record DesktopSettings(bool StartWithWindows, bool CheckForUpdates,
    DateTimeOffset? LastCheckedAt, string? AvailableVersion);
public sealed record QualitySettings(int? PreferredResolution, string? AudioLanguage, long? MaxBytesPerItem);
public sealed record RequestSettings(AutoApproveMode AutoApproveMode, int MaxOpenPerRequester);
public sealed record SchedulerSettings(bool Enabled, int IntervalMinutes, int ActiveScopes,
    int BackgroundScopes, int BackgroundAdapters, int ProbeConcurrency, int BackgroundProbes,
    bool FirstFullRootScanComplete, bool ImportReviewComplete);
public sealed record JellyfinSettings(string? ServerUrl, SecretReference? Credential, string? UserId);
