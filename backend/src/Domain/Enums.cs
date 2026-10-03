namespace TorrentFlow.Domain;

public enum WorkKind { Unknown, Film, Series }
public enum WorkFormat { Unknown, Movie, Series, Special }
public enum ReleaseKind { Movie, Episode, SeasonPack, MultiSeason, CompleteSeries, Special, Other }
public enum ForeignStatus { Unknown, No, Yes }
public enum NameLabel { English, Romaji, Synonym, Native, Original }
public enum MappingStatus { Confirmed, Provisional, Unavailable }
public enum LinkStatus { Verified, Suggested, Rejected }
public enum DatePrecision { Unknown, Day, Instant }
public enum TargetKind { Acquire, Replace }
public enum TargetState { Wanted, Finding, Checking, Planning, Fetching, Filing, Done, Waiting, Paused, Removed }
public enum WaitReason
{
    NotReleased, MetadataUnavailable, NoResults, RejectedCandidates, NoHealthyRelease,
    SourceCooldown, SourceFailure, WaitingForSeeders, DownloadCap, DownloadWindow,
    NoDriveSpace, DriveOffline, FileBusy, MappingUncertain,
    OwnerPickRequired, RecoveryMissing
}
public enum TargetPriority { Now, OwnerRank, FreshRelease, Request, BackCatalogue, UpgradeWatch }
public enum ReplacementMode { Upgrade, Replace }
public enum ScopeIntentState { Pending, Materialized, Cancelled }
public enum RawDownloadState { Wanted, Checking, Planning, Fetching, Filing, Review, Done, Waiting, Paused, Removed }
public enum IntentOrigin { Owner, Request, Rule, Follow, Upgrade }
public enum PriorityLane { Owner, Background }
public enum HealthBand { Good, Weak, Dead, Unknown }
public enum SourceTier { Core, Fallback, OptIn }
public enum SourceOutcome { Success, Partial, TimedOut, Busy, CoolingDown, Unsupported, Unconfigured, Failed }
public enum SearchNamePhase { English, Original, Synonym }
public enum DownloadIntent { Run, Queued, Paused, Stopped }
public enum AssociationRole { Current, Replacement, Retired }
public enum FileRole { Video, Subtitle, Audio, Unwanted }
public enum FilePresence { Present, Offline, Missing }
public enum MediaOrigin { Downloaded, Imported, Adopted }
public enum LibraryKind { Movies, TV, Anime, AnimeMovies }
public enum FileOperationKind { Rename, Move, Copy, Delete, Import, Relocate }
public enum FileOperationState { Pending, Copied, Verified, InventoryCommitted, SourceDeleted, Done, Retry, NeedsOwner, Superseded }
public enum ImportMode { TrackInPlace, Move, Copy }
public enum ImportConfidence { Confident, NeedsPick, Unmatched }
public enum UserRole { Owner, Requester }
public enum RequestScope { Film, Episodes, Seasons, Series }
public enum RequestDecision { Pending, Approved, Declined, Cancelled }
public enum ItemSettlement { Open, Fulfilled, StoppedByOwner }
public enum AutoApproveMode { None, MoviesOnly, Everything }
public enum WatchStatus { Watching, Planned, Completed, Dropped }
public enum AttemptKind { Search, Check, Plan, Fetch, File, Swap, LegacyEvent }
public enum BlockOrigin { Owner, Unsafe, Foreign, Stalled, Swap }
public enum CacheKind { ProviderDetail, TitleSearch, BrowseRail, FribbMap, JellyfinState }
public enum ProbeScope { Off, Watching, Monitored }
public enum StoreOwner { Metadata, Find, Check, Targets, Library, Converter }
public enum StoreOrder { PrimaryKey, CreatedNewest, DuePriority, CheckedNewest }
public enum StoreTable
{
    Work, WorkName, WorkLink, Season, Episode, MetadataCache, WorkPreference, Target,
    Request, RequestItem, AutoApproveRule, Follow, WatchItem, AutoRule, Release,
    ReleaseObservation, Verdict, Attempt, Block, SearchCache, Download, DownloadTarget,
    DownloadFile, StorageRoot, MediaFile, FileOperation, User, Notification,
    PushSubscription, Setting, ScopeIntent, RawIntent, UpgradeEvidence, WorkFolder, FilePathClaim
}
public enum TargetAction { Acquire, Upgrade, Replace, CancelUpgrade, Pause, Resume, Remove, TryNow, DownloadNow, Rank, Swap, Pick }
public enum RequestAction { Create, Approve, Decline, Cancel, Retry, Pick, DownloadNow }
public enum LibraryAction { Scan, ConfirmImport, EnrollRoot, ConfirmRoot, Delete, MoveTitle, Open, Reveal, Tidy, AdoptExternal }
public enum SystemArea { Settings, AutoApproval, Watchlist, Follow, Rules, Notifications, Push, Desktop, Users }
public enum SystemAction { Get, Add, Update, Delete, Run, Test, MarkRead, MarkAllRead, CheckUpdate, InstallUpdate }
public enum AcquisitionMode { Catalog, ExplicitRaw }
