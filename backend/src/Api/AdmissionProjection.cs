using TorrentFlow.Targets;

namespace TorrentFlow.Api;

/// <summary>
/// Projects TargetActionReply outcomes for HTTP.
/// </summary>
internal static class AdmissionProjection
{
    /// <summary>Single-item status label for hunter / automation summaries.</summary>
    internal static string Status(TargetActionReply reply) =>
        reply.Queued > 0 ? "queued" :
        reply.Owned > 0 ? "owned" :
        "existing";

    /// <summary>Title / library grab body: counts plus the Targets message.</summary>
    internal static object Title(TargetActionReply reply, string workKey) => new
    {
        ok = reply.Accepted,
        queued = reply.Queued,
        owned = reply.Owned,
        message = reply.Message,
        workKey,
    };
}
