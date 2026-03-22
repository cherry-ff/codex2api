import { useEffect, useMemo, useState } from "react";

const ADMIN_TOKEN_STORAGE_KEY = "codex2api.adminToken";

type RateLimitWindow = {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
};

type Account = {
  id: string;
  name: string;
  status: string;
  authType: string | null;
  email: string | null;
  planType: string | null;
  lastError: string | null;
  rateLimits: Array<{
    limitId: string | null;
    limitName: string | null;
    primary: RateLimitWindow | null;
    secondary: RateLimitWindow | null;
  }>;
};

type Workspace = {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
};

type Job = {
  id: string;
  accountId: string | null;
  workspaceId: string;
  model: string;
  status: string;
  finalText: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens: number | null;
  errorMessage: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
};

type Overview = {
  accountCount: number;
  readyAccountCount: number;
  queuedJobCount: number;
  runningJobCount: number;
};

type JobEvent = {
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
};

type StreamEntry = {
  id: string;
  title: string;
  createdAt: string;
  tone: "default" | "accent" | "success" | "muted";
  body?: string;
  meta?: string;
  raw: Record<string, unknown>;
};

function readStoredAdminToken(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY) ?? "";
}

function writeStoredAdminToken(value: string): void {
  if (typeof window === "undefined") {
    return;
  }

  if (value) {
    window.localStorage.setItem(ADMIN_TOKEN_STORAGE_KEY, value);
    return;
  }

  window.localStorage.removeItem(ADMIN_TOKEN_STORAGE_KEY);
}

function buildAuthHeaders(headers?: HeadersInit): Headers {
  const merged = new Headers(headers ?? undefined);
  const token = readStoredAdminToken().trim();
  if (token && !merged.has("Authorization")) {
    merged.set("Authorization", `Bearer ${token}`);
  }

  return merged;
}

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = buildAuthHeaders(init?.headers);
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(url, {
    ...init,
    headers
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || `Request failed: ${response.status}`);
  }

  return response.json() as Promise<T>;
}

function formatResetAt(value: number | null): string {
  if (!value) {
    return "-";
  }

  return new Date(value * 1000).toLocaleString();
}

function formatWindowLabel(value: number | null): string {
  if (value === 300) {
    return "5h quota";
  }

  if (value === 10080) {
    return "1w quota";
  }

  if (!value || value <= 0) {
    return "quota";
  }

  if (value % 1440 === 0) {
    return `${value / 1440}d quota`;
  }

  if (value % 60 === 0) {
    return `${value / 60}h quota`;
  }

  return `${value}m quota`;
}

function remainingPercent(window: RateLimitWindow | null): number {
  if (!window) {
    return 0;
  }

  return Math.max(0, Math.min(100, 100 - window.usedPercent));
}

function formatQuotaLeft(window: RateLimitWindow | null): string {
  if (!window) {
    return "-";
  }

  return `${remainingPercent(window).toFixed(1)}%`;
}

function quotaTone(window: RateLimitWindow | null): "high" | "medium" | "low" {
  const remaining = remainingPercent(window);

  if (remaining >= 60) {
    return "high";
  }

  if (remaining >= 30) {
    return "medium";
  }

  return "low";
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "-";
  }

  return new Date(value).toLocaleString();
}

function normalizeClassName(value: string | null | undefined): string {
  const normalized = String(value ?? "default")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "default";
}

function parseMessageText(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) {
    return undefined;
  }

  if (typeof item.text === "string") {
    return item.text;
  }

  if (item.type === "userMessage" && Array.isArray(item.content)) {
    const parts = item.content as Array<Record<string, unknown>>;
    const rendered = parts
      .map((part) => {
        if (typeof part.text === "string") {
          return part.text;
        }

        if (part.type === "image" && typeof part.url === "string") {
          return `[image: ${part.url}]`;
        }

        if ((part.type === "image_url" || part.type === "input_image") && part.image_url) {
          const imagePart = part as {
            image_url?: string | { url?: string };
          };
          const imageUrl =
            typeof imagePart.image_url === "string"
              ? imagePart.image_url
              : typeof imagePart.image_url?.url === "string"
                ? imagePart.image_url.url
                : null;
          return imageUrl ? `[image: ${imageUrl}]` : null;
        }

        if (part.type === "localImage" && typeof part.path === "string") {
          return `[local image: ${part.path}]`;
        }

        if (part.type === "file" || part.type === "input_file") {
          const filePart = part as {
            file?: {
              filename?: string;
              path?: string;
              file_url?: string;
              url?: string;
            };
            filename?: string;
            path?: string;
            file_url?: string;
            url?: string;
          };
          const descriptor =
            typeof filePart.file === "object" && filePart.file !== null ? filePart.file : filePart;
          const name =
            typeof descriptor.filename === "string"
              ? descriptor.filename
              : typeof descriptor.path === "string"
                ? descriptor.path
                : typeof descriptor.file_url === "string"
                  ? descriptor.file_url
                  : typeof descriptor.url === "string"
                    ? descriptor.url
                    : "attachment";
          return `[file: ${name}]`;
        }

        return null;
      })
      .filter((value): value is string => Boolean(value));

    return rendered.join("\n");
  }

  return undefined;
}

function summarizeUsage(payload: Record<string, unknown>): string {
  const tokenUsage = payload.tokenUsage as
    | {
        total?: {
          inputTokens?: number;
          cachedInputTokens?: number;
          outputTokens?: number;
          totalTokens?: number;
          reasoningOutputTokens?: number;
        };
      }
    | undefined;

  const total = tokenUsage?.total;
  if (!total) {
    return "usage updated";
  }

  return `${total.inputTokens ?? 0} in · ${total.outputTokens ?? 0} out · ${total.totalTokens ?? 0} total · cached ${total.cachedInputTokens ?? 0}`;
}

function previewText(value: string | undefined, limit = 84): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) {
    return normalized;
  }

  return `${normalized.slice(0, limit)}...`;
}

function workspaceMonogram(name: string): string {
  const parts = name
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);

  if (parts.length === 0) {
    return "WS";
  }

  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    .slice(0, 2);
}

function streamLevel(entry: StreamEntry): string {
  switch (entry.title) {
    case "Job completed":
    case "Turn completed":
      return "DONE";
    case "Running":
      return "LIVE";
    case "Usage":
      return "METRIC";
    case "User prompt":
      return "INPUT";
    case "Assistant stream":
    case "Assistant answer":
      return "OUTPUT";
    default:
      return "INFO";
  }
}

function streamLine(entry: StreamEntry): string {
  return entry.meta ?? previewText(entry.body, 120) ?? entry.title;
}

function toStreamEntry(event: JobEvent, index: number, accountNames: Map<string, string>): StreamEntry {
  const item = event.payload.item as Record<string, unknown> | undefined;

  switch (event.type) {
    case "job.queued":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Queued",
        createdAt: event.createdAt,
        tone: "muted",
        raw: event.payload
      };
    case "job.running":
      {
        const accountId = typeof event.payload.accountId === "string" ? event.payload.accountId : null;
        const accountLabel = accountId ? accountNames.get(accountId) ?? accountId : "-";
        return {
          id: `${event.createdAt}-${index}`,
          title: "Running",
          createdAt: event.createdAt,
          tone: "accent",
          meta: `account ${accountLabel} · workspace ${String(event.payload.workspaceId ?? "-")}`,
          raw: event.payload
        };
      }
    case "thread.started":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Thread started",
        createdAt: event.createdAt,
        tone: "muted",
        meta: String(event.payload.threadId ?? ""),
        raw: event.payload
      };
    case "assistant.delta":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Assistant stream",
        createdAt: event.createdAt,
        tone: "accent",
        body: String(event.payload.delta ?? ""),
        raw: event.payload
      };
    case "usage.updated":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Usage",
        createdAt: event.createdAt,
        tone: "muted",
        meta: summarizeUsage(event.payload),
        raw: event.payload
      };
    case "turn.completed":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Turn completed",
        createdAt: event.createdAt,
        tone: "success",
        meta: String((event.payload.turn as { status?: string } | undefined)?.status ?? "completed"),
        raw: event.payload
      };
    case "job.completed":
      return {
        id: `${event.createdAt}-${index}`,
        title: "Job completed",
        createdAt: event.createdAt,
        tone: "success",
        meta: String(event.payload.status ?? "completed"),
        raw: event.payload
      };
    case "item.completed": {
      const itemType = String(item?.type ?? "");
      if (itemType === "userMessage") {
        return {
          id: `${event.createdAt}-${index}`,
          title: "User prompt",
          createdAt: event.createdAt,
          tone: "default",
          body: parseMessageText(item),
          raw: event.payload
        };
      }

      if (itemType === "agentMessage") {
        return {
          id: `${event.createdAt}-${index}`,
          title: "Assistant answer",
          createdAt: event.createdAt,
          tone: "accent",
          body: parseMessageText(item),
          meta: String(item?.phase ?? ""),
          raw: event.payload
        };
      }

      if (itemType === "reasoning") {
        return {
          id: `${event.createdAt}-${index}`,
          title: "Reasoning",
          createdAt: event.createdAt,
          tone: "muted",
          meta: "model reasoning finished",
          raw: event.payload
        };
      }

      return {
        id: `${event.createdAt}-${index}`,
        title: `Item completed · ${itemType || "unknown"}`,
        createdAt: event.createdAt,
        tone: "default",
        raw: event.payload
      };
    }
    default:
      return {
        id: `${event.createdAt}-${index}`,
        title: event.type,
        createdAt: event.createdAt,
        tone: "default",
        raw: event.payload
      };
  }
}

function buildStreamEntries(events: JobEvent[], accountNames: Map<string, string>): StreamEntry[] {
  const entries: StreamEntry[] = [];
  let bufferedDelta = "";
  let bufferedRaw: Record<string, unknown>[] = [];
  let bufferedAt = "";

  const flushDelta = () => {
    if (!bufferedDelta) {
      return;
    }

    entries.push({
      id: `delta-${entries.length}-${bufferedAt}`,
      title: "Assistant stream",
      createdAt: bufferedAt,
      tone: "accent",
      body: bufferedDelta,
      raw: {
        events: bufferedRaw
      }
    });

    bufferedDelta = "";
    bufferedRaw = [];
    bufferedAt = "";
  };

  events.forEach((event, index) => {
    if (event.type === "assistant.delta") {
      bufferedDelta += String(event.payload.delta ?? "");
      bufferedRaw.push(event.payload);
      bufferedAt = event.createdAt;
      return;
    }

    flushDelta();
    entries.push(toStreamEntry(event, index, accountNames));
  });

  flushDelta();
  return entries;
}

export default function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [jobEvents, setJobEvents] = useState<JobEvent[]>([]);
  const [savedAdminToken, setSavedAdminToken] = useState(() => readStoredAdminToken());
  const [adminTokenDraft, setAdminTokenDraft] = useState(() => readStoredAdminToken());
  const [authName, setAuthName] = useState("");
  const [authFile, setAuthFile] = useState<File | null>(null);
  const [showImportCard, setShowImportCard] = useState(false);
  const [showWorkspaceForm, setShowWorkspaceForm] = useState(false);
  const [workspaceName, setWorkspaceName] = useState("");
  const [workspacePath, setWorkspacePath] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) ?? null,
    [jobs, selectedJobId]
  );
  const accountNameById = useMemo(
    () => new Map(accounts.map((account) => [account.id, account.name])),
    [accounts]
  );
  const workspaceNameById = useMemo(
    () => new Map(workspaces.map((workspace) => [workspace.id, workspace.name])),
    [workspaces]
  );
  const streamEntries = useMemo(
    () => buildStreamEntries(jobEvents, accountNameById),
    [accountNameById, jobEvents]
  );
  const selectedAccountLabel = selectedJob?.accountId
    ? accountNameById.get(selectedJob.accountId) ?? selectedJob.accountId
    : "-";
  const selectedWorkspaceLabel = selectedJob
    ? workspaceNameById.get(selectedJob.workspaceId) ?? selectedJob.workspaceId
    : "-";
  const totalAccounts = overview?.accountCount ?? accounts.length;
  const readyAccounts =
    overview?.readyAccountCount ?? accounts.filter((account) => account.status === "ready").length;
  const queuedJobs =
    overview?.queuedJobCount ?? jobs.filter((job) => job.status === "queued").length;
  const runningJobs =
    overview?.runningJobCount ?? jobs.filter((job) => job.status === "running").length;
  const readyWorkspaceCount = workspaces.filter((workspace) => workspace.enabled).length;
  const latestJob = jobs[0] ?? null;
  const isInitialLoading =
    overview === null &&
    accounts.length === 0 &&
    workspaces.length === 0 &&
    jobs.length === 0 &&
    !error;

  async function refreshAll() {
    try {
      const [overviewResult, accountsResult, workspacesResult, jobsResult] = await Promise.all([
        api<Overview>("/api/dashboard/overview"),
        api<{ data: Account[] }>("/api/accounts"),
        api<{ data: Workspace[] }>("/api/workspaces"),
        api<{ data: Job[] }>("/api/jobs")
      ]);

      setOverview(overviewResult);
      setAccounts(accountsResult.data);
      setWorkspaces(workspacesResult.data);
      setJobs(jobsResult.data);

      return {
        overview: overviewResult,
        accounts: accountsResult.data,
        workspaces: workspacesResult.data,
        jobs: jobsResult.data
      };
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Failed to refresh");
      return null;
    }
  }

  useEffect(() => {
    void refreshAll();
    const timer = window.setInterval(() => {
      void refreshAll();
    }, 5000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (jobs.length === 0) {
      if (selectedJobId !== null) {
        setSelectedJobId(null);
      }
      return;
    }

    if (!selectedJobId || !jobs.some((job) => job.id === selectedJobId)) {
      setSelectedJobId(jobs[0].id);
    }
  }, [jobs, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId) {
      setJobEvents([]);
      return;
    }

    setJobEvents([]);
    const controller = new AbortController();

    const consumeEvents = async () => {
      try {
        const response = await fetch(`/api/jobs/${selectedJobId}/events`, {
          headers: buildAuthHeaders(),
          signal: controller.signal
        });

        if (!response.ok || !response.body) {
          throw new Error((await response.text()) || `Job event stream failed: ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const parts = buffer.split("\n\n");
          buffer = parts.pop() ?? "";

          for (const part of parts) {
            const line = part
              .split("\n")
              .find((entry) => entry.startsWith("data: "));

            if (!line) {
              continue;
            }

            const parsed = JSON.parse(line.slice(6)) as JobEvent;
            setJobEvents((current) => [...current, parsed]);
          }
        }
      } catch (streamError) {
        if (controller.signal.aborted) {
          return;
        }

        setError(streamError instanceof Error ? streamError.message : "Failed to stream job events");
      }
    };

    void consumeEvents();

    return () => controller.abort();
  }, [selectedJobId, savedAdminToken]);

  async function handleImportAccount(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!authFile || !authName.trim()) {
      return;
    }

    try {
      setBusy("import-account");
      const content = await authFile.text();
      await api("/api/accounts/import-auth", {
        method: "POST",
        body: JSON.stringify({
          name: authName.trim(),
          content
        })
      });
      setAuthName("");
      setAuthFile(null);
      setShowImportCard(false);
      await refreshAll();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Import failed");
    } finally {
      setBusy(null);
    }
  }

  async function handleAddWorkspace(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!workspaceName.trim() || !workspacePath.trim()) {
      return;
    }

    try {
      setBusy("add-workspace");
      await api("/api/workspaces", {
        method: "POST",
        body: JSON.stringify({
          name: workspaceName.trim(),
          path: workspacePath.trim()
        })
      });
      setWorkspaceName("");
      setWorkspacePath("");
      setShowWorkspaceForm(false);
      await refreshAll();
    } catch (workspaceError) {
      setError(workspaceError instanceof Error ? workspaceError.message : "Workspace creation failed");
    } finally {
      setBusy(null);
    }
  }

  function handleSaveAdminToken(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const token = adminTokenDraft.trim();
    writeStoredAdminToken(token);
    setSavedAdminToken(token);
    setAdminTokenDraft(token);
    setError(null);
    void refreshAll();
  }

  function clearAdminToken() {
    writeStoredAdminToken("");
    setSavedAdminToken("");
    setAdminTokenDraft("");
    setError(null);
    void refreshAll();
  }

  async function refreshAccount(accountId: string) {
    try {
      setBusy(`refresh-${accountId}`);
      await api(`/api/accounts/${accountId}/refresh`, {
        method: "POST"
      });
      await refreshAll();
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : "Account refresh failed");
    } finally {
      setBusy(null);
    }
  }

  async function restartAccount(accountId: string) {
    try {
      setBusy(`restart-${accountId}`);
      await api(`/api/accounts/${accountId}/restart`, {
        method: "POST"
      });
      await refreshAll();
    } catch (restartError) {
      setError(restartError instanceof Error ? restartError.message : "Account restart failed");
    } finally {
      setBusy(null);
    }
  }

  async function cancelJob(jobId: string) {
    try {
      setBusy(`cancel-${jobId}`);
      await api(`/api/jobs/${jobId}/cancel`, {
        method: "POST"
      });
      await refreshAll();
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : "Job cancel failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="shell">
      <header className="hero hero-compact">
        <div className="hero-topline">
          <div className="hero-main hero-main-compact">
            <div className="hero-title">
              <p className="eyebrow">codex2api</p>
              <h1>Account quota board</h1>
            </div>
            <p className="hero-inline-meta">
              {latestJob
                ? `Latest job ${latestJob.id.slice(0, 8)}`
                : `${readyWorkspaceCount} enabled workspace paths`}
            </p>
          </div>
          <div className="hero-summary">
            <article>
              <span>Accounts</span>
              <strong>{totalAccounts}</strong>
            </article>
            <article>
              <span>Ready</span>
              <strong>{readyAccounts}</strong>
            </article>
            <article>
              <span>Running</span>
              <strong>{runningJobs}</strong>
            </article>
            <article>
              <span>Queued</span>
              <strong>{queuedJobs}</strong>
            </article>
            <article>
              <span>Latest job</span>
              <strong>{latestJob ? latestJob.id.slice(0, 8) : "-"}</strong>
            </article>
            <article>
              <span>Workspaces</span>
              <strong>{readyWorkspaceCount}</strong>
            </article>
          </div>
        </div>
        <section className="hero-config">
          <div className="hero-config-head">
            <div>
              <p className="section-label">Component config</p>
              <h2>API token</h2>
            </div>
            <div className="panel-head-meta">
              <span className={`pill ${savedAdminToken ? "pill-success" : "pill-muted"}`}>
                {savedAdminToken ? "Token loaded" : "Token missing"}
              </span>
              <span className="pill pill-muted">Auto refresh 5s</span>
            </div>
          </div>
          <form className="auth-form auth-form-compact" onSubmit={handleSaveAdminToken}>
            <label className="token-field">
              <span>Admin token</span>
              <input
                type="password"
                placeholder="ADMIN_TOKEN for deployed server"
                value={adminTokenDraft}
                onChange={(event) => setAdminTokenDraft(event.target.value)}
              />
            </label>
            <div className="token-actions">
              <button type="submit">Save</button>
              <button className="secondary-button" onClick={clearAdminToken} type="button">
                Clear
              </button>
            </div>
          </form>
        </section>
      </header>

      {error ? (
        <section className="panel alert">
          <div>
            <p className="section-label">System notice</p>
            <strong>{error}</strong>
          </div>
          <button onClick={() => setError(null)}>Dismiss</button>
        </section>
      ) : null}

      <section className="panel full accounts-panel accounts-panel-primary">
        <div className="section-heading">
          <div>
            <p className="section-label">Quota focus</p>
            <h2>Account balances</h2>
          </div>
          <div className="panel-head-meta">
            <span className="pill">{accounts.length} loaded</span>
            <span className="pill pill-muted">{readyAccounts} ready</span>
            <button className="ghost-button compact-button" onClick={() => void refreshAll()} type="button">
              Refresh now
            </button>
          </div>
        </div>
        <div className="cards cards-compact">
          {isInitialLoading
            ? Array.from({ length: 4 }, (_, index) => (
                <article className="card skeleton-card" key={`account-skeleton-${index}`}>
                  <div className="skeleton-line skeleton-line-title" />
                  <div className="skeleton-line" />
                  <div className="skeleton-line skeleton-line-wide" />
                  <div className="skeleton-line" />
                  <div className="skeleton-line skeleton-line-short" />
                </article>
              ))
            : null}
          {!isInitialLoading && accounts.length === 0 ? (
            <article className="card empty-card">
              <p className="empty-title">No accounts imported</p>
              <p className="empty-copy">
                Add an `auth.json` cache to start routing Codex work through this surface.
              </p>
            </article>
          ) : null}
          {accounts.map((account) => {
            const rateLimit = account.rateLimits[0];
            const primary = rateLimit?.primary;
            const secondary = rateLimit?.secondary;
            const primaryLabel = formatWindowLabel(primary?.windowDurationMins ?? null);
            const secondaryLabel = formatWindowLabel(secondary?.windowDurationMins ?? null);
            return (
              <article
                className={`card account-card account-card-compact tone-${normalizeClassName(account.status)}`}
                key={account.id}
              >
                <div className="card-head">
                  <div>
                    <h3>{account.name}</h3>
                    <p>{account.email ?? account.authType ?? "unknown"}</p>
                  </div>
                  <span className={`status status-${normalizeClassName(account.status)}`}>
                    {account.status}
                  </span>
                </div>
                <div className="account-balance-grid">
                  {[
                    { label: primaryLabel, window: primary, featured: true },
                    { label: secondaryLabel, window: secondary, featured: false }
                  ].map((quota) => (
                    <div
                      className={`quota-card ${quota.featured ? "quota-card-featured" : "quota-card-secondary"} quota-card-tone-${quotaTone(quota.window)}`}
                      key={`${account.id}-${quota.label}`}
                    >
                      <div className="quota-head">
                        <span>{quota.label}</span>
                        <strong>{formatQuotaLeft(quota.window)}</strong>
                      </div>
                      <div className="quota-meter" aria-hidden="true">
                        <span style={{ width: `${remainingPercent(quota.window)}%` }} />
                      </div>
                      <div className="quota-meta">
                        <small>Reset {quota.window ? formatResetAt(quota.window.resetsAt) : "-"}</small>
                        <small>{quota.window ? `${quota.window.usedPercent.toFixed(1)}% used` : "no data"}</small>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="account-meta">
                  <span>{account.planType ?? "No plan tag"}</span>
                  <span>{account.authType ?? "Auth type unknown"}</span>
                </div>
                {account.lastError ? <p className="error-text">{account.lastError}</p> : null}
                <div className="action-row account-actions">
                  <button
                    className="account-action-button"
                    disabled={busy === `refresh-${account.id}`}
                    onClick={() => void refreshAccount(account.id)}
                  >
                    {busy === `refresh-${account.id}` ? "Refreshing..." : "Refresh"}
                  </button>
                  <button
                    className="secondary-button account-action-button account-action-button-secondary"
                    disabled={busy === `restart-${account.id}`}
                    onClick={() => void restartAccount(account.id)}
                  >
                    {busy === `restart-${account.id}` ? "Restarting..." : "Restart"}
                  </button>
                </div>
              </article>
            );
          })}
          {!isInitialLoading ? (
            <article className={`card account-card add-card ${showImportCard ? "add-card-open" : ""}`}>
              {!showImportCard ? (
                <button className="add-card-button" onClick={() => setShowImportCard(true)} type="button">
                  <span className="add-card-plus">+</span>
                  <span>Add account</span>
                  <small>Import auth.json</small>
                </button>
              ) : (
                <form className="stack import-stack" onSubmit={handleImportAccount}>
                  <div className="card-head">
                    <div>
                      <h3>Import account</h3>
                      <p>Use a local auth cache</p>
                    </div>
                    <button
                      className="ghost-button"
                      onClick={() => {
                        setShowImportCard(false);
                        setAuthName("");
                        setAuthFile(null);
                      }}
                      type="button"
                    >
                      Close
                    </button>
                  </div>
                  <input
                    placeholder="Account name"
                    value={authName}
                    onChange={(event) => setAuthName(event.target.value)}
                  />
                  <input
                    type="file"
                    accept="application/json"
                    onChange={(event) => setAuthFile(event.target.files?.[0] ?? null)}
                  />
                  <button disabled={busy === "import-account"} type="submit">
                    {busy === "import-account" ? "Importing..." : "Import auth.json"}
                  </button>
                </form>
              )}
            </article>
          ) : null}
        </div>
      </section>

      <main className="grid">
        <section className="panel log-panel">
          <div className="section-heading">
            <div className="section-heading-copy">
              <p className="section-label">Execution stream</p>
              <h2>Job stream log</h2>
              <p className="section-copy">Raw event stream for the selected job.</p>
            </div>
            <div className="panel-head-meta">
              <span className="pill pill-muted">{selectedJob ? selectedAccountLabel : "No account selected"}</span>
              <span className="pill pill-muted">{latestJob ? latestJob.id.slice(0, 8) : "No jobs yet"}</span>
            </div>
          </div>
          {isInitialLoading ? (
            <div className="stack">
              <div className="skeleton-line skeleton-line-title" />
              <div className="skeleton-line skeleton-line-wide" />
              <div className="terminal-log skeleton-terminal" />
            </div>
          ) : selectedJob ? (
            <div className="stream">
              <div className="stream-summary-grid">
                <article className={`stream-summary-card tone-${normalizeClassName(selectedJob.status)}`}>
                  <span>Status</span>
                  <strong>{selectedJob.status}</strong>
                  <p>{selectedJob.model}</p>
                </article>
                <article className="stream-summary-card">
                  <span>Context</span>
                  <strong>{selectedAccountLabel}</strong>
                  <p>{selectedWorkspaceLabel}</p>
                </article>
                <article className="stream-summary-card">
                  <span>Usage</span>
                  <strong>
                    {selectedJob.inputTokens !== null || selectedJob.outputTokens !== null
                      ? `${selectedJob.inputTokens ?? 0} / ${selectedJob.outputTokens ?? 0}`
                      : "-"}
                  </strong>
                  <p>
                    Cached {selectedJob.cachedInputTokens ?? "-"} · Reasoning {selectedJob.reasoningOutputTokens ?? "-"}
                  </p>
                </article>
                <article className="stream-summary-card">
                  <span>Timeline</span>
                  <strong>{formatDateTime(selectedJob.startedAt ?? selectedJob.createdAt)}</strong>
                  <p>{selectedJob.finishedAt ? `Finished ${formatDateTime(selectedJob.finishedAt)}` : "Awaiting completion"}</p>
                </article>
              </div>
              {selectedJob.errorMessage ? <p className="error-text">{selectedJob.errorMessage}</p> : null}
              {streamEntries.length > 0 ? (
                <div className="terminal-log">
                  {streamEntries.map((entry) => (
                    <details className={`terminal-entry terminal-${entry.tone}`} key={entry.id}>
                      <summary className="terminal-line">
                        <span className="terminal-time">
                          [{new Date(entry.createdAt).toLocaleTimeString([], { hour12: false })}]
                        </span>
                        <span className={`terminal-level terminal-level-${entry.tone}`}>
                          {streamLevel(entry)}:
                        </span>
                        <span className="terminal-text">{streamLine(entry)}</span>
                      </summary>
                      <div className="terminal-detail">
                        {entry.body ? <pre className="terminal-body">{entry.body}</pre> : null}
                        <div className="stream-raw">
                          <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
                        </div>
                      </div>
                    </details>
                  ))}
                </div>
              ) : (
                <div className="empty-state">
                  <p className="empty-title">Waiting for stream events</p>
                  <p className="empty-copy">
                    The stream will populate as soon as the backend emits activity for the selected job.
                  </p>
                </div>
              )}
            </div>
          ) : (
            <div className="empty-state">
              <p className="empty-title">No job selected</p>
              <p className="empty-copy">Choose a recent job on the right to inspect its live event stream.</p>
            </div>
          )}
        </section>

        <section className="panel workspace-panel">
          <div className="section-heading">
            <div>
              <p className="section-label">Allowed paths</p>
              <h2>Workspaces</h2>
              <p className="section-copy">Approved project roots for job execution.</p>
            </div>
            <div className="panel-head-meta">
              <span className="pill pill-muted">{readyWorkspaceCount} enabled</span>
              <button
                className="ghost-button compact-button"
                onClick={() => setShowWorkspaceForm((current) => !current)}
                type="button"
              >
                {showWorkspaceForm ? "Close" : "Add path"}
              </button>
            </div>
          </div>
          {showWorkspaceForm ? (
            <form className="stack compact-stack" onSubmit={handleAddWorkspace}>
              <input
                placeholder="Workspace name"
                value={workspaceName}
                onChange={(event) => setWorkspaceName(event.target.value)}
              />
              <input
                placeholder="/absolute/path/to/project"
                value={workspacePath}
                onChange={(event) => setWorkspacePath(event.target.value)}
              />
              <button disabled={busy === "add-workspace"} type="submit">
                {busy === "add-workspace" ? "Saving..." : "Save path"}
              </button>
            </form>
          ) : null}
          <div className="workspace-grid">
            {isInitialLoading
              ? Array.from({ length: 3 }, (_, index) => (
                  <article className="workspace-tile workspace-skeleton" key={`workspace-skeleton-${index}`}>
                    <span className="workspace-icon skeleton-block" aria-hidden="true" />
                    <span className="workspace-copy">
                      <span className="skeleton-line skeleton-line-title" />
                      <span className="skeleton-line" />
                    </span>
                  </article>
                ))
              : null}
            {!isInitialLoading && workspaces.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">No workspace paths yet</p>
                <p className="empty-copy">
                  Register an absolute project path so the runtime has an approved execution target.
                </p>
              </div>
            ) : null}
            {workspaces.map((workspace) => (
              <button
                className={`workspace-tile ${workspacePath === workspace.path ? "workspace-tile-selected" : ""}`}
                key={workspace.id}
                onClick={() => {
                  setWorkspacePath(workspace.path);
                  setShowWorkspaceForm(true);
                }}
                type="button"
              >
                <span className="workspace-icon" aria-hidden="true">
                  {workspaceMonogram(workspace.name)}
                </span>
                <span className="workspace-copy">
                  <strong>{workspace.name}</strong>
                  <small>{workspace.path}</small>
                  <em>{workspace.enabled ? "Path ready" : "Disabled"}</em>
                </span>
              </button>
            ))}
          </div>
        </section>

        <section className="panel jobs-panel">
          <div className="section-heading">
            <div>
              <p className="section-label">Recent activity</p>
              <h2>Recent jobs</h2>
            </div>
            <span className="pill">Live updating</span>
          </div>
          <div className="table-list">
            {isInitialLoading
              ? Array.from({ length: 5 }, (_, index) => (
                  <div className="row row-skeleton" key={`job-skeleton-${index}`}>
                    <div className="grow">
                      <div className="skeleton-line skeleton-line-title" />
                      <div className="skeleton-line skeleton-line-wide" />
                    </div>
                  </div>
                ))
              : null}
            {!isInitialLoading && jobs.length === 0 ? (
              <div className="empty-state">
                <p className="empty-title">No jobs recorded</p>
                <p className="empty-copy">Once work is dispatched, the queue and stream history will appear here.</p>
              </div>
            ) : null}
            {jobs.map((job) => (
              <div
                className={`row row-interactive row-${normalizeClassName(job.status)} ${selectedJobId === job.id ? "row-selected" : ""}`}
                key={job.id}
                onClick={() => setSelectedJobId(job.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setSelectedJobId(job.id);
                  }
                }}
                role="button"
                tabIndex={0}
              >
                <div className="row-button grow">
                  <span className="row-primary">
                    <strong>{job.id.slice(0, 8)}</strong>
                    <span className={`status status-${normalizeClassName(job.status)}`}>{job.status}</span>
                  </span>
                  <small>{job.model}</small>
                  <small>
                    {accountNameById.get(job.accountId ?? "") ?? job.accountId ?? "-"} ·{" "}
                    {workspaceNameById.get(job.workspaceId) ?? job.workspaceId}
                  </small>
                  <small>{formatDateTime(job.startedAt ?? job.createdAt)}</small>
                </div>
                {(job.status === "queued" || job.status === "running") && (
                  <button
                    className="secondary-button compact-button"
                    onClick={(event) => {
                      event.stopPropagation();
                      void cancelJob(job.id);
                    }}
                    type="button"
                  >
                    Cancel
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>
      </main>
    </div>
  );
}
