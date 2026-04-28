// CRITICAL
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { AppContext } from "./types/context";
import { createConfig } from "./config/env";
import { createEventManager } from "./modules/monitoring/event-manager";
import { createLaunchState } from "./modules/engines/layers/launch-state";
import { createMetrics } from "./modules/monitoring/metrics";
import { createProcessManager } from "./modules/engines/layers/process-manager";
import { DownloadManager } from "./modules/engines/layers/download-manager";
import { createEngineCoordinator } from "./modules/engines/layers/engine-coordinator";
import { createLogger, resolveLogLevel } from "./core/logger";
import { primaryLogPathFor } from "./core/log-files";
import { ChatStore } from "./modules/chat/store";
import { DownloadStore } from "./modules/engines/layers/download-store";
import { PeakMetricsStore, LifetimeMetricsStore } from "./modules/monitoring/metrics-store";
import { RecipeStore } from "./modules/lifecycle/recipes/recipe-store";
import { ChatRunManager } from "./modules/chat/agent/run-manager";
import { JobStore } from "./stores/job-store";
import { JobManager } from "./modules/jobs/job-manager";

/**
 * Create the application dependency container.
 * @returns AppContext instance.
 */
export const createAppContext = (): AppContext => {
  const config = createConfig();

  mkdirSync(config.data_dir, { recursive: true });
  const dbPath = resolve(config.db_path);

  const recipeStore = new RecipeStore(dbPath);
  const chatStore = new ChatStore(dbPath);
  const downloadStore = new DownloadStore(dbPath);
  const peakMetricsStore = new PeakMetricsStore(dbPath);
  const lifetimeMetricsStore = new LifetimeMetricsStore(dbPath);
  const jobStore = new JobStore(dbPath);
  const eventManager = createEventManager();
  const logger = createLogger(resolveLogLevel("info"), {
    filePath: primaryLogPathFor(config.data_dir, "controller"),
    onLine: (line) => eventManager.publishLogLine("controller", line),
  });
  const launchState = createLaunchState();
  const { registry: metricsRegistry, metrics } = createMetrics();
  const processManager = createProcessManager(config, logger, eventManager);
  let runManager: ChatRunManager | null = null;
  const downloadManager = new DownloadManager(config, downloadStore, eventManager, logger);

  const engineService = createEngineCoordinator({
    config,
    logger,
    eventManager,
    processManager,
    recipeStore,
    downloadManager,
    abortRunsForModel: (modelName) => runManager?.abortRunsForModel(modelName) ?? 0,
  });

  lifetimeMetricsStore.ensureFirstStarted();

  const baseContext = {
    config,
    logger,
    eventManager,
    launchState,
    metrics,
    metricsRegistry,
    processManager,
    downloadManager,
    engineService,
    stores: {
      recipeStore,
      chatStore,
      downloadStore,
      peakMetricsStore,
      lifetimeMetricsStore,
      jobStore,
    },
  } as Omit<AppContext, "runManager" | "jobManager">;

  runManager = new ChatRunManager(baseContext as AppContext);
  const jobManager = new JobManager(baseContext as AppContext, jobStore);

  return {
    ...baseContext,
    runManager,
    jobManager,
  };
};
