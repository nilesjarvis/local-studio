// External provider stream function for pi-agent.
// Proxies agent requests through configured external providers (Anthropic, Groq, etc.)
// instead of the local inference backend.

import type { StreamFn } from "@mariozechner/pi-agent-core";
import type { ProviderRouteConfig } from "../../../services/provider-routing";

export function createExternalProviderStreamFn(
  providerConfig: ProviderRouteConfig,
  baseStreamFn: StreamFn
): StreamFn {
  return (model, context, options) => {
    const externalModel = {
      ...model,
      baseUrl: providerConfig.baseUrl,
    };

    const wrappedOptions = {
      ...options,
      onPayload: (payload: unknown): void => {
        options?.onPayload?.(payload);
        if (payload && typeof payload === "object") {
          const p = payload as Record<string, unknown>;
          if (!p["api_key"] && providerConfig.apiKey) {
            p["api_key"] = providerConfig.apiKey;
          }
        }
      },
    };

    return baseStreamFn(externalModel, context, wrappedOptions);
  };
}
