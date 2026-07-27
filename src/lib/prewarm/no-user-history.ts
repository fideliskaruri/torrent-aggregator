/**
 * A Prisma facade that drops exactly one write: `downloadHistory.create`.
 *
 * WHY THIS EXISTS
 * ---------------
 * `runGrabPipeline` is the single shared search → select → dedupe → viability →
 * send → record path. Three duplicated copies were deliberately collapsed into
 * it and a fourth must not be created, so a speculative pre-warm grab goes
 * through it like everything else.
 *
 * But the pipeline unconditionally writes a `DownloadHistory` row, and
 * `/history` — the download log — renders every one of them with no way to
 * tell them apart. `DownloadHistory` has no `kind` column; `GrabJob` does.
 * A pre-warm the user never asked for, listed in their download log next to
 * things they did ask for, is the app claiming a user action that never
 * happened. That is the exact bug class this repo has already been caught by
 * five times, and it is a stated hard invariant of this work.
 *
 * So the row is not written. The pre-warm is still fully auditable: it writes a
 * `GrabJob` with `kind: "prewarm"`, which Activity already surfaces and can
 * label, and it leaves an `EngineTorrent` row with `origin: "prewarm"`.
 * Nothing is hidden — the record simply lives where it can be attributed.
 *
 * THE HONEST CAVEAT
 * -----------------
 * `_prisma` is a test seam on `GrabPipelineOptions` and using it in production
 * is a workaround, not a design. The right fix is a
 * `recordDownloadHistory?: boolean` option on the pipeline, which is owned by
 * another module. Until that exists, this is the least-bad way to satisfy the
 * invariant without forking the pipeline. The interception is deliberately
 * *deny-one, allow-everything-else*: any write the pipeline gains in future
 * passes straight through, which is the safe default.
 */

type Suppression = { suppressed: number };

const SUPPRESSED_ROW = Object.freeze({ __prewarmSuppressed: true as const });

function wrapDownloadHistory(delegate: object, stats: Suppression): object {
  return new Proxy(delegate, {
    get(target, prop) {
      if (prop === "create") {
        return async () => {
          stats.suppressed += 1;
          return SUPPRESSED_ROW;
        };
      }
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function wrap<T extends object>(base: T, stats: Suppression): T {
  return new Proxy(base, {
    get(target, prop) {
      // `Reflect.get(target, prop)` — receiver defaults to the real client, so
      // Prisma's internal getters keep working. Passing the proxy as receiver
      // breaks them.
      const value = Reflect.get(target, prop);

      if (prop === "downloadHistory" && value && typeof value === "object") {
        return wrapDownloadHistory(value as object, stats);
      }

      if (prop === "$transaction" && typeof value === "function") {
        const original = value as (...args: unknown[]) => unknown;
        return (...args: unknown[]) => {
          const [first, ...rest] = args;
          if (typeof first === "function") {
            const cb = first as (tx: object) => unknown;
            // The hooks that run inside the transaction get the same facade,
            // so the suppression holds for the atomic block too.
            return original.call(
              target,
              (tx: object) => cb(wrap(tx, stats)),
              ...rest,
            );
          }
          return original.call(target, ...args);
        };
      }

      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
}

/**
 * Wrap a Prisma client (or transaction handle) so `downloadHistory.create` is
 * a no-op. Every other model, operation and `$transaction` behaves normally.
 */
export function withoutDownloadHistory<T extends object>(
  base: T,
): { db: T; stats: Suppression } {
  const stats: Suppression = { suppressed: 0 };
  return { db: wrap(base, stats), stats };
}
