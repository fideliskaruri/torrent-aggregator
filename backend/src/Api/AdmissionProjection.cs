using TorrentFlow.Targets;

namespace TorrentFlow.Api;

/// <summary>
/// Projects TargetAdmission / TargetActionReply outcomes for HTTP without
/// inventing a second hold rule. Queued, owned and held stay distinct.
/// </summary>
internal static class AdmissionProjection
{
    /// <summary>Single-item status label for hunter / automation summaries.</summary>
    internal static string Status(TargetActionReply reply) =>
        reply.Queued > 0 ? "queued" :
        reply.Owned > 0 ? "owned" :
        reply.Held > 0 ? "held" :
        "existing";

    /// <summary>Title / library grab body: counts plus the Targets message.</summary>
    internal static object Title(TargetActionReply reply, string workKey) => new
    {
        ok = reply.Accepted,
        queued = reply.Queued,
        owned = reply.Owned,
        held = reply.Held,
        message = reply.Message,
        workKey,
    };
}
