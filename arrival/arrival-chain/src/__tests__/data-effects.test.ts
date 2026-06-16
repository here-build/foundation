/**
 * The data-effect host-capability contract (node A3-iface).
 *
 * Tests the MEMBRANE directly — `defineDataEffectRosettas` over a bare
 * `sandboxedEnv`, no Project — so the contract is verified independent of the
 * verb-body fan (node A3) and the run/effect-log wiring. Three properties:
 *
 *   1. INERT BY DEFAULT — with the disarmed resolver the verbs are present but
 *      throw a teaching error (never an unbound symbol, never a silent no-op).
 *   2. ARMED — an injected resolver receives the canonical `DataEffect` descriptor
 *      with `label`/`path`/`method` (http) and `query`/`params` SEPARATE from text.
 *   3. The result crosses the membrane back into scheme (raw value → scheme value).
 */
import { execGeneratorFromString as exec, sandboxedEnv } from "@here.build/arrival";
import { describe, expect, it, vi } from "vitest";

import {
  type DataEffect,
  type DataEffectResolver,
  defineDataEffectRosettas,
  describeDataEffect,
  inertDataResolver,
} from "../data-effects.js";
// The A4 content-key derivation — used to assert that the body shaping keeps the
// effect identity stable (bodyless ≡ `:body nil`) and sensitive (payload differs ⇒
// key differs). Same kind-tagged key the effect-log records + replays under.
import { dataEffectKey } from "../effect-log.js";

/** Fresh sandbox per test, verbs armed with the supplied resolver. A minimal
 *  `dict` is registered locally (the real one lives in `buildArrivalEnv`, which
 *  this test deliberately doesn't build — we exercise the membrane in isolation)
 *  so http option dicts can be authored in scheme. */
function envWith(resolve: DataEffectResolver): ReturnType<typeof sandboxedEnv.inherit> {
  const env = sandboxedEnv.inherit("data-effects-test");
  env.defineRosetta("dict", {
    fn: (...args: unknown[]) => {
      const out: Record<string, unknown> = {};
      for (let i = 0; i < args.length; i += 2) out[String(args[i])] = args[i + 1];
      return out;
    },
  });
  defineDataEffectRosettas(env, resolve);
  return env;
}

const run = async (env: ReturnType<typeof sandboxedEnv.inherit>, scm: string): Promise<unknown> => {
  const results = await exec(scm, { env });
  const last = results.at(-1);
  return last && typeof (last as { then?: unknown }).then === "function" ? await last : last;
};

/** Run a single data-effect form and return the canonical `DataEffect` the verb
 *  handed the resolver — the shared capture used by the per-verb coercion blocks
 *  (http/get, http/post). The resolver is a no-op sink; we assert on the descriptor
 *  it received, not its result. Throws if the verb never reached the resolver
 *  (e.g. an arg-coercion error short-circuited before the seam). */
const captureEffect = async (scm: string): Promise<DataEffect> => {
  let captured: DataEffect | undefined;
  await run(
    envWith(async (_ctx, e) => {
      captured = e;
      return null;
    }),
    scm,
  );
  if (!captured) throw new Error("resolver was not called");
  return captured;
};

describe("data-effect verbs are INERT until a resolver is injected", () => {
  it("(sql/query …) against the disarmed default throws the teaching error", async () => {
    const env = envWith(inertDataResolver);
    await expect(run(env, `(sql/query "analytics" "select 1" (list))`)).rejects.toThrow(
      /data effects are not enabled/i,
    );
  });

  it("(http/get …) against the disarmed default throws the teaching error", async () => {
    const env = envWith(inertDataResolver);
    await expect(run(env, `(http/get "weather-api" "/forecast")`)).rejects.toThrow(/data effects are not enabled/i);
  });

  it("the teaching error names the verb + routes to the fix (errors-as-doors)", async () => {
    const env = envWith(inertDataResolver);
    // names the effect, points at buildArrivalEnv({ data }) — not a bare "unbound variable".
    await expect(run(env, `(sql/query "db" "select 1" (list))`)).rejects.toThrow(/sql db/);
    await expect(run(env, `(http/get "api" "/x")`)).rejects.toThrow(/buildArrivalEnv\(\{ data \}\)/);
  });

  it("the verbs are PRESENT (bound), not missing symbols", async () => {
    // A disarmed env still has the symbols — the failure is the teaching THROW,
    // never "Unbound variable". (If they were absent, the message would differ.)
    const env = envWith(inertDataResolver);
    await expect(run(env, `(http/get "a" "/b")`)).rejects.not.toThrow(/unbound/i);
  });
});

describe("an injected resolver receives the canonical DataEffect descriptor", () => {
  it("sql: label, query text, and params list arrive SEPARATE (injection-safe)", async () => {
    const seen: DataEffect[] = [];
    const resolve: DataEffectResolver = vi.fn(async (_ctx, effect) => {
      seen.push(effect);
      return [{ id: 7 }]; // a row set
    });
    const env = envWith(resolve);
    await run(env, `(sql/query "analytics" "select * from t where id = $1" (list 7))`);

    expect(seen).toHaveLength(1);
    const effect = seen[0]!;
    expect(effect.kind).toBe("sql");
    if (effect.kind !== "sql") throw new Error("expected sql");
    expect(effect.label).toBe("analytics");
    expect(effect.query).toBe("select * from t where id = $1"); // value NOT spliced into text
    expect(effect.params).toEqual([7]); // bound positionally, separate from the query
  });

  it("sql: a bare (non-list) param is tolerated as a single-element list", async () => {
    let captured: DataEffect | undefined;
    const env = envWith(async (_ctx, e) => {
      captured = e;
      return [];
    });
    await run(env, `(sql/query "db" "select $1" 42)`);
    expect(captured?.kind === "sql" && captured.params).toEqual([42]);
  });

  it("sql: omitted params ⇒ empty list", async () => {
    let captured: DataEffect | undefined;
    const env = envWith(async (_ctx, e) => {
      captured = e;
      return [];
    });
    await run(env, `(sql/query "db" "select 1")`);
    expect(captured?.kind === "sql" && captured.params).toEqual([]);
  });

  it("http/get: method GET, label, path; options dict shapes query/headers", async () => {
    let captured: DataEffect | undefined;
    const env = envWith(async (_ctx, e) => {
      captured = e;
      return { status: 200 };
    });
    await run(env, `(http/get "weather-api" "/forecast" (dict "query" (dict "city" "berlin")))`);

    expect(captured?.kind).toBe("http");
    if (captured?.kind !== "http") throw new Error("expected http");
    expect(captured.method).toBe("GET");
    expect(captured.label).toBe("weather-api");
    expect(captured.path).toBe("/forecast");
    expect(captured.query).toEqual({ city: "berlin" });
  });

  it("http/post: method POST, carries body", async () => {
    let captured: DataEffect | undefined;
    const env = envWith(async (_ctx, e) => {
      captured = e;
      return { ok: true };
    });
    await run(env, `(http/post "crm" "/contacts" (dict "body" (dict "name" "ada")))`);

    expect(captured?.kind).toBe("http");
    if (captured?.kind !== "http") throw new Error("expected http");
    expect(captured.method).toBe("POST");
    expect(captured.body).toEqual({ name: "ada" });
  });

  it("http: no options dict ⇒ no query/headers/body", async () => {
    let captured: DataEffect | undefined;
    const env = envWith(async (_ctx, e) => {
      captured = e;
      return null;
    });
    await run(env, `(http/get "api" "/ping")`);
    if (captured?.kind !== "http") throw new Error("expected http");
    expect(captured.query).toBeUndefined();
    expect(captured.headers).toBeUndefined();
    expect(captured.body).toBeUndefined();
  });
});

describe("http/get — faithful arg coercion (node A3-http/get)", () => {
  /** Capture the canonical effect a single (http/get …) form produces. */
  const captureGet = captureEffect;

  it("query scalars are preserved by TYPE (number/bool stay number/bool — the cache key reflects the ask)", async () => {
    const e = await captureGet(`(http/get "wx" "/f" (dict "query" (dict "city" "berlin" "days" 3 "metric" #t)))`);
    if (e.kind !== "http") throw new Error("expected http");
    // not String()'d into the descriptor — the resolver stringifies into the URL host-side;
    // the descriptor keeps the program's actual values so the content key is faithful.
    expect(e.query).toEqual({ city: "berlin", days: 3, metric: true });
  });

  it("a nil / absent query entry is OMITTED (canonical descriptor ⇒ stable content key)", async () => {
    // `'()` (empty list) crosses as nil; a nil-valued param must not become `"nil"` in the URL,
    // and must not appear in the descriptor at all (else two runs key differently).
    const e = await captureGet(`(http/get "wx" "/f" (dict "query" (dict "city" "berlin" "since" '())))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.query).toEqual({ city: "berlin" });
    expect(e.query && "since" in e.query).toBe(false);
  });

  it("a query dict that coerces to empty ⇒ NO query key (not `{}`)", async () => {
    const e = await captureGet(`(http/get "wx" "/f" (dict "query" (dict "since" '())))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.query).toBeUndefined();
  });

  it("a NON-scalar query value is REJECTED with a teaching error (errors-as-doors, never a lying cast)", async () => {
    // a nested dict can't be a single URL query segment — reject, naming the key + the fix.
    await expect(captureGet(`(http/get "wx" "/f" (dict "query" (dict "box" (dict "a" 1))))`)).rejects.toThrow(
      /query param "box" must be a scalar/i,
    );
  });

  it("a list-valued query value is REJECTED (a list is not one segment)", async () => {
    await expect(captureGet(`(http/get "wx" "/f" (dict "query" (dict "tags" (list "a" "b"))))`)).rejects.toThrow(
      /query param "tags" must be a scalar/i,
    );
  });

  it("headers are STRING-coerced (a numeric header value becomes its string form)", async () => {
    const e = await captureGet(
      `(http/get "wx" "/f" (dict "headers" (dict "accept" "application/json" "x-retries" 3)))`,
    );
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.headers).toEqual({ accept: "application/json", "x-retries": "3" });
  });

  it("a structured header value is REJECTED with a teaching error", async () => {
    await expect(captureGet(`(http/get "wx" "/f" (dict "headers" (dict "x" (list 1 2))))`)).rejects.toThrow(
      /header "x" must be a scalar/i,
    );
  });

  it("GET DROPS a request body (read effect carries none ⇒ idempotent, content-key-stable)", async () => {
    // even if the program passes :body to a GET, the read verb omits it — a request body on a
    // GET is spec-discouraged, ignored by servers, and would taint the idempotent content key.
    const e = await captureGet(`(http/get "api" "/x" (dict "body" (dict "k" "v") "query" (dict "a" "1")))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toBeUndefined();
    expect(e.query).toEqual({ a: "1" }); // query still shaped — only body is dropped
  });

  it("a non-dict opts arg is tolerated as no-options (not a crash)", async () => {
    const e = await captureGet(`(http/get "api" "/x" "ignored")`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.query).toBeUndefined();
    expect(e.headers).toBeUndefined();
    expect(e.body).toBeUndefined();
  });

  it("path + label are stringified; method is GET", async () => {
    const e = await captureGet(`(http/get "weather-api" "/forecast/today")`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.method).toBe("GET");
    expect(e.label).toBe("weather-api");
    expect(e.path).toBe("/forecast/today");
  });
});

describe("http/post — faithful body shaping (node A3-http/post)", () => {
  /** Capture the canonical effect a single (http/post …) form produces. */
  const capturePost = captureEffect;

  it("a structured dict body passes through VERBATIM (nesting preserved — the structure IS the payload)", async () => {
    // unlike query/headers, the body is NOT scalar-coerced: a write carries arbitrary
    // structure the resolver serialises host-side. Flattening it would defeat POST.
    const e = await capturePost(
      `(http/post "crm" "/contacts" (dict "body" (dict "name" "ada" "address" (dict "city" "london") "tags" (list "vip" "beta"))))`,
    );
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.method).toBe("POST");
    expect(e.body).toEqual({ name: "ada", address: { city: "london" }, tags: ["vip", "beta"] });
  });

  it("a list body passes through verbatim (a JSON array payload)", async () => {
    const e = await capturePost(`(http/post "api" "/bulk" (dict "body" (list 1 2 3)))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toEqual([1, 2, 3]);
  });

  it("a scalar body passes through verbatim (a raw string / number payload)", async () => {
    const e = await capturePost(`(http/post "api" "/raw" (dict "body" "plain-text"))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toBe("plain-text");
  });

  it("an explicit `:body nil` ⇒ NO body (bodyless POST — never the scheme Nil sentinel)", async () => {
    // the membrane delivers `nil` as a Nil instance, NOT JS null; a blind pass-through
    // would leak it to the resolver + poison the content key. coerceHttpBody drops it.
    const e = await capturePost(`(http/post "api" "/ping" (dict "body" nil))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toBeUndefined();
  });

  it("the empty scheme list as a body ⇒ NO body (same nil discipline)", async () => {
    const e = await capturePost(`(http/post "api" "/ping" (dict "body" '()))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toBeUndefined();
  });

  it("an omitted `:body` ⇒ NO body key on the effect", async () => {
    const e = await capturePost(`(http/post "api" "/ping" (dict "query" (dict "k" "v")))`);
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.body).toBeUndefined();
    expect(e.query).toEqual({ k: "v" }); // POST still shapes query/headers (shared coercion)
  });

  it("a bodyless POST and `(dict :body nil)` mint the SAME content key (stability — A4 replay)", async () => {
    const omitted = await capturePost(`(http/post "api" "/ping")`);
    const explicitNil = await capturePost(`(http/post "api" "/ping" (dict "body" nil))`);
    // the two authorings are the same effect → the effect-log must not split them.
    expect(dataEffectKey(omitted)).toBe(dataEffectKey(explicitNil));
  });

  it("POST keeps the body ALONGSIDE query + headers (the write-verb counterpart of GET-drops-body)", async () => {
    const e = await capturePost(
      `(http/post "crm" "/contacts" (dict "query" (dict "upsert" #t) "headers" (dict "x-idem" "k1") "body" (dict "name" "ada")))`,
    );
    if (e.kind !== "http") throw new Error("expected http");
    expect(e.query).toEqual({ upsert: true });
    expect(e.headers).toEqual({ "x-idem": "k1" });
    expect(e.body).toEqual({ name: "ada" });
  });

  it("a structured body changes the content key (the payload is part of the effect identity)", async () => {
    const a = await capturePost(`(http/post "api" "/x" (dict "body" (dict "v" 1)))`);
    const b = await capturePost(`(http/post "api" "/x" (dict "body" (dict "v" 2)))`);
    expect(dataEffectKey(a)).not.toBe(dataEffectKey(b));
  });
});

describe("the resolver result crosses the membrane back into scheme", () => {
  it("a returned row array is usable as a scheme list", async () => {
    const env = envWith(async () => [{ id: 1 }, { id: 2 }]);
    // (length …) only works if the JS array came back as a scheme list.
    const n = await run(env, `(length (sql/query "db" "select id from t" (list)))`);
    expect(n).toBe(2);
  });
});

describe("describeDataEffect — legible at-a-glance identity", () => {
  it("http includes method + label + path", () => {
    expect(describeDataEffect({ kind: "http", method: "GET", label: "weather-api", path: "/forecast" })).toBe(
      "http GET weather-api/forecast",
    );
  });

  it("sql includes the label", () => {
    expect(describeDataEffect({ kind: "sql", label: "analytics", query: "select 1", params: [] })).toBe(
      "sql analytics",
    );
  });
});
