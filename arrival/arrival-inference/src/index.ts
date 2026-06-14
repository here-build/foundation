// @here.build/arrival-inference — the inference-runtime cluster extracted from
// arrival-chain (Stage A). Pure "talk to LLMs" layer: model spec/router, provider
// backends, pricing/cost, single-flight infer cache, the rich InferString response,
// and the agentic tool-loop. Knows ModelSpec (data), never the scheme evaluator.
//
// `export *` is used for the cluster modules so EVERY symbol surfaces (incl.
// LlmParams / LLM_PARAM_TYPES from model.ts and the backend-authoring helpers in
// backends/_shared.ts) — arrival-chain re-exports this barrel for back-compat.

// ── Model spec / backend protocol ────────────────────────────────────
export * from "./model.js";
// ── Pricing + speed ──────────────────────────────────────────────────
export * from "./pricing.js";
// ── Projected cost ───────────────────────────────────────────────────
export * from "./projected-cost.js";
// ── Run spend accounting ─────────────────────────────────────────────
export * from "./run-spend.js";
// ── Model router registry ────────────────────────────────────────────
export * from "./registry.js";
// ── Single-flight infer store / cache ────────────────────────────────
export * from "./infer-store.js";
// ── Rich inference response (string-transparent + chunks/reasoning) ──
export * from "./infer-string.js";
// ── Agentic tool-loop driver ─────────────────────────────────────────
export * from "./agentic-loop.js";
// ── Backend authoring helpers (the shared chat-protocol kernel) ──────
export * from "./backends/_shared.js";

// ── Local-runtime connectors (OpenAI transport + native capability probe) ──
export * from "./connectors/index.js";

// ── Concrete backend factories (also reachable via the ./backends/* subpaths) ──
export { anthropicBackend } from "./backends/anthropic.js";
export { openaiBackend } from "./backends/openai.js";
export { openrouterBackend, openRouterCostMicroUsd } from "./backends/openrouter.js";
export { ollamaBackend } from "./backends/ollama.js";
export { vercelBackend } from "./backends/vercel.js";
