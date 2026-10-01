/**
 * Storage-limit vocabulary for the browser, with no filesystem behind it.
 *
 * Byte formatting is owned by `@/lib/format` (`formatBytes`). This leaf only
 * keeps the pure `StorageLimitKind` union so Settings and storage-override stay
 * free of any Node-only module.
 */

/** @see StoragePolicyResult / storage budget kinds on the server. */
export type StorageLimitKind =
  | "setup"
  | "reserve"
  | "wont-fit"
  | "cap"
  | "inventory";
