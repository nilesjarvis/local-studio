// Cross-provider message format normalization.
// Applied in the onPayload hook before sending to the LLM backend.

interface ProviderCompat {
  supportsDeveloperRole?: boolean;
  supportsImageUrl?: boolean;
  supportsMessageName?: boolean;
}

const DEFAULT_COMPAT: ProviderCompat = {
  supportsDeveloperRole: true,
  supportsImageUrl: true,
  supportsMessageName: true,
};

const PROVIDER_COMPAT: Record<string, ProviderCompat> = {
  openai: DEFAULT_COMPAT,
  vllm: DEFAULT_COMPAT,
  sglang: { supportsDeveloperRole: false, supportsImageUrl: true, supportsMessageName: true },
  anthropic: { supportsDeveloperRole: false, supportsImageUrl: false, supportsMessageName: false },
};

export function getProviderCompat(provider: string): ProviderCompat {
  return PROVIDER_COMPAT[provider.toLowerCase()] ?? DEFAULT_COMPAT;
}

export function convertMessagesForProvider(
  payload: Record<string, unknown>,
  targetProvider: string
): void {
  const messages = payload["messages"];
  if (!Array.isArray(messages)) return;

  const compat = getProviderCompat(targetProvider);

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;

    if (!compat.supportsMessageName && "name" in msg) {
      delete (msg as Record<string, unknown>)["name"];
    }

    if (!compat.supportsDeveloperRole && (msg as Record<string, unknown>)["role"] === "developer") {
      (msg as Record<string, unknown>)["role"] = "system";
    }

    const content = (msg as Record<string, unknown>)["content"];
    if (!Array.isArray(content)) continue;

    for (const part of content as Array<Record<string, unknown>>) {
      if (!part || typeof part !== "object") continue;

      if (part["type"] === "image_url" && !compat.supportsImageUrl) {
        const imageUrl = part["image_url"];
        if (imageUrl && typeof imageUrl === "object") {
          const url = (imageUrl as Record<string, unknown>)["url"];
          if (typeof url === "string" && url.startsWith("data:")) {
            const match = url.match(/^data:([^;]+);base64,(.+)$/);
            if (match) {
              part["type"] = "image";
              part["source"] = {
                type: "base64",
                media_type: match[1],
                data: match[2],
              };
              delete part["image_url"];
            }
          }
        }
      }
    }
  }
}
