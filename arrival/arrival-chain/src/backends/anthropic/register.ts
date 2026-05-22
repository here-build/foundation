/**
 *   import "@here.build/arrival-chain/backends/anthropic/register";
 *
 * Programmatic with options:
 *
 *   import { Project } from "@here.build/arrival-chain";
 *   import { anthropicBackend } from "@here.build/arrival-chain/backends/anthropic";
 *   Project.registerBackend("anthropic", anthropicBackend({ maxTokens: 8000 }));
 */
import { Project } from "../../project.js";
import { anthropicBackend } from "../anthropic.js";

Project.registerBackend("anthropic", anthropicBackend());
