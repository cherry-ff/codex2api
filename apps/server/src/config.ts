import fs from "node:fs";
import path from "node:path";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type ApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";

function ensureDir(dirPath: string): string {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function readNumber(name: string, fallback: number): number {
  const value = process.env[name];
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const rootDir = process.env.CODEX2API_ROOT ?? process.cwd();
const dataDir = ensureDir(process.env.CODEX2API_DATA_DIR ?? path.join(rootDir, "data"));

export const config = {
  rootDir,
  dataDir,
  accountsDir: ensureDir(path.join(dataDir, "accounts")),
  dbPath: path.join(dataDir, "codex2api.sqlite"),
  port: readNumber("PORT", 3000),
  host: process.env.HOST ?? "127.0.0.1",
  codexBin: process.env.CODEX_BIN ?? "codex",
  adminToken: process.env.ADMIN_TOKEN ?? "",
  webOrigin: process.env.WEB_ORIGIN ?? "*",
  defaultModel: process.env.DEFAULT_MODEL ?? "gpt-5.4",
  defaultSandbox: (process.env.DEFAULT_SANDBOX as SandboxMode | undefined) ?? "workspace-write",
  defaultApprovalPolicy:
    (process.env.DEFAULT_APPROVAL_POLICY as ApprovalPolicy | undefined) ?? "never",
  serviceName: process.env.SERVICE_NAME ?? "codex2api",
  queueCapacity: readNumber("QUEUE_CAPACITY", 100),
  turnTimeoutMs: readNumber("TURN_TIMEOUT_MS", 30 * 60 * 1000),
  defaultWorkspacePath: process.env.DEFAULT_WORKSPACE_PATH ?? rootDir
};

export function writeAccountConfigFile(codexHome: string): void {
  const configTomlPath = path.join(codexHome, "config.toml");
  const content = [
    'cli_auth_credentials_store = "file"',
    "",
    "[features]",
    "experimental_api = true"
  ].join("\n");

  fs.writeFileSync(configTomlPath, content, "utf8");
}
