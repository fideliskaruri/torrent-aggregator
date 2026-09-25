export interface DisplayPathMapping {
  containerPath: string;
  hostPath: string;
}

/** Presentation only: never send a translated path back to a filesystem API. */
export function displayPath(path: string, mappings: DisplayPathMapping[]): string {
  const match = mappings
    .filter((m) => typeof m?.containerPath === "string" && typeof m?.hostPath === "string" && m.hostPath.trim())
    .map((m) => ({ ...m, containerPath: m.containerPath.replace(/\/+$/, "") }))
    .filter((m) => m.containerPath.startsWith("/") &&
      (path === m.containerPath || path.startsWith(`${m.containerPath}/`)))
    .sort((a, b) => b.containerPath.length - a.containerPath.length)[0];
  if (!match) return path;
  const separator = /^(\\\\|[A-Za-z]:\\)/.test(match.hostPath) ? "\\" : "/";
  const suffix = path.slice(match.containerPath.length).replaceAll("/", separator);
  return match.hostPath.replace(/[/\\]+$/, "") + suffix;
}
