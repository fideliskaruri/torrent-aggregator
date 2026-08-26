/**
 * One place for the cross-cutting preamble every route was re-implementing.
 *
 * Before this, each handler opened with some subset of: resolve the local
 * session, guard cross-site browser mutations, read+validate the JSON body or
 * query, then `try/catch` the whole thing into an ad-hoc error shape. The subset
 * differed per route, which is how one destructive endpoint shipped without the
 * mutation guard and how the error envelope drifted into two incompatible shapes
 * (`{error}` vs `{ok:false,error,message}`) across the API.
 *
 * `defineRoute` owns that preamble. A handler receives an already-authenticated
 * session and an already-parsed, typed `body`/`query`, and returns either a
 * `Response` (for custom status codes like a 507 storage refusal) or a plain
 * object (sent as 200 JSON). Anything thrown — including an {@link ApiError} —
 * becomes the single canonical envelope with the right status.
 *
 * The envelope is deliberately a superset of both historical shapes:
 * `{ ok: false, error, message, field? }`. Callers that read `.error`,
 * `.message`, `.field`, or `.ok` all keep working, so routes can adopt this
 * without a coordinated client change.
 */
import { auth, type LocalSession } from "@/lib/auth";
import {
  type RequestFailure,
  guardBrowserMutation,
  readMutationObject,
  requestFailureResponse,
} from "./request";
import {
  parseFields,
  parseQuery,
  type FieldSchema,
  type ParsedFields,
  type ParsedQuery,
  type QuerySchema,
} from "./schema";

/** The canonical error envelope, a superset of the two shapes that predate it. */
export function errorResponse(
  status: number,
  error: string,
  message?: string,
  extra?: Record<string, unknown>,
): Response {
  // A status outside the valid HTTP range makes `Response.json` throw, which
  // (since this runs inside the wrapper's catch) would escape as a bare
  // framework 500 with no envelope. Clamp defensively.
  const safeStatus =
    Number.isInteger(status) && status >= 200 && status <= 599 ? status : 500;
  // `extra` is spread first so it can never clobber the envelope's own contract
  // keys (`ok`/`error`/`message`); it only contributes extras like `field`.
  return Response.json(
    { ...extra, ok: false, error, message: message ?? error },
    { status: safeStatus },
  );
}

/**
 * An error a handler can throw to end the request with a specific status and
 * the canonical envelope, instead of hand-building a `Response` mid-handler.
 */
export class ApiError extends Error {
  readonly status: number;
  readonly error: string;
  readonly extra?: Record<string, unknown>;

  constructor(
    status: number,
    error: string,
    message?: string,
    extra?: Record<string, unknown>,
  ) {
    super(message ?? error);
    this.name = "ApiError";
    this.status = status;
    this.error = error;
    this.extra = extra;
  }
}

function failureResponse(failure: RequestFailure): Response {
  return errorResponse(
    failure.status,
    failure.error,
    failure.error,
    failure.field ? { field: failure.field } : undefined,
  );
}

type EmptyRecord = Record<never, never>;

export type RouteContext<
  Body,
  Query,
  Params extends Record<string, string> = Record<string, string>,
> = {
  request: Request;
  session: LocalSession;
  body: Body;
  query: Query;
  params: Params;
};

export type RouteHandler<Body, Query, Params extends Record<string, string>> = (
  context: RouteContext<Body, Query, Params>,
) => Response | object | Promise<Response | object>;

type NextRouteContext<Params extends Record<string, string>> = {
  params?: Params | Promise<Params>;
};

/**
 * Wrap a handler with the shared session/parse/error preamble and return a
 * function with the Next.js App Router route signature. It is curried so the
 * schema is inferred in isolation from the handler:
 *
 *   export const POST = defineRoute({ body: {...} })(async ({ body }) => {...});
 *
 * The two-call shape is deliberate. When the schema and handler share one call,
 * TypeScript infers the constrained schema generic and contextually types the
 * handler in the same pass, and a field whose parser carries a literal-union
 * type (e.g. `f.enum([...])`) collapses the whole schema to its default —
 * leaving `body` untyped. Fixing the schema in the first call, then binding the
 * handler in the second, sidesteps that and keeps `body`/`query` fully typed.
 *
 * Routes with URL params supply them on the second call:
 *
 *   export const POST = defineRoute({ body: {...} })<{ workKey: string }>(handler);
 */
export function defineRoute<
  BodySchema extends FieldSchema = EmptyRecord,
  QuerySchemaT extends QuerySchema = EmptyRecord,
>(config: {
  /**
   * Read and validate a JSON object body. Presence of a body schema implies a
   * mutation: the request goes through `readMutationObject`, which enforces the
   * cross-site browser guard. Pass `mutation: false` only for the rare
   * non-mutating body (there are none today).
   */
  body?: BodySchema;
  /** Validate `URLSearchParams` into a typed record. */
  query?: QuerySchemaT;
  /**
   * Enforce the cross-site browser guard on a request with no body schema
   * (e.g. a `DELETE` or a body-less `POST` that still mutates). A request with
   * a `body` schema is always guarded regardless of this flag, because
   * `readMutationObject` guards it.
   */
  mutation?: boolean;
} = {}) {
  return function bind<
    Params extends Record<string, string> = Record<string, string>,
  >(
    handler: RouteHandler<
      ParsedFields<BodySchema>,
      ParsedQuery<QuerySchemaT>,
      Params
    >,
  ) {
    return async function route(
      request: Request,
      context?: NextRouteContext<Params>,
    ): Promise<Response> {
      try {
        const session = await auth();
        const params = ((await context?.params) ?? {}) as Params;

        let body: unknown = {};
        if (config.body) {
          const parsedObject = await readMutationObject(request);
          if (!parsedObject.ok) return failureResponse(parsedObject);
          const parsed = parseFields(parsedObject.value, config.body);
          if (!parsed.ok) return failureResponse(parsed);
          body = parsed.value;
        } else if (config.mutation) {
          // Body-less mutation (DELETE, or a POST that carries no JSON body):
          // still refuse cross-site browser requests.
          const guard = guardBrowserMutation(request);
          if (!guard.ok) return failureResponse(guard);
        }

        let query: unknown = {};
        if (config.query) {
          const searchParams = new URL(request.url).searchParams;
          const parsed = parseQuery(searchParams, config.query);
          if (!parsed.ok) return failureResponse(parsed);
          query = parsed.value;
        }

        const result = await handler({
          request,
          session,
          params,
          body: body as never,
          query: query as never,
        });

        if (result == null) return new Response(null, { status: 204 });
        return result instanceof Response
          ? result
          : Response.json(result, { status: 200 });
      } catch (err) {
        if (err instanceof ApiError) {
          return errorResponse(err.status, err.error, err.message, err.extra);
        }
        // Unexpected: log the real detail for the operator, but don't return it
        // in production — driver/ORM errors can embed connection strings and
        // other secrets in their message.
        console.error("Unhandled route error:", err);
        const detail = err instanceof Error ? err.message : String(err);
        return errorResponse(
          500,
          "Internal error",
          process.env.NODE_ENV === "production" ? "Internal error" : detail,
        );
      }
    };
  };
}

export { requestFailureResponse };
