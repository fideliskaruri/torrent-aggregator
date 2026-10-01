import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** Join short metadata facts with a real, spoken separator. */
export function factsLine(
  parts: readonly (string | null | undefined | false)[],
): string {
  return parts
    .map((part) => (typeof part === "string" ? part.trim() : ""))
    .filter((part) => part.length > 0)
    .join(" · ");
}

// Formatting lives in `@/lib/format`. Re-exported here so older imports keep working.
export {
  formatBytes,
  formatDuration,
  formatRelativeTime,
} from "./format";
