using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class MediaProbe
{
    public string Id { get; set; } = null!;

    public string InfoHash { get; set; } = null!;

    public string FilePath { get; set; } = null!;

    public string? Container { get; set; }

    public double? DurationSec { get; set; }

    public string? VideoCodec { get; set; }

    public string? VideoProfile { get; set; }

    public int? Width { get; set; }

    public int? Height { get; set; }

    public string? ColorTransfer { get; set; }

    public string? AudioCodec { get; set; }

    public int? AudioChannels { get; set; }

    public string? AudioLayout { get; set; }

    public string? StreamsJson { get; set; }

    public DateTime ProbedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public int? BitRateBps { get; set; }

    public int ProbeVersion { get; set; }
}
