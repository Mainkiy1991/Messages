import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadServerEnv } from "./env.js";

try {
  await loadServerEnv();
  const config = loadConfig();
  const app = await buildApp({ databaseUrl: config.DATABASE_URL });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  process.exitCode = 1;
}
