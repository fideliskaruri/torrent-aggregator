using Microsoft.EntityFrameworkCore;
using TorrentFlow.Api.Access;
using TorrentFlow.Domain;
using TorrentFlow.Store;

namespace TorrentFlow.Api.Requests;

// Shared catalog browsing survives the removal of title requests.
internal static class RequestEndpoints
{
    internal static void MapRequests(this WebApplication app)
    {
        app.MapGet("/api/requester/library", async (HttpContext http, TorrentFlowDbContext db, CancellationToken ct) =>
        {
            if (AccessIdentity.Role(http) != "requester") return Results.StatusCode(403);
            var files = await db.MediaFiles.AsNoTracking().Where(f => f.Role == FileRole.Video && f.Status == FilePresence.Present).ToArrayAsync(ct);
            var ids = files.Where(f => File.Exists(f.Path)).Select(f => f.WorkId).ToHashSet();
            var works = await db.Works.AsNoTracking().Where(w => ids.Contains(w.Id)).ToArrayAsync(ct);
            var names = await db.WorkNames.AsNoTracking().Where(n => ids.Contains(n.WorkId)).ToArrayAsync(ct);
            return Results.Json(new { titles = works.Select(w => new { key = w.WorkKey,
                title = names.Where(n => n.WorkId == w.Id).OrderBy(n => n.Ordinal).FirstOrDefault()?.Value ?? w.WorkKey,
                w.Year, mediaType = w.Kind == WorkKind.Film ? "movie" : "tv", w.PosterUrl }) });
        });
        // Retired clients must not reach acquisition through a legacy command.
        foreach (var path in new[] { "/api/requests/{**path}", "/api/requester/requests/{**path}", "/api/requester/seasons" })
            app.MapMethods(path, ["GET", "POST", "PUT", "PATCH", "DELETE"], () =>
                Results.Json(new { error = "Requests are no longer available.", code = "feature_removed" }, statusCode: 410));
    }
}
