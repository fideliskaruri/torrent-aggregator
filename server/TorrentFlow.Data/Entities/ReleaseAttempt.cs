namespace TorrentFlow.Data.Entities;

public sealed class ReleaseAttempt
{
    public string UserId { get; set; } = null!;
    public string WorkKey { get; set; } = null!;
    public string Scope { get; set; } = null!;
    public string Hash { get; set; } = null!;
    public DateTime TriedAt { get; set; }
}
