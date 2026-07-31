export type UnsafeDownloadPathReason =
  | "test-directory"
  | "dependencies"
  | "temporary-directory"
  | "inside-repository";

export interface DownloadPathSafety {
  unsafe: boolean;
  reasons: UnsafeDownloadPathReason[];
}

export interface DownloadPathSafetyOptions {
  repoRoot?: string | null;
  tempRoots?: readonly string[];
}

const TEST_SEGMENT =
  /(?:^|[._-])e2e(?:$|[._-])|^(?:\.?playwright(?:[-_.].*)?|test-results?|playwright-report)$/i;
const TEMP_SEGMENT = /^(?:\.?tmp|\.?temp)$/i;

function normalizePath(value: string): string {
  const normalized = value
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .toLowerCase();
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : normalized;
}

function pathSegments(value: string): string[] {
  return normalizePath(value).split("/").filter(Boolean);
}

function isInside(candidate: string, root: string): boolean {
  const normalizedCandidate = normalizePath(candidate);
  const normalizedRoot = normalizePath(root);
  if (!normalizedCandidate || !normalizedRoot) return false;
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}

/**
 * Classify paths that are likely to be disposable. This never changes a path;
 * it only supplies evidence for the settings warning.
 */
export function detectUnsafeDownloadPath(
  value: string | null | undefined,
  options: DownloadPathSafetyOptions = {},
): DownloadPathSafety {
  const path = String(value ?? "").trim();
  if (!path) return { unsafe: false, reasons: [] };

  const segments = pathSegments(path);
  const reasons = new Set<UnsafeDownloadPathReason>();

  if (segments.some((segment) => TEST_SEGMENT.test(segment))) {
    reasons.add("test-directory");
  }
  if (segments.includes("node_modules")) {
    reasons.add("dependencies");
  }
  if (
    segments.some((segment) => TEMP_SEGMENT.test(segment)) ||
    (options.tempRoots ?? []).some((root) => isInside(path, root))
  ) {
    reasons.add("temporary-directory");
  }
  if (options.repoRoot && isInside(path, options.repoRoot)) {
    reasons.add("inside-repository");
  }

  return { unsafe: reasons.size > 0, reasons: [...reasons] };
}

export function unsafeDownloadPathMessage(
  reasons: readonly UnsafeDownloadPathReason[],
): string {
  const detail = reasons.includes("inside-repository")
    ? "It is inside the TorrentFlow project."
    : reasons.includes("temporary-directory")
      ? "It is in a temporary directory."
      : reasons.includes("dependencies")
        ? "It is inside node_modules."
        : "It looks like a test directory.";
  return `${detail} Tests, updates, or cleanup tools may remove files stored there. Choose a permanent media folder; TorrentFlow will not move existing files automatically.`;
}
