namespace TorrentFlow.Store;

public sealed record RecoverySettings(bool Enabled = true, int MetadataStallSeconds = 180,
    int ProgressStallSeconds = 600, long ProgressStallBytes = 1024 * 1024,
    int MaximumSwaps = 3, int BackoffSeconds = 3600);
