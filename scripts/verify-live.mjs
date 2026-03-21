import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex2api-live-"));
const port = Number(process.env.CODEX2API_VERIFY_PORT ?? 3100);
const baseUrl = `http://127.0.0.1:${port}`;
const authPath = process.env.CODEX2API_AUTH_PATH ?? path.join(process.env.HOME, ".codex", "auth.json");

const server = spawn("node", ["apps/server/dist/index.js"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    CODEX2API_DATA_DIR: dataDir,
    DEFAULT_WORKSPACE_PATH: repoRoot,
    HOST: "127.0.0.1",
    PORT: String(port)
  },
  stdio: ["ignore", "pipe", "pipe"]
});

let serverLog = "";
server.stdout.on("data", (chunk) => {
  const text = chunk.toString();
  serverLog += text;
  process.stdout.write(text);
});
server.stderr.on("data", (chunk) => {
  const text = chunk.toString();
  serverLog += text;
  process.stderr.write(text);
});

async function waitForHealth() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/healthz`);
      if (response.ok) {
        return;
      }
    } catch {
      // retry
    }

    await delay(1000);
  }

  throw new Error(`server did not become healthy in time\n${serverLog}`);
}

async function waitForReadyAccount() {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/accounts`);
    const payload = await response.json();
    const account = payload.data?.[0];
    if (account?.status === "ready") {
      return account;
    }
    if (account?.status === "error") {
      throw new Error(`account entered error state: ${JSON.stringify(account)}`);
    }

    await delay(2000);
  }

  throw new Error("account did not become ready in time");
}

async function main() {
  try {
    await waitForHealth();

    const authContent = fs.readFileSync(authPath, "utf8");
    const importResponse = await fetch(`${baseUrl}/api/accounts/import-auth`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "local-live-test", content: authContent })
    });
    const importPayload = await importResponse.json();
    if (!importResponse.ok) {
      throw new Error(`import failed: ${JSON.stringify(importPayload)}`);
    }

    const account = await waitForReadyAccount();
    console.log(`READY_ACCOUNT ${account.name} ${account.email ?? "-"} ${account.planType ?? "-"}`);

    const agent = spawn("node", ["scripts/verify-api-agent.mjs"], {
      cwd: repoRoot,
      env: {
        ...process.env,
        CODEX2API_BASE_URL: baseUrl
      },
      stdio: ["ignore", "inherit", "inherit"]
    });

    const exitCode = await new Promise((resolve, reject) => {
      agent.once("error", reject);
      agent.once("exit", resolve);
    });

    if (exitCode !== 0) {
      throw new Error(`verification agent exited with code ${exitCode}`);
    }
  } finally {
    server.kill("SIGTERM");
    await delay(1000);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
