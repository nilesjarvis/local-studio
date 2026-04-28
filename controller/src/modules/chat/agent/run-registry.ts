import type { Agent } from "@mariozechner/pi-agent-core";
import {
  createStateMachine,
  type StateMachineContainer,
} from "../../../../../shared/src/state-machine";
import type { ApprovalGate } from "./tool-approval-gate";

export type RunRegistryPhase = "starting" | "running" | "aborting" | "finished";

export interface RunRegistryEntry {
  runId: string;
  phase: RunRegistryPhase;
  agent: Agent;
  abort: AbortController;
  model: string | null;
  provider: string;
  approvalGate: ApprovalGate | undefined;
}

export interface RunRegistry {
  getRun: (runId: string) => RunRegistryEntry | null;
  createRun: (
    runId: string,
    agent: Agent,
    abort: AbortController,
    model: string | null,
    provider: string,
    approvalGate?: ApprovalGate
  ) => RunRegistryEntry;
  markRunning: (runId: string) => void;
  markAbortRequested: (runId: string) => void;
  markFinished: (runId: string) => void;
  deleteRun: (runId: string) => boolean;
  clear: () => void;
  size: () => number;
  listRuns: () => Array<RunRegistryEntry>;
}

interface RunRegistryState {
  runs: Map<string, RunRegistryEntry>;
}

type RunRegistryEvent =
  | {
      type: "create";
      runId: string;
      agent: Agent;
      abort: AbortController;
      model: string | null;
      provider: string;
      approvalGate: ApprovalGate | undefined;
    }
  | {
      type: "start";
      runId: string;
    }
  | {
      type: "abort";
      runId: string;
    }
  | {
      type: "finish";
      runId: string;
    }
  | {
      type: "remove";
      runId: string;
    };

const reducer = (state: RunRegistryState, event: RunRegistryEvent): RunRegistryState => {
  const next = new Map(state.runs);

  switch (event.type) {
    case "create": {
      next.set(event.runId, {
        runId: event.runId,
        phase: "starting",
        agent: event.agent,
        abort: event.abort,
        model: event.model,
        provider: event.provider,
        approvalGate: event.approvalGate,
      });
      return { ...state, runs: next };
    }
    case "start": {
      const current = next.get(event.runId);
      if (!current) return state;
      next.set(event.runId, { ...current, phase: "running" });
      return { ...state, runs: next };
    }
    case "abort": {
      const current = next.get(event.runId);
      if (!current) return state;
      next.set(event.runId, { ...current, phase: "aborting" });
      return { ...state, runs: next };
    }
    case "finish": {
      const current = next.get(event.runId);
      if (!current) return state;
      next.set(event.runId, { ...current, phase: "finished" });
      return { ...state, runs: next };
    }
    case "remove": {
      if (!next.has(event.runId)) {
        return state;
      }
      next.delete(event.runId);
      return { ...state, runs: next };
    }
    default:
      return state;
  }
};

export const createRunRegistry = (): RunRegistry => {
  const machine: StateMachineContainer<
    RunRegistryState,
    RunRegistryEvent,
    undefined,
    never
  > = createStateMachine({
    initialState: {
      runs: new Map<string, RunRegistryEntry>(),
    },
    transition: (state, _, event) => ({
      state: reducer(state, event),
      effects: [],
    }),
  });

  return {
    getRun: (runId: string): RunRegistryEntry | null => {
      const current = machine.state.runs.get(runId);
      return current ?? null;
    },
    createRun: (
      runId: string,
      agent: Agent,
      abort: AbortController,
      model: string | null,
      provider: string,
      approvalGate?: ApprovalGate
    ): RunRegistryEntry => {
      machine.dispatch(
        {
          type: "create",
          runId,
          agent,
          abort,
          model,
          provider,
          approvalGate,
        },
        undefined
      );
      return machine.state.runs.get(runId) as RunRegistryEntry;
    },
    markRunning: (runId: string): void => {
      machine.dispatch({ type: "start", runId }, undefined);
    },
    markAbortRequested: (runId: string): void => {
      machine.dispatch({ type: "abort", runId }, undefined);
    },
    markFinished: (runId: string): void => {
      machine.dispatch({ type: "finish", runId }, undefined);
    },
    deleteRun: (runId: string): boolean => {
      const hadRun = machine.state.runs.has(runId);
      machine.dispatch({ type: "remove", runId }, undefined);
      return hadRun;
    },
    clear: (): void => {
      const entries = Array.from(machine.state.runs.keys());
      for (const runId of entries) {
        machine.dispatch({ type: "remove", runId }, undefined);
      }
    },
    size: (): number => machine.state.runs.size,
    listRuns: (): Array<RunRegistryEntry> => Array.from(machine.state.runs.values()),
  };
};
