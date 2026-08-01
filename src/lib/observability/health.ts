export const HEALTH_COMPONENTS = [
  "database",
  "title-search",
  "torrent-client",
  "automation",
  "rules",
  "prewarm",
  "playback",
] as const;

export type HealthComponent = (typeof HEALTH_COMPONENTS)[number];

export const HEALTH_EVENT_CODES = [
  "DATABASE_READY",
  "DATABASE_UNAVAILABLE",
  "TITLE_SEARCH_SUCCEEDED",
  "TITLE_SEARCH_FAILED",
  "TORRENT_LIST_SUCCEEDED",
  "TORRENT_LIST_FAILED",
  "TORRENT_CONTROL_SUCCEEDED",
  "TORRENT_CONTROL_FAILED",
  "AUTOMATION_SUCCEEDED",
  "AUTOMATION_FAILED",
  "RULES_SUCCEEDED",
  "RULES_FAILED",
  "PREWARM_DISPATCHED",
  "PREWARM_FAILED",
  "PREWARM_SKIPPED",
  "PLAYBACK_PLAN_SUCCEEDED",
  "PLAYBACK_PLAN_FAILED",
  "PLAYBACK_CACHE_FAILED",
  "PLAYBACK_FAILOVER_SUCCEEDED",
  "PLAYBACK_FAILOVER_FAILED",
] as const;

export type HealthEventCode = (typeof HEALTH_EVENT_CODES)[number];
export type HealthOutcome = "success" | "degraded" | "failure";

export type ComponentHealthEvent = {
  at: string;
  outcome: HealthOutcome;
  code: HealthEventCode;
};

export type ComponentHealthSummary = {
  component: HealthComponent;
  status: "unknown" | "healthy" | "degraded" | "unhealthy";
  total: number;
  successes: number;
  degraded: number;
  failures: number;
  lastEventAt: string | null;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastCode: HealthEventCode | null;
  events: ComponentHealthEvent[];
};

const COMPONENT_SET = new Set<string>(HEALTH_COMPONENTS);
const EVENT_CODE_SET = new Set<string>(HEALTH_EVENT_CODES);
const DEFAULT_EVENTS_PER_COMPONENT = 12;

function blankSummary(component: HealthComponent): ComponentHealthSummary {
  return {
    component,
    status: "unknown",
    total: 0,
    successes: 0,
    degraded: 0,
    failures: 0,
    lastEventAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastCode: null,
    events: [],
  };
}

export class ComponentHealthStore {
  readonly maxEventsPerComponent: number;
  private readonly states = new Map<HealthComponent, ComponentHealthSummary>();
  private readonly now: () => Date;

  constructor(
    maxEventsPerComponent = DEFAULT_EVENTS_PER_COMPONENT,
    now: () => Date = () => new Date(),
  ) {
    this.maxEventsPerComponent = Math.max(
      1,
      Math.min(100, Math.trunc(maxEventsPerComponent) || DEFAULT_EVENTS_PER_COMPONENT),
    );
    this.now = now;
    for (const component of HEALTH_COMPONENTS) {
      this.states.set(component, blankSummary(component));
    }
  }

  record(component: string, outcome: HealthOutcome, code: string): boolean {
    if (!COMPONENT_SET.has(component) || !EVENT_CODE_SET.has(code)) return false;
    const typedComponent = component as HealthComponent;
    const typedCode = code as HealthEventCode;
    const state = this.states.get(typedComponent);
    if (!state) return false;

    const at = this.now().toISOString();
    state.total += 1;
    state.lastEventAt = at;
    state.lastCode = typedCode;
    if (outcome === "success") {
      state.successes += 1;
      state.lastSuccessAt = at;
      state.status = "healthy";
    } else if (outcome === "degraded") {
      state.degraded += 1;
      state.lastFailureAt = at;
      state.status = "degraded";
    } else {
      state.failures += 1;
      state.lastFailureAt = at;
      state.status = "unhealthy";
    }

    state.events.push({ at, outcome, code: typedCode });
    if (state.events.length > this.maxEventsPerComponent) {
      state.events.splice(0, state.events.length - this.maxEventsPerComponent);
    }
    return true;
  }

  snapshot(): ComponentHealthSummary[] {
    return HEALTH_COMPONENTS.map((component) => {
      const state = this.states.get(component) ?? blankSummary(component);
      return { ...state, events: state.events.map((event) => ({ ...event })) };
    });
  }
}

const globalHealth = globalThis as unknown as {
  torrentFlowComponentHealth?: ComponentHealthStore;
};

export const componentHealth =
  globalHealth.torrentFlowComponentHealth ?? new ComponentHealthStore();

if (!globalHealth.torrentFlowComponentHealth) {
  globalHealth.torrentFlowComponentHealth = componentHealth;
}

export function recordComponentHealth(
  component: HealthComponent,
  outcome: HealthOutcome,
  code: HealthEventCode,
): void {
  componentHealth.record(component, outcome, code);
}

export function componentHealthSnapshot(): ComponentHealthSummary[] {
  return componentHealth.snapshot();
}
