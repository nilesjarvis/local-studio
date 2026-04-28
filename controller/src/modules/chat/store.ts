// CRITICAL
import { randomUUID } from "node:crypto";
import { hydrateMessageRow, hydrateSessionRow } from "./store-hydration";
import { migrateChatStore } from "./store-schema";
import * as RunOps from "./store-runs";
import { openSqliteDatabase } from "../../stores/sqlite";
import type {
  ChatAgentFileRecord,
  ChatAgentFileVersion,
  ChatAgentFileVersionWrite,
  ChatMessage,
  ChatRun,
  ChatRunEvent,
  ChatSession,
  ChatSessionListItem,
  ChatSessionSummary,
  ChatToolExecution,
  ChatUsage,
} from "../../types/chat";

/** SQLite-backed chat, run, usage, and agent-file store. */
export class ChatStore {
  private readonly db: ReturnType<typeof openSqliteDatabase>;

  /**
   * Open the chat store and ensure its schema exists.
   * @param dbPath - SQLite database path.
   */
  public constructor(dbPath: string) {
    this.db = openSqliteDatabase(dbPath);
    this.migrate();
  }

  /**
   * Apply chat schema migrations.
   * @returns Nothing.
   */
  private migrate(): void {
    migrateChatStore(this.db);
  }

  /**
   * List chat sessions in reverse update order.
   * @returns Session list rows.
   */
  public listSessions(): Array<ChatSessionListItem> {
    const rows = this.db
      .query(
        `SELECT cs.id, cs.title, cs.model, cs.parent_id, cs.created_at, cs.updated_at,
          (SELECT substr(cm.content, 1, 120) FROM chat_messages cm
           WHERE cm.session_id = cs.id AND cm.role = 'user'
           ORDER BY cm.created_at ASC LIMIT 1) AS first_user_message
         FROM chat_sessions cs ORDER BY cs.updated_at DESC`
      )
      .all() as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row }) as ChatSessionListItem);
  }

  /**
   * Fetch a session summary without messages.
   * @param sessionId - Session id.
   * @returns Session summary, or null when not found.
   */
  public getSessionSummary(sessionId: string): ChatSessionSummary | null {
    const session = hydrateSessionRow(
      this.db
        .query(
          "SELECT id, title, model, parent_id, agent_state, created_at, updated_at FROM chat_sessions WHERE id = ?"
        )
        .get(sessionId) as Record<string, unknown> | null
    );
    return session ? ({ ...session } as ChatSessionSummary) : null;
  }

  /**
   * Fetch a session with hydrated messages.
   * @param sessionId - Session id.
   * @returns Session with messages, or null when not found.
   */
  public getSession(sessionId: string): ChatSession | null {
    const rawSession = this.db
      .query(
        "SELECT id, title, model, parent_id, agent_state, created_at, updated_at FROM chat_sessions WHERE id = ?"
      )
      .get(sessionId) as Record<string, unknown> | null;
    const session = hydrateSessionRow(rawSession);
    if (!session) {
      return null;
    }

    const messages = this.db
      .query(
        `SELECT id, role, content, model, tool_calls, tool_call_id, name, parts, metadata,
              request_prompt_tokens, request_tools_tokens, request_total_input_tokens, request_completion_tokens,
              cache_read_tokens, cache_write_tokens, thinking_tokens, provider_model_id, cost_json,
              created_at
              FROM chat_messages WHERE session_id = ? ORDER BY created_at, rowid`
      )
      .all(sessionId) as Array<Record<string, unknown>>;

    const hydrated = messages.map((message) => hydrateMessageRow(message));

    return { ...session, messages: hydrated } as ChatSession;
  }

  /**
   * Create a new chat session.
   * @param sessionId - Session id.
   * @param title - Session title.
   * @param model - Optional model name.
   * @param parentId - Optional fork parent id.
   * @param agentState - Optional persisted agent state.
   * @returns Created session summary.
   */
  public createSession(
    sessionId: string,
    title = "New Chat",
    model?: string,
    parentId?: string,
    agentState?: unknown
  ): ChatSessionSummary {
    const agentStateJson =
      agentState !== undefined && agentState !== null ? JSON.stringify(agentState) : null;
    this.db
      .query(
        "INSERT INTO chat_sessions (id, title, model, parent_id, agent_state) VALUES (?, ?, ?, ?, ?)"
      )
      .run(sessionId, title, model ?? null, parentId ?? null, agentStateJson);
    const row = this.db
      .query(
        "SELECT id, title, model, parent_id, agent_state, created_at, updated_at FROM chat_sessions WHERE id = ?"
      )
      .get(sessionId) as Record<string, unknown>;
    const hydrated = hydrateSessionRow(row);
    return { ...(hydrated ?? row) } as ChatSessionSummary;
  }

  /**
   * Update mutable session fields.
   * @param sessionId - Session id.
   * @param title - Optional title update.
   * @param model - Optional model update.
   * @param agentState - Optional agent state update.
   * @returns True when the session exists or no updates were requested.
   */
  public updateSession(
    sessionId: string,
    title?: string,
    model?: string,
    agentState?: unknown
  ): boolean {
    const updates: string[] = [];
    const params: Array<string | null> = [];
    if (title !== undefined) {
      updates.push("title = ?");
      params.push(title);
    }
    if (model !== undefined) {
      updates.push("model = ?");
      params.push(model);
    }
    if (agentState !== undefined) {
      updates.push("agent_state = ?");
      params.push(agentState === null ? null : JSON.stringify(agentState));
    }
    if (updates.length === 0) {
      return true;
    }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(sessionId);
    const result = this.db
      .query(`UPDATE chat_sessions SET ${updates.join(", ")} WHERE id = ?`)
      .run(...params);
    return result.changes > 0;
  }

  /**
   * Delete a chat session and its messages.
   * @param sessionId - Session id.
   * @returns True when a session was deleted.
   */
  public deleteSession(sessionId: string): boolean {
    this.db.query("DELETE FROM chat_messages WHERE session_id = ?").run(sessionId);
    const result = this.db.query("DELETE FROM chat_sessions WHERE id = ?").run(sessionId);
    return result.changes > 0;
  }

  /**
   * Insert or replace a chat message.
   * @param sessionId - Session id.
   * @param messageId - Message id.
   * @param role - Message role.
   * @param content - Optional text content.
   * @param model - Optional model name.
   * @param toolCalls - Optional tool-call payloads.
   * @param promptTokens - Optional prompt token count.
   * @param toolsTokens - Optional tool schema token count.
   * @param totalInputTokens - Optional total input token count.
   * @param completionTokens - Optional completion token count.
   * @param parts - Optional structured message parts.
   * @param metadata - Optional message metadata.
   * @param toolCallId - Optional tool call id for tool results.
   * @param name - Optional tool name.
   * @returns Hydrated message row.
   */
  public addMessage(
    sessionId: string,
    messageId: string,
    role: string,
    content?: string,
    model?: string,
    toolCalls?: unknown[],
    promptTokens?: number,
    toolsTokens?: number,
    totalInputTokens?: number,
    completionTokens?: number,
    parts?: unknown[],
    metadata?: unknown,
    toolCallId?: string,
    name?: string,
    cacheReadTokens?: number,
    cacheWriteTokens?: number,
    thinkingTokens?: number,
    providerModelId?: string,
    costJson?: unknown
  ): ChatMessage {
    const toolCallsJson = toolCalls ? JSON.stringify(toolCalls) : null;
    const partsJson = parts ? JSON.stringify(parts) : null;
    const metadataJson =
      metadata !== undefined && metadata !== null ? JSON.stringify(metadata) : null;
    const costJsonString = costJson ? JSON.stringify(costJson) : null;
    this.db
      .query(
        `INSERT INTO chat_messages
      (id, session_id, role, content, model, tool_calls, tool_call_id, name, parts, metadata,
       request_prompt_tokens, request_tools_tokens, request_total_input_tokens, request_completion_tokens,
       cache_read_tokens, cache_write_tokens, thinking_tokens, provider_model_id, cost_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        role = excluded.role,
        model = excluded.model,
        content = excluded.content,
        tool_calls = excluded.tool_calls,
        tool_call_id = excluded.tool_call_id,
        name = excluded.name,
        parts = excluded.parts,
        metadata = excluded.metadata,
        request_prompt_tokens = excluded.request_prompt_tokens,
        request_tools_tokens = excluded.request_tools_tokens,
        request_total_input_tokens = excluded.request_total_input_tokens,
        request_completion_tokens = excluded.request_completion_tokens,
        cache_read_tokens = excluded.cache_read_tokens,
        cache_write_tokens = excluded.cache_write_tokens,
        thinking_tokens = excluded.thinking_tokens,
        provider_model_id = excluded.provider_model_id,
        cost_json = excluded.cost_json`
      )
      .run(
        messageId,
        sessionId,
        role,
        content ?? null,
        model ?? null,
        toolCallsJson,
        toolCallId ?? null,
        name ?? null,
        partsJson,
        metadataJson,
        promptTokens ?? null,
        toolsTokens ?? null,
        totalInputTokens ?? null,
        completionTokens ?? null,
        cacheReadTokens ?? null,
        cacheWriteTokens ?? null,
        thinkingTokens ?? null,
        providerModelId ?? null,
        costJsonString
      );
    this.db
      .query("UPDATE chat_sessions SET updated_at = CURRENT_TIMESTAMP WHERE id = ?")
      .run(sessionId);
    const row = this.db
      .query(
        `SELECT id, role, content, model, tool_calls, tool_call_id, name, parts, metadata,
         request_prompt_tokens, request_tools_tokens, request_total_input_tokens, request_completion_tokens,
         cache_read_tokens, cache_write_tokens, thinking_tokens, provider_model_id, cost_json, created_at
         FROM chat_messages WHERE id = ?`
      )
      .get(messageId) as Record<string, unknown>;
    return hydrateMessageRow(row);
  }

  /**
   * Sum token usage for a session.
   * @param sessionId - Session id.
   * @returns Token usage totals.
   */
  public getUsage(sessionId: string): ChatUsage {
    const row = this.db
      .query(
        `SELECT
          SUM(
            CASE
              WHEN COALESCE(request_total_input_tokens, 0) > 0 THEN COALESCE(request_total_input_tokens, 0)
              ELSE COALESCE(request_prompt_tokens, 0)
            END
          ) AS prompt_tokens,
          SUM(COALESCE(request_completion_tokens, 0)) AS completion_tokens,
          SUM(COALESCE(cache_read_tokens, 0)) AS cache_read_tokens,
          SUM(COALESCE(cache_write_tokens, 0)) AS cache_write_tokens,
          SUM(COALESCE(thinking_tokens, 0)) AS thinking_tokens
         FROM chat_messages
         WHERE session_id = ?`
      )
      .get(sessionId) as {
      prompt_tokens?: number | null;
      completion_tokens?: number | null;
      cache_read_tokens?: number | null;
      cache_write_tokens?: number | null;
      thinking_tokens?: number | null;
    } | null;

    const prompt = Number(row?.prompt_tokens ?? 0);
    const completion = Number(row?.completion_tokens ?? 0);
    const cacheRead = Number(row?.cache_read_tokens ?? 0);
    const cacheWrite = Number(row?.cache_write_tokens ?? 0);
    const thinking = Number(row?.thinking_tokens ?? 0);

    // Aggregate cost_json across messages
    const costRows = this.db
      .query("SELECT cost_json FROM chat_messages WHERE session_id = ? AND cost_json IS NOT NULL")
      .all(sessionId) as Array<{ cost_json: string }>;

    let costDetails: Record<string, number> = {};
    for (const row of costRows) {
      try {
        const parsed = JSON.parse(row.cost_json) as Record<string, number>;
        for (const [key, val] of Object.entries(parsed)) {
          costDetails[key] = (costDetails[key] ?? 0) + (typeof val === "number" ? val : 0);
        }
      } catch {
        // skip unparseable cost
      }
    }

    return {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      cache_read_tokens: cacheRead,
      cache_write_tokens: cacheWrite,
      thinking_tokens: thinking,
      estimated_cost: costDetails["total"] ?? undefined,
      cost_details: Object.keys(costDetails).length > 0 ? costDetails : undefined,
    };
  }

  /**
   * Upsert a model pricing record.
   * @param modelId - Model identifier.
   * @param provider - Provider name.
   * @param pricingJson - Pricing object (per-million-token rates).
   */
  public upsertModelPricing(
    modelId: string,
    provider: string | null,
    pricingJson: Record<string, number>
  ): void {
    const json = JSON.stringify(pricingJson);
    this.db
      .query(
        "INSERT INTO model_pricing (model_id, provider, pricing_json) VALUES (?, ?, ?) ON CONFLICT(model_id) DO UPDATE SET provider = excluded.provider, pricing_json = excluded.pricing_json"
      )
      .run(modelId, provider ?? null, json);
  }

  /**
   * Get pricing for a model.
   * @param modelId - Model identifier.
   * @returns Pricing record or null.
   */
  public getModelPricing(modelId: string): {
    model_id: string;
    provider: string | null;
    pricing_json: Record<string, number>;
  } | null {
    const row = this.db
      .query("SELECT model_id, provider, pricing_json FROM model_pricing WHERE model_id = ?")
      .get(modelId) as { model_id: string; provider: string | null; pricing_json: string } | null;
    if (!row) return null;
    let pricing: Record<string, number> = {};
    try {
      pricing = JSON.parse(row.pricing_json) as Record<string, number>;
    } catch {
      // return null on unparseable pricing
      return null;
    }
    return { ...row, pricing_json: pricing };
  }

  /**
   * Fork a session and optionally stop at a message.
   * @param sessionId - Source session id.
   * @param newId - Destination session id.
   * @param messageId - Optional final copied message id.
   * @param model - Optional destination model override.
   * @param title - Optional destination title override.
   * @returns Created fork summary, or null when the source session is missing.
   */
  public forkSession(
    sessionId: string,
    newId: string,
    messageId?: string,
    model?: string,
    title?: string
  ): ChatSessionSummary | null {
    const toNullableString = (value: unknown): string | null => {
      if (value === null || value === undefined) {
        return null;
      }
      return String(value);
    };

    const toNullableNumber = (value: unknown): number | null => {
      if (value === null || value === undefined) {
        return null;
      }
      const parsed = Number(value);
      return Number.isNaN(parsed) ? null : parsed;
    };

    const original = this.getSession(sessionId);
    if (!original) {
      return null;
    }
    const newTitle = title ?? `${String(original["title"])} (fork)`;
    const newModel = model ?? (original["model"] ? String(original["model"]) : undefined);
    const agentState = original["agent_state"] ?? null;
    const agentStateJson = agentState !== null ? JSON.stringify(agentState) : null;

    this.db
      .query(
        "INSERT INTO chat_sessions (id, title, model, parent_id, agent_state) VALUES (?, ?, ?, ?, ?)"
      )
      .run(newId, newTitle, newModel ?? null, sessionId, agentStateJson);

    const messages = (original["messages"] ?? []) as Array<Record<string, unknown>>;
    const insertMessage = this.db.query(
      `INSERT INTO chat_messages
       (id, session_id, role, content, model, tool_calls, tool_call_id, name, parts, metadata,
        request_prompt_tokens, request_tools_tokens, request_total_input_tokens, request_completion_tokens,
        cache_read_tokens, cache_write_tokens, thinking_tokens, provider_model_id, cost_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const tx = this.db.transaction(() => {
      for (const message of messages) {
        const toolCallsJson = message["tool_calls"] ? JSON.stringify(message["tool_calls"]) : null;
        const partsJson = message["parts"] ? JSON.stringify(message["parts"]) : null;
        const metadataJson = message["metadata"] ? JSON.stringify(message["metadata"]) : null;
        const newMessageId = `${newId}_${String(message["id"])}`;
        const role = String(message["role"] ?? "");
        const content = toNullableString(message["content"]);
        const messageModel = toNullableString(message["model"]);
        const toolCallId = toNullableString(message["tool_call_id"]);
        const toolName = toNullableString(message["name"]);
        const promptTokens = toNullableNumber(message["request_prompt_tokens"]);
        const toolTokens = toNullableNumber(message["request_tools_tokens"]);
        const totalTokens = toNullableNumber(message["request_total_input_tokens"]);
        const completionTokens = toNullableNumber(message["request_completion_tokens"]);
        const cacheReadTokens = toNullableNumber(message["cache_read_tokens"]);
        const cacheWriteTokens = toNullableNumber(message["cache_write_tokens"]);
        const thinkingTokens = toNullableNumber(message["thinking_tokens"]);
        const providerModelId = toNullableString(message["provider_model_id"]);
        const costJson = message["cost_json"] ? JSON.stringify(message["cost_json"]) : null;

        insertMessage.run(
          newMessageId,
          newId,
          role,
          content,
          messageModel,
          toolCallsJson,
          toolCallId,
          toolName,
          partsJson,
          metadataJson,
          promptTokens,
          toolTokens,
          totalTokens,
          completionTokens,
          cacheReadTokens,
          cacheWriteTokens,
          thinkingTokens,
          providerModelId,
          costJson
        );

        if (messageId && message["id"] === messageId) {
          break;
        }
      }
    });

    tx();

    const row = this.db
      .query(
        "SELECT id, title, model, parent_id, agent_state, created_at, updated_at FROM chat_sessions WHERE id = ?"
      )
      .get(newId) as Record<string, unknown>;
    const hydrated = hydrateSessionRow(row);
    return { ...(hydrated ?? row) } as ChatSessionSummary;
  }

  /**
   * Create a chat run record.
   * @param runId - Run id.
   * @param sessionId - Session id.
   * @param options - Optional run fields.
   * @param options.userMessageId - Optional user message id.
   * @param options.model - Optional model name.
   * @param options.system - Optional system prompt.
   * @param options.toolsetId - Optional toolset id.
   * @param options.status - Optional run status.
   * @returns Created run.
   */
  public createRun(
    runId: string,
    sessionId: string,
    options: {
      userMessageId?: string;
      model?: string;
      system?: string;
      toolsetId?: string;
      status?: string;
    } = {}
  ): ChatRun {
    return RunOps.createRun(this.db, runId, sessionId, options);
  }

  /**
   * Append an event to a chat run.
   * @param runId - Run id.
   * @param seq - Monotonic event sequence.
   * @param type - Event type.
   * @param data - Event payload.
   * @param eventId - Optional event id.
   * @returns Created run event.
   */
  public addRunEvent(
    runId: string,
    seq: number,
    type: string,
    data: Record<string, unknown>,
    eventId: string = randomUUID()
  ): ChatRunEvent {
    return RunOps.addRunEvent(this.db, runId, seq, type, data, eventId);
  }

  /**
   * Get run events for a run, optionally after a given sequence number.
   * @param runId - Run identifier.
   * @param afterSeq - Optional sequence number to start from (exclusive).
   * @returns Run events ordered by seq.
   */
  public getRunEvents(runId: string, afterSeq = 0): ChatRunEvent[] {
    const rows = this.db
      .query(
        "SELECT id, run_id, seq, type, data, created_at FROM chat_run_events WHERE run_id = ? AND seq > ? ORDER BY seq"
      )
      .all(runId, afterSeq) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const hydrated: Record<string, unknown> = { ...row };
      if (typeof hydrated["data"] === "string") {
        try {
          hydrated["data"] = JSON.parse(hydrated["data"] as string);
        } catch {
          // leave as string
        }
      }
      return hydrated as ChatRunEvent;
    });
  }

  /**
   * Record a tool execution for a run.
   * @param runId - Run id.
   * @param toolCallId - Tool call id.
   * @param toolName - Tool name.
   * @param options - Optional execution fields.
   * @param options.toolServer - Optional tool server name.
   * @param options.arguments - Optional tool arguments.
   * @param options.resultText - Optional result text.
   * @param options.isError - Optional error flag.
   * @param options.startedAt - Optional start timestamp.
   * @param options.finishedAt - Optional finish timestamp.
   * @param options.id - Optional execution id.
   * @returns Created tool execution.
   */
  public addToolExecution(
    runId: string,
    toolCallId: string,
    toolName: string,
    options: {
      toolServer?: string;
      arguments?: Record<string, unknown> | string;
      resultText?: string | null;
      isError?: boolean;
      startedAt?: string;
      finishedAt?: string;
      id?: string;
    } = {}
  ): ChatToolExecution {
    return RunOps.addToolExecution(this.db, runId, toolCallId, toolName, options);
  }

  /**
   * Update a chat run.
   * @param runId - Run id.
   * @param updates - Run status fields to update.
   * @param updates.status - Optional run status.
   * @param updates.finishedAt - Optional finish timestamp.
   * @returns True when a run was updated.
   */
  public updateRun(
    runId: string,
    updates: {
      status?: string;
      finishedAt?: string | null;
    }
  ): boolean {
    return RunOps.updateRun(this.db, runId, updates);
  }

  /**
   * Append a version snapshot, deduplicating if content has not changed.
   * @param sessionId - Session id.
   * @param path - Agent file path.
   * @param content - File content snapshot.
   * @param bytes - Optional byte length.
   * @returns Created or reused version metadata.
   */
  public addAgentFileVersion(
    sessionId: string,
    path: string,
    content: string,
    bytes?: number | null
  ): ChatAgentFileVersionWrite {
    const last = this.db
      .query(
        "SELECT version, content FROM chat_agent_file_versions WHERE session_id = ? AND path = ? ORDER BY version DESC LIMIT 1"
      )
      .get(sessionId, path) as { version?: number; content?: string } | null;

    if (last && typeof last.content === "string" && last.content === content) {
      return {
        version: typeof last.version === "number" ? last.version : 1,
        created_at_ms: Date.now(),
      };
    }

    const nextVersion = (typeof last?.version === "number" ? last.version : 0) + 1;
    const createdAtMs = Date.now();
    this.db
      .query(
        `INSERT INTO chat_agent_file_versions
         (id, session_id, path, version, content, bytes, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(randomUUID(), sessionId, path, nextVersion, content, bytes ?? null, createdAtMs);

    return { version: nextVersion, created_at_ms: createdAtMs };
  }

  /**
   * List all versions for an agent file path.
   * @param sessionId - Session id.
   * @param path - Agent file path.
   * @returns Version history in ascending order.
   */
  public listAgentFileVersions(sessionId: string, path: string): Array<ChatAgentFileVersion> {
    const rows = this.db
      .query(
        "SELECT version, content, created_at_ms FROM chat_agent_file_versions WHERE session_id = ? AND path = ? ORDER BY version ASC"
      )
      .all(sessionId, path) as Array<Record<string, unknown>>;
    return rows.map((row) => ({ ...row }) as ChatAgentFileVersion);
  }

  /**
   * Fetch the latest snapshot for an agent file path.
   * @param sessionId - Session id.
   * @param path - Agent file path.
   * @returns Latest file record, or null when missing.
   */
  public getLatestAgentFile(sessionId: string, path: string): ChatAgentFileRecord | null {
    const row = this.db
      .query(
        `SELECT path, version, content, bytes, created_at_ms
         FROM chat_agent_file_versions
         WHERE session_id = ? AND path = ?
         ORDER BY version DESC LIMIT 1`
      )
      .get(sessionId, path) as ChatAgentFileRecord | null;
    return row ? { ...row } : null;
  }

  /**
   * List latest snapshots for all agent files in a session.
   * @param sessionId - Session id.
   * @returns Latest file records ordered by path.
   */
  public listLatestAgentFiles(sessionId: string): ChatAgentFileRecord[] {
    const rows = this.db
      .query(
        `SELECT v.path, v.version, v.content, v.bytes, v.created_at_ms
         FROM chat_agent_file_versions v
         INNER JOIN (
           SELECT path, MAX(version) AS version
           FROM chat_agent_file_versions
           WHERE session_id = ?
           GROUP BY path
         ) latest ON latest.path = v.path AND latest.version = v.version
         WHERE v.session_id = ?
         ORDER BY v.path`
      )
      .all(sessionId, sessionId) as ChatAgentFileRecord[];
    return rows.map((row) => ({ ...row }));
  }

  /**
   * List explicit agent directory records for a session.
   * @param sessionId - Session id.
   * @returns Directory paths ordered by path.
   */
  public listAgentDirectories(sessionId: string): string[] {
    const rows = this.db
      .query("SELECT path FROM chat_agent_directories WHERE session_id = ? ORDER BY path")
      .all(sessionId) as Array<{ path: string }>;
    return rows.map((row) => row.path);
  }

  /**
   * Add an explicit agent directory record.
   * @param sessionId - Session id.
   * @param path - Directory path.
   * @returns Nothing.
   */
  public addAgentDirectory(sessionId: string, path: string): void {
    if (!path) return;
    this.db
      .query(
        `INSERT OR IGNORE INTO chat_agent_directories (session_id, path, created_at_ms)
         VALUES (?, ?, ?)`
      )
      .run(sessionId, path, Date.now());
  }

  /**
   * Determine whether an agent path is a file, directory, or missing.
   * @param sessionId - Session id.
   * @param path - Agent path.
   * @returns Path kind, or null when missing.
   */
  public getAgentPathKind(sessionId: string, path: string): "file" | "dir" | null {
    if (!path) return "dir";
    if (this.getLatestAgentFile(sessionId, path)) return "file";
    const directory = this.db
      .query("SELECT path FROM chat_agent_directories WHERE session_id = ? AND path = ?")
      .get(sessionId, path) as { path: string } | null;
    if (directory) return "dir";
    const descendantFile = this.db
      .query(
        "SELECT path FROM chat_agent_file_versions WHERE session_id = ? AND path LIKE ? LIMIT 1"
      )
      .get(sessionId, `${path}/%`) as { path: string } | null;
    if (descendantFile) return "dir";
    const descendantDirectory = this.db
      .query("SELECT path FROM chat_agent_directories WHERE session_id = ? AND path LIKE ? LIMIT 1")
      .get(sessionId, `${path}/%`) as { path: string } | null;
    return descendantDirectory ? "dir" : null;
  }

  /**
   * Delete an exact agent path or all descendants if path is a directory.
   * @param sessionId - Session id.
   * @param path - Agent path to delete.
   * @returns Nothing.
   */
  public deleteAgentFileVersionsForPath(sessionId: string, path: string): void {
    const trimmed = (path ?? "").trim();
    if (!trimmed) {
      this.db.query("DELETE FROM chat_agent_file_versions WHERE session_id = ?").run(sessionId);
      this.db.query("DELETE FROM chat_agent_directories WHERE session_id = ?").run(sessionId);
      return;
    }
    const tx = this.db.transaction(() => {
      this.db
        .query(
          "DELETE FROM chat_agent_file_versions WHERE session_id = ? AND (path = ? OR path LIKE ?)"
        )
        .run(sessionId, trimmed, `${trimmed}/%`);
      this.db
        .query(
          "DELETE FROM chat_agent_directories WHERE session_id = ? AND (path = ? OR path LIKE ?)"
        )
        .run(sessionId, trimmed, `${trimmed}/%`);
    });
    tx();
  }

  /**
   * Re-parent file and directory records, continuing version sequences.
   * @param sessionId - Session id.
   * @param from - Source path.
   * @param to - Destination path.
   * @returns Nothing.
   */
  public moveAgentFileVersions(sessionId: string, from: string, to: string): void {
    if (!from || !to || from === to) return;

    const sourceRows = this.db
      .query(
        "SELECT path, version, content, bytes, created_at_ms FROM chat_agent_file_versions WHERE session_id = ? AND (path = ? OR path LIKE ?) ORDER BY path ASC, version ASC"
      )
      .all(sessionId, from, `${from}/%`) as Array<{
      path: string;
      version: number;
      content: string;
      bytes?: number | null;
      created_at_ms: number;
    }>;
    const sourceDirectories = this.db
      .query(
        "SELECT path, created_at_ms FROM chat_agent_directories WHERE session_id = ? AND (path = ? OR path LIKE ?) ORDER BY path ASC"
      )
      .all(sessionId, from, `${from}/%`) as Array<{ path: string; created_at_ms: number }>;

    if (sourceRows.length === 0 && sourceDirectories.length === 0) return;

    const tx = this.db.transaction(() => {
      const versionsByPath = new Map<string, number>();
      for (const row of sourceRows) {
        const suffix = row.path === from ? "" : row.path.slice(from.length);
        const destinationPath = `${to}${suffix}`;
        let offset = versionsByPath.get(destinationPath);
        if (offset === undefined) {
          const destinationMax = this.db
            .query(
              "SELECT MAX(version) AS max_version FROM chat_agent_file_versions WHERE session_id = ? AND path = ?"
            )
            .get(sessionId, destinationPath) as { max_version?: number | null } | null;
          offset = typeof destinationMax?.max_version === "number" ? destinationMax.max_version : 0;
        }
        const nextVersion = offset + 1;
        versionsByPath.set(destinationPath, nextVersion);
        this.db
          .query(
            `INSERT INTO chat_agent_file_versions
             (id, session_id, path, version, content, bytes, created_at_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            randomUUID(),
            sessionId,
            destinationPath,
            nextVersion,
            row.content,
            row.bytes ?? null,
            row.created_at_ms
          );
      }
      for (const row of sourceDirectories) {
        const suffix = row.path === from ? "" : row.path.slice(from.length);
        this.db
          .query(
            `INSERT OR IGNORE INTO chat_agent_directories (session_id, path, created_at_ms)
             VALUES (?, ?, ?)`
          )
          .run(sessionId, `${to}${suffix}`, row.created_at_ms);
      }
      this.db
        .query(
          "DELETE FROM chat_agent_file_versions WHERE session_id = ? AND (path = ? OR path LIKE ?)"
        )
        .run(sessionId, from, `${from}/%`);
      this.db
        .query(
          "DELETE FROM chat_agent_directories WHERE session_id = ? AND (path = ? OR path LIKE ?)"
        )
        .run(sessionId, from, `${from}/%`);
    });

    tx();
  }
}
