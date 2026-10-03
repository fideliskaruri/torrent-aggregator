using System.Collections.Immutable;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Domain;
using TorrentFlow.Plan;

namespace TorrentFlow.Targets;

public static class PlanComposition
{
    public static IServiceCollection AddPlanModule(this IServiceCollection services)
    {
        services.AddSingleton<IPlan, ParsedPlan>();
        return services;
    }

    private sealed class ParsedPlan(IParser parser) : IPlan
    {
        private readonly ReleasePlanner planner = new();
        public PlanResult Choose(PlanInput input)
        {
            var metadata = input.Pool.Select(candidate =>
            {
                var evidence = input.Evidence.Where(e => e.Hash.Equals(candidate.Release.Id, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(e => e.CheckedAt).FirstOrDefault();
                var files = evidence?.Files ?? candidate.Release.Files ?? [];
                var supplied = input.FileMetadata.FirstOrDefault(m => m.Hash.Equals(candidate.Release.Id, StringComparison.OrdinalIgnoreCase));
                return new PlanFileMetadata(candidate.Release.Id, supplied?.PieceLength,
                    files.DistinctBy(f => f.Index).ToImmutableDictionary(f => f.Index,
                        f => parser.Parse(f.RelativePath.Replace('\\', '/').Split('/')[^1])))
                {
                    ParsedDirectories = files.DistinctBy(f => f.Index).ToImmutableDictionary(f => f.Index, f =>
                    {
                        var path = f.RelativePath.Replace('\\', '/');
                        var slash = path.LastIndexOf('/');
                        return parser.Parse(slash < 0 ? "" : path[..slash]);
                    }),
                };
            }).ToImmutableArray();
            return planner.Choose(input with { FileMetadata = metadata });
        }
    }
}
