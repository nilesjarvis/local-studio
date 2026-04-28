// CRITICAL
import { Agent } from "@mariozechner/pi-agent-core";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantStream,
  StreamContext,
  StreamModel,
  StreamOptions,
  ToolCall,
} from "./pi-agent-types";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import { convertMessagesForProvider } from "./context-converter";

type ToolCallWithPartialArguments = ToolCall & { partialArgs?: string };
type WritableAssistantStream = AssistantStream & {
  push: (event: AssistantMessageEvent) => void;
  end: () => void;
};

const defaultStreamFunction = new Agent().streamFn as (
  model: StreamModel,
  context: StreamContext,
  options?: StreamOptions
) => AssistantStream;

const createStreamLike = (baseStream: AssistantStream): WritableAssistantStream => {
  const StreamConstructor = baseStream.constructor as new () => WritableAssistantStream;
  return new StreamConstructor();
};

const normalizeTextOnlyOpenAiMessages = (payload: unknown): void => {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return;
  }

  const messages = (payload as Record<string, unknown>)["messages"];
  if (!Array.isArray(messages)) {
    return;
  }

  for (const message of messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      continue;
    }
    const record = message as Record<string, unknown>;
    const content = record["content"];
    if (!Array.isArray(content)) {
      continue;
    }

    const chunks: string[] = [];
    let textOnly = true;
    for (const part of content) {
      if (!part || typeof part !== "object" || Array.isArray(part)) {
        textOnly = false;
        break;
      }
      const partRecord = part as Record<string, unknown>;
      const type = typeof partRecord["type"] === "string" ? partRecord["type"] : "";
      const text = partRecord["text"];
      if ((type !== "text" && type !== "input_text") || typeof text !== "string") {
        textOnly = false;
        break;
      }
      chunks.push(text);
    }

    if (textOnly) {
      record["content"] = chunks.join("");
    }
  }
};

const isToolCallParseError = (message: AssistantMessage): boolean => {
  if (!message.errorMessage) {
    return false;
  }
  const lower = message.errorMessage.toLowerCase();
  // pi-ai may surface JSON parsing failures using different phrasing depending on provider/runtime.
  // Example: "JSON Parse error: Expected '}'" (MiniMax M2.*).
  return (
    lower.includes("json parse error") ||
    lower.includes("unexpected token") ||
    lower.includes("unexpected identifier") ||
    lower.includes("unexpected end of json") ||
    lower.includes("expected '}'") ||
    lower.includes("expected ']'") ||
    (lower.includes("parse error") && lower.includes("json"))
  );
};

const coerceArgumentsObject = (value: unknown, raw: string): Record<string, unknown> => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return { value, raw };
};

const tryParseJsonObjectFromString = (raw: string): Record<string, unknown> | null => {
  const trimmed = raw.trim();
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  const start =
    firstBrace === -1
      ? firstBracket
      : firstBracket === -1
        ? firstBrace
        : Math.min(firstBrace, firstBracket);
  if (start === -1) return null;

  const input = trimmed.slice(start);
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastCompleteIndex = -1;

  for (let index = 0; index < input.length; index++) {
    const c = input[index]!;
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (c === "\\") {
        escaped = true;
        continue;
      }
      if (c === '"') {
        inString = false;
      }
      continue;
    }

    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") {
      stack.push("}");
      continue;
    }
    if (c === "[") {
      stack.push("]");
      continue;
    }
    if (c === "}" || c === "]") {
      const expected = stack[stack.length - 1];
      if (expected === c) {
        stack.pop();
        if (stack.length === 0) {
          lastCompleteIndex = index + 1;
        }
      }
    }
  }

  const tryParse = (candidate: string): Record<string, unknown> | null => {
    try {
      return coerceArgumentsObject(JSON.parse(candidate), raw);
    } catch {
      return null;
    }
  };

  if (lastCompleteIndex > 0) {
    const parsed = tryParse(input.slice(0, lastCompleteIndex));
    if (parsed) return parsed;
  }

  if (stack.length > 0) {
    const balanced = `${input}${stack.slice().reverse().join("")}`;
    const parsed = tryParse(balanced);
    if (parsed) return parsed;
  }

  return null;
};

const buildToolCallEndEvents = (message: AssistantMessage): AssistantMessageEvent[] => {
  const events: AssistantMessageEvent[] = [];
  message.content.forEach((block, index): void => {
    if (block.type !== "toolCall") {
      return;
    }
    const toolBlock = block as ToolCallWithPartialArguments;
    if (!toolBlock.partialArgs || toolBlock.partialArgs.trim().length === 0) {
      return;
    }
    try {
      toolBlock.arguments = coerceArgumentsObject(
        JSON.parse(toolBlock.partialArgs),
        toolBlock.partialArgs
      );
    } catch {
      // If the provider stream ended mid-JSON (common with tool calling), salvage what we can so the
      // agent can proceed and surface tool errors as tool failures instead of aborting the run.
      toolBlock.arguments = tryParseJsonObjectFromString(toolBlock.partialArgs) ?? {
        raw: toolBlock.partialArgs,
      };
    }
    const toolBlockRecord = toolBlock as unknown as Record<string, unknown>;
    delete toolBlockRecord["partialArgs"];
    events.push({
      type: "toolcall_end",
      contentIndex: index,
      toolCall: toolBlock,
      partial: message,
    });
  });
  return events;
};

const shouldRecoverToolCallError = (message: AssistantMessage): boolean => {
  if (!isToolCallParseError(message)) {
    return false;
  }
  return message.content.some((block): boolean => {
    if (block.type !== "toolCall") {
      return false;
    }
    const toolBlock = block as ToolCallWithPartialArguments;
    return typeof toolBlock.partialArgs === "string" && toolBlock.partialArgs.trim().length > 0;
  });
};

const finalizeRecoveredMessage = (message: AssistantMessage): void => {
  const hasToolCalls = message.content.some((block): boolean => block.type === "toolCall");
  message.stopReason = hasToolCalls ? "toolUse" : "stop";
  const messageRecord = message as unknown as Record<string, unknown>;
  delete messageRecord["errorMessage"];
};

export const streamOpenAiCompletionsSafe: StreamFn = (
  model: StreamModel,
  context: StreamContext,
  options?: StreamOptions
): AssistantStream => {
  if (model.api !== "openai-completions") {
    return defaultStreamFunction(model, context, options);
  }

  const wrappedOptions = {
    ...options,
    // Let pi-ai do the canonical Pi Message -> OpenAI payload conversion first,
    // then adapt the resulting OpenAI text-only content parts for SGLang builds
    // that still expect `message.content` to be a string.
    onPayload: (payload: unknown): void => {
      options?.onPayload?.(payload);
      normalizeTextOnlyOpenAiMessages(payload);
	      if (typeof model.provider === "string" && model.provider !== "openai") {
	        convertMessagesForProvider(payload as Record<string, unknown>, model.provider);
	      }
    },
  };

  const baseStream = defaultStreamFunction(model, context, wrappedOptions);
  const stream = createStreamLike(baseStream);

  (async (): Promise<void> => {
    try {
      for await (const event of baseStream) {
        if (event.type !== "error") {
          stream.push(event);
          continue;
        }

        const message = event.error;
        if (!shouldRecoverToolCallError(message)) {
          stream.push(event);
          stream.end();
          return;
        }

        const toolCallEvents = buildToolCallEndEvents(message);
        if (toolCallEvents.length === 0) {
          stream.push(event);
          stream.end();
          return;
        }

        finalizeRecoveredMessage(message);
        for (const toolEvent of toolCallEvents) {
          stream.push(toolEvent);
        }
        const reason: Extract<AssistantMessage["stopReason"], "stop" | "length" | "toolUse"> =
          message.stopReason === "toolUse" ? "toolUse" : "stop";
        stream.push({ type: "done", reason, message });
        stream.end();
        return;
      }
      stream.end();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const fallback: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: "" }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "error",
        errorMessage,
        timestamp: Date.now(),
      };
      stream.push({ type: "error", reason: "error", error: fallback });
      stream.end();
    }
  })().catch((error) => {
    console.error("[stream-openai-completions-safe] Unhandled error in stream:", error);
  });

  return stream;
};
