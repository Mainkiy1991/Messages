import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "../../..");
const port = 3001;
let child;

async function waitForServer() {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (
      (child?.exitCode !== null && child?.exitCode !== undefined) ||
      (child?.signalCode !== null && child?.signalCode !== undefined)
    ) {
      throw new Error(`Server exited with code ${child.exitCode}`);
    }
    try {
      const response = await globalThis.fetch("http://127.0.0.1:3000/health");
      if (response.ok) return;
    } catch {
      // The API process is still starting.
    }
    await delay(100);
  }
  throw new Error("Timed out waiting for the API server");
}

async function startServer() {
  if (child && child.exitCode === null && child.signalCode === null) return;
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) throw new Error("E2E_DATABASE_URL is required");
  child = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      HOST: "127.0.0.1",
      PORT: "3000",
      WEB_ORIGIN: "http://localhost:5173",
      TRUST_PROXY: "false",
    },
    stdio: "inherit",
  });
  await waitForServer();
}

async function stopServer() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const current = child;
  current.kill("SIGTERM");
  await Promise.race([
    new Promise((resolveExit) => current.once("exit", resolveExit)),
    delay(5000),
  ]);
  if (current.exitCode === null && current.signalCode === null)
    current.kill("SIGKILL");
}

const manager = createServer(async (request, response) => {
  try {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200).end("ok");
      return;
    }
    if (request.url === "/stop" && request.method === "POST") {
      await stopServer();
      response.writeHead(204).end();
      return;
    }
    if (request.url === "/start" && request.method === "POST") {
      await startServer();
      response.writeHead(204).end();
      return;
    }
    response.writeHead(404).end();
  } catch (error) {
    response.writeHead(500).end(String(error));
  }
});

await startServer();
manager.listen(port, "127.0.0.1");
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await stopServer();
    manager.close(() => process.exit(0));
  });
}
