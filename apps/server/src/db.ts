import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

import type {
  AccountRecord,
  AccountSnapshot,
  AccountStatus,
  JobEventRecord,
  JobRecord,
  JobStatus,
  RateLimitRecord,
  WorkspaceRecord
} from "./types.js";

function nowIso(): string {
  return new Date().toISOString();
}

function parseRateLimitRow(row: Record<string, unknown>): RateLimitRecord {
  return {
    accountId: String(row.account_id),
    limitId: row.limit_id === null ? null : String(row.limit_id),
    limitName: row.limit_name === null ? null : String(row.limit_name),
    primary: row.primary_json ? JSON.parse(String(row.primary_json)) : null,
    secondary: row.secondary_json ? JSON.parse(String(row.secondary_json)) : null,
    planType: row.plan_type === null ? null : String(row.plan_type),
    updatedAt: String(row.updated_at)
  };
}

export class AppDb {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        codex_home TEXT NOT NULL,
        status TEXT NOT NULL,
        auth_type TEXT,
        email TEXT,
        plan_type TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_rate_limit_refresh_at TEXT
      );

      CREATE TABLE IF NOT EXISTS account_rate_limits (
        account_id TEXT NOT NULL,
        limit_id TEXT,
        limit_name TEXT,
        primary_json TEXT,
        secondary_json TEXT,
        plan_type TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS workspaces (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        path TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        workspace_id TEXT NOT NULL,
        thread_id TEXT,
        turn_id TEXT,
        model TEXT NOT NULL,
        status TEXT NOT NULL,
        request_body TEXT NOT NULL,
        final_text TEXT,
        input_tokens INTEGER,
        cached_input_tokens INTEGER,
        output_tokens INTEGER,
        reasoning_output_tokens INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        FOREIGN KEY(account_id) REFERENCES accounts(id) ON DELETE SET NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS job_events (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON jobs(created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_job_events_job_id_seq ON job_events(job_id, seq);
    `);
  }

  seedDefaultWorkspace(defaultPath: string): void {
    const existing = this.db
      .prepare("SELECT id FROM workspaces ORDER BY created_at ASC LIMIT 1")
      .get() as { id: string } | undefined;

    if (existing) {
      return;
    }

    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO workspaces (id, name, path, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run("default", "Default Workspace", defaultPath, 1, now, now);
  }

  listAccounts(): AccountRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM accounts ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;

    const rateLimitRows = this.db
      .prepare("SELECT * FROM account_rate_limits ORDER BY updated_at DESC")
      .all() as Array<Record<string, unknown>>;

    const rateLimitsByAccount = new Map<string, RateLimitRecord[]>();
    for (const row of rateLimitRows) {
      const parsed = parseRateLimitRow(row);
      const entries = rateLimitsByAccount.get(parsed.accountId) ?? [];
      entries.push(parsed);
      rateLimitsByAccount.set(parsed.accountId, entries);
    }

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      codexHome: String(row.codex_home),
      status: row.status as AccountStatus,
      authType: row.auth_type === null ? null : String(row.auth_type),
      email: row.email === null ? null : String(row.email),
      planType: row.plan_type === null ? null : String(row.plan_type),
      lastError: row.last_error === null ? null : String(row.last_error),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      lastRateLimitRefreshAt:
        row.last_rate_limit_refresh_at === null ? null : String(row.last_rate_limit_refresh_at),
      rateLimits: rateLimitsByAccount.get(String(row.id)) ?? []
    }));
  }

  getAccount(accountId: string): AccountRecord | null {
    return this.listAccounts().find((account) => account.id === accountId) ?? null;
  }

  deleteAccount(accountId: string): boolean {
    const result = this.db.prepare("DELETE FROM accounts WHERE id = ?").run(accountId) as {
      changes?: number;
    };
    return Number(result.changes ?? 0) > 0;
  }

  upsertAccount(input: {
    id: string;
    name: string;
    codexHome: string;
    status: AccountStatus;
  }): void {
    const now = nowIso();
    this.db
      .prepare(`
        INSERT INTO accounts (id, name, codex_home, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          codex_home = excluded.codex_home,
          status = excluded.status,
          updated_at = excluded.updated_at
      `)
      .run(input.id, input.name, input.codexHome, input.status, now, now);
  }

  updateAccountState(accountId: string, input: {
    status?: AccountStatus;
    snapshot?: AccountSnapshot;
    lastError?: string | null;
    lastRateLimitRefreshAt?: string | null;
  }): void {
    const current = this.getAccount(accountId);
    if (!current) {
      return;
    }

    const now = nowIso();
    this.db
      .prepare(`
        UPDATE accounts
        SET status = ?,
            auth_type = ?,
            email = ?,
            plan_type = ?,
            last_error = ?,
            last_rate_limit_refresh_at = ?,
            updated_at = ?
        WHERE id = ?
      `)
      .run(
        input.status ?? current.status,
        input.snapshot?.authType ?? current.authType,
        input.snapshot?.email ?? current.email,
        input.snapshot?.planType ?? current.planType,
        input.lastError === undefined ? current.lastError : input.lastError,
        input.lastRateLimitRefreshAt ?? current.lastRateLimitRefreshAt,
        now,
        accountId
      );
  }

  replaceAccountRateLimits(accountId: string, rateLimits: Omit<RateLimitRecord, "accountId">[]): void {
    const now = nowIso();
    const deleteStmt = this.db.prepare("DELETE FROM account_rate_limits WHERE account_id = ?");
    const insertStmt = this.db.prepare(`
      INSERT INTO account_rate_limits (
        account_id,
        limit_id,
        limit_name,
        primary_json,
        secondary_json,
        plan_type,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.db.exec("BEGIN");
    try {
      deleteStmt.run(accountId);
      for (const entry of rateLimits) {
        insertStmt.run(
          accountId,
          entry.limitId,
          entry.limitName,
          entry.primary ? JSON.stringify(entry.primary) : null,
          entry.secondary ? JSON.stringify(entry.secondary) : null,
          entry.planType,
          now
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
    this.updateAccountState(accountId, { lastRateLimitRefreshAt: now });
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM workspaces ORDER BY created_at ASC")
      .all() as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      path: String(row.path),
      enabled: Boolean(row.enabled),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at)
    }));
  }

  getWorkspace(workspaceId: string): WorkspaceRecord | null {
    return this.listWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;
  }

  createWorkspace(input: { name: string; path: string; enabled?: boolean }): WorkspaceRecord {
    const id = randomUUID();
    const now = nowIso();

    this.db
      .prepare(`
        INSERT INTO workspaces (id, name, path, enabled, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.name, input.path, input.enabled === false ? 0 : 1, now, now);

    return this.getWorkspace(id)!;
  }

  createJob(input: { workspaceId: string; model: string; requestBody: string }): JobRecord {
    const id = randomUUID();
    const now = nowIso();

    this.db
      .prepare(`
        INSERT INTO jobs (
          id, workspace_id, model, status, request_body, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(id, input.workspaceId, input.model, "queued", input.requestBody, now);

    return this.getJob(id)!;
  }

  listJobs(limit = 50): JobRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      accountId: row.account_id === null ? null : String(row.account_id),
      workspaceId: String(row.workspace_id),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      model: String(row.model),
      status: row.status as JobStatus,
      requestBody: String(row.request_body),
      finalText: row.final_text === null ? null : String(row.final_text),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      cachedInputTokens:
        row.cached_input_tokens === null ? null : Number(row.cached_input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      reasoningOutputTokens:
        row.reasoning_output_tokens === null ? null : Number(row.reasoning_output_tokens),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      createdAt: String(row.created_at),
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at)
    }));
  }

  getJob(jobId: string): JobRecord | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId) as
      | Record<string, unknown>
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      accountId: row.account_id === null ? null : String(row.account_id),
      workspaceId: String(row.workspace_id),
      threadId: row.thread_id === null ? null : String(row.thread_id),
      turnId: row.turn_id === null ? null : String(row.turn_id),
      model: String(row.model),
      status: row.status as JobStatus,
      requestBody: String(row.request_body),
      finalText: row.final_text === null ? null : String(row.final_text),
      inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      cachedInputTokens: row.cached_input_tokens === null ? null : Number(row.cached_input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      reasoningOutputTokens:
        row.reasoning_output_tokens === null ? null : Number(row.reasoning_output_tokens),
      errorMessage: row.error_message === null ? null : String(row.error_message),
      createdAt: String(row.created_at),
      startedAt: row.started_at === null ? null : String(row.started_at),
      finishedAt: row.finished_at === null ? null : String(row.finished_at)
    };
  }

  updateJob(jobId: string, input: Partial<{
    accountId: string | null;
    threadId: string | null;
    turnId: string | null;
    status: JobStatus;
    finalText: string | null;
    errorMessage: string | null;
    inputTokens: number | null;
    cachedInputTokens: number | null;
    outputTokens: number | null;
    reasoningOutputTokens: number | null;
    startedAt: string | null;
    finishedAt: string | null;
  }>): void {
    const current = this.getJob(jobId);
    if (!current) {
      return;
    }

    this.db
      .prepare(`
        UPDATE jobs
        SET account_id = ?,
            thread_id = ?,
            turn_id = ?,
            status = ?,
            final_text = ?,
            error_message = ?,
            input_tokens = ?,
            cached_input_tokens = ?,
            output_tokens = ?,
            reasoning_output_tokens = ?,
            started_at = ?,
            finished_at = ?
        WHERE id = ?
      `)
      .run(
        input.accountId === undefined ? current.accountId : input.accountId,
        input.threadId === undefined ? current.threadId : input.threadId,
        input.turnId === undefined ? current.turnId : input.turnId,
        input.status ?? current.status,
        input.finalText === undefined ? current.finalText : input.finalText,
        input.errorMessage === undefined ? current.errorMessage : input.errorMessage,
        input.inputTokens === undefined ? current.inputTokens : input.inputTokens,
        input.cachedInputTokens === undefined
          ? current.cachedInputTokens
          : input.cachedInputTokens,
        input.outputTokens === undefined ? current.outputTokens : input.outputTokens,
        input.reasoningOutputTokens === undefined
          ? current.reasoningOutputTokens
          : input.reasoningOutputTokens,
        input.startedAt === undefined ? current.startedAt : input.startedAt,
        input.finishedAt === undefined ? current.finishedAt : input.finishedAt,
        jobId
      );
  }

  appendJobEvent(jobId: string, eventType: string, payload: Record<string, unknown>): JobEventRecord {
    const nextSeq =
      ((this.db
        .prepare("SELECT COALESCE(MAX(seq), 0) AS max_seq FROM job_events WHERE job_id = ?")
        .get(jobId) as { max_seq: number }).max_seq ?? 0) + 1;

    const record: JobEventRecord = {
      id: randomUUID(),
      jobId,
      seq: nextSeq,
      eventType,
      payloadJson: JSON.stringify(payload),
      createdAt: nowIso()
    };

    this.db
      .prepare(`
        INSERT INTO job_events (id, job_id, seq, event_type, payload_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(
        record.id,
        record.jobId,
        record.seq,
        record.eventType,
        record.payloadJson,
        record.createdAt
      );

    return record;
  }

  getJobEvents(jobId: string): JobEventRecord[] {
    const rows = this.db
      .prepare("SELECT * FROM job_events WHERE job_id = ? ORDER BY seq ASC")
      .all(jobId) as Array<Record<string, unknown>>;

    return rows.map((row) => ({
      id: String(row.id),
      jobId: String(row.job_id),
      seq: Number(row.seq),
      eventType: String(row.event_type),
      payloadJson: String(row.payload_json),
      createdAt: String(row.created_at)
    }));
  }

  getOverview(): {
    accountCount: number;
    readyAccountCount: number;
    queuedJobCount: number;
    runningJobCount: number;
  } {
    const accountCount = this.listAccounts().length;
    const readyAccountCount = this.listAccounts().filter((account) => account.status === "ready").length;
    const queuedJobCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'queued'").get() as {
        count: number;
      }
    ).count;
    const runningJobCount = (
      this.db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get() as {
        count: number;
      }
    ).count;

    return { accountCount, readyAccountCount, queuedJobCount, runningJobCount };
  }
}
