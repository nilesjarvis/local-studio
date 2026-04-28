// CRITICAL
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type {
  AgentModel,
  AssistantMessage,
  ImageContent,
  LlmMessage,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  Usage,
  UserMessage,
} from "./pi-agent-types";
import { AGENT_TOOL_NAMES, type AgentToolName } from "./contracts";

type StoredMessageRecord = Record<string, unknown>;

const getString = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;
const getNumber = (value: unknown): number | undefined =>
  typeof value === "number" && !Number.isNaN(value) ? value : undefined;

const parseJson = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};

const parseTimestamp = (value: unknown): number => {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return parsed;
  }
  return Date.now();
};

const normalizeToolArguments = (value: unknown): Record<string, unknown> => {
  if (!value) return {};
  if (typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return { raw: value };
    }
  }
  return { value };
};

const extractToolResult = (
  raw: unknown
): { text: string; isError: boolean; details: Record<string, unknown> } | null => {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === "string") {
    return { text: raw, isError: false, details: { content: raw } };
  }
  if (typeof raw === "object") {
    const record = raw as Record<string, unknown>;
    const isError = record["isError"] === true;
    const content = record["content"] ?? record["result"] ?? record["output"];
    if (typeof content === "string") {
      return { text: content, isError, details: record };
    }
    try {
      return { text: JSON.stringify(content ?? record), isError, details: record };
    } catch {
      return { text: String(content ?? raw), isError, details: record };
    }
  }
  return { text: String(raw), isError: false, details: { content: raw } };
};

const buildUsage = (message: StoredMessageRecord): Usage => {
  const promptTokens =
    getNumber(message["prompt_tokens"]) ?? getNumber(message["request_prompt_tokens"]) ?? 0;
  const completionTokens =
    getNumber(message["completion_tokens"]) ?? getNumber(message["request_completion_tokens"]) ?? 0;
  const totalTokens =
    getNumber(message["total_tokens"]) ??
    getNumber(message["request_total_input_tokens"]) ??
    promptTokens + completionTokens;
  const cacheRead = getNumber(message["cache_read_tokens"]) ?? 0;
  const cacheWrite = getNumber(message["cache_write_tokens"]) ?? 0;
  let cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const rawCost = message["cost_json"];
  if (rawCost && typeof rawCost === "object" && !Array.isArray(rawCost)) {
    const c = rawCost as Record<string, unknown>;
    cost = {
      input: getNumber(c["input"]) ?? 0,
      output: getNumber(c["output"]) ?? 0,
      cacheRead: getNumber(c["cacheRead"]) ?? 0,
      cacheWrite: getNumber(c["cacheWrite"]) ?? 0,
      total: getNumber(c["total"]) ?? 0,
    };
  }
  return {
    input: promptTokens,
    output: completionTokens,
    cacheRead,
    cacheWrite,
    totalTokens,
    cost,
  };
};

const buildAssistantContent = (
  message: StoredMessageRecord,
  toolCallsById: Map<string, ToolCall>
): Array<TextContent | ThinkingContent | ToolCall> => {
  const contentBlocks: Array<TextContent | ThinkingContent | ToolCall> = [];
  const rawParts = Array.isArray(message["parts"])
    ? (message["parts"] as Array<Record<string, unknown>>)
    : [];
  const addedToolCalls = new Set<string>();

  for (const part of rawParts) {
    const type = getString(part["type"]) ?? "";
    if (type === "text") {
      const text = getString(part["text"]) ?? "";
      if (text) {
        contentBlocks.push({ type: "text", text });
      }
      continue;
    }
    if (type === "reasoning") {
      const thinking = getString(part["text"]) ?? "";
      if (thinking) {
        contentBlocks.push({ type: "thinking", thinking });
      }
      continue;
    }
    const isToolPart = type === "dynamic-tool" || type.startsWith("tool-");
    if (isToolPart) {
      const toolCallId = getString(part["toolCallId"]) ?? "";
      const toolName =
        getString(part["toolName"]) ??
        (type.startsWith("tool-") ? type.replace(/^tool-/, "") : "tool");
      const input = normalizeToolArguments(part["input"]);
      if (toolCallId) {
        const existing = toolCallsById.get(toolCallId);
        if (existing) {
          contentBlocks.push(existing);
        } else {
          contentBlocks.push({
            type: "toolCall",
            id: toolCallId,
            name: toolName,
            arguments: input,
          });
        }
        addedToolCalls.add(toolCallId);
      }
      continue;
    }
  }

  for (const [toolCallId, toolCall] of toolCallsById.entries()) {
    if (!addedToolCalls.has(toolCallId)) {
      contentBlocks.push(toolCall);
    }
  }

  if (contentBlocks.length === 0) {
    const content = getString(message["content"]) ?? "";
    if (content) {
      contentBlocks.push({ type: "text", text: content });
    }
  }

  return contentBlocks;
};

const buildToolCalls = (message: StoredMessageRecord): Map<string, ToolCall> => {
  const calls = Array.isArray(message["tool_calls"])
    ? message["tool_calls"]
    : parseJson(message["tool_calls"]);
  const toolCalls: unknown[] = Array.isArray(calls) ? calls : [];
  const map = new Map<string, ToolCall>();

  for (const call of toolCalls) {
    if (!call || typeof call !== "object") continue;
    const record = call as Record<string, unknown>;
    const id = getString(record["id"]) ?? "";
    const functionPayload = record["function"] as Record<string, unknown> | undefined;
    const name = getString(functionPayload?.["name"]) ?? "tool";
    const argsRaw = functionPayload?.["arguments"];
    const args = normalizeToolArguments(argsRaw);
    if (!id) continue;
    map.set(id, { type: "toolCall", id, name, arguments: args });
  }

  return map;
};

const buildToolResults = (message: StoredMessageRecord): ToolResultMessage[] => {
  const calls = Array.isArray(message["tool_calls"])
    ? message["tool_calls"]
    : parseJson(message["tool_calls"]);
  const toolCallsArray: unknown[] = Array.isArray(calls) ? calls : [];
  const results: ToolResultMessage[] = [];
  const agentFsTools = new Set<string>([
    AGENT_TOOL_NAMES.LIST_FILES,
    AGENT_TOOL_NAMES.READ_FILE,
    AGENT_TOOL_NAMES.WRITE_FILE,
    AGENT_TOOL_NAMES.DELETE_FILE,
    AGENT_TOOL_NAMES.MAKE_DIRECTORY,
    AGENT_TOOL_NAMES.MOVE_FILE,
  ]);

  for (const call of toolCallsArray) {
    if (!call || typeof call !== "object") continue;
    const record = call as Record<string, unknown>;
    const id = getString(record["id"]) ?? "";
    const functionPayload = record["function"] as Record<string, unknown> | undefined;
    const name = getString(functionPayload?.["name"]) ?? "tool";
    if (agentFsTools.has(name as AgentToolName)) {
      results.push({
        role: "toolResult",
        toolCallId: id,
        toolName: name,
        content: [{ type: "text", text: "[completed]" }],
        details: {},
        isError: false,
        timestamp: parseTimestamp(record["created_at"] ?? message["created_at"]),
      });
      continue;
    }
    const result = extractToolResult(record["result"]);
    if (!id || !result) continue;
    results.push({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: [{ type: "text", text: result.text }],
      details: result.details,
      isError: result.isError,
      timestamp: parseTimestamp(record["created_at"] ?? message["created_at"]),
    });
  }

  return results;
};

export const mapStoredMessagesToAgentMessages = (
  storedMessages: StoredMessageRecord[],
  fallbackModel: AgentModel<"openai-completions">
): AgentMessage[] => {
  const mapped: AgentMessage[] = [];

  for (const message of storedMessages) {
    const role = getString(message["role"]) ?? "assistant";
    const timestamp = parseTimestamp(message["created_at"]);

    if (role === "user") {
      const textContent = getString(message["content"]) ?? "";
      const rawParts = Array.isArray(message["parts"])
        ? (message["parts"] as Array<Record<string, unknown>>)
        : [];
      const imageParts: ImageContent[] = [];
      for (const part of rawParts) {
        if (
          getString(part["type"]) === "image" &&
          typeof part["data"] === "string" &&
          typeof part["mimeType"] === "string"
        ) {
          imageParts.push({
            type: "image",
            data: part["data"] as string,
            mimeType: part["mimeType"] as string,
          });
        }
      }
      if (imageParts.length > 0) {
        const contentArray: (TextContent | ImageContent)[] = [];
        if (textContent) {
          contentArray.push({ type: "text", text: textContent });
        }
        contentArray.push(...imageParts);
        mapped.push({ role: "user", content: contentArray, timestamp } as UserMessage);
      } else {
        mapped.push({ role: "user", content: textContent, timestamp });
      }
      continue;
    }

    if (role === "assistant") {
      const toolCalls = buildToolCalls(message);
      const content = buildAssistantContent(message, toolCalls);
      const usage = buildUsage(message);
      const stopReason = content.some((block) => block.type === "toolCall") ? "toolUse" : "stop";
      const assistant: AssistantMessage = {
        role: "assistant",
        content,
        api: fallbackModel.api,
        provider: fallbackModel.provider,
        model: getString(message["model"]) ?? fallbackModel.id,
        usage,
        stopReason,
        timestamp,
      };
      mapped.push(assistant);
      const toolResults = buildToolResults(message);
      if (toolResults.length > 0) {
        mapped.push(...toolResults);
      }
      continue;
    }
  }

  return mapped;
};

export const mapAgentMessagesToLlm = (messages: AgentMessage[]): LlmMessage[] =>
  messages.filter(
    (m) => m.role === "user" || m.role === "assistant" || m.role === "toolResult"
  ) as LlmMessage[];
