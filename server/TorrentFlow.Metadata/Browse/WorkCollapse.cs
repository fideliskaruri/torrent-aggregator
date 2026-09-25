using System.Text.RegularExpressions;

namespace TorrentFlow.Metadata.Browse;

/// <summary>collapse.ts CollapsibleRelease.</summary>
public sealed record CollapsibleRelease<T>(string? Name, DateTime SortAt, T Value)
{
    public string? WorkTitle { get; init; }
    public string? WorkKey { get; init; }
    public string? IdentityKey { get; init; }
    public bool HasArtwork { get; init; }
    public bool Prefer { get; init; }
}

/// <summary>collapse.ts CollapsedWork.</summary>
public sealed record CollapsedWork<T>(string WorkKey, string Title, T Value, string Name, int ReleaseCount);

/// <summary>src/lib/browse/collapse.ts: releases → works, first-seen order, prefer &gt; artwork &gt; recency.</summary>
public static partial class WorkCollapse
{
    public const string UnknownWorkTitle = "Unknown title";

    private sealed class Bucket<T>
    {
        public string? IdentityKey;
        public required HashSet<string> Aliases;
        public required string WorkKey;
        public required string Title;
        public required T Value;
        public required string Name;
        public int ReleaseCount;
        public DateTime SortAt;
        public bool HasArtwork;
        public bool Prefer;
    }

    public static List<CollapsedWork<T>> CollapseReleasesByWork<T>(IEnumerable<CollapsibleRelease<T>> releases)
    {
        var works = new List<Bucket<T>>();
        foreach (var release in releases)
        {
            var name = release.Name?.Trim();
            if (string.IsNullOrEmpty(name)) continue;
            var display = BrowseWorkDisplay(name);
            var explicitKey = release.WorkKey?.Trim();
            var workKey = string.IsNullOrEmpty(explicitKey) ? display.Key : explicitKey;
            var identityKey = string.IsNullOrEmpty(release.IdentityKey?.Trim()) ? null : release.IdentityKey!.Trim();
            var workTitle = release.WorkTitle?.Trim();
            var aliases = new HashSet<string>(StringComparer.Ordinal) { $"key:{workKey}", $"release:{display.Key}" };
            if (!string.IsNullOrEmpty(workTitle)) aliases.Add($"title:{BrowseWorkDisplay(release.WorkTitle!).Key}");
            var title = string.IsNullOrEmpty(workTitle) ? display.Title : workTitle;

            var matches = works.Where(w => identityKey != null && w.IdentityKey != null
                ? identityKey == w.IdentityKey
                : aliases.Any(w.Aliases.Contains)).ToList();
            if (identityKey is null && matches.Select(w => w.IdentityKey).Where(id => id != null).Distinct().Count() > 1)
                matches = matches.Where(w => w.IdentityKey is null).ToList();
            var existing = matches.FirstOrDefault(w => w.IdentityKey == identityKey)
                ?? matches.FirstOrDefault(w => w.IdentityKey != null) ?? matches.FirstOrDefault();

            if (existing is null)
            {
                works.Add(new Bucket<T>
                {
                    IdentityKey = identityKey, Aliases = aliases, WorkKey = workKey, Title = title, Value = release.Value,
                    Name = name, ReleaseCount = 1, SortAt = release.SortAt, HasArtwork = release.HasArtwork, Prefer = release.Prefer,
                });
                continue;
            }

            foreach (var match in matches)
            {
                if (ReferenceEquals(match, existing)) continue;
                existing.Aliases.UnionWith(match.Aliases);
                existing.ReleaseCount += match.ReleaseCount;
                if (Preferred(match.Prefer, match.HasArtwork, match.SortAt, existing))
                {
                    existing.Value = match.Value; existing.Name = match.Name; existing.Title = match.Title;
                    existing.SortAt = match.SortAt; existing.HasArtwork = match.HasArtwork; existing.Prefer = match.Prefer;
                }
                works.Remove(match);
            }
            existing.Aliases.UnionWith(aliases);
            if (identityKey != null && existing.IdentityKey is null) existing.IdentityKey = identityKey;
            if (identityKey != null && !string.IsNullOrEmpty(explicitKey)) existing.WorkKey = explicitKey;
            existing.ReleaseCount += 1;
            if (Preferred(release.Prefer, release.HasArtwork, release.SortAt, existing))
            {
                existing.Value = release.Value; existing.Name = name; existing.Title = title;
                existing.SortAt = release.SortAt; existing.HasArtwork = release.HasArtwork; existing.Prefer = release.Prefer;
            }
        }
        return works.Select(w => new CollapsedWork<T>(w.WorkKey, w.Title, w.Value, w.Name, w.ReleaseCount)).ToList();
    }

    private static bool Preferred<T>(bool prefer, bool hasArtwork, DateTime sortAt, Bucket<T> current)
    {
        if (prefer != current.Prefer) return prefer;
        if (hasArtwork != current.HasArtwork) return hasArtwork;
        return sortAt > current.SortAt;
    }

    /// <summary>collapse.ts browseWorkDisplay.</summary>
    public static (string Key, string Title) BrowseWorkDisplay(string name)
    {
        var trimmed = name.Trim();
        var identity = ReleaseNames.WorkIdentity(trimmed);
        var derived = identity.Name.Trim();
        var numbered = identity.IsSeries ? ExplicitNumberedSeriesTitle(trimmed, derived) : null;
        if (numbered != null) return ($"series:{NormalizeBrowseKey(numbered)}", numbered);
        if (derived.Length > 0 && !IsEpisodeOnlyLabel(derived))
            return (identity.Key.Length > 0 ? identity.Key : FallbackWorkKey(trimmed), derived);
        return (FallbackWorkKey(trimmed), trimmed.Length > 0 && !IsEpisodeOnlyLabel(trimmed) ? trimmed : UnknownWorkTitle);
    }

    private static string FallbackWorkKey(string name) => $"release:{Whitespace().Replace(name.ToLowerInvariant(), " ").Trim()}";

    private static string? ExplicitNumberedSeriesTitle(string releaseName, string identityTitle)
    {
        if (identityTitle.Length == 0 || IsEpisodeOnlyLabel(identityTitle)) return null;
        var normalized = Whitespace().Replace(DotsUnderscores().Replace(releaseName, " "), " ").Trim();
        var marker = SxxEyy().Match(normalized);
        if (!marker.Success || marker.Index <= 0) return null;
        var head = TrailingPunct().Replace(normalized[..marker.Index], "").Trim();
        if (!TrailingNumber().IsMatch(head)) return null;
        var headKey = NormalizeBrowseKey(head);
        var identityKey = NormalizeBrowseKey(identityTitle);
        if (headKey.Length == 0 || identityKey.Length == 0) return null;
        return TrailingNumber().Replace(headKey, "") == identityKey ? head : null;
    }

    public static string NormalizeBrowseKey(string s) =>
        Whitespace().Replace(NonAlnum().Replace(Apostrophes().Replace(s.ToLowerInvariant(), ""), " "), " ").Trim();

    public static bool IsEpisodeOnlyLabel(string value) =>
        EpisodeOnly().IsMatch(Whitespace().Replace(DotsDashes().Replace(value.ToLowerInvariant(), " "), " ").Trim());

    [GeneratedRegex(@"\s+")] private static partial Regex Whitespace();
    [GeneratedRegex(@"[._]+")] private static partial Regex DotsUnderscores();
    [GeneratedRegex(@"[._-]+")] private static partial Regex DotsDashes();
    [GeneratedRegex(@"\bS\d{1,3}\s*E\d{1,4}\b", RegexOptions.IgnoreCase)] private static partial Regex SxxEyy();
    [GeneratedRegex(@"[\s\-–—_:|.]+$")] private static partial Regex TrailingPunct();
    [GeneratedRegex(@"\s\d{1,4}$")] private static partial Regex TrailingNumber();
    [GeneratedRegex(@"['’`]")] private static partial Regex Apostrophes();
    [GeneratedRegex(@"[^\p{L}\p{N}]+")] private static partial Regex NonAlnum();
    [GeneratedRegex(@"^(?:s\d{1,3}\s*e\d{1,4}|\d{1,3}x\d{1,4}|e(?:p(?:isode)?)?\s*\d{1,4}|episode\s+\d{1,4})$")] private static partial Regex EpisodeOnly();
}
