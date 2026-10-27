import Fastify from "fastify";
import type { Pool } from "pg";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { registerWebSocket } from "./ws.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function listen() {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerWebSocket(app, {} as Pool, {
    origins: ["https://site.example"],
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return `${address.replace(/^http/u, "ws")}/ws`;
}

function connect(url: string, origin?: string) {
  return new WebSocket(url, origin ? { origin } : undefined);
}

describe("WebSocket Origin policy", () => {
  it("accepts the configured Origin", async () => {
    const socket = connect(await listen(), "https://site.example");
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    socket.close();
    await closed;
  });

  it("rejects a foreign Origin", async () => {
    const socket = connect(await listen(), "https://evil.example");
    socket.on("error", () => undefined);
    const status = await new Promise<number>((resolve) => {
      socket.once("unexpected-response", (_request, response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
    });
    expect(status).toBe(403);
    socket.terminate();
  });

  it("allows connections without an Origin header", async () => {
    const socket = connect(await listen());
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const closed = new Promise<void>((resolve) =>
      socket.once("close", resolve),
    );
    socket.close();
    await closed;
  });
});
