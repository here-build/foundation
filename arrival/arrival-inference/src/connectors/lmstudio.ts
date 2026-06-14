/**
 * The LM Studio connector — the first "OpenAI base + native capability extension".
 *
 * Every provider speaks OpenAI chat-completions, so EXECUTION is uniform:
 * `openaiBackend({ baseURL })` runs every model, unchanged. What differs between
 * providers is the metadata side-channel — and LM Studio's is the richest, because
 * it's the local runtime that cares most about exposing machine state. It ships a
 * native REST namespace at `/api/v0/` that returns what `/v1/models` can't: per-model
 * `state` (loaded vs cold), `max_context_length`, and `type` (llm/vlm/embeddings).
 *
 * So this file is exactly two things:
 *   - `probeLmStudio` — read `/api/v0/models`, normalize to a provider-agnostic
 *     `ConnectorStatus`. This is the SOLE LM-Studio-specific code; it doubles as the
 *     type detector (that endpoint answering with that shape IS the proof it's LM Studio).
 *   - `lmStudioRouter` — point every probed model id at one `openaiBackend` transport.
 *
 * The split is deliberate: **`/api/v0` to KNOW (status, in the UI), `/v1` to RUN
 * (inference, via the shared backend).** The native protocol never touches the
 * execution path. Nothing here is persisted — capabilities are a fact about THIS
 * machine right now (which models are pulled, which are hot), re-detected live every
 * load. The only durable footprint is the endpoint, stored as connection intent.
 */
import { openaiBackend } from "../backends/openai.js";
import { emptyRouter, LayeredRouter, type ModelRouter, StaticRouter } from "../registry.js";

/** The default LM Studio server address. Browsers tolerate `localhost` (happy-eyeballs
 *  falls back to IPv4 when the server binds 127.0.0.1 only); a native client should
 *  prefer `127.0.0.1` explicitly. We store nothing unless the user overrides this. */
export const LM_STUDIO_DEFAULT_BASE = "http://localhost:1234";

/**
 * Normalize a stored endpoint to the runtime ROOT — the origin LM Studio serves
 * BOTH namespaces under (`/api/v0/*` to know, `/v1/*` to run). Users naturally
 * paste either the bare origin (`http://localhost:1234`) or the OpenAI base they
 * already use elsewhere (`http://localhost:1234/v1`); both name the same runtime.
 * We strip a trailing `/v1` (the OpenAI-compat suffix) and any trailing slashes so
 * the two namespaces append cleanly — without this, a `…/v1` base would reach
 * `…/v1/api/v0/models` (404) and the router would double to `…/v1/v1`.
 */
export function normalizeLmStudioBase(base = LM_STUDIO_DEFAULT_BASE): string {
  return base.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** A normalized capability read — what a native probe reveals that `/v1/models` can't.
 *  Provider-agnostic on purpose: a future Ollama probe fills the same shape. NEVER
 *  persisted; recomputed live on every load (local environments vary machine to machine). */
export interface LocalModelInfo {
  id: string;
  /** Hot in memory now (LM Studio `state === "loaded"`) — instant vs a cold-load wait. */
  loaded: boolean;
  /** `max_context_length` when the runtime reports it. */
  contextWindow?: number;
  /** `type` — modality without a lookup table. */
  kind: "llm" | "vlm" | "embeddings";
  /** What the model can do beyond plain text completion. Derived from the runtime's
   *  own signals (a `vlm` type IS vision) plus any explicit `capabilities` tokens the
   *  runtime reports; tolerant, since the wire shape varies across LM Studio versions. */
  capabilities: ModelCapability[];
}

/** Provider-agnostic capability tokens — what we can paint an icon for. */
export type ModelCapability = "tool_use" | "vision" | "audio";

/** The live status of a local connector: is it up, and what's on the machine. */
export interface ConnectorStatus {
  reachable: boolean;
  models: LocalModelInfo[];
}

/** One row of `/api/v0/models`. Tolerant: every field is optional on the wire. */
interface V0Model {
  id?: unknown;
  state?: unknown;
  max_context_length?: unknown;
  type?: unknown;
  capabilities?: unknown;
}

const KINDS = new Set(["llm", "vlm", "embeddings"]);

/** Tokens different LM Studio builds use for the same capability → our normalized set. */
const CAPABILITY_ALIASES: Record<string, ModelCapability> = {
  tool_use: "tool_use",
  tools: "tool_use",
  function_calling: "tool_use",
  vision: "vision",
  image_input: "vision",
  audio: "audio",
  audio_input: "audio",
  speech: "audio",
};

/** Derive normalized capabilities from a model's type + whatever `capabilities` the
 *  runtime reports. A `vlm` type IS vision (no token needed); explicit tokens are
 *  mapped through the alias table and de-duplicated. */
function normalizeCapabilities(raw: V0Model, kind: LocalModelInfo["kind"]): ModelCapability[] {
  const caps = new Set<ModelCapability>();
  if (kind === "vlm") caps.add("vision");
  if (Array.isArray(raw.capabilities)) {
    for (const token of raw.capabilities) {
      if (typeof token === "string" && token in CAPABILITY_ALIASES) caps.add(CAPABILITY_ALIASES[token]);
    }
  }
  return [...caps];
}

/** Map one `/api/v0/models` row → `LocalModelInfo`, or `null` if it has no usable id
 *  (skipped by the caller's flatMap). */
function normalizeModel(raw: V0Model): LocalModelInfo[] {
  if (typeof raw.id !== "string" || raw.id.length === 0) return [];
  const kind = typeof raw.type === "string" && KINDS.has(raw.type) ? (raw.type as LocalModelInfo["kind"]) : "llm";
  const ctx = typeof raw.max_context_length === "number" && raw.max_context_length > 0 ? raw.max_context_length : undefined;
  return [
    {
      id: raw.id,
      loaded: raw.state === "loaded",
      ...(ctx === undefined ? {} : { contextWindow: ctx }),
      kind,
      capabilities: normalizeCapabilities(raw, kind),
    },
  ];
}

/**
 * Probe an LM Studio server's native `/api/v0/models`. Returns the live status, or
 * `null` when this isn't (a reachable, CORS-cooperative) LM Studio — a network error
 * (LNA-denied / CORS-blocked / connection refused, all indistinguishable from JS), a
 * non-200, or a response whose shape isn't the `/api/v0` model list. Never throws:
 * the caller treats `null` as "no LM Studio here" and shows the connect/enable nudge.
 *
 * `signal` lets a superseded load abort an in-flight probe.
 *
 * `fetchImpl` injects the transport — default is the global `fetch` (browser-direct, the
 * same-device interactive case). A server-side caller passes a reverse-tunnel adapter so the
 * probe rides the user's own tunnel: the tunnel is server-initiated end to end (the DO mints
 * the call), so probing through it preserves the "server is sole initiator" asymmetry.
 */
export async function probeLmStudio(
  base = LM_STUDIO_DEFAULT_BASE,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectorStatus | null> {
  const root = normalizeLmStudioBase(base);
  let res: Response;
  try {
    res = await fetchImpl(`${root}/api/v0/models`, { method: "GET", signal });
  } catch {
    return null; // LNA-denied / CORS / refused — indistinguishable, all mean "not here / not readable"
  }
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { data?: unknown } | null;
  if (!body || !Array.isArray(body.data)) return null; // wrong shape → not the /api/v0 list → not LM Studio
  return { reachable: true, models: (body.data as V0Model[]).flatMap(normalizeModel) };
}

/**
 * Build a router that serves every probed LM Studio model from ONE local transport.
 * Each model id the probe saw maps to the same `openaiBackend` pointed at `/v1`;
 * an unknown id returns `null` so it falls through to the next `LayeredRouter` layer.
 *
 * `apiKey` is a non-empty placeholder — the OpenAI SDK requires one, LM Studio ignores
 * it. `temperature: 0` suits the structured-emission role (see `openaiBackend`).
 *
 * `fetchImpl` injects the run transport — default global `fetch` (browser-direct). A
 * server-side caller passes a reverse-tunnel adapter so `/v1` inference rides the user's
 * own tunnel, exactly as the probe does.
 */
export function lmStudioRouter(
  status: ConnectorStatus,
  base = LM_STUDIO_DEFAULT_BASE,
  fetchImpl?: typeof fetch,
): ModelRouter {
  const transport = openaiBackend({
    baseURL: `${normalizeLmStudioBase(base)}/v1`,
    apiKey: "lm-studio",
    temperature: 0,
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
  });
  return new StaticRouter(status.models.map((m) => [m.id, transport] as const));
}

/**
 * A router that probes ONE LM Studio endpoint LAZILY — on the first `backendFor`,
 * not at construction. This is the resolver's discovery decision in code: no
 * model list is held server-side, and nothing reaches the endpoint until an
 * `(infer …)` actually asks for a model. The probe (and its resulting
 * `StaticRouter`) is memoized for this router's lifetime, so a run touching the
 * same endpoint twice probes once.
 *
 * A probe miss (`null` — endpoint offline / not LM Studio / unreachable, e.g. a
 * 503 from the reverse tunnel when no node serves it) memoizes the EMPTY router:
 * every `backendFor` returns null and the lookup falls through to the next layer
 * (a lower-precedence local endpoint, then the team router). The endpoint coming
 * online later needs a fresh router (a new request builds one) — correct for the
 * per-request overlay, which is rebuilt each call anyway.
 *
 * `fetchImpl` injects the transport for BOTH probe and run — server-side this is
 * the reverse-tunnel adapter, so discovery and inference both ride the user's own
 * tunnel and the "server is sole initiator" asymmetry holds end to end.
 */
export function lazyLmStudioRouter(base = LM_STUDIO_DEFAULT_BASE, fetchImpl?: typeof fetch): ModelRouter {
  let resolved: Promise<ModelRouter> | undefined;
  const resolve = (): Promise<ModelRouter> => {
    resolved ??= probeLmStudio(base, undefined, fetchImpl).then((status) =>
      status ? lmStudioRouter(status, base, fetchImpl) : emptyRouter,
    );
    return resolved;
  };
  return {
    async backendFor(modelId) {
      return (await resolve()).backendFor(modelId);
    },
  };
}

/**
 * Compose a precedence-ordered local router over several endpoints — the user's
 * personal config order IS the precedence (first endpoint serving a model wins,
 * so LM Studio above Ollama both serving `qwen` resolves to LM Studio). Each
 * endpoint becomes a {@link lazyLmStudioRouter} layer via `fetchFor(endpoint)`,
 * which supplies that endpoint's transport (server-side: a tunnel adapter pinned
 * to `(userId, endpoint)`). Empty list ⇒ the empty router (no local models).
 */
export function localEndpointsRouter(
  endpoints: readonly string[],
  fetchFor: (endpoint: string) => typeof fetch | undefined,
): ModelRouter {
  return new LayeredRouter(endpoints.map((ep) => lazyLmStudioRouter(ep, fetchFor(ep))));
}
