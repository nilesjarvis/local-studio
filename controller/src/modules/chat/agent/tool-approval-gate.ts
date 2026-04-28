// Per-run approval gate for dangerous tool executions.
// Tool execute functions await approval via a Promise that is resolved
// when the user approves/denies through the frontend.

const APPROVAL_TIMEOUT_MS = 120_000;

export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  runId: string;
  sessionId: string;
}

export interface ApprovalDecision {
  approved: boolean;
  reason: string | undefined;
}

interface PendingApproval extends ApprovalRequest {
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
}

export type ApprovalGate = {
  requestApproval(request: ApprovalRequest): Promise<ApprovalDecision>;
  resolveApproval(toolCallId: string, decision: ApprovalDecision): boolean;
  clear(): void;
  hasPending(toolCallId: string): boolean;
};

export function createApprovalGate(
  emitEvent: (type: string, data: Record<string, unknown>) => void
): ApprovalGate {
  const pending = new Map<string, PendingApproval>();

  const requestApproval = (request: ApprovalRequest): Promise<ApprovalDecision> => {
    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        resolveApproval(request.toolCallId, { approved: false, reason: "Timeout" });
      }, APPROVAL_TIMEOUT_MS);

      const entry: PendingApproval = { ...request, resolve, timer };
      pending.set(request.toolCallId, entry);

      emitEvent("approval_requested", {
        toolCallId: request.toolCallId,
        toolName: request.toolName,
        args: request.args,
        runId: request.runId,
        sessionId: request.sessionId,
      });
    });
  };

  const resolveApproval = (toolCallId: string, decision: ApprovalDecision): boolean => {
    const entry = pending.get(toolCallId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    pending.delete(toolCallId);
    entry.resolve(decision);

    emitEvent("approval_resolved", {
      toolCallId,
      approved: decision.approved,
      reason: decision.reason,
      runId: entry.runId,
      sessionId: entry.sessionId,
    });

    return true;
  };

  return {
    requestApproval,
    resolveApproval,
    hasPending: (toolCallId) => pending.has(toolCallId),
    clear: () => {
      for (const [, entry] of pending) {
        clearTimeout(entry.timer);
        entry.resolve({ approved: false, reason: "Cleared" });
      }
      pending.clear();
    },
  };
}
