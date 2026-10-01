/**
 * Storage-limit vocabulary for the browser, with no filesystem behind it.
 *
 * Byte formatting is owned by `@/lib/format` (binary 1024). This leaf only
 * keeps the pure `StorageLimitKind` union and a thin re-export so Settings and
 * storage-override stay free of any Node-only module.
 */

import { formatBytesShort as formatBytesShortShared } from "@/lib/format";

/** @see StoragePolicyResult / storage budget kinds on the server. */
export type StorageLimitKind =
  | "setup"
  | "reserve"
  | "wont-fit"
  | "cap"
  | "inventory";

/** Human-readable bytes — binary 1024, same labels as the rest of the UI. */
export function formatBytesShort(n: number): string {
  return formatBytesShortShared(n);
}
