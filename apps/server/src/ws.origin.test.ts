import Fastify from "fastify";
import type { Pool } from "pg";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { registerWebSocket } from "./ws.js";

const apps: Array<ReturnType<typeof Fastify>> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function listen(pool: Pool = {} as Pool) {
  const app = Fastify({ logger: false });
  apps.push(app);
  await registerWebSocket(app, pool, {
    origins: ["https://site.example"],
  });
  const address = await app.listen({ port: 0, host: "127.0.0.1" });
  return `${address.replace(/^http/u, "ws")}/ws`;
}

function connect(url: string, origin?: string) {
  return new WebSocket(url, origin ? { origin } : undefined);
}

describe("WebSocket Origin policy", () => {
  it("closes ping floods with code 4429 before and after authentication", async () => {
    const pool = {
      async query(sql: string) {
        if (sql.includes("SELECT user_id FROM sessions"))
          return { rows: [{ user_id: "a".repeat(64) }], rowCount: 1 };
        if (sql.includes("RETURNING last_seen_at"))
          return { rows: [{ last_seen_at: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const url = await listen(pool);
    const authenticated = connect(url);
    await new Promise<void>((resolve, reject) => {
      authenticated.once("open", resolve);
      authenticated.once("error", reject);
    });
    authenticated.send(JSON.stringify({ type: "auth", token: "b".repeat(43) }));
    await new Promise<void>((resolve, reject) => {
      const onMessage = (data: WebSocket.RawData) => {
        if (
          (JSON.parse(data.toString()) as { type?: string }).type !== "auth_ok"
        )
          return;
        authenticated.off("message", onMessage);
        resolve();
      };
      authenticated.on("message", onMessage);
      authenticated.once("error", reject);
    });
    const authenticatedClose = new Promise<number>((resolve) =>
      authenticated.once("close", (code) => resolve(code)),
    );
    for (let i = 0; i < 121; i++)
      authenticated.send(JSON.stringify({ type: "ping" }));
    await expect(authenticatedClose).resolves.toBe(4429);

    const unauthenticated = connect(url);
    await new Promise<void>((resolve, reject) => {
      unauthenticated.once("open", resolve);
      unauthenticated.once("error", reject);
    });
    const unauthenticatedClose = new Promise<number>((resolve) =>
      unauthenticated.once("close", (code) => resolve(code)),
    );
    for (let i = 0; i < 121; i++)
      unauthenticated.send(JSON.stringify({ type: "ping" }));
    await expect(unauthenticatedClose).resolves.toBe(4429);
  });

  it("answers authenticated pings once per four seconds without database writes", async () => {
    const queries: string[] = [];
    const pool = {
      async query(sql: string) {
        queries.push(sql);
        if (sql.includes("SELECT user_id FROM sessions"))
          return { rows: [{ user_id: "a".repeat(64) }], rowCount: 1 };
        if (sql.includes("RETURNING last_seen_at"))
          return { rows: [{ last_seen_at: new Date() }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const socket = connect(await listen(pool));
    const frames: unknown[] = [];
    socket.on("message", (data) => frames.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify({ type: "ping" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(frames).toEqual([]);
    socket.send(JSON.stringify({ type: "auth", token: "b".repeat(43) }));
    await waitUntil(() =>
      frames.some((frame) => (frame as { type?: string }).type === "auth_ok"),
    );
    const queryCount = queries.length;
    socket.send(JSON.stringify({ type: "ping" }));
    await waitUntil(() =>
      frames.some((frame) => (frame as { type?: string }).type === "pong"),
    );
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    socket.send(JSON.stringify({ type: "ping" }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(
      frames.filter((frame) => (frame as { type?: string }).type === "pong"),
    ).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    socket.send(JSON.stringify({ type: "ping" }));
    await waitUntil(
      () =>
        frames.filter((frame) => (frame as { type?: string }).type === "pong")
          .length === 2,
    );
    expect(queries).toHaveLength(queryCount);
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.close();
    await closed;
  }, 10_000);

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

async function waitUntil(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for WebSocket frame");
}
