import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";

try {
  const config = loadConfig();
  const app = await buildApp({ databaseUrl: config.DATABASE_URL });
  await app.listen({ port: config.PORT, host: "0.0.0.0" });
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  process.exitCode = 1;
}
