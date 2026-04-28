// CRITICAL
import { Event } from "../../monitoring/event-manager";
import type { AppContext } from "../../../types/context";
import { AGENT_RUN_EVENT_TYPES } from "./contracts";
import type { AssistantMessage, ToolResultMessage, Usage } from "./pi-agent-types";
import { calculateCost, getModelPricing } from "../cost-calculator";

/**
 * Convert Pi usage counters into the controller chat usage shape.
 * @param usage - Usage payload from an assistant message.
 * @returns Language usage counters, or undefined when absent.
 */
export function toLanguageUsage(
  usage: Usage | undefined
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } | undefined;
} | undefined {
  if (!usage) return undefined;
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    totalTokens: usage.totalTokens,
    cacheReadTokens: usage.cacheRead ?? 0,
    cacheWriteTokens: usage.cacheWrite ?? 0,
    cost: usage.cost,
  };
}

/**
 * Convert a tool result payload into persisted text output.
 * @param result - Tool result content from the agent runtime.
 * @returns Text representation of the tool result.
 */
export function extractToolResultText(result: unknown): string {
  if (Array.isArray(result)) {
    return result
      .filter(
        (item) =>
          item && typeof item === "object" && (item as Record<string, unknown>)["type"] === "text"
      )
      .map((item) => String((item as Record<string, unknown>)["text"] ?? ""))
      .join("\n");
  }
  if (result && typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    const content = (result as Record<string, unknown>)["content"];
    return typeof content === "string" ? content : JSON.stringify(content);
  }
  return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

/**
 * Persist an assistant message and publish chat update events.
 * @param context - Application context.
 * @param params - Assistant message persistence parameters.
 * @param params.sessionId - Chat session id.
 * @param params.messageId - Assistant message id.
 * @param params.assistant - Assistant message emitted by the agent runtime.
 * @param params.toolResults - Tool results associated with the assistant turn.
 * @param params.runId - Chat run id.
 * @param params.turnIndex - Optional turn index for multi-turn agent loops.
 */
export function persistAssistantMessage(
  context: AppContext,
  params: {
    sessionId: string;
    messageId: string;
    assistant: AssistantMessage;
    toolResults: ToolResultMessage[];
    runId: string;
    turnIndex?: number;
  }
): void {
  const { sessionId, messageId, assistant, toolResults, runId, turnIndex } = params;

  const contentText = assistant.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");

  const toolResultsById = new Map<string, ToolResultMessage>();
  for (const result of toolResults) {
    toolResultsById.set(result.toolCallId, result);
  }

  const parts: Array<Record<string, unknown>> = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const block of assistant.content) {
    if (block.type === "text") {
      parts.push({ type: "text", text: block.text });
    } else if (block.type === "thinking") {
      parts.push({ type: "reasoning", text: block.thinking });
    } else if (block.type === "toolCall") {
      const toolCallId = block.id;
      const toolName = block.name;
      const input = block.arguments ?? {};

      parts.push({
        type: "dynamic-tool",
        toolCallId,
        toolName,
        input,
        state: "input-available",
      });

      const result = toolResultsById.get(toolCallId);
      if (result) {
        const resultText = extractToolResultText(result.content);
        if (result.isError) {
          parts[parts.length - 1] = {
            ...parts[parts.length - 1],
            state: "output-error",
            errorText: resultText,
          };
        } else {
          parts[parts.length - 1] = {
            ...parts[parts.length - 1],
            state: "output-available",
            output: resultText,
          };
        }
      }

      toolCalls.push({
        id: toolCallId,
        type: "function",
        function: {
          name: toolName,
          arguments: JSON.stringify(input),
        },
        ...(result
          ? {
              result: {
                content: extractToolResultText(result.content),
                isError: result.isError,
              },
            }
          : {}),
      });
    }
  }

  const usage = toLanguageUsage(assistant.usage);
  const metadata: Record<string, unknown> = {
    model: assistant.model,
    usage,
    runId,
  };
  if (typeof turnIndex === "number") {
    metadata["turnIndex"] = turnIndex;
  }

  // Prefer pi-agent cost, fall back to local pricing calculation
  let costJson: Record<string, number> | undefined = usage?.cost;
  if (!costJson || Object.values(costJson).every((v) => v === 0)) {
    const pricing = getModelPricing(context, assistant.model ?? "");
    if (pricing && usage) {
      costJson = calculateCost(
        {
          input: usage.inputTokens,
          output: usage.outputTokens,
          cacheRead: usage.cacheReadTokens,
          cacheWrite: usage.cacheWriteTokens,
        },
        pricing
      );
    }
  }

  context.stores.chatStore.addMessage(
    sessionId,
    messageId,
    "assistant",
    contentText,
    assistant.model,
    toolCalls.length > 0 ? toolCalls : undefined,
    usage?.inputTokens,
    undefined,
    usage?.totalTokens,
    usage?.outputTokens,
    parts,
    metadata,
    undefined,
    undefined,
    usage?.cacheReadTokens,
    usage?.cacheWriteTokens,
    undefined,
    assistant.model,
    costJson
  );

  const sessionSummary = context.stores.chatStore.getSessionSummary(sessionId);
  context.eventManager.publish(
    new Event(AGENT_RUN_EVENT_TYPES.CHAT_MESSAGE_UPSERTED, {
      session_id: sessionId,
      message: {
        id: messageId,
        role: "assistant",
        content: contentText,
        model: assistant.model,
        tool_calls: toolCalls,
        parts,
        metadata,
      },
      session: sessionSummary,
    })
  );
  const usageSummary = context.stores.chatStore.getUsage(sessionId);
  context.eventManager.publish(
    new Event(AGENT_RUN_EVENT_TYPES.CHAT_USAGE_UPDATED, {
      session_id: sessionId,
      usage: usageSummary,
    })
  );
}
