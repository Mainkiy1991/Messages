import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
export default async function globalSetup(): Promise<void> {
  const databaseUrl = process.env.E2E_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "E2E_DATABASE_URL must point to a dedicated, empty PostgreSQL database.",
    );
  }

  const root = resolve(import.meta.dirname, "../../..");
  const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
  const env = {
    ...process.env,
    DATABASE_URL: databaseUrl,
    VITE_API_URL: "http://localhost:3000",
  };
  for (const args of [
    ["--filter", "@messages/crypto", "build"],
    ["--filter", "@messages/server", "build"],
    ["--filter", "@messages/web", "build"],
    ["--filter", "@messages/server", "migrate"],
  ]) {
    execFileSync(pnpm, args, { cwd: root, env, stdio: "inherit" });
  }
}
