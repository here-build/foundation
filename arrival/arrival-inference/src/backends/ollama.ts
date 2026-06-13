// Namespace imports (not named): vite externalizes node:http(s) to a browser
// stub with no NAMED exports, so `{ request }` hard-fails the SPA bundle even
// though ollama is node-only and never selected there. A namespace import
// resolves to the (empty) stub fine; `.request` is only touched in node.
import * as nodeHttp from "node:http";
import type { IncomingMessage } from "node:http";
import * as nodeHttps from "node:https";

import invariant from "tiny-invariant";

import type { Completion, ModelBackend, ModelSpec, ToolCall, ToolDescriptor } from "../model.js";
import { coerceModelJson, renderSchema, specMessages, type ChatMessage } from "./_shared.js";

/** POST `payload` to `url` and resolve with the streaming response. Uses node:http(s)
 *  directly — NOT global fetch — because undici's 300s headersTimeout fires while a large
 *  model cold-loads or does a slow prompt-eval before its first token. node:http has no such
 *  default, so a multi-minute thinking response streams fine. No timeout is set: a local
 *  inference daemon has no runaway-connection risk, and the caller's transient-retry wraps it. */
function postStream(url: URL, payload: string): Promise<IncomingMessage> {
  const requestFn = url.protocol === "https:" ? nodeHttps.request : nodeHttp.request;
  return new Promise((resolve, reject) => {
    const req = requestFn(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      },
      resolve,
    );
    req.on("error", reject);
    req.end(payload);
  });
}

export interface OllamaOptions {
  /** Ollama base (no `/v1`). Defaults to the local daemon. The NATIVE `/api/chat`
   *  endpoint is used deliberately — not the OpenAI-compat `/v1` — because per-request
   *  thinking control (`think`) is honored only there (the `/v1` shim ignores it). */
  baseURL?: string;
  /** Per-request reasoning gate, the whole reason this backend exists. `true` → the
   *  model thinks (reasoning surfaces in `message.thinking`, kept OUT of `content`);
   *  `false` → no reasoning, direct answer. A single thinking model (e.g. glm-4.7-flash)
   *  thus serves BOTH a fast no-think scout/serializer (`think:false`) and a thinking
   *  ideator (`think:true`) — the role-split with one model, which `/v1` could not do.
   *  Undefined → field omitted (model default). */
  think?: boolean;
  /** Default completion-token cap (`num_predict`); per-call `spec.maxTokens` overrides. */
  maxTokens?: number;
  /** Sampling temperature; undefined → endpoint default. */
  temperature?: number;
}

/** Ollama's `/api/chat` message shape (a superset of `{role,content}` with tool fields). */
interface OllamaMessage {
  role: string;
  content: string;
  tool_calls?: Array<{ function: { name: string; arguments: unknown } }>;
}

const toOllamaMessages = (messages: readonly ChatMessage[]): OllamaMessage[] =>
  messages.map((m) => ({
    role: m.role,
    content: m.content,
    ...(m.toolCalls && m.toolCalls.length > 0
      ? { tool_calls: m.toolCalls.map((tc) => ({ function: { name: tc.name, arguments: tc.arguments } })) }
      : {}),
  }));

const toOllamaTool = (t: ToolDescriptor): Record<string, unknown> => ({
  type: "function",
  function: {
    name: t.name,
    ...(t.description ? { description: t.description } : {}),
    ...(t.inputSchema ? { parameters: t.inputSchema } : {}),
  },
});

interface OllamaChatResponse {
  message?: {
    content?: string;
    thinking?: string;
    tool_calls?: Array<{ function?: { name?: string; arguments?: unknown } }>;
  };
  done?: boolean;
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

/**
 * Local Ollama backend over the NATIVE `/api/chat` endpoint. The point of difference
 * from the OpenAI-compat path is per-request `think`: Ollama's `/v1` shim drops it, so
 * one model cannot be both modes there; here it can. Thinking, when on, lands in
 * `message.thinking` (its own channel) and is never mixed into `content` — so a schema'd
 * call still parses clean, and a text-mode scout reads only the answer.
 *
 * No rate-limit retry: this is a local daemon with no 429s, and the inference plane's
 * own transient-retry wraps the call.
 */
export function ollamaBackend(opts: OllamaOptions = {}): ModelBackend {
  const base = (opts.baseURL ?? "http://localhost:11434").replace(/\/+$/, "").replace(/\/v1$/, "");
  return {
    async complete(spec: ModelSpec): Promise<Completion> {
      const schema = renderSchema(spec.schema);
      const numPredict = spec.maxTokens ?? opts.maxTokens;
      // A `#think` / `#nothink` suffix on the model name selects reasoning PER CALL and is
      // stripped before the request — so a caller that can only pass a model string (the
      // store keys inference by model, and two roles sharing one model must stay distinct)
      // still routes thinking per role. Overrides the construction-time `opts.think`.
      const think = spec.model.endsWith("#think") ? true : spec.model.endsWith("#nothink") ? false : opts.think;
      const model = spec.model.replace(/#(no)?think$/, "");
      const body = {
        model,
        messages: toOllamaMessages(specMessages(spec)),
        // STREAM: a thinking response can take minutes to compute; with stream:false the fetch
        // waits for the whole body before any headers arrive and trips undici's headersTimeout
        // (UND_ERR_HEADERS_TIMEOUT). Streaming sends NDJSON chunks as tokens generate, so headers
        // land at the first token — no timeout — and we accumulate the deltas ourselves.
        stream: true,
        ...(think === undefined ? {} : { think }),
        ...(schema ? { format: schema } : {}),
        ...(spec.tools && spec.tools.length > 0 ? { tools: spec.tools.map(toOllamaTool) } : {}),
        options: {
          ...(opts.temperature === undefined ? {} : { temperature: opts.temperature }),
          ...(numPredict === undefined ? {} : { num_predict: numPredict }),
        },
      };

      const res = await postStream(new URL(`${base}/api/chat`), JSON.stringify(body));
      const status = res.statusCode ?? 0;

      // Accumulate the NDJSON stream: each line is a chat chunk with content/thinking deltas;
      // the final line (done:true) carries usage + done_reason + any tool calls.
      res.setEncoding("utf8");
      let buf = "";
      let content = "";
      let thinking = "";
      let doneReason: string | undefined;
      const usage = { inputTokens: 0, outputTokens: 0 };
      const rawToolCalls: NonNullable<NonNullable<OllamaChatResponse["message"]>["tool_calls"]> = [];
      // INTER-TOKEN IDLE WATCHDOG (see vercel.ts): a stream that stalls mid-generation would await
      // forever — destroy the socket on idle so the for-await throws (transient → makeInfer retries).
      // Env: ARRIVAL_INFER_IDLE_MS (default 180s).
      const idleMs = Number(process.env.ARRIVAL_INFER_IDLE_MS) || 180_000;
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const armIdle = (): void => {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(
          () => res.destroy(new Error(`infer idle ${idleMs}ms — stream stalled (aborted)`)),
          idleMs,
        );
      };
      try {
        armIdle();
        for await (const piece of res) {
          armIdle(); // reset on every chunk — fires only on a true stall
          buf += piece as string;
          let nl: number;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            invariant(status < 400, () => `ollama /api/chat ${status}: ${line.slice(0, 300)}`);
            const chunk = JSON.parse(line) as OllamaChatResponse;
            const m = chunk.message;
            if (m?.content) content += m.content;
            if (m?.thinking) thinking += m.thinking;
            if (m?.tool_calls) rawToolCalls.push(...m.tool_calls);
            if (chunk.done) {
              doneReason = chunk.done_reason;
              usage.inputTokens = chunk.prompt_eval_count ?? 0;
              usage.outputTokens = chunk.eval_count ?? 0;
            }
          }
        }
      } finally {
        if (idleTimer) clearTimeout(idleTimer);
      }

      // Schema'd: parse content to the structured value (recover from the reasoning channel
      // if the model emptied content into `thinking`). Plain: the content IS the value.
      const value = spec.schema
        ? (() => {
            const c = coerceModelJson(content, { finish: doneReason, reasoning: thinking });
            invariant(c.ok, () => `ollama: unparseable schema'd response (finish=${doneReason})`);
            return c.value;
          })()
        : content;

      const toolCalls: ToolCall[] | undefined =
        rawToolCalls.length > 0
          ? rawToolCalls.map((tc, i) => ({
              id: `call_${i}`,
              name: String(tc.function?.name ?? ""),
              arguments: tc.function?.arguments ?? {},
            }))
          : undefined;

      return { value, usage, ...(toolCalls ? { toolCalls } : {}) };
    },
  };
}
