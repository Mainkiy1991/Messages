import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadServerEnv } from "./env.js";

const keys = ["MESSAGES_ENV_TEST_FILE", "MESSAGES_ENV_TEST_EXISTING"];

afterEach(() => {
  for (const key of keys) delete process.env[key];
});

describe("loadServerEnv", () => {
  it("loads a .env file without overwriting existing environment variables", async () => {
    const directory = await mkdtemp(join(tmpdir(), "messages-env-"));
    const file = join(directory, ".env");
    try {
      await writeFile(
        file,
        "MESSAGES_ENV_TEST_FILE=from-file\nMESSAGES_ENV_TEST_EXISTING=file-value\n",
      );
      process.env.MESSAGES_ENV_TEST_EXISTING = "from-environment";
      await loadServerEnv(file);
      expect(process.env.MESSAGES_ENV_TEST_FILE).toBe("from-file");
      expect(process.env.MESSAGES_ENV_TEST_EXISTING).toBe("from-environment");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
