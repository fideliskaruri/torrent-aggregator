using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Logging;
using TorrentFlow.Core.Contracts.Search;
using TorrentFlow.Data;

namespace TorrentFlow.Search;

public sealed class SearchCacheStore(IDbContextFactory<TorrentFlowDbContext> factory, ILogger<SearchCacheStore> logger)
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web) { DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull };
    private readonly object gate = new();
    private readonly Dictionary<string, (SearchResponse Value, DateTime Expires)> memory = [];
    private readonly (int Count, DateTime Reset)[] budgets = new (int, DateTime)[2];
    public static string Key(SearchOptions options, int target)
    {
        var raw = JsonSerializer.Serialize(new { q = options.Query.Trim().ToLowerInvariant(), category = options.Category, limit = options.Limit,
            sources = options.Sources?.Order(StringComparer.Ordinal).ToArray(), filters = options.Filters ?? new(), target }, Json);
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(raw)))[..40].ToLowerInvariant();
    }
    public int Spend(bool background)
    {
        lock (gate)
        {
            var index = background ? 1 : 0;
            var b = budgets[index];
            if (b.Reset <= DateTime.UtcNow) b = (0, DateTime.UtcNow.AddMinutes(1));
            if (b.Count >= (background ? 15 : 40)) return Math.Max(1, (int)Math.Ceiling((b.Reset - DateTime.UtcNow).TotalSeconds));
            budgets[index] = (b.Count + 1, b.Reset);
            return 0;
        }
    }
    private void Remember(string key, SearchResponse value, DateTime expires)
    {
        lock (gate)
        {
            if (!memory.ContainsKey(key) && memory.Count >= 500) memory.Remove(memory.Keys.First());
            memory[key] = (value, expires);
        }
    }
    public async Task<SearchResponse?> GetAsync(string key, bool allowStale = false, CancellationToken token = default)
    {
        lock (gate)
            if (memory.TryGetValue(key, out var hit) && (allowStale || hit.Expires >= DateTime.UtcNow)) return hit.Value;
        try
        {
            await using var db = await factory.CreateDbContextAsync(token);
            var row = await db.SearchCaches.AsNoTracking().FirstOrDefaultAsync(r => r.CacheKey == key, token);
            if (row == null || !allowStale && row.ExpiresAt < DateTime.UtcNow || row.Payload.Length > 8 * 1024 * 1024) return null;
            var value = JsonSerializer.Deserialize<SearchResponse>(row.Payload, Json);
            if (value != null) Remember(key, value, row.ExpiresAt);
            return value;
        }
        catch (Exception e) when (!token.IsCancellationRequested)
        {
            logger.LogWarning(e, "Could not read persistent search cache");
            return null;
        }
    }
    public async Task SetAsync(string key, SearchResponse value, CancellationToken token = default)
    {
        var expires = DateTime.UtcNow.AddMinutes(3);
        Remember(key, value, expires);
        try
        {
            await using var db = await factory.CreateDbContextAsync(token);
            var row = await db.SearchCaches.FirstOrDefaultAsync(r => r.CacheKey == key, token);
            if (row == null)
            {
                row = new() { Id = Ids.New(), CacheKey = key, CreatedAt = DateTime.UtcNow };
                db.SearchCaches.Add(row);
            }
            row.Payload = JsonSerializer.Serialize(value, Json);
            row.ExpiresAt = expires;
            row.NormalizedQuery = ReleaseQuality.NormalizeTitle(value.Query);
            await db.SaveChangesAsync(token);
            // Keep stale fallback, but cap disk growth as well as process memory.
            var excess = await db.SearchCaches.OrderByDescending(r => r.ExpiresAt).Skip(500).Select(r => r.Id).ToArrayAsync(token);
            if (excess.Length > 0) await db.SearchCaches.Where(r => excess.Contains(r.Id)).ExecuteDeleteAsync(token);
        }
        catch (Exception e) when (!token.IsCancellationRequested) { logger.LogWarning(e, "Could not persist search cache"); }
    }
    public async Task InvalidateAsync(CancellationToken token = default)
    {
        lock (gate) memory.Clear();
        await using var db = await factory.CreateDbContextAsync(token);
        await db.SearchCaches.ExecuteDeleteAsync(token);
    }
}
