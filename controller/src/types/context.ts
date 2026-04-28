import type { Config } from "../config/env";
import type { Logger } from "../core/logger";
import type { EventManager } from "../modules/monitoring/event-manager";
import type { LaunchState } from "../modules/engines/layers/launch-state";
import type { ControllerMetrics, MetricsRegistry } from "../modules/monitoring/metrics";
import type { ProcessManager } from "../modules/engines/layers/process-manager";
import type { EngineCoordinator } from "../modules/engines/layers/engine-coordinator";
import type { DownloadManager } from "../modules/engines/layers/download-manager";
import type { ChatRunOptions, ChatRunStream } from "../modules/chat/agent/run-manager-types";
import type { ChatStore } from "../modules/chat/store";
import type { DownloadStore } from "../modules/engines/layers/download-store";
import type { LifetimeMetricsStore, PeakMetricsStore } from "../modules/monitoring/metrics-store";
import type { RecipeStore } from "../modules/lifecycle/recipes/recipe-store";
import type { JobStore } from "../stores/job-store";
import type { JobType } from "../modules/jobs/types";

/**
 * Minimal interface for the chat run manager as seen through the app context.
 * The concrete ChatRunManager class satisfies this interface structurally.
 */
export interface IChatRunManager {
  startRun(options: ChatRunOptions): Promise<ChatRunStream>;
  abortRun(runId: string): boolean;
  abortRunsForModel(modelName: string): number;
  resolveApproval(runId: string, toolCallId: string, approved: boolean, reason?: string): boolean;
  continueRun(sessionId: string, runId: string): Promise<ChatRunStream>;
  followUpRun(sessionId: string, content: string): Promise<ChatRunStream>;
}

/**
 * Minimal interface for the job manager as seen through the app context.
 * The concrete JobManager class satisfies this interface structurally.
 */
export interface IJobManager {
  createJob(type: JobType, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  getJob(id: string): Record<string, unknown> | null;
  listJobs(limit?: number): Record<string, unknown>[];
}

/**
 * Application-wide dependency container.
 */
export interface AppContext {
  config: Config;
  logger: Logger;
  eventManager: EventManager;
  launchState: LaunchState;
  metrics: ControllerMetrics;
  metricsRegistry: MetricsRegistry;
  processManager: ProcessManager;
  downloadManager: DownloadManager;
  engineService: EngineCoordinator;
  runManager: IChatRunManager;
  jobManager: IJobManager;
  stores: {
    recipeStore: RecipeStore;
    chatStore: ChatStore;
    downloadStore: DownloadStore;
    peakMetricsStore: PeakMetricsStore;
    lifetimeMetricsStore: LifetimeMetricsStore;
    jobStore: JobStore;
  };
}
