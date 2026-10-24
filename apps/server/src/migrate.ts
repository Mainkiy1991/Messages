import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { loadConfig } from "./config.js";
import { loadServerEnv } from "./env.js";

const { Pool } = pg;
await loadServerEnv();
const pool = new Pool({ connectionString: loadConfig().DATABASE_URL });
const directory = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "migrations",
);

try {
  await pool.query(
    "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
  );
  for (const name of (await readdir(directory))
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
    const found = await pool.query(
      "SELECT 1 FROM schema_migrations WHERE name = $1",
      [name],
    );
    if (found.rowCount) continue;
    const sql = await readFile(join(directory, name), "utf8");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations(name) VALUES ($1)", [
        name,
      ]);
      await client.query("COMMIT");
      console.log(`Applied migration ${name}`);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
} catch (error) {
  console.error(
    "Migration failed",
    error instanceof Error ? error.message : "unknown error",
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
