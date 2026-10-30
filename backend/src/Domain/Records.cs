using System.Collections.Immutable;
using System.Text.Json;

namespace TorrentFlow.Domain;

public abstract record StoreRow
{
    public required string Id { get; init; }
}
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
    public bool ThreeDigitSceneEpisode { get; init; }
    public ImmutableArray<NumberRange> EpisodeRanges { get; init; } = [];
    public ImmutableArray<NumberRange> AbsoluteRanges { get; init; } = [];
}
public sealed record TorrentFile(int Index, string RelativePath, long Bytes, long Offset);
public sealed record Rejection(string Hash, string? TargetId, string Code, string Explanation);

public sealed record WorkRow : StoreRow
{
    public required string WorkKey { get; init; }
    public required WorkKind Kind { get; init; }
    public required WorkFormat Format { get; init; }
    public bool? Anime { get; init; }
    public int? Year { get; init; }
    public string? OriginalLanguage { get; init; }
    public int? RuntimeMinutes { get; init; }
    public string? PosterUrl { get; init; }
    public string? BackdropUrl { get; init; }
    public string? Synopsis { get; init; }
    public double? Rating { get; init; }
    public string? RatingSource { get; init; }
    public required ImmutableArray<string> Genres { get; init; }
    public DateTimeOffset? TheatricalAt { get; init; }
    public DateTimeOffset? DigitalAt { get; init; }
    public DateTimeOffset? PhysicalAt { get; init; }
    public required DatePrecision ReleasePrecision { get; init; }
    public string? ProviderStatus { get; init; }
    public string? NumberingVersion { get; init; }
    public DateTimeOffset? RefreshedAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record WorkNameRow : StoreRow
{
    public required string WorkId { get; init; }
    public required string Value { get; init; }
    public required string NormalizedValue { get; init; }
    public required NameLabel Label { get; init; }
    public string? LinkId { get; init; }
    public required int Ordinal { get; init; }
    public required bool Authoritative { get; init; }
    public DateTimeOffset? RefreshedAt { get; init; }
}
public sealed record WorkLinkRow : StoreRow
{
    public required string WorkId { get; init; }
    public required string Provider { get; init; }
    public required string ExternalId { get; init; }
    public string? ProviderKind { get; init; }
    public string? SeasonId { get; init; }
    public required string Source { get; init; }
    public string? MappingVersion { get; init; }
    public required double Confidence { get; init; }
    public required LinkStatus Status { get; init; }
    public required bool IsPrimary { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
}
public sealed record SeasonRow : StoreRow
{
    public required string WorkId { get; init; }
    public required int Number { get; init; }
    public string? Title { get; init; }
    public string? Overview { get; init; }
    public string? PosterUrl { get; init; }
    public required MappingStatus MappingStatus { get; init; }
    public string? ProviderEntryId { get; init; }
    public int? ExpectedEpisodeCount { get; init; }
    public DateTimeOffset? RefreshedAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record EpisodeRow : StoreRow
{
    public required string SeasonId { get; init; }
    public required int Number { get; init; }
    public int? AbsoluteNumber { get; init; }
    public string? Provider { get; init; }
    public string? ProviderEpisodeId { get; init; }
    public string? Title { get; init; }
    public string? Synopsis { get; init; }
    public string? StillUrl { get; init; }
    public DateTimeOffset? AirAt { get; init; }
    public required DatePrecision AirPrecision { get; init; }
    public int? RuntimeMinutes { get; init; }
    public required MappingStatus MappingStatus { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record MetadataCacheRow : StoreRow
{
    public required CacheKind Kind { get; init; }
    public required string CacheKey { get; init; }
    public required JsonElement Payload { get; init; }
    public required DateTimeOffset FetchedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public string? Etag { get; init; }
    public string? LastModified { get; init; }
    public required bool Complete { get; init; }
    public string? Provider { get; init; }
}
public sealed record WorkPreferenceRow : StoreRow
{
    public required string WorkId { get; init; }
    public int? ResolutionFloor { get; init; }
    public int? PreferredResolution { get; init; }
    public long? MaxBytesPerItem { get; init; }
    public string? StorageRootOverrideId { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record TargetRow : StoreRow
{
    public required string WorkId { get; init; }
    public string? EpisodeId { get; init; }
    public required TargetKind Kind { get; init; }
    public required TargetState State { get; init; }
    public TargetState? ResumeState { get; init; }
    public WaitReason? ReasonCode { get; init; }
    public string? ReasonText { get; init; }
    public DateTimeOffset? NextTryAt { get; init; }
    public DateTimeOffset? ExpectedAt { get; init; }
    public int? ResolutionFloor { get; init; }
    public int? PreferredResolution { get; init; }
    public long? MaxBytes { get; init; }
    public required bool DownloadNow { get; init; }
    public required string CreatedBy { get; init; }
    public required IntentOrigin Origin { get; init; }
    public string? AutoRuleId { get; init; }
    public string? ChosenReleaseHash { get; init; }
    public string? ReplaceMediaFileId { get; init; }
    public ReplacementMode? ReplacementMode { get; init; }
    public string? BatchId { get; init; }
    public DateTimeOffset? ClickedAt { get; init; }
    public required int SubstantiveMisses { get; init; }
    public DateTimeOffset? HelpNotifiedAt { get; init; }
    public DateTimeOffset? LeaseUntil { get; init; }
    public string? LeaseToken { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
    public int? MinListedSeeders { get; init; }
    public string? PickedReleaseHash { get; init; }

}
public static class TargetRowExtensions
{
    public static bool IsPaused(this TargetRow row) =>
        row.State == TargetState.Waiting && row.ReasonCode == WaitReason.Paused;
}
public sealed record RequestScopeData(ImmutableArray<int> Seasons, bool FutureEpisodes);
public sealed record ScopeIntentRow : StoreRow
{
    public required string ActorUserId { get; init; }
    public required string WorkId { get; init; }
    public int? Episode { get; init; }
    public required RequestScope Scope { get; init; }
    public required RequestScopeData ScopeData { get; init; }
    public required Policy Policy { get; init; }
    public required bool Now { get; init; }
    public required string BatchId { get; init; }
    public required ScopeIntentState State { get; init; }
    public DateTimeOffset? NextTryAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record RawIntentRow : StoreRow
{
    public required string ActorUserId { get; init; }
    public required string ReleaseHash { get; init; }
    public string? DownloadId { get; init; }
    public required ImmutableArray<int> SelectedFiles { get; init; }
    public string? ExplicitDirectory { get; init; }
    public required RawDownloadState State { get; init; }
    public DateTimeOffset? NowAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record RequestRow : StoreRow
{
    public required string UserId { get; init; }
    public required string WorkId { get; init; }
    public required RequestScope Scope { get; init; }
    public required RequestScopeData ScopeData { get; init; }
    public string? Note { get; init; }
    public required RequestDecision Decision { get; init; }
    public string? DecisionReason { get; init; }
    public DateTimeOffset? DecidedAt { get; init; }
    public string? DecidedBy { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record RequestItemRow : StoreRow
{
    public required string RequestId { get; init; }
    public string? EpisodeId { get; init; }
    public string? TargetId { get; init; }
    public required ItemSettlement Settlement { get; init; }
    public DateTimeOffset? SettledAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
}
public sealed record FollowRow : StoreRow
{
    public required string WorkId { get; init; }
    public required bool Enabled { get; init; }
    public string? FromEpisodeId { get; init; }
    public required DateTimeOffset NewEpisodesSince { get; init; }
    public DateTimeOffset? LastMaterializedAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record WatchItemRow : StoreRow
{
    public required string UserId { get; init; }
    public required string WorkId { get; init; }
    public required WatchStatus Status { get; init; }
    public required bool UpgradeWatch { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record AutoRuleRow : StoreRow
{
    public required string UserId { get; init; }
    public required string Name { get; init; }
    public required string Query { get; init; }
    public required string Category { get; init; }
    public required int MinListedSeeders { get; init; }
    public long? MaxBytes { get; init; }
    public int? ResolutionFloor { get; init; }
    public required ImmutableArray<string> SourceIds { get; init; }
    public required bool Enabled { get; init; }
    public DateTimeOffset? LastRunAt { get; init; }
    public string? LastMatchHash { get; init; }
    public required int MatchCount { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record ReleaseRow : StoreRow
{
    public required string Name { get; init; }
    public required ParsedRelease Parsed { get; init; }
    public long? TotalBytes { get; init; }
    public string? TorrentUri { get; init; }
    public string? Magnet { get; init; }
    public ImmutableArray<TorrentFile>? Files { get; init; }
    public string? MetadataDigest { get; init; }
    public bool? Private { get; init; }
    public required DateTimeOffset FirstSeenAt { get; init; }
    public required DateTimeOffset LastSeenAt { get; init; }
}
public sealed record ReleaseObservationRow : StoreRow
{
    public required string Hash { get; init; }
    public required string SourceId { get; init; }
    public string? SourceItemId { get; init; }
    public required string Query { get; init; }
    public int? ListedSeeders { get; init; }
    public int? ListedLeechers { get; init; }
    public DateTimeOffset? UploadedAt { get; init; }
    public required DateTimeOffset ObservedAt { get; init; }
    public string? TorrentUri { get; init; }
    public required ImmutableArray<string> WebSeeds { get; init; }
}
public sealed record VerdictRow : StoreRow
{
    public required HealthBand Band { get; init; }
    public required int ConnectedPeers { get; init; }
    public required int ConnectedSeeders { get; init; }
    public required long BytesDelivered { get; init; }
    public required int SampleMilliseconds { get; init; }
    public int? ScrapedSeeders { get; init; }
    public required string Reason { get; init; }
    public required DateTimeOffset CheckedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
    public required int ProbeVersion { get; init; }
    public int ByteSendingPeers { get; init; }
    public ProbePayloadMetrics? ProbeMetrics { get; init; }

}
public sealed record ProbePayloadMetrics(int? PieceLength, long VerifiedPieceBytes, int VerifiedPieces,
    int HashFailures, ImmutableDictionary<string, long> PeerBytesReceived);
public sealed record DecisionEvidence(ImmutableArray<Rejection> Rejections,
    ImmutableArray<int> SelectedFiles, ImmutableArray<SourceResult> SourceErrors);
public sealed record SwapTargetBaseline(string TargetId, long CompletedBytes);
public sealed record SwapDecision(string OldDownloadId, ImmutableArray<string> ReplacementDownloadIds,
    ImmutableArray<string> TargetIds, long OldCompletedBytes,
    ImmutableArray<SwapTargetBaseline> TargetBaselines, DateTimeOffset? GoodSince,
    bool PartialsReleasedForDiskPressure);
public sealed record AttemptRow : StoreRow
{
    public string? TargetId { get; init; }
    public string? WorkId { get; init; }
    public string? ReleaseHash { get; init; }
    public string? ActorUserId { get; init; }
    public required AttemptKind Kind { get; init; }
    public required DateTimeOffset StartedAt { get; init; }
    public DateTimeOffset? EndedAt { get; init; }
    public string? Outcome { get; init; }
    public string? ReasonCode { get; init; }
    public string? ReasonText { get; init; }
    public DecisionEvidence? Decision { get; init; }
    public JsonElement? LegacyContext { get; init; }
    public string? BatchId { get; init; }
    public string? DownloadId { get; init; }
    public DateTimeOffset? DeadlineAt { get; init; }
    public SwapDecision? Swap { get; init; }
}
public sealed record BlockRow : StoreRow
{
    public required string Hash { get; init; }
    public string? WorkKey { get; init; }
    public required string Reason { get; init; }
    public required BlockOrigin Origin { get; init; }
    public string? ReplacedByHash { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? Until { get; init; }
}
public sealed record SearchCachePayload(ImmutableArray<string> ReleaseHashes, SourceResult SourceResult)
{
    public bool FailureRetryAttempted { get; init; }
}
public sealed record SearchCacheRow : StoreRow
{
    public required string NormalizedQuery { get; init; }
    public required string ScopeKey { get; init; }
    public required string SourceId { get; init; }
    public required long SourceRevision { get; init; }
    public required long CredentialRevision { get; init; }
    public required int ParserVersion { get; init; }
    public required SearchCachePayload Payload { get; init; }
    public required bool Complete { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset ExpiresAt { get; init; }
}
public sealed record DownloadRow : StoreRow
{
    public required string Hash { get; init; }
    public required DownloadIntent Intent { get; init; }
    public string? RootId { get; init; }
    public required DateTimeOffset AddedAt { get; init; }
    public DateTimeOffset? FinishedAt { get; init; }
    public required string AdmissionToken { get; init; }
    public string? ResumeArtifact { get; init; }
    public string? RawIntentId { get; init; }
    public required long Version { get; init; }
}
public sealed record DownloadTargetRow : StoreRow
{
    public required string DownloadId { get; init; }
    public required string TargetId { get; init; }
    public required AssociationRole Role { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}
public sealed record DownloadFileRow : StoreRow
{
    public required string DownloadId { get; init; }
    public required int FileIndex { get; init; }
    public required bool Selected { get; init; }
    public string? TargetId { get; init; }
    public string? PartialPath { get; init; }
    public string? FinalPath { get; init; }
    public string? PhysicalKey { get; init; }
    public string? MediaFileId { get; init; }
    public required FileRole Role { get; init; }
    public required long ExpectedBytes { get; init; }
    public string? EnginePath { get; init; }
    public required bool Filed { get; init; }
}
public sealed record LibraryFolders(string Movies, string TV, string Anime, string AnimeMovies);
public sealed record StorageRootRow : StoreRow
{
    public required string Path { get; init; }
    public required string PhysicalKey { get; init; }
    public required ImmutableArray<LibraryKind> Kinds { get; init; }
    public required LibraryFolders LibraryFolders { get; init; }
    public required string VolumeSerial { get; init; }
    public required int Priority { get; init; }
    public required long ReserveBytes { get; init; }
    public long? MaxAllocatedBytes { get; init; }
    public required bool Enabled { get; init; }
    public required bool Online { get; init; }
    public required bool ReviewRequired { get; init; }
    public DateTimeOffset? LastCheckedAt { get; init; }
    public string? LastError { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record WorkFolderRow : StoreRow
{
    public required string WorkId { get; init; }
    public string? RootId { get; init; }
    public string? RelativeItemFolder { get; init; }
    public string? ExternalItemFolder { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public required long Version { get; init; }
}
public sealed record MediaFileRow : StoreRow
{
    public required string WorkId { get; init; }
    public string? EpisodeId { get; init; }
    public string? RootId { get; init; }
    public required string Path { get; init; }
    public required string PhysicalKey { get; init; }
    public required FileRole Role { get; init; }
    public string? ParentMediaFileId { get; init; }
    public required long Bytes { get; init; }
    public required DateTimeOffset MtimeUtc { get; init; }
    public int? Resolution { get; init; }
    public string? Source { get; init; }
    public string? Container { get; init; }
    public string? VideoCodec { get; init; }
    public string? VideoProfile { get; init; }
    public int? Width { get; init; }
    public int? Height { get; init; }
    public string? Hdr { get; init; }
    public double? RuntimeSeconds { get; init; }
    public long? BitrateBps { get; init; }
    public required ImmutableArray<MediaTrack> Tracks { get; init; }
    public required MediaOrigin Origin { get; init; }
    public string? DownloadId { get; init; }
    public int? FileIndex { get; init; }
    public required DateTimeOffset AddedAt { get; init; }
    public DateTimeOffset? LastSeenAt { get; init; }
    public DateTimeOffset? MissingSince { get; init; }
    public required FilePresence Status { get; init; }
    public DateTimeOffset? MissingConfirmedAt { get; init; }
    public DateTimeOffset? VerifiedAt { get; init; }
    public string? ContentDigest { get; init; }
    public string? JellyfinItemId { get; init; }
    public string InspectionState { get; init; } = "pending";
    public DateTimeOffset? InspectedAt { get; init; }
    public string? AudioLanguages { get; init; }
    public required long Version { get; init; }
}
public sealed record FileOperationRow : StoreRow
{
    public required FileOperationKind Kind { get; init; }
    public string? TargetId { get; init; }
    public string? DownloadId { get; init; }
    public string? MediaFileId { get; init; }
    public string? SourcePath { get; init; }
    public string? DestinationPath { get; init; }
    public long? ExpectedBytes { get; init; }
    public string? ExpectedDigest { get; init; }
    public required FileOperationState State { get; init; }
    public required bool DeleteSource { get; init; }
    public required int Attempts { get; init; }
    public DateTimeOffset? NextTryAt { get; init; }
    public string? LastError { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
    public string? LeaseToken { get; init; }
    public DateTimeOffset? LeaseUntil { get; init; }
    public FileOperationState? ResumeStage { get; init; }
    public string? EnginePermitToken { get; init; }
}
public sealed record FilePathClaimRow : StoreRow
{
    public required string OperationId { get; init; }
    public required string PhysicalKey { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
}
public sealed record UserRow : StoreRow
{
    public string? NormalizedEmail { get; init; }
    public string? Name { get; init; }
    public string? Image { get; init; }
    public required UserRole Role { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
}
public sealed record NotificationRow : StoreRow
{
    public required string UserId { get; init; }
    public required string Kind { get; init; }
    public required string Title { get; init; }
    public string? Body { get; init; }
    public string? Link { get; init; }
    public string? DedupeKey { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public DateTimeOffset? ReadAt { get; init; }
    public required bool PushPending { get; init; }
    public DateTimeOffset? PushAttemptAt { get; init; }
    public required int PushAttempts { get; init; }
}
public sealed record SettingRow : StoreRow
{
    public required int SchemaVersion { get; init; }
    public required JsonElement Value { get; init; }
    public required long Revision { get; init; }
    public required DateTimeOffset UpdatedAt { get; init; }
}

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
    long? MaxBytes, string? RootOverrideId);
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
    PriorityLane Lane, int Limit, DateTimeOffset DeadlineAt, long SourceRevision, long CredentialRevision);
public sealed record SourceResult(string SourceId, SourceOutcome Outcome, ImmutableArray<RawRelease> Results,
    DateTimeOffset? RetryAt, string? Error, TimeSpan Elapsed)
{
    public bool Complete { get; init; } = Outcome == SourceOutcome.Success;
    public SourceDiagnostics? Diagnostics { get; init; }
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
    ImmutableArray<Candidate> Pool, ImmutableArray<OwnedItem> Owned,
    ImmutableArray<BlockRow> Blocks, DateTimeOffset Now)
{
    public WorkPreferenceRow? Preference { get; init; }
    public ImmutableArray<PlanFileMetadata> FileMetadata { get; init; } = [];
    public string? AudioLanguage { get; init; }
}
public sealed record PlanShortlist(ImmutableArray<Candidate> Candidates, ImmutableArray<Rejection> Rejections);
public sealed record PlanResult(ImmutableArray<Assignment> Assignments, ImmutableArray<Rejection> Rejections,
    ImmutableArray<string> UncoveredTargetIds);
public sealed record EngineFileSnapshot(int Index, long Bytes, long CompletedBytes, long AllocatedBytes,
    bool Selected, string? PhysicalPath, bool AllTouchingPiecesComplete, bool Held = false);
public sealed record EngineSnapshot(string DownloadId, string Hash, bool MetadataAvailable,
    bool Attached, bool Complete, bool StalledMetadata, bool StalledProgress,
    long SelectedBytes, long CompletedSelectedBytes, long BytesPerSecond, int Peers, int Seeders,
    ImmutableArray<EngineFileSnapshot> Files, DateTimeOffset ObservedAt, Failure? Failure)
{
    public bool Active { get; init; }
    public DownloadIntent Intent { get; init; }
    public TimeSpan? Eta { get; init; }
    public long UploadedBytes { get; init; }
    public bool Checking { get; init; }
    public int? ErrorHResult { get; init; }
}
public sealed record ProbeHandle(string Token, string Hash, bool CreatedByProbe, bool ObservesLiveTransfer,
    DateTimeOffset ExpiresAt);
public sealed record ProbeAttachment(ProbeHandle? Handle, ImmutableArray<TorrentFile>? Files, Failure? Failure);
public sealed record FileBinding(int FileIndex, string AbsolutePath, bool Selected, string? RootPath = null);
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
public sealed record EngineDrainResult(string DownloadId, bool Detached, bool WritesDrained, Failure? Failure);
public sealed record DownloadWindow(ImmutableArray<DayOfWeek> Days, TimeOnly Start, TimeOnly End,
    int? DownloadBytesPerSecond, int? UploadBytesPerSecond);
public sealed record PlacementInput(WorkSnapshot? Work, ImmutableArray<TargetRow> Targets, Assignment Assignment,
    ImmutableArray<TorrentFile> Files, ImmutableArray<StorageRootRow> Roots,
    ImmutableArray<OwnedItem> Owned, string? ExplicitRootId, string? ExplicitDirectory, LibraryKind? ExplicitKind);
public sealed record PlacementResult(ImmutableArray<DownloadFileRow> Files, string? RootId,
    long ReservedBytes, ImmutableArray<WorkFolderRow> Folders, Failure? Failure);
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
public sealed record DeletionPlan(string Token, ImmutableArray<string> MediaFileIds,
    ImmutableArray<string> DownloadFileIds, ImmutableArray<string> Paths, long Bytes,
    ImmutableArray<string> ProtectedPaths);
public sealed record LibraryCommand(LibraryAction Action, Actor Actor, string? WorkId,
    ImmutableArray<string> EpisodeIds, string? Token, string? Path, string? RootId,
    bool Confirmed, bool DeleteFiles);
public sealed record TargetCommand(string IdempotencyKey, TargetAction Action, Actor Actor,
    TargetScope Scope, Policy Policy, ImmutableArray<string> TargetIds,
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
    ImmutableArray<RawIntentRow> RawIntents, ImmutableArray<QueuedTransferProjection> QueuedTransfers);
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
public sealed record RowWrite(StoreRow Row, long? ExpectedVersion, StoreRow? ExpectedRow);
public sealed record RowDelete(StoreTable Table, string Id, long? ExpectedVersion, StoreRow? ExpectedRow);
public sealed record ApiCall(string Method, string RoutePattern, ImmutableDictionary<string, string> RouteValues,
    ImmutableDictionary<string, string> Query, JsonElement? Body, Actor Actor);
public sealed record ApiReply(int StatusCode, string ContentType, JsonElement Body);

public sealed record SecretReference(string FileId, long Revision);
public sealed record EngineSettings(int ListenPort, int MaxActiveDownloads, int GlobalPeers, int PerTorrentPeers,
    int HalfOpenConnections, int ProbePeers, long DiskCacheBytes, int OpenFiles,
    bool Dht, bool Pex, bool LocalDiscovery, bool Upnp,
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
    int BackgroundScopes, int BackgroundAdapters, int ProbeConcurrency, int BackgroundProbes);
public sealed record JellyfinPathMapping(string From, string To);
public sealed record JellyfinUserMapping(string TorrentFlowUserId, string JellyfinUserId);
public sealed record JellyfinSettings(string? ServerUrl, SecretReference? Credential, string? UserId)
{
    public string? PublicUrl { get; init; }
    public ImmutableArray<JellyfinPathMapping> PathMappings { get; init; } = [];
    public ImmutableArray<string> WatchUserIds { get; init; } = [];
    public bool SyncLibraries { get; init; } = true;
    public int SuggestNextEpisodes { get; init; } = 2;
    public ImmutableArray<string> SubtitleLanguages { get; init; } = [];
    public bool SubtitleProviderMissing { get; init; }
    public ImmutableArray<JellyfinUserMapping> UserMappings { get; init; } = [];
    public string? ServerId { get; init; }
    public ImmutableDictionary<string, string> LibraryOverrides { get; init; } =
        ImmutableDictionary<string, string>.Empty;
}

public sealed record JellyfinJobRow : StoreRow
{
    public required string Kind { get; init; }
    public required JsonElement PayloadJson { get; init; }
    public string? TargetId { get; init; }
    public string? MediaFileId { get; init; }
    public required int Attempts { get; init; }
    public required DateTimeOffset NextAttemptAt { get; init; }
    public required DateTimeOffset CreatedAt { get; init; }
    public string? LastError { get; init; }
    public required string State { get; init; }
}

public sealed record JellyfinLibraryPathRow : StoreRow
{
    public required string ServerId { get; init; }
    public required string LibraryItemId { get; init; }
    public required string LibraryName { get; init; }
    public required string RootId { get; init; }
    public required string Kind { get; init; }
    public required string ServerPath { get; init; }
    public required DateTimeOffset AddedAt { get; init; }
}

public sealed record JellyfinSuggestionDismissalRow
{
    public required string UserId { get; init; }
    public required string WorkId { get; init; }
    public required int Season { get; init; }
    public required int Episode { get; init; }
    public required DateTimeOffset DismissedAt { get; init; }
}
