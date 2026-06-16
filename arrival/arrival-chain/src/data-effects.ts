/**
 * Host capability interface for DATA EFFECTS — the membrane through which a run's
 * `(http/get …)` / `(http/post …)` / `(sql/query …)` calls reach the outside
 * world.
 *
 * This is the data-side twin of {@link InferFn} (the `(infer …)` seam). The
 * design principle is identical and load-bearing:
 *
 *   The OSS engine knows the VERBS, never the CREDENTIALS.
 *
 * A program names a connection by **label** (intent) — `"weather-api"`,
 * `"analytics"` — and the resolver maps that label to a decrypted credential and
 * a concrete endpoint HOST-SIDE (the same membrane the LLM keys cross: the
 * interface vends BEHAVIOUR, not the secret). Code stays portable and
 * secret-free; the label→binding lives in the SaaS config plane.
 *
 * INERT BY DEFAULT. Like the inference plane (`Project.bindInfer` throws until a
 * store is bound), the data verbs exist as forms but REJECT at call time until a
 * `DataEffectResolver` is injected via `buildArrivalEnv({ data })`. The OSS
 * `foundations/arrival` distribution ships the verbs disarmed: with no resolver
 * the engine can `(require)` and analyse a program that mentions `(sql/query …)`,
 * but executing one throws a teaching error (see {@link inertDataResolver}) — it
 * never silently no-ops, and it never reaches a network or a database.
 *
 * Single seam, many verbs. There is exactly ONE host-contact point: a resolver
 * keyed by {@link DataEffect.kind}. The verbs (`http/get`, `sql/query`, …) are
 * thin scheme-facing wrappers that canonicalise their args into a `DataEffect`
 * and cross this one membrane. Keeping it single (vs one callback per verb)
 * mirrors `effectKind(infer|http|sql)` in the effect-log: every external effect a
 * run performs is one uniformly-shaped, content-addressable record, so the
 * effect-log / replay machinery treats data effects exactly as it treats infer.
 *
 * The credentialed resolver (label→connection lookup, envelope-decrypt,
 * SSRF-safe fetch, SELECT-only SQL role) is host-private — it is NOT part of
 * this OSS package. This module defines only the contract those host-side
 * implementations satisfy, plus the inert guard that keeps the engine safe when
 * no host is present.
 */

// Value-level `Nil` (NOT the `Environment` type — that stays duck-typed via
// `RosettaHost` below). The verb arg-coercion is inherently about the scheme
// membrane's representation: an empty scheme list (`(list)` / `'()`) crosses the
// rosetta boundary as a `Nil` instance, not a JS `[]`, so a verb that builds a
// positional param list MUST recognise it (the same `instanceof Nil` discipline
// `project.ts`'s `isNilLike` uses). This couples only to the engine's own value
// type, which arrival-chain already depends on package-wide.
import { Nil } from "@here.build/arrival";

/**
 * The HTTP request methods a `(http/*)` verb can carry. Read methods (`GET`,
 * `HEAD`) are the v1 idempotent surface — content-key cacheable + replay-clean.
 * `POST` is enumerated for the verb the registry reserves; non-idempotent methods
 * are valid in the type but flagged by the effect-log / replay lint (a
 * non-idempotent effect in a parallel arm is the lintable case), not forbidden at
 * the interface.
 */
export type HttpMethod = "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE";

/**
 * An HTTP data effect — the INTENT a `(http/get "label" "/path" …)` form carries.
 * Every field is plain-serializable so the effect-log can canonicalise the whole
 * descriptor into a stable content key (the cache / replay identity) without
 * reaching into scheme value types.
 *
 *   (http/get  "weather-api" "/forecast" (dict :query (dict :city "berlin")))
 *   (http/post "crm"         "/contacts" (dict :body  (dict :name "…")))
 *
 * `label` is the connection handle (intent); the resolver binds it to a base URL +
 * credential host-side. `path` is appended to that base — the program never sees
 * (and cannot forge) the absolute origin, so an allowlist enforced at the binding
 * holds regardless of program input.
 */
export interface HttpEffect {
  kind: "http";
  /** HTTP method. Defaults to `GET` at the verb layer; carried explicitly here. */
  method: HttpMethod;
  /** Connection label — the code handle the resolver maps to a base URL + creds. */
  label: string;
  /** Request path appended to the connection's base URL (the resolver owns the base). */
  path: string;
  /** Query parameters, merged into the URL by the resolver (host-side, after
   *  encoding). Plain record so it canonicalises cleanly; absent ⇒ no query. */
  query?: Readonly<Record<string, string | number | boolean>>;
  /** Caller-supplied request headers. The resolver MAY drop/override hop-by-hop or
   *  credential headers — auth is bound from the connection, never the program. */
  headers?: Readonly<Record<string, string>>;
  /** Request body for write methods (serialised host-side, typically JSON).
   *  Ignored for bodyless methods. */
  body?: unknown;
}

/**
 * A SQL data effect — the INTENT a `(sql/query "label" "select …" (list …))` form
 * carries. SELECT-only is a v1 invariant enforced at the resolver / connection
 * role (a read-only DB role + single-statement extended protocol — see the
 * host-private egress node), NOT by string parsing here: the interface admits
 * the shape and the credentialed side guarantees read-only by construction.
 *
 * Params are a SEPARATE positional list — never string-interpolated into the
 * query — so the binding is injection-safe by construction (`$1`, `$2`, … bind to
 * `params[0]`, `params[1]`, …). Keeping params off the SQL text is the whole
 * safety property; the interface makes the separation structural.
 */
export interface SqlEffect {
  kind: "sql";
  /** Connection label — the code handle the resolver maps to a DSN + read-only role. */
  label: string;
  /** Parameterised SQL text. Placeholders bind positionally to `params`; the text
   *  itself never carries a caller value (that is what `params` is for). */
  query: string;
  /** Positional bind values, scalars only at v1 (already coerced from scheme).
   *  `$n` binds to `params[n-1]`. Empty list ⇒ a query with no placeholders. */
  params: readonly unknown[];
}

/**
 * The discriminated set of data effects a run can request. Discriminating on
 * `kind` (not a verb name) keeps the seam single and the effect-log uniform:
 * `effectKind` in the per-call log is exactly this `kind`. New protocol families
 * (e.g. a future `"vector"` store) extend the union; the resolver gains an arm.
 */
export type DataEffect = HttpEffect | SqlEffect;

/**
 * What a resolver returns — the RAW JS value the originating verb hands back to
 * scheme (the verb membrane-wraps it on the way out, exactly as the `infer` seam
 * does). The concrete shape is per-kind and decided by the verb + the host-side
 * implementation (SQL ⇒ an array of row objects → a scheme list; HTTP ⇒ a
 * `{ status, headers, body }` record or the parsed JSON body). Deliberately
 * `unknown` so the OSS contract stays neutral about materialisation — the name is
 * a documented part of the cross-package contract (the effect-log + the host
 * resolver read it), not redundant boilerplate, hence the targeted disable.
 */
// eslint-disable-next-line sonarjs/redundant-type-aliases -- named contract type across the eject boundary, not a redundant `unknown` alias
export type DataEffectResult = unknown;

/**
 * Minimal structural view of the `EvalContext` a resolver receives — only the
 * current invocation it needs to mark a provenance point / bind node metadata.
 * Mirrors `InferFn`'s context arg; duck-typed to avoid pulling in arrival-chain's
 * full `Invocation`/trace types at the interface (the same one-way-cycle
 * discipline `rosetta.ts` uses for `InvocationLike`).
 */
export interface DataEffectContext {
  currentInvocation?: unknown;
}

/**
 * THE SEAM. A host injects ONE of these to arm the data verbs; absent it, the
 * verbs are inert (see {@link inertDataResolver}). Receives the eval context
 * (for tracing/provenance) and the canonical {@link DataEffect}, performs the
 * credentialed, egress-controlled materialisation host-side, and resolves to the
 * raw value.
 *
 * This is deliberately the same SHAPE as {@link InferFn}: `(ctx, descriptor) →
 * Promise<value>`. A host that already routes `(infer …)` through its own plane
 * routes data effects through the structurally-identical resolver — one membrane
 * idiom for every external effect a run performs.
 *
 * Contract obligations on the host implementation (NOT enforceable here — they
 * live on the host-private side and are stated so the membrane's guarantees
 * are explicit):
 *   - Resolve `label` → connection host-side; NEVER accept a raw URL/DSN/key from
 *     the program (intent over materialisation — the program names, the host binds).
 *   - Enforce egress safety at the network/role layer (SSRF allowlist for http;
 *     read-only role + single statement for sql) — the interface admits the shape;
 *     the host guarantees the safety.
 *   - SANITISE errors before they propagate: a thrown resolver error must not carry
 *     a DSN / key / internal endpoint (it would otherwise land in the persisted Run
 *     and the logs). The engine surfaces whatever the resolver throws.
 *
 * Returns a {@link DataEffectResult} (the raw value the verb hands back to scheme).
 */
export type DataEffectResolver = (ctx: DataEffectContext, effect: DataEffect) => Promise<DataEffectResult>;

/**
 * Stable, human-readable name for a data effect — `"http GET weather-api/forecast"`,
 * `"sql analytics"`. Used in inert / error messages and as a legible label for the
 * effect node. NOT the content key (the effect-log derives that from the full
 * canonical descriptor incl. query/params/body); this is the at-a-glance identity.
 */
export function describeDataEffect(effect: DataEffect): string {
  switch (effect.kind) {
    case "http":
      return `http ${effect.method} ${effect.label}${effect.path}`;
    case "sql":
      return `sql ${effect.label}`;
  }
}

/**
 * The disarmed default. When `buildArrivalEnv` is called WITHOUT a `data`
 * resolver, the data verbs route here and throw a teaching error at call time —
 * the data-side analogue of `Project.infer`'s "no inference store bound"
 * invariant.
 *
 * Why throw-at-call rather than omit-the-verb: a missing symbol ("unbound
 * variable: sql/query") is opaque and looks like a typo; this names the real
 * condition (the capability isn't wired in THIS environment) and points at the
 * fix (inject a resolver). It also keeps the verb SURFACE identical whether or
 * not a host armed it — the form parses + analyses the same; only execution
 * differs. Crucially it can never silently no-op: an inert environment that
 * pretended a `(sql/query …)` returned `nil` would corrupt a run's results.
 *
 * Errors-as-doors: the message routes the caller to the subsystem that grants the
 * capability rather than merely banning the call.
 */
export const inertDataResolver: DataEffectResolver = (_ctx, effect) => {
  throw new Error(
    `${describeDataEffect(effect)}: data effects are not enabled in this environment. ` +
      `The (http/*) and (sql/query) verbs require a host-injected DataEffectResolver — ` +
      `pass one via buildArrivalEnv({ data }). The OSS engine ships these verbs disarmed; ` +
      `a credentialed resolver (label→connection, decrypt, egress-safe fetch) is supplied by the SaaS host.`,
  );
};

// ── Verb registration seam (the A3-iface scaffold barrier) ────────────────────
//
// The data verbs are registered HERE so the surface is identical whether or not a
// host armed the capability: with no resolver they route to `inertDataResolver`
// and throw the teaching error (present-but-disarmed), never an unbound symbol and
// never a silent no-op. `buildArrivalEnv` calls this with `opts.data ??
// inertDataResolver`, so every verb closes over exactly ONE resolved seam.
//
// The shells below are the SCAFFOLD: they canonicalise scheme args into a
// `DataEffect` at the simplest faithful level and cross the membrane. Node A3 (the
// fan) enriches the per-verb arg coercion in place — query/header/body shaping for
// http, the param-list discipline for sql — WITHOUT touching the seam (the
// `resolve` call), the disarmed default, or the descriptor types. That separation
// is what lets the verbs fan out in parallel behind this one contract.

/** Structural shape of the `Environment.defineRosetta` this module touches —
 *  duck-typed so `data-effects.ts` stays free of an arrival-scheme import (the
 *  contract lives below the env that wires it). The real signature is declared on
 *  `Environment` in arrival-scheme/rosetta.ts. */
export interface RosettaHost {
  defineRosetta(
    name: string,
    config: { fn: (...args: any[]) => any; withContext?: boolean; options?: Record<string, unknown>; type?: string },
  ): void;
}

/** A URL query value is a scalar by construction — it has to become one literal
 *  segment in `?k=v`. Anything structured (a nested dict, a list) is meaningless
 *  as a query param AND would poison the effect-log content key (the A4 log keys
 *  on `query` verbatim), so it is rejected at the verb, not silently flattened. */
function isQueryScalar(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

/** "No value" as it crosses the rosetta membrane: a missing dict field is JS
 *  `undefined`/`null`, and an empty scheme list (`'()` / `(list)`) arrives as a
 *  `Nil` instance — NOT a JS `[]` (the same membrane fact `sqlParams` and
 *  `project.ts`'s `isNilLike` encode). A nil-valued query/header entry means
 *  "omit", so the canonical descriptor stays minimal: `{city}` and
 *  `{city, since: nil}` must mint the SAME content key. */
function isAbsentValue(v: unknown): boolean {
  return v === null || v === undefined || v instanceof Nil;
}

/**
 * Coerce a `(dict :query (dict :city "…" :days 3))` options field into the
 * `HttpEffect.query` shape (scalar-valued record). Faithful, not blind-cast:
 *
 *   - drops absent / nil entries (keeps the canonical descriptor minimal so the
 *     content key is stable — `{city}` and `{city, days: nil}` must not differ);
 *   - keeps scalars verbatim (string/number/boolean — the resolver `String()`s
 *     them into the URL host-side; the number/bool identity is preserved in the
 *     descriptor so the cache key reflects what the program actually asked for);
 *   - REJECTS a non-scalar value (nested dict / list) with a teaching error that
 *     names the offending key + the fix — errors-as-doors, never a lying cast.
 *
 *  `undefined` in ⇒ `undefined` out (no `query` key on the effect at all).
 */
function coerceHttpQuery(raw: unknown): HttpEffect["query"] {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      `http/get: :query must be a dict of scalar values (got ${dataTypeName(raw)}); ` +
        `e.g. (http/get "label" "/path" (dict :query (dict :city "berlin")))`,
    );
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAbsentValue(v)) continue; // absent param (incl. empty-list nil) — omit, don't encode "nil"
    if (!isQueryScalar(v)) {
      throw new TypeError(
        `http/get: query param "${k}" must be a scalar (string/number/boolean), got ${dataTypeName(v)}. ` +
          `URL query values are single segments — a nested dict/list can't be one. ` +
          `Pass it in the path or as separate scalar params.`,
      );
    }
    out[k] = v;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Coerce a `(dict :headers (dict :accept "application/json"))` options field into
 * the `HttpEffect.headers` shape (string-valued record). HTTP header values ARE
 * strings by spec, so a scalar is faithfully `String()`'d (a numeric `:retries 3`
 * → `"3"`); a structured value is a category error and is rejected. Auth/credential
 * headers the program supplies are still subject to the resolver's drop/override
 * (the membrane binds auth from the connection, never the program) — this only
 * shapes what the descriptor carries. `undefined` in ⇒ `undefined` out.
 */
function coerceHttpHeaders(raw: unknown): HttpEffect["headers"] {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new TypeError(
      `http/get: :headers must be a dict of scalar values (got ${dataTypeName(raw)}); ` +
        `e.g. (http/get "label" "/path" (dict :headers (dict :accept "application/json")))`,
    );
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (isAbsentValue(v)) continue; // absent header (incl. empty-list nil) — omit
    if (!isQueryScalar(v)) {
      throw new TypeError(
        `http/get: header "${k}" must be a scalar (string/number/boolean), got ${dataTypeName(v)}. ` +
          `HTTP header values are strings.`,
      );
    }
    out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Shape a `(dict :body …)` options field into `HttpEffect.body` for a WRITE verb
 * (`http/post`). The body is the defining axis of a write — unlike query/headers
 * it is NOT coerced to scalars: a `(http/post "crm" "/contacts" (dict :body (dict
 * :name "ada" :tags (list …))))` carries arbitrary structured intent, and the
 * structure IS the payload. The resolver serialises it host-side (typically
 * JSON); the engine passes it through verbatim — flattening it would destroy the
 * very thing POST exists to send.
 *
 * The ONE shaping the body needs is the membrane's nil discipline (the same fact
 * `coerceHttpQuery`/`sqlParams` encode): an absent `:body`, an explicit `:body
 * nil`, and the empty scheme list all mean "no request body" → drop the slot. Two
 * reasons this matters and isn't a blind pass-through:
 *   - CONTENT KEY STABILITY — a bodyless POST and `(dict :body nil)` must mint the
 *     SAME A4 effect key; if `nil` leaked through, the key would canonicalise the
 *     scheme `Nil` sentinel (`{provenance,kind:"nil"}`) and the two would diverge.
 *   - CLEAN MATERIALISATION — the resolver receives `undefined` (no body to send),
 *     never a scheme-internal `Nil` object it would try to JSON-serialise.
 *
 * Any real value (dict / list / scalar) passes through unchanged. `undefined` in
 * (no `:body` field) ⇒ `undefined` out (no `body` key on the effect at all).
 */
function coerceHttpBody(raw: unknown): HttpEffect["body"] {
  return isAbsentValue(raw) ? undefined : raw; // nil/absent ⇒ no body; structure ⇒ verbatim
}

/** Shape an HTTP options dict (`(dict :query … :headers … :body …)`) — already
 *  schemeToJs'd to a plain record by the rosetta wrapper — into the `HttpEffect`
 *  request fields, per method. `query`/`headers` coercion is shared (both verbs
 *  want faithfully-scalar values); the body is the per-method axis: a read verb
 *  (GET/HEAD) carries NO body — a request body on a read is spec-discouraged,
 *  ignored by servers, and would taint the idempotent content key — so it is
 *  dropped here even if the program passed one. Write verbs keep `:body`, shaped
 *  by `coerceHttpBody` (nil-aware, structure-preserving).
 *  Tolerates absence / a non-record opts arg (⇒ no options). */
function httpOptions(method: HttpMethod, raw: unknown): Pick<HttpEffect, "query" | "headers" | "body"> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: Pick<HttpEffect, "query" | "headers" | "body"> = {};
  const query = coerceHttpQuery(r.query);
  if (query !== undefined) out.query = query;
  const headers = coerceHttpHeaders(r.headers);
  if (headers !== undefined) out.headers = headers;
  // Read methods carry no request body (keeps GET/HEAD effects idempotent +
  // content-key-stable). Write methods keep the body, nil-shaped by coerceHttpBody.
  if (!isBodylessMethod(method)) {
    const body = coerceHttpBody(r.body);
    if (body !== undefined) out.body = body;
  }
  return out;
}

/** Read methods take no request body — the idempotent, content-key-cacheable
 *  surface. (HEAD reserved alongside GET for symmetry.) */
function isBodylessMethod(method: HttpMethod): boolean {
  return method === "GET" || method === "HEAD";
}

/** Type name for teaching errors — distinguishes null/array from object so a
 *  rejected `:query` says "array"/"null", not a bare "object". Mirrors the
 *  `typeName` helper the template verb uses in project.ts. */
function dataTypeName(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

/**
 * Register the data-effect verbs on `env`, routing each through the single
 * resolved `resolve` seam. Called by `buildArrivalEnv`; exported so a host
 * building its own env (the host runner, tests) wires the verbs the same way.
 *
 *   (http/get  "label" "/path" (dict :query (dict …)))
 *   (http/post "label" "/path" (dict :body  (dict …)))
 *   (sql/query "label" "select … where id = $1" (list id))   ; params SEPARATE
 *
 * `withContext: true` threads the eval context to the resolver (for
 * provenance/tracing), mirroring the `infer` verbs. The result is returned RAW;
 * the rosetta membrane wraps it into scheme on the way out (so a SQL row array
 * becomes a list, an HTTP JSON body becomes a dict) exactly as the infer seam does.
 */
export function defineDataEffectRosettas(env: RosettaHost, resolve: DataEffectResolver): void {
  const httpVerb =
    (method: HttpMethod) =>
    (ctx: DataEffectContext, label: unknown, path: unknown, opts?: unknown): Promise<DataEffectResult> =>
      resolve(ctx, { kind: "http", method, label: String(label), path: String(path), ...httpOptions(method, opts) });

  env.defineRosetta("http/get", { withContext: true, type: "(label: SStr, path: SStr, opts?: unknown): unknown", fn: httpVerb("GET") });
  env.defineRosetta("http/post", { withContext: true, type: "(label: SStr, path: SStr, opts?: unknown): unknown", fn: httpVerb("POST") });

  env.defineRosetta("sql/query", {
    withContext: true,
    type: "(label: SStr, query: SStr, params?: unknown): unknown",
    fn: (ctx: DataEffectContext, label: unknown, query: unknown, params?: unknown): Promise<DataEffectResult> =>
      resolve(ctx, { kind: "sql", label: String(label), query: String(query), params: sqlParams(params) }),
  });
}

/**
 * Coerce the `(sql/query "…" "select … $1" (list a b))` params arg into the
 * positional bind list the resolver hands to the driver. The SEPARATION of these
 * values from the query text is the load-bearing safety property (`$n` binds to
 * `params[n-1]`; a caller value never touches the SQL string) — it lives HERE so
 * the resolver only ever sees a clean positional scalar list, and the A4
 * effect-log keys on `params` verbatim (a junk element ⇒ a wrong content key).
 *
 * Three arg shapes arrive across the membrane (verified against the rosetta
 * boundary):
 *   - a scheme list `(list a b)`  → a JS array  → bind each element;
 *   - the empty list `(list)` / `'()` → a `Nil` instance (NOT `[]`) → no binds;
 *   - omitted (no params arg)     → `undefined`  → no binds;
 *   - a bare scalar `42` (sugar for `(list 42)`) → wrapped as one element.
 *
 * The `Nil`/`undefined` ⇒ `[]` arm is the correctness fix the scaffold lacked:
 * an empty scheme list does NOT auto-become a JS array (`schemeToJs` returns the
 * `Nil` as-is, the same membrane gap `project.ts`'s template `coerceShape`
 * handles), so the naive `[params]` fallback would have bound a spurious `Nil`
 * sentinel to a placeholder-free query.
 */
function sqlParams(raw: unknown): readonly unknown[] {
  if (raw === undefined || raw instanceof Nil) return []; // omitted, or the empty scheme list
  if (Array.isArray(raw)) return raw.map((el, i) => sqlParam(el, i));
  return [sqlParam(raw, 0)]; // bare scalar — `(sql/query … 42)` ≡ `(sql/query … (list 42))`
}

/**
 * Coerce ONE positional param element to a v1 SQL bind value — the scalar
 * discipline the {@link SqlEffect} contract states ("scalars only at v1"):
 *
 *   - a scheme nil element (`'()` used as a value) / JS null/undefined ⇒ `null`
 *     (SQL `NULL` is a legitimate bind — `where col = $1` with `$1 = null`);
 *   - string / number / boolean / bigint ⇒ passed verbatim (real PG scalar binds);
 *   - a composite (array / object) ⇒ REJECTED with a teaching error naming the
 *     offending position (errors-as-doors). A v1 bind value can't be a structure:
 *     the driver has no scalar to send and the effect-log can't canonicalise it
 *     into a stable key. Surfacing it at the verb (vs a later opaque driver crash)
 *     keeps the membrane's promise that the resolver sees only positional scalars.
 */
function sqlParam(value: unknown, index: number): unknown {
  if (value === null || value === undefined || value instanceof Nil) return null;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
    case "bigint":
      return value;
    default:
      throw new TypeError(
        `sql/query: param $${index + 1} must be a scalar (string/number/boolean/null), got ${dataTypeName(value)}. ` +
          `Positional binds are single values — a list/dict can't be one. ` +
          `Bind each scalar separately, or serialise the structure to text first.`,
      );
  }
}
