import { randomUUID } from "node:crypto";
import {
  recordComponentHealth,
  type HealthComponent,
  type HealthEventCode,
  type HealthOutcome,
} from "./health";

export const CORRELATION_HEADER = "x-correlation-id";
const CORRELATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,63}$/;
const CONTENT_HASH_PATTERN = /^(?:[a-f0-9]{40}|[a-z2-7]{32})$/i;

const SAFE_FIELD_NAMES = [
  "action",
  "category",
  "clientType",
  "count",
  "durationMs",
  "limit",
  "offline",
  "resultCount",
  // Playback byte locality: "disk" | "swarm". Low-cardinality and carries no
  // user content — it is the field that tells you whether a completed download
  // is still being read through the swarm.
  "source",
  "status",
  "statusCode",
  "strategy",
] as const;

type SafeFieldName = (typeof SAFE_FIELD_NAMES)[number];
export type SafeLogFields = Partial<
  Record<SafeFieldName, string | number | boolean | null | undefined>
>;

const SAFE_FIELD_SET = new Set<string>(SAFE_FIELD_NAMES);
const SAFE_STRING_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;

export type SafeError = {
  name:
    | "AuthenticationError"
    | "DatabaseError"
    | "InputError"
    | "NotFoundError"
    | "TimeoutError"
    | "UnavailableError"
    | "InternalError";
  code:
    | "AUTHENTICATION_FAILED"
    | "DATABASE_UNAVAILABLE"
    | "INVALID_INPUT"
    | "NOT_FOUND"
    | "OPERATION_TIMEOUT"
    | "UPSTREAM_UNAVAILABLE"
    | "INTERNAL_ERROR";
  message: string;
};

export function correlationIdFromRequest(request: Request): string {
  const incoming =
    request.headers.get(CORRELATION_HEADER)?.trim() ||
    request.headers.get("x-request-id")?.trim();
  return incoming &&
    CORRELATION_PATTERN.test(incoming) &&
    !CONTENT_HASH_PATTERN.test(incoming)
    ? incoming
    : randomUUID();
}

export function sanitizeLogFields(
  fields: Record<string, unknown> | SafeLogFields,
): Record<string, string | number | boolean | null> {
  const safe: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!SAFE_FIELD_SET.has(key) || value === undefined) continue;
    if (value === null || typeof value === "boolean") {
      safe[key] = value;
    } else if (typeof value === "number" && Number.isFinite(value)) {
      safe[key] = Math.max(-1_000_000_000, Math.min(1_000_000_000, value));
    } else if (typeof value === "string") {
      safe[key] =
        SAFE_STRING_PATTERN.test(value) && !CONTENT_HASH_PATTERN.test(value)
          ? value
          : "[redacted]";
    }
  }
  return safe;
}

function errorText(error: unknown): string {
  if (!(error instanceof Error)) return "";
  const cause = error.cause instanceof Error ? error.cause.message : "";
  const code =
    "code" in error && typeof error.code === "string" ? error.code : "";
  return `${error.name} ${error.message} ${cause} ${code}`.slice(0, 2_000).toLowerCase();
}

export function normalizeError(error: unknown): SafeError {
  const text = errorText(error);
  if (/\b(401|403|unauthori[sz]ed|authentication|login failed)\b/.test(text)) {
    return {
      name: "AuthenticationError",
      code: "AUTHENTICATION_FAILED",
      message: "Authentication failed.",
    };
  }
  if (/\b(prisma|sqlite|database|sql_|p1001|p1008)\b/.test(text)) {
    return {
      name: "DatabaseError",
      code: "DATABASE_UNAVAILABLE",
      message: "The database is unavailable.",
    };
  }
  if (/\b(timeout|timed out|etimedout|aborterror)\b/.test(text)) {
    return {
      name: "TimeoutError",
      code: "OPERATION_TIMEOUT",
      message: "The operation timed out.",
    };
  }
  if (
    /\b(econnrefused|econnreset|enotfound|enetunreach|ehostunreach|fetch failed|networkerror|unreachable|not listening|cannot reach)\b/.test(
      text,
    )
  ) {
    return {
      name: "UnavailableError",
      code: "UPSTREAM_UNAVAILABLE",
      message: "A required service is unavailable.",
    };
  }
  if (/\b(enoent|not found|missing)\b/.test(text)) {
    return {
      name: "NotFoundError",
      code: "NOT_FOUND",
      message: "The requested resource was not found.",
    };
  }
  if (/\b(syntaxerror|invalid|malformed|validation)\b/.test(text)) {
    return {
      name: "InputError",
      code: "INVALID_INPUT",
      message: "The request could not be processed.",
    };
  }
  return {
    name: "InternalError",
    code: "INTERNAL_ERROR",
    message: "The operation could not be completed.",
  };
}

type LogLevel = "info" | "warn" | "error";

export class OperationObserver {
  readonly correlationId: string;
  readonly component: HealthComponent;
  readonly operation: string;
  private readonly startedAt = Date.now();

  constructor(request: Request, component: HealthComponent, operation: string) {
    this.correlationId = correlationIdFromRequest(request);
    this.component = component;
    this.operation = SAFE_STRING_PATTERN.test(operation) ? operation : "operation";
  }

  private emit(
    level: LogLevel,
    event: HealthEventCode,
    outcome: HealthOutcome,
    fields: SafeLogFields = {},
    error?: SafeError,
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      correlationId: this.correlationId,
      component: this.component,
      operation: this.operation,
      event,
      outcome,
      ...sanitizeLogFields({
        ...fields,
        durationMs: Date.now() - this.startedAt,
      }),
      ...(error ? { error } : {}),
    };
    const line = JSON.stringify(entry);
    if (level === "error") console.error(line);
    else if (level === "warn") console.warn(line);
    else console.info(line);
  }

  success(
    event: HealthEventCode,
    fields: SafeLogFields = {},
    options: { emit?: boolean } = {},
  ): void {
    recordComponentHealth(this.component, "success", event);
    if (options.emit !== false) this.emit("info", event, "success", fields);
  }

  degraded(event: HealthEventCode, fields: SafeLogFields = {}): void {
    recordComponentHealth(this.component, "degraded", event);
    this.emit("warn", event, "degraded", fields);
  }

  failure(
    event: HealthEventCode,
    error: unknown,
    fields: SafeLogFields = {},
  ): SafeError {
    const normalized = normalizeError(error);
    recordComponentHealth(this.component, "failure", event);
    this.emit("error", event, "failure", fields, normalized);
    return normalized;
  }

  headers(existing?: HeadersInit): Headers {
    const headers = new Headers(existing);
    headers.set(CORRELATION_HEADER, this.correlationId);
    return headers;
  }
}

export function observeRequest(
  request: Request,
  component: HealthComponent,
  operation: string,
): OperationObserver {
  return new OperationObserver(request, component, operation);
}

export function jsonResponse(
  observer: OperationObserver,
  body: unknown,
  init: ResponseInit = {},
): Response {
  return Response.json(body, { ...init, headers: observer.headers(init.headers) });
}
