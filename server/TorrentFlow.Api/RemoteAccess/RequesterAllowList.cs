using Microsoft.AspNetCore.Mvc.ApplicationModels;

namespace TorrentFlow.Api.RemoteAccess;

/// <summary>
/// Single source of truth for what a requester may call. Path pre-check (<see cref="RequesterPaths"/>), endpoint
/// metadata (via <see cref="RequesterAllowConvention"/>), and the table-driven test all derive from this list.
/// Controllers in other assemblies cannot call <c>AllowRequesters()</c>, so method+route matching is applied here.
/// </summary>
public static class RequesterAllowList
{
    /// <summary>
    /// <see cref="Prefix"/> matches any method under the path; otherwise only the listed HTTP method is allowed.
    /// Patterns are lowercase, no leading slash, and use <c>{param}</c> for a single segment.
    /// </summary>
    public readonly record struct Rule(string Method, string Pattern, bool Prefix = false);

    /// <summary>Catalog + session surfaces a friend may use. Everything else stays owner-only by default.</summary>
    public static readonly Rule[] Rules =
    [
        // Session / shell (any method under these prefixes where applicable)
        new("GET", "api/me"),
        new("GET", "api/health"),
        new("GET", "api/features"),
        new("*", "api/requester", Prefix: true),
        new("*", "api/notifications", Prefix: true),

        // Read-only catalog the unified web UI needs (method-specific)
        new("GET", "api/search/titles"),
        new("GET", "api/suggest"),
        new("GET", "api/title/{workKey}"),
        new("GET", "api/title/{workKey}/extras"),
        new("GET", "api/browse"),
        new("GET", "api/recommendations"),
        // Artwork is a pure metadata lookup (title/year → poster/backdrop URLs); nothing user-controlled is persisted.
        new("POST", "api/artwork"),
    ];

    /// <summary>
    /// Pre-routing gate. Non-<c>/api</c> paths are the SPA/static shell. Empty segments are ignored so
    /// <c>//api/x</c> cannot slip past; casing never matters; <c>api.</c> / <c>%</c> / <c>\</c> tricks are refused.
    /// </summary>
    public static bool IsAllowed(string method, PathString path)
    {
        var segments = (path.Value ?? "").Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (segments.Length == 0) return true;
        if (!IsApiSegment(segments[0])) return true;
        if (segments.Length < 2) return false;

        var pathKey = string.Join('/', segments.Select(s => s.ToLowerInvariant()));
        var verb = (method ?? "GET").Trim().ToUpperInvariant();
        if (verb == "HEAD") verb = "GET";

        foreach (var rule in Rules)
        {
            if (rule.Prefix)
            {
                var prefix = rule.Pattern.Trim('/').ToLowerInvariant();
                if (pathKey == prefix || pathKey.StartsWith(prefix + "/", StringComparison.Ordinal))
                    return rule.Method is "*" || string.Equals(rule.Method, verb, StringComparison.OrdinalIgnoreCase);
                continue;
            }

            if (!MethodMatches(rule.Method, verb)) continue;
            if (MatchesTemplate(rule.Pattern, segments)) return true;
        }

        return false;
    }

    public static bool MatchesEndpoint(string? httpMethodsJoined, string routePattern)
    {
        var pattern = (routePattern ?? "").Trim('/');
        var methods = (httpMethodsJoined ?? "*").Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        if (methods.Length == 0) methods = ["*"];

        foreach (var rule in Rules)
        {
            if (rule.Prefix)
            {
                var prefix = rule.Pattern.Trim('/');
                if (pattern.Equals(prefix, StringComparison.OrdinalIgnoreCase)
                    || pattern.StartsWith(prefix + "/", StringComparison.OrdinalIgnoreCase)
                    || pattern.StartsWith(prefix + "{", StringComparison.OrdinalIgnoreCase))
                    return true;
                continue;
            }

            if (!methods.Any(m => MethodMatches(rule.Method, m))) continue;
            if (TemplatesEqual(rule.Pattern, pattern)) return true;
        }

        return false;
    }

    private static bool MethodMatches(string ruleMethod, string actual) =>
        ruleMethod is "*" || string.Equals(ruleMethod, actual, StringComparison.OrdinalIgnoreCase)
        || (string.Equals(ruleMethod, "GET", StringComparison.OrdinalIgnoreCase)
            && string.Equals(actual, "HEAD", StringComparison.OrdinalIgnoreCase));

    private static bool MatchesTemplate(string template, string[] pathSegments)
    {
        var parts = template.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        // pathSegments[0] is "api"; template starts with "api"
        if (parts.Length != pathSegments.Length) return false;
        for (var i = 0; i < parts.Length; i++)
        {
            var part = parts[i];
            if (part.StartsWith('{') && part.EndsWith('}')) continue;
            if (!string.Equals(part, pathSegments[i], StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    private static bool TemplatesEqual(string rule, string endpoint)
    {
        var a = rule.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        var b = endpoint.Trim('/').Split('/', StringSplitOptions.RemoveEmptyEntries);
        if (a.Length != b.Length) return false;
        for (var i = 0; i < a.Length; i++)
        {
            var left = a[i];
            var right = b[i];
            var leftParam = left.StartsWith('{') && left.EndsWith('}');
            var rightParam = right.StartsWith('{') && right.EndsWith('}');
            if (leftParam || rightParam)
            {
                if (leftParam != rightParam) return false;
                continue;
            }
            if (!string.Equals(left, right, StringComparison.OrdinalIgnoreCase)) return false;
        }
        return true;
    }

    // "api" with trailing dots/spaces is treated as api too; Windows-style trimming must not create a bypass.
    // Encoded tricks (% / \) are refused by treating the segment as api-shaped so the path fails the allow list.
    internal static bool IsApiSegment(string segment) =>
        string.Equals(segment.TrimEnd('.', ' '), "api", StringComparison.OrdinalIgnoreCase)
        || segment.Contains('%') || segment.Contains('\\');
}

/// <summary>Marks matching controller actions with <see cref="RequesterAccess.Allowed"/> so the post-routing gate agrees with the path table.</summary>
public sealed class RequesterAllowConvention : IApplicationModelConvention
{
    public void Apply(ApplicationModel application)
    {
        foreach (var controller in application.Controllers)
        {
            foreach (var action in controller.Actions)
            {
                var methods = action.Attributes.OfType<Microsoft.AspNetCore.Mvc.Routing.HttpMethodAttribute>()
                    .SelectMany(a => a.HttpMethods).Distinct(StringComparer.OrdinalIgnoreCase).ToArray();
                if (methods.Length == 0) methods = ["*"];

                foreach (var selector in action.Selectors)
                {
                    var template = BuildTemplate(controller, selector);
                    if (template is null) continue;
                    var joined = string.Join(',', methods);
                    if (!RequesterAllowList.MatchesEndpoint(joined, template)) continue;
                    selector.EndpointMetadata.Add(RequesterAccess.Allowed);
                }
            }
        }
    }

    private static string? BuildTemplate(ControllerModel controller, SelectorModel selector)
    {
        var actionTemplate = selector.AttributeRouteModel?.Template;
        // Absolute action routes (e.g. [HttpGet("/api/browse")]) win on their own.
        if (!string.IsNullOrEmpty(actionTemplate) && actionTemplate.StartsWith('/'))
            return actionTemplate.Trim('/');

        var controllerTemplate = controller.Selectors
            .Select(s => s.AttributeRouteModel?.Template)
            .FirstOrDefault(t => !string.IsNullOrEmpty(t));

        // Bare [HttpGet] under [Route("api/title/{workKey}")] → api/title/{workKey}
        if (string.IsNullOrEmpty(actionTemplate))
            return string.IsNullOrEmpty(controllerTemplate) ? null : controllerTemplate.Trim('/');

        if (string.IsNullOrEmpty(controllerTemplate)) return actionTemplate.Trim('/');
        return $"{controllerTemplate.Trim('/')}/{actionTemplate.Trim('/')}";
    }
}

