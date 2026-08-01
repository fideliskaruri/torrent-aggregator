/**
 * Small request-boundary primitives.
 *
 * Routes receive untrusted runtime values even when their callers are TypeScript.
 * These helpers keep parsing explicit, dependency-free, and discriminated so a
 * route cannot accidentally continue after a validation failure.
 */

export type RequestFailure = {
  ok: false;
  status: 400 | 403 | 413 | 415;
  error: string;
  field?: string;
};

export type RequestResult<T> = { ok: true; value: T } | RequestFailure;

export const DEFAULT_JSON_LIMIT_BYTES = 64 * 1024;

function fail(
  status: RequestFailure["status"],
  error: string,
  field?: string,
): RequestFailure {
  return field ? { ok: false, status, error, field } : { ok: false, status, error };
}

export function requestFailureResponse(failure: RequestFailure): Response {
  return Response.json(
    {
      error: failure.error,
      ...(failure.field ? { field: failure.field } : {}),
    },
    { status: failure.status },
  );
}

/**
 * Reject cross-site browser mutations without treating spoofable forwarding
 * headers as authentication.
 *
 * `Sec-Fetch-Site` is emitted by browsers (including Playwright) and cannot be
 * set by page JavaScript. Requests without Fetch Metadata are treated as
 * non-browser clients and remain compatible with curl and server-to-server use.
 * Reverse-proxied same-origin browser requests are accepted from the browser's
 * `same-origin` classification; `X-Forwarded-*` is deliberately never read.
 */
export function guardBrowserMutation(request: Request): RequestResult<null> {
  const site = request.headers.get("sec-fetch-site")?.toLowerCase();
  if (!site || site === "none" || site === "same-origin") {
    return { ok: true, value: null };
  }
  if (site === "cross-site") {
    return fail(403, "Cross-site browser requests are not allowed");
  }

  // `same-site` is not necessarily the same origin. Require an exact browser
  // Origin match when available; fail closed if the browser omitted it.
  if (site === "same-site") {
    const origin = request.headers.get("origin");
    if (origin && origin === new URL(request.url).origin) {
      return { ok: true, value: null };
    }
    return fail(403, "Browser request origin does not match this application");
  }

  return fail(403, "Unrecognised browser request origin");
}

export async function readJson(
  request: Request,
  maxBytes = DEFAULT_JSON_LIMIT_BYTES,
): Promise<RequestResult<unknown>> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (!/(?:^|\/)(?:json|[^;+]+\+json)(?:;|$)/.test(contentType)) {
    return fail(415, "Content-Type must be application/json");
  }

  const declared = request.headers.get("content-length");
  if (declared) {
    const bytes = Number(declared);
    if (Number.isFinite(bytes) && bytes > maxBytes) {
      return fail(413, `JSON body exceeds the ${maxBytes}-byte limit`);
    }
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return fail(400, "Could not read request body");
  }
  if (new TextEncoder().encode(text).byteLength > maxBytes) {
    return fail(413, `JSON body exceeds the ${maxBytes}-byte limit`);
  }
  if (!text.trim()) return fail(400, "JSON body is required");

  try {
    const value: unknown = JSON.parse(text);
    return { ok: true, value };
  } catch {
    return fail(400, "Request body is not valid JSON");
  }
}

export async function readMutationObject(
  request: Request,
  maxBytes = DEFAULT_JSON_LIMIT_BYTES,
): Promise<RequestResult<ReadonlyMap<string, unknown>>> {
  const origin = guardBrowserMutation(request);
  if (!origin.ok) return origin;
  const parsed = await readJson(request, maxBytes);
  if (!parsed.ok) return parsed;
  if (
    parsed.value === null ||
    typeof parsed.value !== "object" ||
    Array.isArray(parsed.value)
  ) {
    return fail(400, "JSON body must be an object");
  }
  return { ok: true, value: new Map(Object.entries(parsed.value)) };
}

type CommonFieldOptions = {
  required?: boolean;
  nullable?: boolean;
};

export function stringField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions & {
    trim?: boolean;
    minLength?: number;
    maxLength?: number;
    pattern?: RegExp;
    patternMessage?: string;
  } = {},
): RequestResult<string | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const raw = fields.get(name);
  if (raw === null && options.nullable) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return fail(400, `${name} must be a string`, name);
  }
  const value = options.trim === false ? raw : raw.trim();
  if (options.required && value.length === 0) {
    return fail(400, `${name} is required`, name);
  }
  if (options.minLength != null && value.length < options.minLength) {
    return fail(400, `${name} must be at least ${options.minLength} characters`, name);
  }
  if (options.maxLength != null && value.length > options.maxLength) {
    return fail(400, `${name} must be at most ${options.maxLength} characters`, name);
  }
  if (options.pattern && !options.pattern.test(value)) {
    return fail(400, options.patternMessage ?? `${name} has an invalid format`, name);
  }
  return { ok: true, value };
}

export function numberField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions & {
    integer?: boolean;
    min?: number;
    max?: number;
  } = {},
): RequestResult<number | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const value = fields.get(name);
  if (value === null && options.nullable) return { ok: true, value: null };
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fail(400, `${name} must be a finite number`, name);
  }
  if (options.integer && !Number.isInteger(value)) {
    return fail(400, `${name} must be an integer`, name);
  }
  if (options.min != null && value < options.min) {
    return fail(400, `${name} must be at least ${options.min}`, name);
  }
  if (options.max != null && value > options.max) {
    return fail(400, `${name} must be at most ${options.max}`, name);
  }
  return { ok: true, value };
}

export function booleanField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions = {},
): RequestResult<boolean | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const value = fields.get(name);
  if (value === null && options.nullable) return { ok: true, value: null };
  return typeof value === "boolean"
    ? { ok: true, value }
    : fail(400, `${name} must be a boolean`, name);
}

export function enumField<const T extends string>(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  allowed: readonly T[],
  options: CommonFieldOptions = {},
): RequestResult<T | null | undefined> {
  const parsed = stringField(fields, name, options);
  if (!parsed.ok) return parsed;
  if (parsed.value == null) return { ok: true, value: parsed.value };
  const value = allowed.find((candidate) => candidate === parsed.value);
  return value === undefined
    ? fail(400, `${name} must be one of: ${allowed.join(", ")}`, name)
    : { ok: true, value };
}

export function stringArrayField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions & {
    maxItems?: number;
    maxItemLength?: number;
  } = {},
): RequestResult<string[] | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const value = fields.get(name);
  if (value === null && options.nullable) return { ok: true, value: null };
  if (!Array.isArray(value)) return fail(400, `${name} must be an array`, name);
  if (options.maxItems != null && value.length > options.maxItems) {
    return fail(400, `${name} may contain at most ${options.maxItems} items`, name);
  }
  const out: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item !== "string") {
      return fail(400, `${name}[${index}] must be a string`, name);
    }
    const trimmed = item.trim();
    if (!trimmed) return fail(400, `${name}[${index}] may not be empty`, name);
    if (options.maxItemLength != null && trimmed.length > options.maxItemLength) {
      return fail(
        400,
        `${name}[${index}] must be at most ${options.maxItemLength} characters`,
        name,
      );
    }
    out.push(trimmed);
  }
  return { ok: true, value: out };
}

export function stringRecordField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions & {
    maxEntries?: number;
    maxKeyLength?: number;
    maxValueLength?: number;
  } = {},
): RequestResult<Record<string, string> | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const value = fields.get(name);
  if (value === null && options.nullable) return { ok: true, value: null };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(400, `${name} must be an object of string values`, name);
  }
  const entries = Object.entries(value);
  if (options.maxEntries != null && entries.length > options.maxEntries) {
    return fail(400, `${name} may contain at most ${options.maxEntries} entries`, name);
  }
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (!key || typeof rawValue !== "string" || !rawValue.trim()) {
      return fail(400, `${name} keys and values must be non-empty strings`, name);
    }
    const item = rawValue.trim();
    if (options.maxKeyLength != null && key.length > options.maxKeyLength) {
      return fail(400, `${name} keys must be at most ${options.maxKeyLength} characters`, name);
    }
    if (options.maxValueLength != null && item.length > options.maxValueLength) {
      return fail(400, `${name} values must be at most ${options.maxValueLength} characters`, name);
    }
    out[key] = item;
  }
  return { ok: true, value: out };
}

export function objectField(
  fields: ReadonlyMap<string, unknown>,
  name: string,
  options: CommonFieldOptions = {},
): RequestResult<ReadonlyMap<string, unknown> | null | undefined> {
  if (!fields.has(name)) {
    return options.required
      ? fail(400, `${name} is required`, name)
      : { ok: true, value: undefined };
  }
  const value = fields.get(name);
  if (value === null && options.nullable) return { ok: true, value: null };
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail(400, `${name} must be an object`, name);
  }
  return { ok: true, value: new Map(Object.entries(value)) };
}

export function queryString(
  params: URLSearchParams,
  name: string,
  options: {
    required?: boolean;
    maxLength?: number;
    allowed?: readonly string[];
  } = {},
): RequestResult<string | undefined> {
  const raw = params.get(name);
  if (raw === null) {
    return options.required
      ? fail(400, `Missing query parameter \`${name}\``, name)
      : { ok: true, value: undefined };
  }
  const value = raw.trim();
  if (options.required && !value) {
    return fail(400, `Query parameter \`${name}\` is required`, name);
  }
  if (options.maxLength != null && value.length > options.maxLength) {
    return fail(400, `${name} must be at most ${options.maxLength} characters`, name);
  }
  if (options.allowed && !options.allowed.includes(value)) {
    return fail(400, `${name} must be one of: ${options.allowed.join(", ")}`, name);
  }
  return { ok: true, value };
}

export function queryNumber(
  params: URLSearchParams,
  name: string,
  options: {
    integer?: boolean;
    min?: number;
    max?: number;
  } = {},
): RequestResult<number | undefined> {
  const raw = params.get(name);
  if (raw === null || raw === "") return { ok: true, value: undefined };
  if (!/^-?(?:\d+|\d*\.\d+)$/.test(raw.trim())) {
    return fail(400, `${name} must be a number`, name);
  }
  const value = Number(raw);
  if (!Number.isFinite(value)) return fail(400, `${name} must be a finite number`, name);
  if (options.integer && !Number.isInteger(value)) {
    return fail(400, `${name} must be an integer`, name);
  }
  if (options.min != null && value < options.min) {
    return fail(400, `${name} must be at least ${options.min}`, name);
  }
  if (options.max != null && value > options.max) {
    return fail(400, `${name} must be at most ${options.max}`, name);
  }
  return { ok: true, value };
}
