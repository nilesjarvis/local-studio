import type { AgentEventType } from "./contracts";
import type { ApprovalGate } from "./tool-approval-gate";

export interface AgentToolRegistryOptions {
  sessionId: string;
  agentMode: boolean;
  agentFiles?: boolean;
  emitEvent?: (type: AgentEventType, data: Record<string, unknown>) => void;
  approvalGate?: ApprovalGate;
  runId?: string;
}
