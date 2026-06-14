// Local-runtime connectors: OpenAI base transport + native capability probe. One per
// runtime. LM Studio is the first; Ollama would join here with its own probe filling
// the same `ConnectorStatus`/`LocalModelInfo` shape.
export * from "./lmstudio.js";
