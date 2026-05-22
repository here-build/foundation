import type { ModelBackend, ModelSpec } from "../model.js";
import { lazyBackend, specMessages } from "./_shared.js";

/**
 * Thin bridge to `@host/providers`'s `chatComplete`. `spec.model`
 * is passed through as the tier name; `chatComplete` dispatches it
 * to the configured provider/model for that tier.
 *
 * Valid tier names live on the Project's `models` map; this backend
 * doesn't validate. If chatComplete rejects a tier, it propagates as
 * an InferenceError on the task.
 */
export function tieredProvidersBackend(): ModelBackend {
  return lazyBackend(async () => {
    const { chatComplete } = await import("@host/providers");
    return {
      async complete(spec: ModelSpec): Promise<unknown> {
        const messages = specMessages(spec);
        const system = messages.find((m) => m.role === "system")?.content ?? "";
        const user = messages
          .filter((m) => m.role !== "system")
          .map((m) => (m.role === "assistant" ? `assistant: ${m.content}` : m.content))
          .join("\n\n");
        const wantsJson = spec.schema !== null;
        const res = await chatComplete(spec.model as Parameters<typeof chatComplete>[0], {
          system,
          user,
          ...(wantsJson ? { responseFormat: "json_object" as const } : {}),
        });
        return wantsJson ? JSON.parse(res.text) : res.text;
      },
    };
  });
}
