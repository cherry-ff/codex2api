import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { config, writeAccountConfigFile } from "./config.js";
import { CodexAppServerClient } from "./codex-app-server.js";
import { AppDb } from "./db.js";
import type { AccountRecord, RateLimitRecord } from "./types.js";

function mapRateLimitResponse(accountId: string, response: Record<string, unknown>): Omit<RateLimitRecord, "accountId">[] {
  const rateLimitsByLimitId = response.rateLimitsByLimitId as Record<string, unknown> | null | undefined;
  const single = response.rateLimits as Record<string, unknown> | undefined;

  const snapshots = rateLimitsByLimitId
    ? Object.values(rateLimitsByLimitId)
    : single
      ? [single]
      : [];

  return snapshots.map((snapshot) => {
    const typedSnapshot = snapshot as Record<string, unknown>;
    const primary = typedSnapshot.primary as Record<string, unknown> | null | undefined;
    const secondary = typedSnapshot.secondary as Record<string, unknown> | null | undefined;
    return {
      limitId: typedSnapshot.limitId === null ? null : String(typedSnapshot.limitId ?? ""),
      limitName:
        typedSnapshot.limitName === null ? null : String(typedSnapshot.limitName ?? ""),
      primary: primary
        ? {
            usedPercent: Number(primary.usedPercent ?? 0),
            windowDurationMins:
              primary.windowDurationMins === null ? null : Number(primary.windowDurationMins ?? 0),
            resetsAt: primary.resetsAt === null ? null : Number(primary.resetsAt ?? 0)
          }
        : null,
      secondary: secondary
        ? {
            usedPercent: Number(secondary.usedPercent ?? 0),
            windowDurationMins:
              secondary.windowDurationMins === null
                ? null
                : Number(secondary.windowDurationMins ?? 0),
            resetsAt: secondary.resetsAt === null ? null : Number(secondary.resetsAt ?? 0)
          }
        : null,
      planType: typedSnapshot.planType === null ? null : String(typedSnapshot.planType ?? ""),
      updatedAt: new Date().toISOString()
    };
  });
}

export class RuntimeManager {
  private readonly runtimes = new Map<string, CodexAppServerClient>();

  constructor(private readonly db: AppDb) {}

  async startKnownAccounts(): Promise<void> {
    const accounts = this.db.listAccounts();
    for (const account of accounts) {
      try {
        await this.ensureRuntime(account.id);
      } catch (error) {
        this.db.updateAccountState(account.id, {
          status: "error",
          lastError: error instanceof Error ? error.message : "Failed to start runtime"
        });
      }
    }
  }

  async importAuthJson(name: string, authJsonText: string): Promise<AccountRecord> {
    const accountId = randomUUID();
    const accountDir = path.join(config.accountsDir, accountId);
    const codexHome = path.join(accountDir, ".codex");

    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "auth.json"), authJsonText, {
      encoding: "utf8",
      mode: 0o600
    });
    writeAccountConfigFile(codexHome);

    this.db.upsertAccount({
      id: accountId,
      name,
      codexHome,
      status: "starting"
    });

    try {
      await this.ensureRuntime(accountId);
    } catch (error) {
      this.db.updateAccountState(accountId, {
        status: "error",
        lastError: error instanceof Error ? error.message : "Failed to import account"
      });
      throw error;
    }

    const record = this.db.getAccount(accountId);
    if (!record) {
      throw new Error("imported account record not found");
    }

    return record;
  }

  async ensureRuntime(accountId: string): Promise<CodexAppServerClient> {
    const existing = this.runtimes.get(accountId);
    if (existing) {
      return existing;
    }

    const account = this.db.getAccount(accountId);
    if (!account) {
      throw new Error(`account ${accountId} not found`);
    }

    const runtime = new CodexAppServerClient({
      codexBin: config.codexBin,
      codexHome: account.codexHome,
      serviceName: config.serviceName
    });

    runtime.on("runtime-exit", (message: string) => {
      this.db.updateAccountState(accountId, {
        status: "error",
        lastError: message
      });
      this.runtimes.delete(accountId);
    });

    runtime.on("account-updated", async () => {
      try {
        await this.refreshAccount(accountId);
      } catch {
        // Ignore best-effort updates.
      }
    });

    runtime.on("rate-limits-updated", (params: Record<string, unknown>) => {
      const snapshots = mapRateLimitResponse(accountId, {
        rateLimitsByLimitId: { live: params.rateLimits },
        rateLimits: params.rateLimits
      });
      this.db.replaceAccountRateLimits(accountId, snapshots);
    });

    await runtime.start();
    this.runtimes.set(accountId, runtime);
    await this.refreshAccount(accountId);
    return runtime;
  }

  async refreshAccount(accountId: string): Promise<void> {
    const runtime = await this.ensureRuntime(accountId);
    const snapshot = await runtime.getAccount(true);
    const rateLimitsResponse = await runtime.getRateLimits();

    this.db.updateAccountState(accountId, {
      status: snapshot ? "ready" : "error",
      snapshot: snapshot ?? undefined,
      lastError: snapshot ? null : "Missing account credentials"
    });

    this.db.replaceAccountRateLimits(accountId, mapRateLimitResponse(accountId, rateLimitsResponse));
  }

  async restartRuntime(accountId: string): Promise<void> {
    await this.stopRuntime(accountId);
    this.db.updateAccountState(accountId, {
      status: "starting",
      lastError: null
    });
    await this.ensureRuntime(accountId);
  }

  async stopRuntime(accountId: string): Promise<void> {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) {
      return;
    }

    this.runtimes.delete(accountId);
    await runtime.stop();
    this.db.updateAccountState(accountId, {
      status: "stopped"
    });
  }

  async stopAll(): Promise<void> {
    const accountIds = [...this.runtimes.keys()];
    for (const accountId of accountIds) {
      await this.stopRuntime(accountId);
    }
  }

  listAccounts(): AccountRecord[] {
    return this.db.listAccounts();
  }

  getRuntime(accountId: string): CodexAppServerClient | null {
    return this.runtimes.get(accountId) ?? null;
  }

  getReadyAccounts(): AccountRecord[] {
    return this.db
      .listAccounts()
      .filter((account) => account.status === "ready")
      .sort((left, right) => {
        const leftUsage = left.rateLimits[0]?.primary?.usedPercent ?? 100;
        const rightUsage = right.rateLimits[0]?.primary?.usedPercent ?? 100;
        return leftUsage - rightUsage;
      });
  }
}
