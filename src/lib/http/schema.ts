/**
 * Declarative field schemas over the request primitives in `./request`.
 *
 * Every mutation route had grown the same shape by hand:
 *
 *   const a = stringField(fields, "a", {...}); if (!a.ok) return requestFailureResponse(a);
 *   const b = numberField(fields, "b", {...}); if (!b.ok) return requestFailureResponse(b);
 *   ... ×N, then a hand-built object literal that restates every name a third time.
 *
 * That `if (!x.ok) return …` ladder was ~350 lines across the API and the exact
 * place fields silently drifted out of sync with the object they built. This
 * module keeps the individual parsers (they own the actual validation) but lets
 * a route declare the whole body or query as one schema and get back a single
 * typed record or the first failure — no ladder, no restating names.
 */
import {
  type RequestResult,
  type RequestFailure,
  booleanField,
  enumField,
  numberField,
  objectField,
  queryNumber,
  queryString,
  stringArrayField,
  stringField,
  stringRecordField,
} from "./request";

/** A parser bound to its options; the field name is supplied by the schema key. */
export type FieldParser<T> = (
  fields: ReadonlyMap<string, unknown>,
  name: string,
) => RequestResult<T>;

export type FieldSchema = Record<string, FieldParser<unknown>>;

/** The typed record a `FieldSchema` produces, inferred parser-by-parser. */
export type ParsedFields<S extends FieldSchema> = {
  [K in keyof S]: S[K] extends FieldParser<infer T> ? T : never;
};

/** A parser bound to its options for `URLSearchParams`. */
export type QueryParser<T> = (
  params: URLSearchParams,
  name: string,
) => RequestResult<T>;

export type QuerySchema = Record<string, QueryParser<unknown>>;

export type ParsedQuery<S extends QuerySchema> = {
  [K in keyof S]: S[K] extends QueryParser<infer T> ? T : never;
};

/**
 * Body-field builders. Each returns a `FieldParser` with the options baked in,
 * so a schema reads as a plain shape:
 *
 *   { season: f.number({ required: true, integer: true, min: 1 }),
 *     retention: f.enum(["stream", "keep"]) }
 *
 * When `required: true` is passed, the builder narrows its result to the
 * non-nullable type (`number` rather than `number | null | undefined`), so a
 * handler that declared a field required doesn't have to re-assert it. The
 * `const` type parameter is what preserves the `required: true` literal through
 * inference; without it the flag widens to `boolean` and the narrowing is lost.
 */
/**
 * True only when the field is required AND not nullable. A nullable field can
 * still resolve to `null` even with `required: true` (the parsers accept an
 * explicit `null` before the required check), so narrowing to the non-nullable
 * type in that case would be unsound.
 */
type IsRequired<O> = O extends { required: true }
  ? O extends { nullable: true }
    ? false
    : true
  : false;

export const f = {
  string: <const O extends Parameters<typeof stringField>[2]>(
    options?: O,
  ): FieldParser<IsRequired<O> extends true ? string : string | null | undefined> =>
    ((fields, name) => stringField(fields, name, options) as never),
  number: <const O extends Parameters<typeof numberField>[2]>(
    options?: O,
  ): FieldParser<IsRequired<O> extends true ? number : number | null | undefined> =>
    ((fields, name) => numberField(fields, name, options) as never),
  boolean: <const O extends Parameters<typeof booleanField>[2]>(
    options?: O,
  ): FieldParser<IsRequired<O> extends true ? boolean : boolean | null | undefined> =>
    ((fields, name) => booleanField(fields, name, options) as never),
  enum: <const T extends string, const O extends Parameters<typeof enumField>[3]>(
    allowed: readonly T[],
    options?: O,
  ): FieldParser<IsRequired<O> extends true ? T : T | null | undefined> =>
    ((fields, name) => enumField(fields, name, allowed, options) as never),
  stringArray: <const O extends Parameters<typeof stringArrayField>[2]>(
    options?: O,
  ): FieldParser<IsRequired<O> extends true ? string[] : string[] | null | undefined> =>
    ((fields, name) => stringArrayField(fields, name, options) as never),
  stringRecord: <const O extends Parameters<typeof stringRecordField>[2]>(
    options?: O,
  ): FieldParser<
    IsRequired<O> extends true
      ? Record<string, string>
      : Record<string, string> | null | undefined
  > => ((fields, name) => stringRecordField(fields, name, options) as never),
  object: <const O extends Parameters<typeof objectField>[2]>(
    options?: O,
  ): FieldParser<
    IsRequired<O> extends true
      ? ReadonlyMap<string, unknown>
      : ReadonlyMap<string, unknown> | null | undefined
  > => ((fields, name) => objectField(fields, name, options) as never),
} as const;

/** Query-parameter builders, mirroring `f` for `URLSearchParams`. */
export const q = {
  string: <const O extends Parameters<typeof queryString>[2]>(
    options?: O,
  ): QueryParser<IsRequired<O> extends true ? string : string | undefined> =>
    ((params, name) => queryString(params, name, options) as never),
  number: (options?: Parameters<typeof queryNumber>[2]): QueryParser<
    number | undefined
  > => (params, name) => queryNumber(params, name, options),
} as const;

/**
 * Parse every field in a schema, returning the first failure or the whole
 * typed record. Insertion order of the schema decides which failure wins, which
 * matches the top-to-bottom ladder it replaces.
 */
export function parseFields<S extends FieldSchema>(
  fields: ReadonlyMap<string, unknown>,
  schema: S,
): RequestResult<ParsedFields<S>> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(schema)) {
    const result = schema[name](fields, name);
    if (!result.ok) return result as RequestFailure;
    out[name] = result.value;
  }
  return { ok: true, value: out as ParsedFields<S> };
}

/** `parseFields` for query strings. */
export function parseQuery<S extends QuerySchema>(
  params: URLSearchParams,
  schema: S,
): RequestResult<ParsedQuery<S>> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(schema)) {
    const result = schema[name](params, name);
    if (!result.ok) return result as RequestFailure;
    out[name] = result.value;
  }
  return { ok: true, value: out as ParsedQuery<S> };
}
