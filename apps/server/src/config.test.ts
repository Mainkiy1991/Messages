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
  it("removes a trailing slash from an allowed origin", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ALLOWED_ORIGINS: "https://site.onrender.com/",
      }).ALLOWED_ORIGINS,
    ).toEqual(["https://site.onrender.com"]);
  });
  it("trims whitespace and newlines around comma-separated origins", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ALLOWED_ORIGINS:
          "  https://site.onrender.com/ ,\n  https://preview.example  ",
      }).ALLOWED_ORIGINS,
    ).toEqual(["https://site.onrender.com", "https://preview.example"]);
  });
  it("rejects paths, queries, and hashes without exposing the input", () => {
    for (const value of [
      "https://site.onrender.com/app",
      "https://site.onrender.com/.",
      "https://site.onrender.com?x=1",
      "https://site.onrender.com#section",
    ]) {
      let message = "";
      try {
        loadConfig({ DATABASE_URL: databaseUrl, ALLOWED_ORIGINS: value });
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message).toContain(
        "ALLOWED_ORIGINS must contain origins like https://example.com",
      );
      expect(message).not.toContain(value);
    }
  });
  it.each(["site.onrender.com", "ftp://site.onrender.com"])(
    "rejects an origin with an unsupported or missing scheme: %s",
    (value) => {
      expect(() =>
        loadConfig({ DATABASE_URL: databaseUrl, ALLOWED_ORIGINS: value }),
      ).toThrow(
        "ALLOWED_ORIGINS must contain origins like https://example.com",
      );
    },
  );
  it("removes duplicate origins after normalization", () => {
    expect(
      loadConfig({
        DATABASE_URL: databaseUrl,
        ALLOWED_ORIGINS:
          "https://site.onrender.com/, https://SITE.onrender.com",
      }).ALLOWED_ORIGINS,
    ).toEqual(["https://site.onrender.com"]);
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
