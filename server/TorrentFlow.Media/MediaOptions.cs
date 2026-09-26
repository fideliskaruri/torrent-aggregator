using System.ComponentModel.DataAnnotations;

namespace TorrentFlow.Media;

public sealed class MediaOptions
{
    public const string SectionName = "TorrentFlow:Media";

    /// <summary>Explicit ffmpeg binary. Falls back to FFMPEG_PATH, node_modules/ffmpeg-static, then PATH.</summary>
    public string? FfmpegPath { get; set; }

    /// <summary>Explicit ffprobe binary. Falls back to FFPROBE_PATH, node_modules/ffprobe-static, then PATH.</summary>
    public string? FfprobePath { get; set; }

    /// <summary>Where HLS sessions, VOD conversions and subtitle caches live. Defaults to &lt;DataDirectory&gt;/.sessions.</summary>
    public string? SessionsDirectory { get; set; }

    /// <summary>Extra directory searched for node_modules (the TS app's bundled binaries). Defaults to walking up from the content root.</summary>
    public string? NodeModulesRoot { get; set; }

    /// <summary>Folder holding ffmpeg/ffprobe downloaded by the desktop app (host default &lt;DataDirectory&gt;/tools/ffmpeg). Searched after the env vars.</summary>
    public string? ManagedToolsDirectory { get; set; }

    [Range(1, 32)] public int MaxConcurrentSessions { get; set; } = 4;

    [Range(5, 3600)] public int SessionIdleTimeoutSeconds { get; set; } = 120;
    /// <summary>Arms the foreground swarm-delivery watchdog poll.</summary>
    public bool SwarmWatchEnabled { get; set; } = true;
}
