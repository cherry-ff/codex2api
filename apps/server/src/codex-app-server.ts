import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import path from "node:path";

import type { ApprovalPolicy, SandboxMode } from "./config.js";
import type { AccountSnapshot, JobExecutionResult, JobRuntimeEvent, TokenUsage } from "./types.js";

interface RpcMessage {
  method?: string;
  id?: number;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: {
    code: number;
    message: string;
  };
}

interface ExecutionOptions {
  model: string;
  cwd: string;
  prompt: string;
  sandbox: SandboxMode;
  approvalPolicy: ApprovalPolicy;
  timeoutMs: number;
  onEvent: (event: JobRuntimeEvent) => void;
}

interface ActiveRun {
  threadId: string;
  turnId: string;
  text: string;
  usage: TokenUsage | null;
  resolve: (result: JobExecutionResult) => void;
  reject: (error: Error) => void;
  onEvent: (event: JobRuntimeEvent) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export class CodexAppServerClient extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private started = false;
  private activeRun: ActiveRun | null = null;
  private stderrBuffer = "";

  constructor(
    private readonly options: {
      codexBin: string;
      codexHome: string;
      serviceName: string;
    }
  ) {
    super();
  }

  get busy(): boolean {
    return this.activeRun !== null;
  }

  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    this.child = spawn(
      this.options.codexBin,
      ["app-server", "--listen", "stdio://", "--session-source", this.options.serviceName],
      {
        env: {
          ...process.env,
          CODEX_HOME: this.options.codexHome
        },
        stdio: ["pipe", "pipe", "pipe"]
      }
    );

    this.child.once("exit", (code, signal) => {
      const message = `codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`;
      this.started = false;
      this.rejectPending(message);
      if (this.activeRun) {
        this.activeRun.reject(new Error(message));
        this.activeRun = null;
      }
      this.emit("runtime-exit", message);
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer += chunk;
    });

    const lineReader = readline.createInterface({
      input: this.child.stdout
    });

    lineReader.on("line", (line) => {
      if (!line.trim()) {
        return;
      }

      const message = JSON.parse(line) as RpcMessage;
      this.handleMessage(message);
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex2api",
        title: "codex2api",
        version: "0.1.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify("initialized");
    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.child) {
      return;
    }

    this.child.kill("SIGTERM");
    this.child = null;
    this.started = false;
  }

  async getAccount(refreshToken = false): Promise<AccountSnapshot | null> {
    const result = (await this.request("account/read", { refreshToken })) as {
      account: { type: string; email?: string; planType?: string } | null;
    };

    if (!result.account) {
      return null;
    }

    if (result.account.type === "chatgpt") {
      return {
        authType: "chatgpt",
        email: result.account.email ?? null,
        planType: result.account.planType ?? null
      };
    }

    return {
      authType: result.account.type,
      email: null,
      planType: null
    };
  }

  async getRateLimits(): Promise<Record<string, unknown>> {
    return (await this.request("account/rateLimits/read", undefined)) as Record<string, unknown>;
  }

  async execute(options: ExecutionOptions): Promise<JobExecutionResult> {
    if (this.activeRun) {
      throw new Error("runtime is already executing a turn");
    }

    await this.start();

    const threadResponse = (await this.request("thread/start", {
      model: options.model,
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
      ephemeral: true,
      experimentalRawEvents: false,
      persistExtendedHistory: false,
      serviceName: this.options.serviceName
    })) as { thread: { id: string } };

    const threadId = threadResponse.thread.id;
    options.onEvent({
      type: "thread.started",
      payload: { threadId },
      createdAt: new Date().toISOString()
    });

    const turnResponse = (await this.request("turn/start", {
      threadId,
      input: [
        {
          type: "text",
          text: options.prompt,
          text_elements: []
        }
      ]
    })) as { turn: { id: string } };

    const turnId = turnResponse.turn.id;

    return await new Promise<JobExecutionResult>((resolve, reject) => {
      const timeout = setTimeout(async () => {
        try {
          await this.interrupt(threadId, turnId);
        } catch {
          // Ignore interrupt failures on timeout.
        }

        reject(new Error("job timed out"));
      }, options.timeoutMs);

      this.activeRun = {
        threadId,
        turnId,
        text: "",
        usage: null,
        onEvent: options.onEvent,
        resolve: (result) => {
          clearTimeout(timeout);
          resolve(result);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        }
      };
    });
  }

  async interrupt(threadId: string, turnId: string): Promise<void> {
    await this.request("turn/interrupt", {
      threadId,
      turnId
    });
  }

  private rejectPending(message: string): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(message));
    }
    this.pending.clear();
  }

  private handleMessage(message: RpcMessage): void {
    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    if (message.method && message.id !== undefined) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.handleNotification(message.method, message.params ?? {});
    }
  }

  private handleNotification(method: string, params: Record<string, unknown>): void {
    this.emit("notification", { method, params });

    if (method === "account/updated") {
      this.emit("account-updated");
      return;
    }

    if (method === "account/rateLimits/updated") {
      this.emit("rate-limits-updated", params);
      return;
    }

    const activeRun = this.activeRun;
    if (!activeRun) {
      return;
    }

    if (params.threadId !== activeRun.threadId) {
      return;
    }

    switch (method) {
      case "item/agentMessage/delta": {
        const delta = String(params.delta ?? "");
        activeRun.text += delta;
        activeRun.onEvent({
          type: "assistant.delta",
          payload: { delta },
          createdAt: new Date().toISOString()
        });
        break;
      }
      case "turn/plan/updated": {
        activeRun.onEvent({
          type: "turn.plan",
          payload: params,
          createdAt: new Date().toISOString()
        });
        break;
      }
      case "turn/diff/updated": {
        activeRun.onEvent({
          type: "turn.diff",
          payload: params,
          createdAt: new Date().toISOString()
        });
        break;
      }
      case "item/completed": {
        const item = params.item as { type?: string; text?: string } | undefined;
        if (item?.type === "agentMessage" && typeof item.text === "string") {
          activeRun.text = item.text;
        }
        activeRun.onEvent({
          type: "item.completed",
          payload: params,
          createdAt: new Date().toISOString()
        });
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = params.tokenUsage as {
          last?: {
            totalTokens: number;
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            reasoningOutputTokens: number;
          };
          total?: {
            totalTokens: number;
            inputTokens: number;
            cachedInputTokens: number;
            outputTokens: number;
            reasoningOutputTokens: number;
          };
        } | undefined;

        const breakdown = usage?.last ?? usage?.total;
        if (breakdown) {
          activeRun.usage = {
            totalTokens: breakdown.totalTokens,
            inputTokens: breakdown.inputTokens,
            cachedInputTokens: breakdown.cachedInputTokens,
            outputTokens: breakdown.outputTokens,
            reasoningOutputTokens: breakdown.reasoningOutputTokens
          };
        }

        activeRun.onEvent({
          type: "usage.updated",
          payload: params,
          createdAt: new Date().toISOString()
        });
        break;
      }
      case "turn/completed": {
        const turn = params.turn as {
          id?: string;
          status?: string;
          error?: { message?: string } | null;
        };

        if (turn?.id !== activeRun.turnId) {
          return;
        }

        const result: JobExecutionResult = {
          text: activeRun.text,
          usage: activeRun.usage,
          threadId: activeRun.threadId,
          turnId: activeRun.turnId,
          status: (turn.status as JobExecutionResult["status"]) ?? "failed",
          errorMessage: turn.error?.message ?? undefined
        };

        this.activeRun = null;
        activeRun.onEvent({
          type: "turn.completed",
          payload: params,
          createdAt: new Date().toISOString()
        });
        activeRun.resolve(result);
        break;
      }
      default:
        break;
    }
  }

  private handleServerRequest(message: RpcMessage): void {
    const method = message.method!;
    const id = message.id!;

    switch (method) {
      case "item/commandExecution/requestApproval":
        this.respond(id, { decision: "decline" });
        break;
      case "item/fileChange/requestApproval":
        this.respond(id, { decision: "decline" });
        break;
      case "applyPatchApproval":
        this.respond(id, { decision: "denied" });
        break;
      case "execCommandApproval":
        this.respond(id, { decision: "denied" });
        break;
      case "item/tool/requestUserInput":
        this.respond(id, { answers: [] });
        break;
      case "item/permissions/requestApproval":
        this.respond(id, { permissions: {}, scope: "turn" });
        break;
      case "account/chatgptAuthTokens/refresh":
        this.handleChatgptTokenRefresh(id);
        break;
      default:
        this.respondError(id, -32000, `Unsupported server request: ${method}`);
        break;
    }
  }

  private handleChatgptTokenRefresh(id: number): void {
    try {
      const authPath = path.join(this.options.codexHome, "auth.json");
      const raw = fs.readFileSync(authPath, "utf8");
      const parsed = JSON.parse(raw) as {
        tokens?: {
          access_token?: string;
          account_id?: string;
        };
      };

      const accessToken = parsed.tokens?.access_token;
      const accountId = parsed.tokens?.account_id;

      if (!accessToken || !accountId) {
        this.respondError(id, -32001, "missing ChatGPT access token in auth.json");
        return;
      }

      this.respond(id, {
        accessToken,
        chatgptAccountId: accountId,
        chatgptPlanType: null
      });
    } catch (error) {
      this.respondError(
        id,
        -32001,
        error instanceof Error ? error.message : "failed to read auth tokens"
      );
    }
  }

  private request(method: string, params: Record<string, unknown> | undefined): Promise<unknown> {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }

    const id = this.nextId++;
    const payload: RpcMessage = { method, id, params };

    return new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new Error(
            `codex app-server request timed out: ${method}${
              this.stderrBuffer ? `; stderr=${this.stderrBuffer.trim()}` : ""
            }`
          )
        );
      }, 30000);

      this.pending.set(id, { resolve, reject, timeout });
      this.child!.stdin.write(`${JSON.stringify(payload)}\n`, "utf8");
    });
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    if (!this.child) {
      throw new Error("codex app-server is not running");
    }

    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`, "utf8");
  }

  private respond(id: number, result: Record<string, unknown>): void {
    if (!this.child) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`, "utf8");
  }

  private respondError(id: number, code: number, message: string): void {
    if (!this.child) {
      return;
    }
    this.child.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`, "utf8");
  }
}
