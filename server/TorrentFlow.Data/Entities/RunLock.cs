using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class RunLock
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Scope { get; set; } = null!;

    public DateTime AcquiredAt { get; set; }
}
