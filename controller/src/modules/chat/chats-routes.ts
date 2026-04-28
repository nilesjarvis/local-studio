// CRITICAL
import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { AppContext } from "../../types/context";
import { badRequest, notFound } from "../../core/errors";
import { compactChatSession } from "./compaction";
import { Event } from "../monitoring/event-manager";
import { buildSseHeaders, streamAsyncStrings } from "../../http/sse";
import { THINKING_LEVELS } from "./configs";
import { AGENT_RUN_EVENT_TYPES } from "./agent/contracts";

const THINKING_LEVELS_SET = new Set<ThinkingLevel>(THINKING_LEVELS);

const toThinkingLevel = (value: unknown): ThinkingLevel | undefined => {
  if (typeof value !== "string") return undefined;
  return THINKING_LEVELS_SET.has(value as ThinkingLevel) ? (value as ThinkingLevel) : undefined;
};

/**
 * Generate a simple title from the first few words of a message.
 * @param content - The message content to generate title from.
 * @returns A generated title string.
 */
function generateTitleFromMessage(content: string): string {
  if (!content || !content.trim()) {
    return "New Chat";
  }

  const cleaned = content
    .replace(/\n/g, " ")
    .replace(/[^\w\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const words = cleaned.split(" ").filter((w) => w.length > 0);
  const titleWords = words.slice(0, 5);

  if (titleWords.length === 0) {
    return "New Chat";
  }

  const title = titleWords
    .map((w, index) => (index === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w))
    .join(" ");

  return title.length > 50 ? title.slice(0, 47) + "..." : title;
}

/**
 * Register chat session routes.
 * @param app - Hono app.
 * @param context - App context.
 */
export const registerChatsRoutes = (app: Hono, context: AppContext): void => {
  app.get("/chats", async (ctx) => {
    ctx.header("Cache-Control", "private, max-age=5, stale-while-revalidate=10");
    return ctx.json(context.stores.chatStore.listSessions());
  });

  app.get("/chats/:sessionId", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const session = context.stores.chatStore.getSession(sessionId);
    if (!session) {
      throw notFound("Session not found");
    }
    return ctx.json({ session });
  });

  app.post("/chats/:sessionId/compact", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    let body: Record<string, unknown> = {};
    try {
      body = (await ctx.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const systemPrompt = typeof body["system"] === "string" ? body["system"] : undefined;
    const title = typeof body["title"] === "string" ? body["title"] : undefined;
    const preserveFirst = body["preserve_first"] !== false;
    const preserveLast = body["preserve_last"] !== false;

    const result = await compactChatSession(context, sessionId, {
      ...(model ? { model } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(title ? { title } : {}),
      preserveFirst,
      preserveLast,
    });
    const newSessionId =
      typeof result.session["id"] === "string" ? String(result.session["id"]) : undefined;
    const compactedSession = newSessionId
      ? (context.stores.chatStore.getSessionSummary(newSessionId) ?? result.session)
      : result.session;
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_COMPACTED, {
        source_id: sessionId,
        session: compactedSession,
        summary: result.summary,
      })
    );
    return ctx.json(result);
  });

  app.post("/chats", async (ctx) => {
    const body = (await ctx.req.json()) as Record<string, unknown>;
    const sessionId = randomUUID();
    const title = typeof body["title"] === "string" ? body["title"] : "New Chat";
    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const agentState = body["agent_state"];
    const session = context.stores.chatStore.createSession(
      sessionId,
      title,
      model,
      undefined,
      agentState
    );
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_CREATED, { session })
    );
    return ctx.json({ session });
  });

  app.put("/chats/:sessionId", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const body = (await ctx.req.json()) as Record<string, unknown>;
    const title = typeof body["title"] === "string" ? body["title"] : undefined;
    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const hasAgentState = Object.prototype.hasOwnProperty.call(body, "agent_state");
    const agentState = hasAgentState ? body["agent_state"] : undefined;
    const updated = context.stores.chatStore.updateSession(sessionId, title, model, agentState);
    if (!updated) {
      throw notFound("Session not found");
    }
    const session = context.stores.chatStore.getSessionSummary(sessionId);
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_UPDATED, {
        session_id: sessionId,
        session,
        changes: {
          ...(title !== undefined ? { title } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(hasAgentState ? { agent_state: agentState } : {}),
        },
      })
    );
    return ctx.json({ success: true });
  });

  app.delete("/chats/:sessionId", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const deleted = context.stores.chatStore.deleteSession(sessionId);
    if (!deleted) {
      throw notFound("Session not found");
    }
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_DELETED, { session_id: sessionId })
    );
    return ctx.json({ success: true });
  });

  app.post("/chats/:sessionId/messages", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const body = (await ctx.req.json()) as Record<string, unknown>;
    const messageId = typeof body["id"] === "string" ? body["id"] : randomUUID();
    const role = typeof body["role"] === "string" ? body["role"] : "user";
    const content = typeof body["content"] === "string" ? body["content"] : undefined;
    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const toolCalls = Array.isArray(body["tool_calls"]) ? body["tool_calls"] : undefined;
    const toolCallId = typeof body["tool_call_id"] === "string" ? body["tool_call_id"] : undefined;
    const toolName = typeof body["name"] === "string" ? body["name"] : undefined;
    const parts = Array.isArray(body["parts"]) ? body["parts"] : undefined;
    const metadata = Object.prototype.hasOwnProperty.call(body, "metadata")
      ? body["metadata"]
      : undefined;
    const promptTokens =
      typeof body["request_prompt_tokens"] === "number" ? body["request_prompt_tokens"] : undefined;
    const toolsTokens =
      typeof body["request_tools_tokens"] === "number" ? body["request_tools_tokens"] : undefined;
    const totalInputTokens =
      typeof body["request_total_input_tokens"] === "number"
        ? body["request_total_input_tokens"]
        : undefined;
    const completionTokens =
      typeof body["request_completion_tokens"] === "number"
        ? body["request_completion_tokens"]
        : undefined;

    const message = context.stores.chatStore.addMessage(
      sessionId,
      messageId,
      role,
      content,
      model,
      toolCalls,
      promptTokens,
      toolsTokens,
      totalInputTokens,
      completionTokens,
      parts,
      metadata,
      toolCallId,
      toolName
    );
    const session = context.stores.chatStore.getSessionSummary(sessionId);
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_MESSAGE_UPSERTED, {
        session_id: sessionId,
        message,
        session,
      })
    );
    const usage = context.stores.chatStore.getUsage(sessionId);
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_USAGE_UPDATED, { session_id: sessionId, usage })
    );
    return ctx.json(message);
  });

  app.get("/chats/:sessionId/usage", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    return ctx.json(context.stores.chatStore.getUsage(sessionId));
  });

  app.post("/chats/:sessionId/turn", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const session = context.stores.chatStore.getSession(sessionId);
    if (!session) {
      throw notFound("Session not found");
    }

    let body: Record<string, unknown> = {};
    try {
      body = (await ctx.req.json()) as Record<string, unknown>;
    } catch {
      body = {};
    }

    const content = typeof body["content"] === "string" ? body["content"] : "";
    const rawImages = Array.isArray(body["images"]) ? body["images"] : [];
    const parsedImages = rawImages.filter((img) => {
      return (
        img &&
        typeof img === "object" &&
        typeof img["data"] === "string" &&
        typeof img["mimeType"] === "string"
      );
    });

    if (!content.trim() && parsedImages.length === 0) {
      throw badRequest("Message content is required");
    }

    const messageId = typeof body["message_id"] === "string" ? body["message_id"] : undefined;
    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const provider = typeof body["provider"] === "string" ? body["provider"] : undefined;
    const systemPrompt = typeof body["system"] === "string" ? body["system"] : undefined;
    const agentMode = body["agent_mode"] === true;
    const agentFiles = body["agent_files"] === true;
    const deepResearch = body["deep_research"] === true;
    const thinkingLevel = toThinkingLevel(body["thinking_level"]);

    const images: Array<{ data: string; mimeType: string; name?: string }> = [];
    for (const img of parsedImages) {
      if (
        img &&
        typeof img === "object" &&
        typeof img["data"] === "string" &&
        typeof img["mimeType"] === "string"
      ) {
        images.push({
          data: img["data"] as string,
          mimeType: img["mimeType"] as string,
          ...(typeof img["name"] === "string" ? { name: img["name"] as string } : {}),
        });
      }
    }

    const runOptions = {
      sessionId,
      content,
      agentMode,
      agentFiles,
      deepResearch,
      ...(messageId ? { messageId } : {}),
      ...(model ? { model } : {}),
      ...(provider ? { provider } : {}),
      ...(systemPrompt ? { systemPrompt } : {}),
      ...(thinkingLevel ? { thinkingLevel } : {}),
      ...(images.length > 0 ? { images } : {}),
    };

    const { runId, stream } = await context.runManager.startRun(runOptions);

    return new Response(streamAsyncStrings(stream), {
      headers: {
        ...buildSseHeaders(),
        "X-Run-Id": runId,
      },
    });
  });

  app.post("/chats/:sessionId/runs/:runId/abort", async (ctx) => {
    const runId = ctx.req.param("runId");
    const aborted = context.runManager.abortRun(runId);
    if (!aborted) {
      throw notFound("Run not found");
    }
    return ctx.json({ success: true });
  });

  app.get("/chats/:sessionId/runs/:runId/events", async (ctx) => {
    const runId = ctx.req.param("runId");
    const afterSeq = Number(ctx.req.query("after_seq") ?? 0);
    const events = context.stores.chatStore.getRunEvents(runId, afterSeq);
    const lines: string[] = [];
    for (const event of events) {
      const eventData = event.data ? JSON.stringify(event.data) : "{}";
      lines.push(`event: ${event.type}\ndata: ${eventData}\n\n`);
    }
    return new Response(
      streamAsyncStrings(
        (async function* () {
          for (const line of lines) {
            yield line;
          }
          yield ":done\n\n";
        })()
      ),
      { headers: buildSseHeaders() }
    );
  });

  app.post("/chats/:sessionId/continue", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
    const runId = typeof body["run_id"] === "string" ? body["run_id"] : "";
    if (!runId) {
      throw badRequest("run_id is required");
    }
    const stream = await context.runManager.continueRun(sessionId, runId);
    return new Response(
      streamAsyncStrings(stream.stream),
      { headers: { ...buildSseHeaders(), "X-Run-Id": stream.runId } }
    );
  });

  app.post("/chats/:sessionId/followup", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
    const content = typeof body["content"] === "string" ? body["content"] : "";
    if (!content) {
      throw badRequest("content is required");
    }
    const stream = await context.runManager.followUpRun(sessionId, content);
    return new Response(
      streamAsyncStrings(stream.stream),
      { headers: { ...buildSseHeaders(), "X-Run-Id": stream.runId } }
    );
  });

  app.post("/chats/:sessionId/runs/:runId/approve", async (ctx) => {
    const runId = ctx.req.param("runId");
    const body = (await ctx.req.json().catch(() => ({}))) as Record<string, unknown>;
    const toolCallId = typeof body["tool_call_id"] === "string" ? body["tool_call_id"] : "";
    const approved = Boolean(body["approved"]);
    const reason = typeof body["reason"] === "string" ? body["reason"] : undefined;
    if (!toolCallId) {
      throw badRequest("tool_call_id is required");
    }
    const resolved = context.runManager.resolveApproval(runId, toolCallId, approved, reason);
    if (!resolved) {
      throw notFound("Pending approval not found");
    }
    return ctx.json({ success: true });
  });

  app.post("/chats/retitle-all", async (ctx) => {
    const sessions = context.stores.chatStore.listSessions();
    let updated = 0;
    let skipped = 0;

    for (const session of sessions) {
      const sessionId = String(session["id"]);
      const fullSession = context.stores.chatStore.getSession(sessionId);
      if (!fullSession) {
        skipped++;
        continue;
      }

      const messages = (fullSession["messages"] ?? []) as Array<Record<string, unknown>>;
      const firstUserMessage = messages.find((m) => m["role"] === "user");

      if (!firstUserMessage || !firstUserMessage["content"]) {
        skipped++;
        continue;
      }

      const newTitle = generateTitleFromMessage(String(firstUserMessage["content"]));
      context.stores.chatStore.updateSession(sessionId, newTitle);
      const summary = context.stores.chatStore.getSessionSummary(sessionId);
      await context.eventManager.publish(
        new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_UPDATED, {
          session_id: sessionId,
          session: summary,
          changes: { title: newTitle },
        })
      );
      updated++;
    }

    return ctx.json({ updated, skipped, total: sessions.length });
  });

  app.post("/chats/:sessionId/fork", async (ctx) => {
    const sessionId = ctx.req.param("sessionId");
    const body = (await ctx.req.json()) as Record<string, unknown>;
    const newId = randomUUID();
    const messageId = typeof body["message_id"] === "string" ? body["message_id"] : undefined;
    const model = typeof body["model"] === "string" ? body["model"] : undefined;
    const title = typeof body["title"] === "string" ? body["title"] : undefined;
    const session = context.stores.chatStore.forkSession(sessionId, newId, messageId, model, title);
    if (!session) {
      throw notFound("Session not found");
    }
    const summary = context.stores.chatStore.getSessionSummary(newId) ?? session;
    await context.eventManager.publish(
      new Event(AGENT_RUN_EVENT_TYPES.CHAT_SESSION_FORKED, {
        source_id: sessionId,
        session: summary,
      })
    );
    return ctx.json({ session });
  });
};
