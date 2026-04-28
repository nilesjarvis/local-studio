// CRITICAL
import type { AgentTool, AgentToolResult } from "@mariozechner/pi-agent-core";
import type { TSchema } from "@sinclair/typebox";
import type { AppContext } from "../../../types/context";
import { Event } from "../../monitoring/event-manager";
import { AGENT_FILE_EVENT_TYPES, AGENT_TOOL_NAMES, type AgentEventType } from "./contracts";
import { createTextResult } from "./tool-registry-common";
import type { AgentToolRegistryOptions } from "./tool-registry-types";
import {
  createAgentDirectory,
  deleteAgentPath,
  listAgentFiles,
  moveAgentPath,
  readAgentFile,
  writeAgentFile,
} from "../agent-files/service";

/**
 * Build agent filesystem tools.
 * @param context - Application context.
 * @param options - Tool registry options.
 * @returns Agent tools.
 */
export const buildAgentFsTools = (
  context: AppContext,
  options: AgentToolRegistryOptions
): AgentTool[] => {
  const sessionId = options.sessionId;
  const emit = options.emitEvent;
  const approvalGate = options.approvalGate;
  const runId = options.runId;
  const publishAgentFsEvent = async (
    eventName: AgentEventType,
    payload: Record<string, unknown>
  ): Promise<void> => {
    emit?.(eventName, payload);
    await context.eventManager.publish(new Event(eventName, payload));
  };

  const listFiles: AgentTool = {
    name: AGENT_TOOL_NAMES.LIST_FILES,
    label: AGENT_TOOL_NAMES.LIST_FILES,
    description: "List files in the agent workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        recursive: { type: "boolean" },
      },
    } as unknown as TSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const rawPath = typeof raw["path"] === "string" ? raw["path"] : "";
      const recursive = raw["recursive"] !== false;
      const files = await listAgentFiles(context, sessionId, rawPath, recursive);
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_FILES_LISTED, {
        session_id: sessionId,
        path: rawPath || null,
        recursive,
        files,
      });
      return createTextResult(JSON.stringify(files, null, 2), {
        files,
        path: rawPath,
        recursive,
      });
    },
  };

  const readFile: AgentTool = {
    name: AGENT_TOOL_NAMES.READ_FILE,
    label: AGENT_TOOL_NAMES.READ_FILE,
    description: "Read a file from the agent workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    } as unknown as TSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const path = typeof raw["path"] === "string" ? raw["path"] : "";
      if (!path) throw new Error("Path is required.");
      const { normalizedPath, content } = await readAgentFile(context, sessionId, path);
      const bytes = Buffer.byteLength(content, "utf8");
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_FILE_READ, {
        session_id: sessionId,
        path: normalizedPath,
        bytes,
      });
      return createTextResult(content, { path: normalizedPath });
    },
  };

  const writeFile: AgentTool = {
    name: AGENT_TOOL_NAMES.WRITE_FILE,
    label: AGENT_TOOL_NAMES.WRITE_FILE,
    description:
      "Write or overwrite a file in the agent workspace. Parent directories are created automatically.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    } as unknown as TSchema,
    execute: async (toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const path = typeof raw["path"] === "string" ? raw["path"] : "";
      if (!path) throw new Error("Path is required.");
      if (approvalGate && runId) {
        const decision = await approvalGate.requestApproval({
          toolCallId,
          toolName: AGENT_TOOL_NAMES.WRITE_FILE,
          args: { path, contentLength: typeof raw["content"] === "string" ? raw["content"].length : 0 },
          runId,
          sessionId,
        });
        if (!decision.approved) {
          return createTextResult(
            `File write denied${decision.reason ? `: ${decision.reason}` : ""}`,
            { denied: true, path }
          );
        }
      }
      const content = typeof raw["content"] === "string" ? raw["content"] : "";
      const { normalizedPath, bytes } = await writeAgentFile(context, sessionId, path, content);
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_FILE_WRITTEN, {
        session_id: sessionId,
        path: normalizedPath,
        bytes,
        encoding: "utf8",
      });
      return createTextResult(`Wrote ${normalizedPath}`, { path: normalizedPath });
    },
  };

  const deleteFile: AgentTool = {
    name: AGENT_TOOL_NAMES.DELETE_FILE,
    label: AGENT_TOOL_NAMES.DELETE_FILE,
    description: "Delete a file from the agent workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    } as unknown as TSchema,
    execute: async (toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const path = typeof raw["path"] === "string" ? raw["path"] : "";
      if (!path) throw new Error("Path is required.");
      if (approvalGate && runId) {
        const decision = await approvalGate.requestApproval({
          toolCallId,
          toolName: AGENT_TOOL_NAMES.DELETE_FILE,
          args: { path },
          runId,
          sessionId,
        });
        if (!decision.approved) {
          return createTextResult(
            `File deletion denied${decision.reason ? `: ${decision.reason}` : ""}`,
            { denied: true, path }
          );
        }
      }
      const normalizedPath = await deleteAgentPath(context, sessionId, path);
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_FILE_DELETED, {
        session_id: sessionId,
        path: normalizedPath,
      });
      return createTextResult(`Deleted ${normalizedPath}`, { path: normalizedPath });
    },
  };

  const makeDirectory: AgentTool = {
    name: AGENT_TOOL_NAMES.MAKE_DIRECTORY,
    label: AGENT_TOOL_NAMES.MAKE_DIRECTORY,
    description: "Create a directory in the agent workspace.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    } as unknown as TSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const path = typeof raw["path"] === "string" ? raw["path"] : "";
      if (!path) throw new Error("Path is required.");
      const normalizedPath = await createAgentDirectory(context, sessionId, path);
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_DIRECTORY_CREATED, {
        session_id: sessionId,
        path: normalizedPath,
      });
      return createTextResult(`Created directory ${normalizedPath}`, { path: normalizedPath });
    },
  };

  const moveFile: AgentTool = {
    name: AGENT_TOOL_NAMES.MOVE_FILE,
    label: AGENT_TOOL_NAMES.MOVE_FILE,
    description: "Move or rename a file in the agent workspace.",
    parameters: {
      type: "object",
      properties: { from: { type: "string" }, to: { type: "string" } },
      required: ["from", "to"],
    } as unknown as TSchema,
    execute: async (_toolCallId, params): Promise<AgentToolResult<Record<string, unknown>>> => {
      const raw = params as Record<string, unknown>;
      const from = typeof raw["from"] === "string" ? raw["from"] : "";
      const to = typeof raw["to"] === "string" ? raw["to"] : "";
      if (!from || !to) throw new Error("from and to are required.");
      const payload = await moveAgentPath(context, sessionId, from, to);
      await publishAgentFsEvent(AGENT_FILE_EVENT_TYPES.AGENT_FILE_MOVED, {
        session_id: sessionId,
        from: payload.from,
        to: payload.to,
      });
      return createTextResult(`Moved ${payload.from} to ${payload.to}`, payload);
    },
  };

  return [listFiles, readFile, writeFile, deleteFile, makeDirectory, moveFile];
};
