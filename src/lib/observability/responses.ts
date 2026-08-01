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
  options: { now?: Date; uptimeSeconds?: number; buildId?: string } = {},
) {
  return {
    ...buildPublicHealthResponse(database, options),
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
