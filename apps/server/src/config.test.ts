import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const databaseUrl = "postgresql://user:password@localhost/messages";

describe("loadConfig", () => {
  it("uses development defaults", () => {
    expect(loadConfig({ DATABASE_URL: databaseUrl })).toMatchObject({
      HOST: "127.0.0.1",
      PORT: 3000,
      TRUST_PROXY: false,
      ALLOWED_ORIGINS: ["http://localhost:5173"],
    });
  });
  it("uses production defaults and parses allowed origins", () => {
    expect(
      loadConfig({
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        ALLOWED_ORIGINS: "https://site.example, https://preview.example",
        TRUST_PROXY: "true",
      }),
    ).toMatchObject({
      HOST: "0.0.0.0",
      ALLOWED_ORIGINS: ["https://site.example", "https://preview.example"],
      TRUST_PROXY: true,
    });
  });
  it("accepts an explicit host", () => {
    expect(
      loadConfig({ DATABASE_URL: databaseUrl, HOST: "0.0.0.0", PORT: "8080" }),
    ).toMatchObject({ HOST: "0.0.0.0", PORT: 8080 });
  });
  it.each(["DATABASE_URL", "ALLOWED_ORIGINS"])(
    "requires %s in production without exposing values",
    (key) => {
      const env = {
        NODE_ENV: "production",
        DATABASE_URL: databaseUrl,
        ALLOWED_ORIGINS: "https://site.example",
      };
      delete env[key as keyof typeof env];
      expect(() => loadConfig(env)).toThrow(`${key} is required in production`);
      expect(() => loadConfig(env)).not.toThrow(/postgresql|site\.example/u);
    },
  );
});
