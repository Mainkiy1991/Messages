import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const databaseUrl = "postgresql://user:password@localhost/messages";

describe("loadConfig", () => {
  it("binds to localhost by default", () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl }).HOST).toBe("127.0.0.1");
  });

  it("uses an explicitly configured host", () => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, HOST: "0.0.0.0" }).HOST,
    ).toBe("0.0.0.0");
  });
});
