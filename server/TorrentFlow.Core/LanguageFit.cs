namespace TorrentFlow.Core;

/// <summary>
/// How well a release's language fits what the owner wants (docs/release-language.md). The grab ladder sends
/// <see cref="Preferred"/> and <see cref="Neutral"/> releases in its normal pass; <see cref="Backup"/> and
/// <see cref="Clash"/> releases wait for the last-resort pass, so an episode with any sendable release still gets one.
/// </summary>
public enum LanguageFit
{
    Preferred,
    Neutral,
    Backup,
    Clash,
}
