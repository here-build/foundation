/**
 * Side-effect import: register a default-configured openai backend
 * with the Project static registry. Use when the calling app picks up
 * `OPENAI_API_KEY` from the environment and doesn't need per-call
 * customisation.
 *
 *   import "@here.build/arrival-chain/backends/openai/register";
 *
 * For programmatic registration with custom options:
 *
 *   import { Project } from "@here.build/arrival-chain";
 *   import { openaiBackend } from "@here.build/arrival-chain/backends/openai";
 *   Project.registerBackend("openai", openaiBackend({ apiKey: "..." }));
 */
import { Project } from "../../project.js";
import { openaiBackend } from "../openai.js";

Project.registerBackend("openai", openaiBackend());
