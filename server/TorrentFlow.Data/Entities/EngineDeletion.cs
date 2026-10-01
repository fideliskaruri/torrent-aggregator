namespace TorrentFlow.Data.Entities;

/// <summary>
/// A delete the owner already asked for. It is written in the same save that removes the transfer's row, so the
/// transfer never lists again; the cleanup worker then detaches it from the client, deletes its files when asked and
/// drops this row. It survives a restart, so a crash mid-cleanup still ends with the files gone.
/// </summary>
public sealed class EngineDeletion
{
    public string UserId { get; set; } = null!;
    public string Hash { get; set; } = null!;
    /// <summary>Transfers deleted together share a batch, so a season folder that holds only them goes whole.</summary>
    public string BatchId { get; set; } = null!;
    public string Name { get; set; } = null!;
    public string? SavePath { get; set; }
    /// <summary>JSON array of the full paths of the transfer's files, captured when it was deleted.</summary>
    public string FilesJson { get; set; } = null!;
    public bool DeleteFiles { get; set; }
    public int Attempts { get; set; }
    public string? LastError { get; set; }
    public DateTime CreatedAt { get; set; }
    public DateTime NextAttemptAt { get; set; }
}
