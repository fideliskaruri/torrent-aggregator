/**
 * Byte formatting and the storage-limit vocabulary, with no filesystem behind it.
 *
 * `disk-space.ts` imports `node:fs` at module scope, so anything it exports drags
 * the Node filesystem into whatever bundle reaches it. Two of its exports —
 * the `StorageLimitKind` union and the `formatBytesShort` formatter — are pure
 * and are needed by code that also runs in the browser (`storage-override.ts`,
 * which the Settings page imports). Keeping them in this leaf is what lets a
 * client component name a storage limit without pulling `node:fs` into the
 * client chunk, which Turbopack refuses outright.
 *
 * `disk-space.ts` re-exports both, so existing server-side imports are unchanged.
 */

/** @see StoragePolicyResult in `disk-space.ts` */
export type StorageLimitKind = "setup" | "reserve" | "wont-fit" | "cap";

/** Human-readable bytes. */
export function formatBytesShort(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "?";
  if (n >= 1e12) return `${(n / 1e12).toFixed(1)} TB`;
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`;
  return `${Math.round(n)} B`;
}
