namespace TorrentFlow.Engine.Layout;

/// <summary>What an owner-run tidy did: downloads checked, how many were rearranged, and what stayed put.</summary>
/// <param name="StillNested">Videos kept in a release folder because another release already owns the flat name.</param>
/// <param name="Skipped">Downloads left alone because the client holds them or a reader has them open.</param>
public sealed record LayoutTidyResult(int Checked, int Tidied, int FilesMoved, int StillNested, int Skipped);

/// <summary>Re-runs the content layout over finished downloads whose files still sit in a release folder.</summary>
public interface ILayoutTidy
{
    Task<LayoutTidyResult> TidyAsync(CancellationToken ct);
}
