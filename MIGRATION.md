# Migration Status

| Domain       | Phase | Status       |
|-------------|-------|-------------|
| engines     | 1     | 🟢 done     |
| system      | 2     | 🔴 old      |
| models      | 3     | 🔴 old      |
| chat        | 4     | 🔴 old      |
| pass-through| 1/5   | 🟡 touched  |

## Phase 1: Engines Module — Completed

### Summary

The `engines/` module is fully wired and replaces the old `lifecycle/engines/`, `lifecycle/process/`, `lifecycle/runtime/`, `lifecycle/state/`, and `downloads/` modules.

### What moved into `engines/`

| Old location | New location |
|---|---|
| `lifecycle/engines/backends.ts` | `engines/layers/backend-builder.ts` |
| `lifecycle/runtime/vllm-runtime.ts` | `engines/layers/vllm-runtime.ts` |
| `lifecycle/runtime/llamacpp-runtime.ts` | `engines/layers/llamacpp-runtime.ts` |
| `lifecycle/runtime/vllm-python-path.ts` | `engines/layers/vllm-python-path.ts` |
| `lifecycle/runtime/runtime-info.ts` | `engines/layers/runtime-info.ts` |
| `lifecycle/runtime/runtime-upgrade.ts` | `engines/layers/runtime-upgrade.ts` |
| `lifecycle/runtime/runtime-upgrade-config.ts` | `engines/layers/upgrade-config.ts` |
| `lifecycle/runtime/configs.ts` | merged into `engines/configs.ts` |
| `lifecycle/process/process-manager.ts` | `engines/layers/process-manager.ts` |
| `lifecycle/process/process-utilities.ts` | `engines/layers/process-utilities.ts` |
| `lifecycle/state/launch-state.ts` | `engines/layers/launch-state.ts` |
| `lifecycle/state/lifecycle-coordinator.ts` | `engines/layers/engine-coordinator.ts` |
| `lifecycle/configs.ts` | merged into `engines/configs.ts` |
| `lifecycle/routes/lifecycle-routes.ts` | `engines/routes.ts` |
| `lifecycle/routes/runtime-routes.ts` | `engines/routes.ts` |
| `downloads/manager.ts` | `engines/layers/download-manager.ts` |
| `downloads/store.ts` | `engines/layers/download-store.ts` |
| `downloads/huggingface-api.ts` | `engines/layers/huggingface-api.ts` |
| `downloads/download-paths.ts` | `engines/layers/download-paths.ts` |
| `downloads/download-math.ts` | `engines/layers/download-math.ts` |
| `downloads/download-globs.ts` | `engines/layers/download-globs.ts` |
| `downloads/types.ts` | `engines/types.ts` |
| `downloads/configs.ts` | merged into `engines/configs.ts` |
| `downloads/routes.ts` | `engines/routes.ts` |

### What was deleted

- `controller/src/modules/downloads/` — entire directory removed
- `controller/src/modules/lifecycle/engines/` — entire directory removed
- `controller/src/modules/lifecycle/process/` — entire directory removed
- `controller/src/modules/lifecycle/runtime/` — entire directory removed
- `controller/src/modules/lifecycle/state/` — entire directory removed
- `controller/src/modules/lifecycle/configs.ts` — removed
- `controller/src/modules/lifecycle/routes/lifecycle-routes.ts` — removed
- `controller/src/modules/lifecycle/routes/runtime-routes.ts` — removed

### What stays in `lifecycle/` (for Phase 2/3)

- `lifecycle/platform/` → Phase 2 (system module)
- `lifecycle/metrics/` → Phase 2 (system module)
- `lifecycle/recipes/` → Phase 3 (models module)
- `lifecycle/routes/system-routes.ts` → Phase 2 (system module)
- `lifecycle/types.ts` → Phase 2 (shared or system)

### Wiring changes

- `AppContext` now exposes `engineService: EngineCoordinator` instead of `lifecycleCoordinator`
- `engineService` provides `launch()`, `ensureActive()`, `evict()`, `cancelLaunch()`, download methods, and runtime methods
- `processManager` and `downloadManager` remain in AppContext for backward compatibility with consumers not yet migrated
- `proxy/openai-routes.ts` and `audio/routes.ts` updated to use `engineService` instead of `lifecycleCoordinator`
- `studio/routes.ts` updated to import from `engines/layers/` instead of `lifecycle/runtime/`
- `http/app.ts` registers `registerEngineRoutes` + `registerSystemRoutes` instead of `registerAllLifecycleRoutes` + `registerDownloadsRoutes`

### New constructs

- **State machines**: `engine-lifecycle-machine.ts` and `download-machine.ts` using shared `createStateMachine`
- **EngineService interface**: `services/engine-service.ts` — the single public contract
- **Engine coordinator**: `layers/engine-coordinator.ts` — orchestrates lifecycle, dispatches events to state machine, implements `EngineService`

### Verification

- `npx tsc --noEmit` passes (controller) ✓
- `bun test` passes (113/114, 1 pre-existing failure) ✓
- `npx next build` passes (frontend) ✓

## Phase 5: Pass-through/OpenAI Proxy — Touched During Phase 1

### Summary

The pass-through domain is not migrated yet, but `controller/src/modules/proxy/openai-routes.ts` was changed while debugging the OpenAI-compatible streaming response contract for `api.homelabai.org`.

### What changed

- Added `ensureStreamingUsageIncluded()` to normalize streamed `/v1/chat/completions` requests.
- Streaming requests now force `stream_options.include_usage = true` before forwarding upstream, while preserving any existing `stream_options` fields.
- This makes SGLang/vLLM emit the final OpenAI-compatible SSE usage chunk with `prompt_tokens`, `completion_tokens`, and `total_tokens` even when clients omit `stream_options`.
- Added `controller/src/modules/proxy/openai-routes.test.ts` covering usage injection, non-streaming no-op behavior, and already-normalized streaming payloads.

### Verification

- `cd controller && npx tsc --noEmit` passes ✓
- `cd controller && bun test src/modules/proxy/openai-routes.test.ts` passes ✓
- `cd controller && bun test` passes except the pre-existing `security middleware > allows public health checks without auth` failure (116/117) ✓
- Verified `https://api.homelabai.org/v1/chat/completions` now returns a final streaming `usage` chunk for `deepseek-v4-flash` without clients explicitly sending `stream_options.include_usage` ✓
