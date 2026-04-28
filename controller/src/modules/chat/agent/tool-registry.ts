// CRITICAL
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { AppContext } from "../../../types/context";
import { buildAgentFsTools } from "./tool-registry-agentfs";
import { createTextResult } from "./tool-registry-common";
import { buildLocalTools } from "./tool-registry-local";
import { buildPlanTools } from "./tool-registry-plan";
import { wrapToolsWithCircuitBreaker } from "./tool-circuit-breaker";

export type { AgentToolRegistryOptions } from "./tool-registry-types";
import type { AgentToolRegistryOptions } from "./tool-registry-types";

/**
 * Build tools available to the agent for a session, based on enabled capabilities.
 * @param context - Application context.
 * @param options - Registry options.
 * @returns Agent tools.
 */
export const buildAgentTools = async (
  context: AppContext,
  options: AgentToolRegistryOptions
): Promise<AgentTool[]> => {
  const tools: AgentTool[] = [];

  if (options.agentMode) {
    tools.push(...buildPlanTools(context, options));
  }

  if (options.agentMode) {
    const localOpts: { sessionId: string; approvalGate?: typeof options.approvalGate; runId?: string } = {
      sessionId: options.sessionId,
    };
    if (options.approvalGate) localOpts.approvalGate = options.approvalGate;
    if (options.runId) localOpts.runId = options.runId;
    tools.push(...buildLocalTools(context, localOpts));
  }

  if (options.agentMode || options.agentFiles) {
    tools.push(...buildAgentFsTools(context, options));
  }

  // Always include a no-op tool for debugging.
  tools.push({
    name: "noop",
    label: "noop",
    description: "No-op tool for debugging.",
    parameters: {
      type: "object",
      properties: {
        message: { type: "string" },
      },
    } as unknown as TSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const message = typeof raw["message"] === "string" ? raw["message"] : "noop";
      return createTextResult(message, { message });
    },
  });

  return wrapToolsWithCircuitBreaker(tools);
};
