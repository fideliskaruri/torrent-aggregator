using System;

namespace TorrentFlow.Data.Entities;

/// <summary>One entry in a user's notification feed. <see cref="RecipientUserId"/> is the owner's local user id or a requester's.</summary>
public partial class Notification
{
    public string Id { get; set; } = null!;

    public string RecipientUserId { get; set; } = null!;

    /// <summary>request.new | request.approved | request.declined | request.fulfilled | request.failed | download.completed | download.failed.</summary>
    public string Kind { get; set; } = null!;

    public string Title { get; set; } = null!;

    public string? Body { get; set; }

    /// <summary>An in-app path (never a file-system path).</summary>
    public string? Link { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime? ReadAt { get; set; }
}

/// <summary>A browser Web Push subscription belonging to one user.</summary>
public partial class PushSubscription
{
    public string Id { get; set; } = null!;

    public string UserId { get; set; } = null!;

    public string Endpoint { get; set; } = null!;

    public string P256dh { get; set; } = null!;

    public string Auth { get; set; } = null!;

    public DateTime CreatedAt { get; set; }
}
