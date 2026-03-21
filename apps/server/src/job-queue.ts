import { EventEmitter } from "node:events";

import { config } from "./config.js";
import { AppDb } from "./db.js";
import { buildCodexPrompt } from "./openai.js";
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

  cancel(jobId: string): boolean {
    const queuedIndex = this.queuedJobs.findIndex((item) => item.job.id === jobId);
    if (queuedIndex >= 0) {
      const [queuedJob] = this.queuedJobs.splice(queuedIndex, 1);
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

  private pickAccount() {
    return this.runtimeManager.getReadyAccounts().find((account) => {
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
    const runtime = await this.runtimeManager.ensureRuntime(accountId);
    const startedAt = new Date().toISOString();

    this.db.updateJob(candidate.job.id, {
      accountId,
      status: "running",
      startedAt
    });

    this.emitJobEvent(candidate.job.id, {
      type: "job.running",
      payload: { accountId, workspaceId: workspace.id },
      createdAt: startedAt
    });

    try {
      const result = await runtime.execute({
        model: candidate.request.model,
        cwd: workspace.path,
        prompt: buildCodexPrompt(candidate.request.messages),
        sandbox: config.defaultSandbox,
        approvalPolicy: config.defaultApprovalPolicy,
        timeoutMs: config.turnTimeoutMs,
        onEvent: (event) => this.emitJobEvent(candidate.job.id, event)
      });

      this.handleCompletion(candidate.job.id, result);
      candidate.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : "job failed";
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
    } finally {
      this.runningJobs.delete(candidate.job.id);
      this.workspaceLocks.delete(workspace.id);
      void this.schedule();
    }
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
}
