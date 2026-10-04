using TorrentFlow.Domain;
using TorrentFlow.Targets;

namespace TorrentFlow.Requests;

public static class RequestPick
{
    public sealed record Input(string TargetId, string ReleaseHash);

    public static async Task<TargetActionReply> Handle(string id, Input input, RequestService service,
        TargetPipeline pipeline, CancellationToken ct)
    {
        var request = (await service.Read<RequestRow>(CatalogState.Query(id), ct)).SingleOrDefault()
            ?? throw new KeyNotFoundException("Request not found.");
        if (request.Decision != RequestDecision.Approved)
            throw new ArgumentException("Approve this request before choosing a release.");
        var items = await service.Read<RequestItemRow>(CatalogState.Query() with { RequestId = id }, ct);
        if (!items.Any(i => i.TargetId == input.TargetId && i.Settlement == ItemSettlement.Open))
            throw new ArgumentException("Choose an unfinished item from this request.");
        return await pipeline.PickAsync(input.TargetId, input.ReleaseHash, ct);
    }
}
