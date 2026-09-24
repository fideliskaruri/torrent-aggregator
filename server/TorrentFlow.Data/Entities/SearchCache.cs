using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class SearchCache
{
    public string Id { get; set; } = null!;

    public string CacheKey { get; set; } = null!;

    public string Payload { get; set; } = null!;

    public DateTime ExpiresAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public string? NormalizedQuery { get; set; }
}
