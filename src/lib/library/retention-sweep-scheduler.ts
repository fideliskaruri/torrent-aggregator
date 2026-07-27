/**
 * Background retention sweep scheduler.
 *
 * The sweep itself is deliberately conservative and defaults to preview. This
 * file is the missing invocation point: it periodically previews the ephemeral
 * cache, and only if that preview proves the stream cache is over budget does it
 * run the destructive pass. No pressure, no deletion.
 *
 * The user-facing opt-out is the existing retention default: choosing
 * "Keep everything" means new sends are permanent and this scheduler is disabled
 * for that user. The default remains stream-only/automatic reclamation because
 * that is the owner's stated product intent: streamed content is transient;
 * tracked/watchlisted/explicitly-kept content is retained.
 */
import { LOCAL_USER_ID } from "@/lib/auth-constants";
import { getUserClientConfig } from "@/lib/clients";
import type { ClientConnectionConfig } from "@/lib/clients/types";
import { foregroundActive } from "@/lib/prewarm/foreground";
import { STREAM_CACHE_GRACE_MS } from "@/lib/streaming/retention";
import {
  RETENTION_POLICY_KEPT,
  readDefaultRetentionPolicy,
  type RetentionPolicy,
} from "./retention-settings";
import {
  sweepRetentionCache,
  type RetentionSweepResult,
} from "./retention-sweep";

/**
 * Steady-state cadence between retention previews.
 *
 * Chosen against STREAM_CACHE_GRACE_MS (6h). The sweep cannot delete an item
 * until it is fully watched and at least one full grace window old; a 30-minute
 * cadence means an eligible stream cache entry is normally reclaimed within
 * 30 minutes after that 6h protection expires, while avoiding constant disk and
 * DB churn. Preview is cheap and the destructive pass only runs under pressure.
 */
export const RETENTION_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

/** Retry soon after playback stops instead of waiting a full cadence. */
export const RETENTION_SWEEP_FOREGROUND_RETRY_MS = 60 * 1000;

/** Poll for settings/client changes while sweeping is disabled or unavailable. */
export const RETENTION_SWEEP_DISABLED_POLL_MS = 5 * 60 * 1000;

/** Stagger behind automation (30s) and pre-probe (45s) startup timers. */
export const RETENTION_SWEEP_STARTUP_DELAY_MS = 75 * 1000;

const GLOBAL_KEY = Symbol.for("torrentflow.retention-sweep.scheduler");

type SchedulerState = { started: boolean; timer: NodeJS.Timeout | null };

function state(): SchedulerState {
  const g = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  if (!g[GLOBAL_KEY]) g[GLOBAL_KEY] = { started: false, timer: null };
  return g[GLOBAL_KEY]!;
}

export interface RetentionSweepTickDeps {
  userId?: string;
  isForeground?: () => boolean;
  resolvePolicy?: (userId: string) => Promise<RetentionPolicy>;
  getConfig?: (userId: string) => Promise<ClientConnectionConfig | null>;
  sweep?: (opts: {
    userId: string;
    config: ClientConnectionConfig;
    mode: "preview" | "delete";
  }) => Promise<RetentionSweepResult>;
  log?: Pick<Console, "log" | "warn" | "error">;
}

export interface RetentionSweepTickOutcome {
  delayMs: number;
  ran: boolean;
  skipped?:
    | "disabled"
    | "foreground"
    | "settings-error"
    | "no-client"
    | "under-budget"
    | "preview-error"
    | "delete-error";
  preview?: RetentionSweepResult;
  result?: RetentionSweepResult;
}

function summarizeSkips(result: RetentionSweepResult): string {
  const counts = new Map<string, number>();
  for (const s of result.skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([reason, count]) => `${reason}=${count}`)
    .join(" · ");
}

export async function runRetentionSweepTick(
  deps: RetentionSweepTickDeps = {},
): Promise<RetentionSweepTickOutcome> {
  const userId = deps.userId ?? LOCAL_USER_ID;
  const log = deps.log ?? console;
  const isForeground = deps.isForeground ?? foregroundActive;
  const resolvePolicy =
    deps.resolvePolicy ?? (async (u) => (await readDefaultRetentionPolicy(u)).policy);
  const getConfig = deps.getConfig ?? ((u) => getUserClientConfig(u));
  const sweep =
    deps.sweep ??
    ((opts) =>
      sweepRetentionCache({
        userId: opts.userId,
        config: opts.config,
        mode: opts.mode,
      }));

  let policy: RetentionPolicy;
  try {
    policy = await resolvePolicy(userId);
  } catch (err) {
    log.error("[retention-sweep] could not read retention setting", err);
    return { delayMs: RETENTION_SWEEP_DISABLED_POLL_MS, ran: false, skipped: "settings-error" };
  }

  if (policy === RETENTION_POLICY_KEPT) {
    return { delayMs: RETENTION_SWEEP_DISABLED_POLL_MS, ran: false, skipped: "disabled" };
  }

  if (isForeground()) {
    return { delayMs: RETENTION_SWEEP_FOREGROUND_RETRY_MS, ran: false, skipped: "foreground" };
  }

  let config: ClientConnectionConfig | null;
  try {
    config = await getConfig(userId);
  } catch (err) {
    log.error("[retention-sweep] could not read client config", err);
    return { delayMs: RETENTION_SWEEP_DISABLED_POLL_MS, ran: false, skipped: "settings-error" };
  }
  if (!config) {
    return { delayMs: RETENTION_SWEEP_DISABLED_POLL_MS, ran: false, skipped: "no-client" };
  }

  let preview: RetentionSweepResult;
  try {
    preview = await sweep({ userId, config, mode: "preview" });
  } catch (err) {
    log.error("[retention-sweep] preview failed", err);
    return { delayMs: RETENTION_SWEEP_INTERVAL_MS, ran: false, skipped: "preview-error" };
  }

  if (preview.usedBytes <= preview.budgetBytes) {
    log.log(
      `[retention-sweep] under budget · used ${preview.usedBytes} / ${preview.budgetBytes}`,
    );
    return {
      delayMs: RETENTION_SWEEP_INTERVAL_MS,
      ran: false,
      skipped: "under-budget",
      preview,
    };
  }

  if (isForeground()) {
    return {
      delayMs: RETENTION_SWEEP_FOREGROUND_RETRY_MS,
      ran: false,
      skipped: "foreground",
      preview,
    };
  }

  try {
    const result = await sweep({ userId, config, mode: "delete" });
    log.log(
      `[retention-sweep] reclaimed ${result.reclaimedBytes} bytes from ${result.deleted.length} item(s) · ` +
        `used ${result.usedBytes} / ${result.budgetBytes} · ` +
        `satisfied=${result.satisfied}` +
        (result.skipped.length ? ` · skipped ${summarizeSkips(result)}` : ""),
    );
    return { delayMs: RETENTION_SWEEP_INTERVAL_MS, ran: true, preview, result };
  } catch (err) {
    log.error("[retention-sweep] delete pass failed", err);
    return {
      delayMs: RETENTION_SWEEP_INTERVAL_MS,
      ran: false,
      skipped: "delete-error",
      preview,
    };
  }
}

function schedule(delayMs: number): void {
  const s = state();
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void runRetentionSweepTick().then((o) => schedule(o.delayMs));
  }, delayMs);
  s.timer.unref?.();
}

/** Idempotent: safe to call on every module evaluation. */
export function startRetentionSweepScheduler(): void {
  const s = state();
  if (s.started) return;
  s.started = true;
  schedule(RETENTION_SWEEP_STARTUP_DELAY_MS);
  console.log("[retention-sweep] scheduler armed");
}
