import { EventEmitter } from "node:events";
import fs from "node:fs/promises";

import { config } from "./config.js";
import { AppDb } from "./db.js";
import { prepareCodexInput } from "./openai.js";
import { RuntimeManager } from "./runtime-manager.js";
import type {
  JobExecutionResult,
  JobRecord,
  JobRequest,
  JobRuntimeEvent,
  JobStatus,
  WorkspaceRecord
} from "./types.js";

interface QueuedJob {
  job: JobRecord;
  request: JobRequest;
  resolve: (result: JobExecutionResult) => void;
  reject: (error: Error) => void;
}

const ACCOUNT_FAILURE_PATTERNS = [
  "auth",
  "token",
  "credential",
  "missing account",
  "quota",
  "rate limit",
  "plan",
  "chatgpt",
  "unauthorized",
  "forbidden",
  "expired",
  "session",
  "sign in",
  "login",
  "app-server exited"
];

export class JobQueue {
  private readonly queuedJobs: QueuedJob[] = [];
  private readonly eventBus = new EventEmitter();
  private readonly runningJobs = new Map<string, { accountId: string; workspaceId: string }>();
  private readonly workspaceLocks = new Set<string>();
  private scheduling = false;

  constructor(
    private readonly db: AppDb,
    private readonly runtimeManager: RuntimeManager
  ) {}

  enqueue(request: JobRequest): {
    job: JobRecord;
    result: Promise<JobExecutionResult>;
    subscribe: (listener: (event: JobRuntimeEvent) => void) => () => void;
  } {
    if (this.queuedJobs.length >= config.queueCapacity) {
      throw new Error("queue is full");
    }

    const job = this.db.createJob({
      workspaceId: request.workspaceId,
      model: request.model,
      requestBody: JSON.stringify(request.requestBody)
    });

    const result = new Promise<JobExecutionResult>((resolve, reject) => {
      this.queuedJobs.push({ job, request, resolve, reject });
    });

    this.emitJobEvent(job.id, {
      type: "job.queued",
      payload: { status: "queued" },
      createdAt: new Date().toISOString()
    });

    void this.schedule();

    return {
      job,
      result,
      subscribe: (listener) => this.subscribe(job.id, listener)
    };
  }

  subscribe(jobId: string, listener: (event: JobRuntimeEvent) => void): () => void {
    this.eventBus.on(jobId, listener);
    return () => this.eventBus.off(jobId, listener);
  }

  async cancel(jobId: string): Promise<boolean> {
    const queuedIndex = this.queuedJobs.findIndex((item) => item.job.id === jobId);
    if (queuedIndex >= 0) {
      const [queuedJob] = this.queuedJobs.splice(queuedIndex, 1);
      await this.cleanupPreparedFiles(queuedJob.request.preparedInput?.cleanupPaths ?? []);
      this.db.updateJob(jobId, {
        status: "cancelled",
        finishedAt: new Date().toISOString(),
        errorMessage: "job cancelled before execution"
      });
      this.emitJobEvent(jobId, {
        type: "job.cancelled",
        payload: { status: "cancelled" },
        createdAt: new Date().toISOString()
      });
      queuedJob.reject(new Error("job cancelled"));
      return true;
    }

    const running = this.runningJobs.get(jobId);
    if (!running) {
      return false;
    }

    const runtime = this.runtimeManager.getRuntime(running.accountId);
    const record = this.db.getJob(jobId);
    if (!runtime || !record?.threadId || !record.turnId) {
      return false;
    }

    void runtime.interrupt(record.threadId, record.turnId);
    return true;
  }

  private async schedule(): Promise<void> {
    if (this.scheduling) {
      return;
    }

    this.scheduling = true;

    try {
      let madeProgress = true;
      while (madeProgress) {
        madeProgress = false;

        for (let index = 0; index < this.queuedJobs.length; index += 1) {
          const candidate = this.queuedJobs[index];
          const workspace = this.db.getWorkspace(candidate.request.workspaceId);
          if (!workspace || !workspace.enabled) {
            this.failQueuedJob(candidate, "workspace is not available");
            this.queuedJobs.splice(index, 1);
            madeProgress = true;
            break;
          }

          if (this.workspaceLocks.has(workspace.id)) {
            continue;
          }

          const account = this.pickAccount();
          if (!account) {
            continue;
          }

          this.queuedJobs.splice(index, 1);
          this.workspaceLocks.add(workspace.id);
          this.runningJobs.set(candidate.job.id, { accountId: account.id, workspaceId: workspace.id });
          void this.runJob(candidate, account.id, workspace);
          madeProgress = true;
          break;
        }
      }
    } finally {
      this.scheduling = false;
    }
  }

  private pickAccount(excludedAccountIds: Iterable<string> = []) {
    const excluded = new Set(excludedAccountIds);
    return this.runtimeManager.getReadyAccounts().find((account) => {
      if (excluded.has(account.id)) {
        return false;
      }
      const runtime = this.runtimeManager.getRuntime(account.id);
      return runtime && !runtime.busy;
    });
  }

  private failQueuedJob(candidate: QueuedJob, message: string): void {
    this.db.updateJob(candidate.job.id, {
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorMessage: message
    });
    this.emitJobEvent(candidate.job.id, {
      type: "job.failed",
      payload: { error: message },
      createdAt: new Date().toISOString()
    });
    candidate.reject(new Error(message));
  }

  private async runJob(candidate: QueuedJob, accountId: string, workspace: WorkspaceRecord): Promise<void> {
    let preparedInput = candidate.request.preparedInput;
    let currentAccountId = accountId;
    let startedAt: string | null = null;
    const attemptedAccountIds = new Set<string>();

    try {
      preparedInput ??= await prepareCodexInput(candidate.request.messages, workspace.path);

      while (true) {
        attemptedAccountIds.add(currentAccountId);

        const runningAt = new Date().toISOString();
        if (!startedAt) {
          startedAt = runningAt;
        }

        this.db.updateJob(candidate.job.id, {
          accountId: currentAccountId,
          status: "running",
          startedAt,
          errorMessage: null
        });
        this.runningJobs.set(candidate.job.id, {
          accountId: currentAccountId,
          workspaceId: workspace.id
        });

        this.emitJobEvent(candidate.job.id, {
          type: "job.running",
          payload: {
            accountId: currentAccountId,
            workspaceId: workspace.id,
            attempt: attemptedAccountIds.size
          },
          createdAt: runningAt
        });

        try {
          const runtime = await this.runtimeManager.ensureRuntime(currentAccountId);
          const result = await runtime.execute({
            model: candidate.request.model,
            cwd: workspace.path,
            input: preparedInput.input,
            sandbox: config.defaultSandbox,
            approvalPolicy: config.defaultApprovalPolicy,
            timeoutMs: config.turnTimeoutMs,
            onEvent: (event) => this.emitJobEvent(candidate.job.id, event)
          });

          if (result.status !== "failed") {
            this.handleCompletion(candidate.job.id, result);
            candidate.resolve(result);
            return;
          }

          const message = result.errorMessage ?? "job failed";
          const retryAccountId = await this.retryOnAnotherAccountIfNeeded(
            candidate.job.id,
            currentAccountId,
            attemptedAccountIds,
            workspace.id,
            message
          );

          if (!retryAccountId) {
            this.handleCompletion(candidate.job.id, result);
            candidate.reject(new Error(message));
            return;
          }

          currentAccountId = retryAccountId;
        } catch (error) {
          const message = error instanceof Error ? error.message : "job failed";
          const retryAccountId = await this.retryOnAnotherAccountIfNeeded(
            candidate.job.id,
            currentAccountId,
            attemptedAccountIds,
            workspace.id,
            message
          );

          if (retryAccountId) {
            currentAccountId = retryAccountId;
            continue;
          }

          const status: JobStatus = message === "job timed out" ? "timeout" : "failed";
          this.db.updateJob(candidate.job.id, {
            status,
            errorMessage: message,
            finishedAt: new Date().toISOString()
          });
          this.emitJobEvent(candidate.job.id, {
            type: "job.failed",
            payload: { error: message, status },
            createdAt: new Date().toISOString()
          });
          candidate.reject(new Error(message));
          return;
        }
      }
    } finally {
      await this.cleanupPreparedFiles(preparedInput?.cleanupPaths ?? []);
      this.runningJobs.delete(candidate.job.id);
      this.workspaceLocks.delete(workspace.id);
      void this.schedule();
    }
  }

  private async retryOnAnotherAccountIfNeeded(
    jobId: string,
    failedAccountId: string,
    attemptedAccountIds: Set<string>,
    workspaceId: string,
    message: string
  ): Promise<string | null> {
    if (!this.isRetryableAccountFailure(failedAccountId, message)) {
      return null;
    }

    await this.runtimeManager.markAccountError(failedAccountId, message);

    const nextAccount = this.pickAccount(attemptedAccountIds);
    if (!nextAccount) {
      return null;
    }

    this.emitJobEvent(jobId, {
      type: "job.retrying",
      payload: {
        failedAccountId,
        accountId: nextAccount.id,
        workspaceId,
        error: message,
        attempt: attemptedAccountIds.size + 1
      },
      createdAt: new Date().toISOString()
    });

    return nextAccount.id;
  }

  private isRetryableAccountFailure(accountId: string, message: string): boolean {
    const normalized = message.trim().toLowerCase();
    if (!normalized) {
      return false;
    }

    if (normalized === "job timed out" || normalized === "job cancelled" || normalized === "job canceled") {
      return false;
    }

    const account = this.runtimeManager.getAccount(accountId);
    if (!account || account.status !== "ready") {
      return true;
    }

    return ACCOUNT_FAILURE_PATTERNS.some((pattern) => normalized.includes(pattern));
  }

  private handleCompletion(jobId: string, result: JobExecutionResult): void {
    const finishedAt = new Date().toISOString();
    const status: JobStatus =
      result.status === "completed"
        ? "completed"
        : result.status === "interrupted"
          ? "cancelled"
          : "failed";

    this.db.updateJob(jobId, {
      threadId: result.threadId,
      turnId: result.turnId,
      finalText: result.text,
      status,
      errorMessage: result.errorMessage ?? null,
      inputTokens: result.usage?.inputTokens ?? null,
      cachedInputTokens: result.usage?.cachedInputTokens ?? null,
      outputTokens: result.usage?.outputTokens ?? null,
      reasoningOutputTokens: result.usage?.reasoningOutputTokens ?? null,
      finishedAt
    });

    this.emitJobEvent(jobId, {
      type: "job.completed",
      payload: {
        status,
        threadId: result.threadId,
        turnId: result.turnId,
        usage: result.usage
      },
      createdAt: finishedAt
    });
  }

  private emitJobEvent(jobId: string, event: JobRuntimeEvent): void {
    this.db.appendJobEvent(jobId, event.type, {
      ...event.payload,
      createdAt: event.createdAt
    });
    this.eventBus.emit(jobId, event);
  }

  private async cleanupPreparedFiles(paths: string[]): Promise<void> {
    await Promise.all(
      paths.map(async (filePath) => {
        try {
          await fs.unlink(filePath);
        } catch {
          // Ignore missing temp files.
        }
      })
    );
  }
}
