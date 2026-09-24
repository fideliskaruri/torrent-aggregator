using System;
using System.Collections.Generic;

namespace TorrentFlow.Data.Entities;

public partial class SwarmMeasurement
{
    public string Id { get; set; } = null!;

    public string InfoHash { get; set; } = null!;

    public int PeersConnected { get; set; }

    public int PeersUnchoked { get; set; }

    public long BytesReceived { get; set; }

    public int ElapsedMs { get; set; }

    public double EffectiveBps { get; set; }

    public double RequiredBps { get; set; }

    public string Verdict { get; set; } = null!;

    public DateTime MeasuredAt { get; set; }

    public DateTime ExpiresAt { get; set; }

    public DateTime CreatedAt { get; set; }

    public DateTime UpdatedAt { get; set; }

    public string? Name { get; set; }
}
