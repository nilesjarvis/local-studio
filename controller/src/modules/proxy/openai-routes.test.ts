import { describe, expect, it } from "bun:test";
import { ensureStreamingUsageIncluded } from "./openai-routes";

describe("openai route request normalization", () => {
  it("injects stream_options.include_usage for streaming requests", () => {
    const payload: Record<string, unknown> = {
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: { other: "preserved" },
    };

    expect(ensureStreamingUsageIncluded(payload)).toBe(true);
    expect(payload["stream_options"]).toEqual({ other: "preserved", include_usage: true });
  });

  it("leaves non-streaming requests unchanged", () => {
    const payload: Record<string, unknown> = { model: "deepseek-v4-flash", stream: false };

    expect(ensureStreamingUsageIncluded(payload)).toBe(false);
    expect(payload["stream_options"]).toBeUndefined();
  });

  it("does not rewrite streaming requests that already include usage", () => {
    const streamOptions = { include_usage: true, other: "preserved" };
    const payload: Record<string, unknown> = {
      model: "deepseek-v4-flash",
      stream: true,
      stream_options: streamOptions,
    };

    expect(ensureStreamingUsageIncluded(payload)).toBe(false);
    expect(payload["stream_options"]).toBe(streamOptions);
  });
});
