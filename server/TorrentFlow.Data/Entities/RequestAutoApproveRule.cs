using System;

namespace TorrentFlow.Data.Entities;

/// <summary>Owner rule: auto-approve matching requests from this email (lowercased).</summary>
public partial class RequestAutoApproveRule
{
    public string Id { get; set; } = null!;

    /// <summary>Requester email, stored lowercased.</summary>
    public string Email { get; set; } = null!;

    /// <summary>none | moviesOnly | everything.</summary>
    public string Mode { get; set; } = null!;

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }
}
