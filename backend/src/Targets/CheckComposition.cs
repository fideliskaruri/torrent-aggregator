using System.Collections.Immutable;
using System.Runtime.CompilerServices;
using Microsoft.Extensions.DependencyInjection;
using TorrentFlow.Check;
using TorrentFlow.Domain;

namespace TorrentFlow.Targets;

public static class CheckComposition
{
    public static IServiceCollection AddCheckModule(this IServiceCollection services, CheckOptions? options = null)
    {
        services.AddSingleton(options ?? new CheckOptions());
        services.AddSingleton<SwarmCheck>();
        services.AddSingleton<ICheck, PersistingCheck>();
        return services;
    }

    private sealed class PersistingCheck(SwarmCheck check, ICheckRepository repository) : ICheck
    {
        public CheckDiagnostics Diagnostics => check.Diagnostics;
        public async IAsyncEnumerable<SwarmEvidence> ProbeAsync(ImmutableArray<ProbeRequest> requests,
            [EnumeratorCancellation] CancellationToken ct)
        {
            await foreach (var result in ProbeStreamAsync(Input(requests, ct), ct)) yield return result;
        }
        private static async IAsyncEnumerable<ProbeRequest> Input(ImmutableArray<ProbeRequest> requests,
            [EnumeratorCancellation] CancellationToken ct)
        {
            foreach (var request in requests) { ct.ThrowIfCancellationRequested(); yield return request; }
            await Task.CompletedTask;
        }
        public async IAsyncEnumerable<SwarmEvidence> ProbeStreamAsync(IAsyncEnumerable<ProbeRequest> requests,
            [EnumeratorCancellation] CancellationToken ct)
        {
            var candidates = new System.Collections.Concurrent.ConcurrentDictionary<string, Candidate>();
            await foreach (var result in check.ProbeStreamAsync(Capture(ct), ct))
            {
                ct.ThrowIfCancellationRequested();
                await repository.SaveAsync(candidates[result.Hash], result, ct);
                yield return result;
            }
            async IAsyncEnumerable<ProbeRequest> Capture([EnumeratorCancellation] CancellationToken token)
            {
                await foreach (var request in requests.WithCancellation(token))
                {
                    candidates[request.Candidate.Release.Id] = request.Candidate;
                    yield return request;
                }
            }
        }
        public Task<ImmutableArray<SwarmEvidence>> LoadAsync(ImmutableArray<string> hashes, CancellationToken ct) =>
            check.LoadAsync(hashes, ct);
        public Task<ImmutableArray<SwarmEvidence>> RecentAsync(int limit, CancellationToken ct) => check.RecentAsync(limit, ct);
    }
}
