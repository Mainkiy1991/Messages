import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { loadServerEnv } from "./env.js";

try {
  await loadServerEnv();
  const config = loadConfig();
  const app = await buildApp({ databaseUrl: config.DATABASE_URL });
  await app.listen({ port: config.PORT, host: config.HOST });
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await app.close();
  };
  process.once(
    "SIGTERM",
    () =>
      void stop().catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Server shutdown failed",
        );
        process.exitCode = 1;
      }),
  );
  process.once(
    "SIGINT",
    () =>
      void stop().catch((error: unknown) => {
        console.error(
          error instanceof Error ? error.message : "Server shutdown failed",
        );
        process.exitCode = 1;
      }),
  );
  console.log(
    `Server listening. Сервер запущен: http://${config.HOST}:${config.PORT}`,
  );
} catch (error) {
  console.error(
    error instanceof Error ? error.message : "Server startup failed",
  );
  process.exitCode = 1;
}
