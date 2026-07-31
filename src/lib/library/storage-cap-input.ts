/**
 * Reading a storage cap off the wire, where three inputs mean three things.
 *
 * ## The bug this exists to prevent
 *
 * The cap is the single setting that gates every download. When it is absent
 * the app reports `setupComplete: false` and refuses all downloads with "finish
 * setup first" — correct behaviour for a genuinely unconfigured install, and a
 * catastrophe if something clears the cap by accident.
 *
 * The old parser did exactly that. It collapsed "clear it" and "that isn't a
 * number" into one branch:
 *
 * ```ts
 * if (value == null || !Number.isFinite(value) || value <= 0) { clear(); }
 * ```
 *
 * `Number.isFinite("20")` is `false` — it does not coerce, unlike the global
 * `isFinite`. So a cap sent as a string, which is the exact shape an `<input>`
 * hands you when nobody parses it, took the clear branch. The request returned
 * 200 with no error, and every download from then on was refused. Measured
 * live: one `PUT {maxStorageGb: "1"}` flipped `setupComplete` to false.
 *
 * ## The rule
 *
 * | input | meaning | result |
 * |---|---|---|
 * | absent (`undefined`) | not part of this update | leave the stored cap |
 * | `null` or `0` | the owner unset it — 0 means unset in the UI | clear |
 * | any finite number > 0 | a cap | store it |
 * | a string, `NaN`, `Infinity`, a negative, an object | malformed | **reject** |
 *
 * The load-bearing line is the last one. Destroying configuration is not a
 * reasonable response to input you could not read, and answering 200 while
 * doing it is worse — it denies the caller the chance to notice. Malformed
 * input changes nothing and says so.
 */

/** A cap that could not be read. `reason` is safe to show a caller verbatim. */
export type StorageCapInputError = { ok: false; reason: string };

export type StorageCapInput =
  /** Not present in the request — leave whatever is stored. */
  | { ok: true; action: "keep" }
  /** Deliberately unset by the owner. */
  | { ok: true; action: "clear" }
  /** A real cap, already scaled to bytes. */
  | { ok: true; action: "set"; bytes: number }
  | StorageCapInputError;

/**
 * @param value the raw JSON value, which is why this takes `unknown` — the
 *   whole failure mode was trusting a declared `number` that arrived a string.
 * @param field name used in the error, so the caller knows which one was wrong.
 * @param scale multiplier to bytes (1e9 for GB, 1 for bytes).
 */
export function readStorageCapInput(
  value: unknown,
  field: string,
  scale: number,
): StorageCapInput {
  if (value === undefined) return { ok: true, action: "keep" };
  if (value === null) return { ok: true, action: "clear" };

  if (typeof value !== "number") {
    return {
      ok: false,
      reason: `${field} must be a number, received ${typeof value}. Use 0 or null to clear the cap.`,
    };
  }
  if (Number.isNaN(value)) {
    return { ok: false, reason: `${field} must be a number, received NaN.` };
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: `${field} must be a finite number.` };
  }
  if (value < 0) {
    return {
      ok: false,
      reason: `${field} cannot be negative. Use 0 to clear the cap.`,
    };
  }
  if (value === 0) return { ok: true, action: "clear" };

  const bytes = Math.round(value * scale);
  if (!Number.isSafeInteger(bytes)) {
    return { ok: false, reason: `${field} is too large to store.` };
  }
  return { ok: true, action: "set", bytes };
}
