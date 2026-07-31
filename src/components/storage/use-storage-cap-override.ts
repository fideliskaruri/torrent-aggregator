"use client";

/**
 * React binding for the "confirm, don't block" storage rule.
 *
 * The rule itself lives in `@/lib/library/storage-override` and is pure — this
 * hook only supplies the missing half: turning a dialog into a promise the rule
 * can await. Every send surface uses this rather than repeating the flow, so a
 * new surface cannot accidentally ship the old dead-end behaviour.
 *
 * Usage:
 *
 *   const cap = useStorageCapOverride();
 *   ...
 *   const outcome = await cap.run(({ overrideStorageCap }) => send({ overrideStorageCap }));
 *   if (outcome.status === "cancelled") return;   // the user said no
 *   ...
 *   <StorageCapDialog {...cap.dialogProps} />
 */

import { useCallback, useRef, useState } from "react";
import {
  runWithStorageOverride,
  type StorageOverrideFacts,
  type StorageOverrideOutcome,
} from "@/lib/library/storage-override";

export interface UseStorageCapOverride {
  /**
   * Run a send through the override rule. Resolves `cancelled` when the owner
   * declines; rethrows anything that is not an overridable storage refusal.
   */
  run: <T>(
    attempt: (opts: { overrideStorageCap: boolean }) => Promise<T>,
  ) => Promise<StorageOverrideOutcome<T>>;
  /** Spread onto `<StorageCapDialog />`. */
  dialogProps: {
    facts: StorageOverrideFacts | null;
    onCancel: () => void;
    onConfirm: () => void;
  };
}

export function useStorageCapOverride(): UseStorageCapOverride {
  const [facts, setFacts] = useState<StorageOverrideFacts | null>(null);
  // Held in a ref, not state: the pending decision is not rendered, and putting
  // it in state would re-run the resolver identity on every keystroke elsewhere.
  const decide = useRef<((proceed: boolean) => void) | null>(null);

  const settle = useCallback((proceed: boolean) => {
    const resolve = decide.current;
    decide.current = null;
    setFacts(null);
    // A dialog that is dismissed twice (Esc during the close animation) must not
    // resolve twice — the null-out above makes the second call a no-op.
    resolve?.(proceed);
  }, []);

  const run = useCallback(
    <T,>(attempt: (opts: { overrideStorageCap: boolean }) => Promise<T>) =>
      runWithStorageOverride(attempt, (next) => {
        // A second refusal while one is already on screen would strand the first
        // promise forever. Decline the newcomer rather than replacing the dialog.
        if (decide.current) return Promise.resolve(false);
        setFacts(next);
        return new Promise<boolean>((resolve) => {
          decide.current = resolve;
        });
      }),
    [],
  );

  const onCancel = useCallback(() => settle(false), [settle]);
  const onConfirm = useCallback(() => settle(true), [settle]);

  return { run, dialogProps: { facts, onCancel, onConfirm } };
}
