import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

export async function loadServerEnv(path = envPath): Promise<void> {
  try {
    await access(path);
  } catch {
    return;
  }
  loadEnvFile(path);
}
