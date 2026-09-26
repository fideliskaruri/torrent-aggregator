using System.Net.Mail;
using System.Text.Json;
using Microsoft.EntityFrameworkCore;
using TorrentFlow.Data;
using TorrentFlow.Data.Entities;

namespace TorrentFlow.Api.Requests;

/// <summary>Owner-configurable auto-approve modes for a requester email.</summary>
public static class AutoApproveMode
{
    public const string None = "none";
    public const string MoviesOnly = "moviesOnly";
    public const string Everything = "everything";

    public static readonly string[] All = [None, MoviesOnly, Everything];

    public static bool IsKnown(string? mode) =>
        mode is not null && All.Contains(mode, StringComparer.Ordinal);

    /// <summary>Whether a pending request with this scope/media type should auto-approve under <paramref name="mode"/>.</summary>
    public static bool Matches(string mode, string scope, string mediaType)
    {
        if (string.Equals(mode, Everything, StringComparison.Ordinal)) return true;
        if (!string.Equals(mode, MoviesOnly, StringComparison.Ordinal)) return false;
        return string.Equals(scope, MediaRequestScope.Movie, StringComparison.Ordinal)
            || string.Equals(mediaType, "movie", StringComparison.OrdinalIgnoreCase);
    }
}

public sealed record AutoApproveRuleDto(string Email, string Mode);

/// <summary>Persists and applies per-email auto-approve rules; approvals reuse <see cref="RequestDecisionService.ApproveAsync"/>.</summary>
public sealed class RequestAutoApproveService(
    IDbContextFactory<TorrentFlowDbContext> factory,
    RequestDecisionService decisions,
    TimeProvider time)
{
    public const string AutoApprovedReason = "Auto-approved";
    public const int MaxRules = 200;
    public const int MaxEmailLength = 320;

    public async Task<(IReadOnlyList<AutoApproveRuleDto> Rules, IReadOnlyList<string> KnownEmails)> GetAsync(CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var rules = await db.RequestAutoApproveRules.AsNoTracking()
            .OrderBy(r => r.Email)
            .Select(r => new AutoApproveRuleDto(r.Email, r.Mode))
            .ToListAsync(ct);
        var fromRequests = await db.MediaRequests.AsNoTracking()
            .Where(r => r.RequestedBy.Email != null && r.RequestedBy.Email != "")
            .Select(r => r.RequestedBy.Email!)
            .Distinct()
            .ToListAsync(ct);
        var known = fromRequests
            .Select(NormalizeEmail)
            .Where(e => e is not null)
            .Cast<string>()
            .Concat(rules.Select(r => r.Email))
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToList();
        return (rules, known);
    }

    /// <summary>Replace the full rule set. Empty mode or <see cref="AutoApproveMode.None"/> drops that email.</summary>
    public async Task<(bool Ok, string? Error, IReadOnlyList<AutoApproveRuleDto>? Rules)> PutAsync(IReadOnlyList<AutoApproveRuleDto> incoming, CancellationToken ct)
    {
        if (incoming.Count > MaxRules) return (false, $"At most {MaxRules} rules.", null);
        var cleaned = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var row in incoming)
        {
            var email = NormalizeEmail(row.Email);
            if (email is null) return (false, "Each rule needs a valid email.", null);
            var mode = (row.Mode ?? "").Trim();
            if (!AutoApproveMode.IsKnown(mode)) return (false, "mode must be none, moviesOnly or everything.", null);
            if (mode == AutoApproveMode.None)
            {
                cleaned.Remove(email);
                continue;
            }
            cleaned[email] = mode;
        }

        await using var db = await factory.CreateDbContextAsync(ct);
        var existing = await db.RequestAutoApproveRules.ToListAsync(ct);
        db.RequestAutoApproveRules.RemoveRange(existing.Where(e => !cleaned.ContainsKey(e.Email)));
        var now = time.GetUtcNow().UtcDateTime;
        foreach (var (email, mode) in cleaned)
        {
            var row = existing.FirstOrDefault(e => e.Email == email);
            if (row is null)
            {
                db.RequestAutoApproveRules.Add(new RequestAutoApproveRule
                {
                    Id = Ids.New(),
                    Email = email,
                    Mode = mode,
                    CreatedAt = now,
                    UpdatedAt = now,
                });
            }
            else if (row.Mode != mode)
            {
                row.Mode = mode;
                row.UpdatedAt = now;
            }
        }
        await db.SaveChangesAsync(ct);
        var rules = await db.RequestAutoApproveRules.AsNoTracking()
            .OrderBy(r => r.Email)
            .Select(r => new AutoApproveRuleDto(r.Email, r.Mode))
            .ToListAsync(ct);
        return (true, null, rules);
    }

    /// <summary>If the requester has a matching rule, runs the same approve path as the owner.</summary>
    public async Task<bool> TryAutoApproveAsync(string userId, string requestId, string scope, string mediaType, CancellationToken ct)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        var email = await db.Users.AsNoTracking()
            .Where(u => u.Id == userId)
            .Select(u => u.Email)
            .FirstOrDefaultAsync(ct);
        var normalized = NormalizeEmail(email);
        if (normalized is null) return false;
        var mode = await db.RequestAutoApproveRules.AsNoTracking()
            .Where(r => r.Email == normalized)
            .Select(r => r.Mode)
            .FirstOrDefaultAsync(ct);
        if (mode is null || !AutoApproveMode.Matches(mode, scope, mediaType)) return false;
        var (outcome, _) = await decisions.ApproveAsync(requestId, ct, AutoApprovedReason);
        return outcome == DecisionOutcome.Done;
    }

    public static string? NormalizeEmail(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw)) return null;
        var trimmed = raw.Trim();
        if (trimmed.Length > MaxEmailLength) return null;
        try
        {
            var addr = new MailAddress(trimmed);
            if (string.IsNullOrEmpty(addr.Address) || addr.Address.Contains(' ', StringComparison.Ordinal)) return null;
            return addr.Address.ToLowerInvariant();
        }
        catch (FormatException)
        {
            return null;
        }
    }

    public static (List<AutoApproveRuleDto>? Rules, string? Error) ParsePutBody(JsonElement body)
    {
        if (body.ValueKind != JsonValueKind.Object) return (null, "JSON body must be an object");
        if (!body.TryGetProperty("rules", out var rulesEl)) return (null, "rules is required");
        if (rulesEl.ValueKind != JsonValueKind.Array) return (null, "rules must be a list");
        if (rulesEl.GetArrayLength() > MaxRules) return (null, $"At most {MaxRules} rules.");
        var list = new List<AutoApproveRuleDto>();
        foreach (var item in rulesEl.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object) return (null, "Each rule must be an object");
            string? email = null, mode = null;
            foreach (var p in item.EnumerateObject())
            {
                switch (p.Name)
                {
                    case "email":
                        if (p.Value.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) return (null, "email must be a string");
                        email = p.Value.GetString();
                        break;
                    case "mode":
                        if (p.Value.ValueKind is not (JsonValueKind.String or JsonValueKind.Null)) return (null, "mode must be a string");
                        mode = p.Value.GetString();
                        break;
                    default:
                        return (null, $"Unknown field `{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}`");
                }
            }
            list.Add(new AutoApproveRuleDto(email ?? "", mode ?? ""));
        }
        foreach (var p in body.EnumerateObject())
        {
            if (p.Name != "rules") return (null, $"Unknown field `{(p.Name.Length > 40 ? p.Name[..40] : p.Name)}`");
        }
        return (list, null);
    }
}
