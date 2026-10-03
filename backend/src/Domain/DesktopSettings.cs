namespace TorrentFlow.Domain;

public sealed record DesktopRelease(string Version, string Tag, string? PageUrl, string? InstallerName,
    string? InstallerUrl, string? InstallerSha256, long? InstallerSize);

public sealed partial record DesktopSettings
{
    public string? LastCheckError { get; init; }
    public DesktopRelease? Latest { get; init; }
}
