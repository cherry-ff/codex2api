import Fastify from "fastify";
import cors from "@fastify/cors";

import { config } from "./config.js";
import { AppDb } from "./db.js";
import { formatChatCompletion, createChunk, createUsageChunk, newCompletionId } from "./openai.js";
import { JobQueue } from "./job-queue.js";
import { RuntimeManager } from "./runtime-manager.js";
import type { ChatCompletionRequestBody, JobRuntimeEvent } from "./types.js";

function requireAdminToken(request: { headers: Record<string, unknown> }): boolean {
  if (!config.adminToken) {
    return true;
  }

  const authHeader = String(request.headers.authorization ?? "");
  return authHeader === `Bearer ${config.adminToken}`;
}

export async function buildServer() {
  const db = new AppDb(config.dbPath);
  db.seedDefaultWorkspace(config.defaultWorkspacePath);

  const runtimeManager = new RuntimeManager(db);
  await runtimeManager.startKnownAccounts();

  const jobQueue = new JobQueue(db, runtimeManager);
  const app = Fastify({ logger: true });

  await app.register(cors, {
    origin: config.webOrigin === "*" ? true : config.webOrigin
  });

  app.addHook("onRequest", async (request, reply) => {
    if (request.method === "OPTIONS" || request.url === "/healthz") {
      return;
    }

    if (requireAdminToken(request)) {
      return;
    }

    reply.code(401).send({
      error: "unauthorized"
    });
  });

  app.get("/healthz", async () => ({
    ok: true
  }));

  app.get("/api/dashboard/overview", async () => ({
    ...db.getOverview(),
    accounts: runtimeManager.listAccounts()
  }));

  app.get("/api/accounts", async () => ({
    data: runtimeManager.listAccounts()
  }));

  app.post("/api/accounts/import-auth", async (request, reply) => {
    const body = request.body as { name?: string; content?: string };
    if (!body?.name || !body?.content) {
      return reply.code(400).send({ error: "name and content are required" });
    }

    const account = await runtimeManager.importAuthJson(body.name, body.content);
    return {
      data: account
    };
  });

  app.post("/api/accounts/:id/refresh", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = db.getAccount(id);
    if (!account) {
      return reply.code(404).send({ error: "account not found" });
    }

    await runtimeManager.refreshAccount(id);
    return {
      data: db.getAccount(id)
    };
  });

  app.post("/api/accounts/:id/restart", async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = db.getAccount(id);
    if (!account) {
      return reply.code(404).send({ error: "account not found" });
    }

    await runtimeManager.restartRuntime(id);
    return {
      data: db.getAccount(id)
    };
  });

  app.get("/api/workspaces", async () => ({
    data: db.listWorkspaces()
  }));

  app.post("/api/workspaces", async (request, reply) => {
    const body = request.body as { name?: string; path?: string; enabled?: boolean };
    if (!body?.name || !body?.path) {
      return reply.code(400).send({ error: "name and path are required" });
    }

    const workspace = db.createWorkspace({
      name: body.name,
      path: body.path,
      enabled: body.enabled
    });

    return {
      data: workspace
    };
  });

  app.get("/api/jobs", async () => ({
    data: db.listJobs()
  }));

  app.get("/api/jobs/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    return {
      data: {
        ...job,
        events: db.getJobEvents(id).map((event) => ({
          ...event,
          payload: JSON.parse(event.payloadJson)
        }))
      }
    };
  });

  app.get("/api/jobs/:id/events", async (request, reply) => {
    const { id } = request.params as { id: string };
    const job = db.getJob(id);
    if (!job) {
      return reply.code(404).send({ error: "job not found" });
    }

    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    for (const event of db.getJobEvents(id)) {
      reply.raw.write(
        `data: ${JSON.stringify({
          type: event.eventType,
          payload: JSON.parse(event.payloadJson),
          createdAt: event.createdAt
        })}\n\n`
      );
    }

    const listener = (event: JobRuntimeEvent) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const off = jobQueue.subscribe(id, listener);

    request.raw.on("close", () => {
      off();
    });

    return reply;
  });

  app.post("/api/jobs/:id/cancel", async (request, reply) => {
    const { id } = request.params as { id: string };
    const cancelled = jobQueue.cancel(id);
    if (!cancelled) {
      return reply.code(404).send({ error: "job not found or not cancellable" });
    }

    return {
      ok: true
    };
  });

  app.get("/v1/models", async () => ({
    object: "list",
    data: [
      { id: config.defaultModel, object: "model", owned_by: "openai" },
      { id: "gpt-5.3-codex", object: "model", owned_by: "openai" }
    ]
  }));

  app.post("/v1/chat/completions", async (request, reply) => {
    const body = request.body as ChatCompletionRequestBody;

    if (!body?.messages?.length) {
      return reply.code(400).send({ error: "messages are required" });
    }

    const workspaceId =
      typeof body.metadata?.workspace_id === "string"
        ? body.metadata.workspace_id
        : db.listWorkspaces()[0]?.id;

    if (!workspaceId) {
      return reply.code(400).send({ error: "no workspace configured" });
    }

    if (runtimeManager.getReadyAccounts().length === 0) {
      return reply.code(503).send({ error: "no ready Codex accounts available" });
    }

    const handle = jobQueue.enqueue({
      workspaceId,
      model: body.model ?? config.defaultModel,
      stream: Boolean(body.stream),
      messages: body.messages,
      metadata: body.metadata,
      requestBody: body
    });

    if (!body.stream) {
      const result = await handle.result;
      const job = db.getJob(handle.job.id);
      if (!job) {
        return reply.code(500).send({ error: "job record missing" });
      }

      return formatChatCompletion(job, body.model ?? config.defaultModel, result.text, result.usage);
    }

    const completionId = newCompletionId();
    const includeUsage = body.stream_options?.include_usage === true;
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.flushHeaders();

    const initialChunk = {
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: body.model ?? config.defaultModel,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      usage: includeUsage ? null : undefined
    };
    reply.raw.write(`data: ${JSON.stringify(initialChunk)}\n\n`);

    const unsubscribe = handle.subscribe((event) => {
      if (event.type !== "assistant.delta") {
        return;
      }

      const delta = String(event.payload.delta ?? "");
      const chunk = createChunk(body.model ?? config.defaultModel, completionId, delta, false, includeUsage);
      reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    });

    try {
      const result = await handle.result;
      const finalChunk = createChunk(
        body.model ?? config.defaultModel,
        completionId,
        "",
        true,
        includeUsage
      );
      reply.raw.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
      if (includeUsage) {
        const usageChunk = createUsageChunk(body.model ?? config.defaultModel, completionId, result.usage);
        reply.raw.write(`data: ${JSON.stringify(usageChunk)}\n\n`);
      }
      reply.raw.write("data: [DONE]\n\n");
      reply.raw.end();
    } catch (error) {
      reply.raw.write(
        `data: ${JSON.stringify({
          error: error instanceof Error ? error.message : "job failed"
        })}\n\n`
      );
      reply.raw.end();
    } finally {
      unsubscribe();
    }

    return reply;
  });

  app.addHook("onClose", async () => {
    await runtimeManager.stopAll();
  });

  return app;
}
