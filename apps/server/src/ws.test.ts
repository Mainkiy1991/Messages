import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { getWebSocketMemoryState } from "./ws.js";

describe("WebSocket test diagnostics", () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it("does not expose connection counters in production mode", async () => {
    const app = Fastify();
    process.env.NODE_ENV = "production";
    try {
      expect(() => getWebSocketMemoryState(app)).toThrow(
        "WebSocket memory state is available in tests only",
      );
    } finally {
      await app.close();
    }
  });
});
