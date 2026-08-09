import type { ComponentHealthSummary } from "./health";

export type DatabaseReadiness = {
  ready: boolean;
  latencyMs: number;
};

function safeBuildId(raw: string | undefined): string {
  const value = raw?.trim();
  const contentHash = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;
  return value &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value) &&
    !contentHash.test(value)
    ? value
    : "unknown";
}

export function currentBuildId(): string {
  return safeBuildId(
    process.env.NEXT_PUBLIC_BUILD_ID ??
      process.env.BUILD_ID ??
      process.env.npm_package_version,
  );
}

export function buildPublicHealthResponse(
  database: DatabaseReadiness,
  options: { now?: Date; uptimeSeconds?: number; buildId?: string } = {},
) {
  const ready = database.ready;
  return {
    status: ready ? "ok" : "degraded",
    live: true,
    ready,
    timestamp: (options.now ?? new Date()).toISOString(),
    process: {
      status: "up",
      uptimeSeconds: Math.max(
        0,
        Math.floor(options.uptimeSeconds ?? process.uptime()),
      ),
    },
    build: {
      id: safeBuildId(options.buildId ?? currentBuildId()),
    },
    database: {
      status: ready ? "up" : "down",
      latencyMs: Math.max(0, Math.min(30_000, Math.round(database.latencyMs))),
    },
  } as const;
}

export function buildDiagnosticsHealthResponse(
  database: DatabaseReadiness,
  components: ComponentHealthSummary[],
  options: {
    now?: Date;
    uptimeSeconds?: number;
    buildId?: string;
    caches?: Record<string, number>;
    /** Names currently present in the cache registry (proof it is not empty). */
    cacheNames?: string[];
    /** Registered-cache names the barrel expected but did not find. */
    missingCaches?: string[];
    enginePressure?: unknown;
    /** Cumulative completion-sweep counters (park attempts vs. failures). */
    completionSweep?: unknown;
    eventLoopDelay?: unknown;
  /** Recent-window event-loop lag; see vent-loop-recent.ts. */
  eventLoopDelayRecent?: unknown;
  } = {},
) {
  return {
    ...buildPublicHealthResponse(database, options),
    // Cache cardinality over the session — a growing map here is the signature
    // of the slow-degradation bug (BUG-011); one request now diagnoses it.
    caches: options.caches ?? {},
    // Additive only. Every field below is new; nothing above changed shape, so
    // existing consumers of this payload keep reading exactly what they read
    // before.
    cacheRegistry: {
      names: options.cacheNames ?? Object.keys(options.caches ?? {}).sort(),
      missing: options.missingCaches ?? [],
    },
    enginePressure: options.enginePressure ?? null,
    completionSweep: options.completionSweep ?? null,
    eventLoopDelay: options.eventLoopDelay ?? null,
    eventLoopDelayRecent: options.eventLoopDelayRecent ?? null,
    components: components.map((component) => ({
      component: component.component,
      status: component.status,
      counters: {
        total: component.total,
        successes: component.successes,
        degraded: component.degraded,
        failures: component.failures,
      },
      lastEventAt: component.lastEventAt,
      lastSuccessAt: component.lastSuccessAt,
      lastFailureAt: component.lastFailureAt,
      lastCode: component.lastCode,
      events: component.events.map((event) => ({ ...event })),
    })),
  } as const;
}
