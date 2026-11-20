import { describe, expect, it, vi } from "vitest";
import { deriveKeys } from "@messages/crypto";
import { ApiError } from "./api.js";
import { registerDeviceWithRetry } from "./sign-in.js";

const derived = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);

describe("registerDeviceWithRetry", () => {
  it("retries network failures twice with 5-second pauses and then succeeds", async () => {
    let calls = 0;
    const sleep = vi.fn(async () => {});
    const register = vi.fn(async () => {
      calls++;
      if (calls <= 2) throw new TypeError("network");
      return {
        session: {
          token: "token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: "user",
          deviceId: "a".repeat(64),
        },
        deviceKeys: {
          identityPublicKey: derived.identity.publicKey,
          encryption: derived.encryption,
          historyKey: derived.historyKey,
          device: {
            privateKey: new Uint8Array(32),
            publicKey: new Uint8Array(32),
          },
        },
      };
    });
    await expect(
      registerDeviceWithRetry(derived, { register, sleep }),
    ).resolves.toMatchObject({ session: { token: "token" } });
    expect(register).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenNthCalledWith(1, 5_000);
    expect(sleep).toHaveBeenNthCalledWith(2, 5_000);
  });

  it("returns network after 60 seconds", async () => {
    let elapsed = 0;
    const sleep = vi.fn(async (ms: number) => {
      elapsed += ms;
    });
    const register = vi.fn(async () => {
      throw new ApiError(0, "network_timeout");
    });
    await expect(
      registerDeviceWithRetry(derived, {
        register,
        sleep,
        now: () => elapsed,
      }),
    ).rejects.toMatchObject({ kind: "network" });
  });

  it("does not retry 429", async () => {
    const sleep = vi.fn(async () => {});
    const register = vi.fn(async () => {
      throw new ApiError(429, "rate_limit");
    });
    await expect(
      registerDeviceWithRetry(derived, { register, sleep }),
    ).rejects.toMatchObject({ kind: "other" });
    expect(register).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries 401 once immediately and succeeds", async () => {
    let calls = 0;
    const register = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new ApiError(401, "invalid_credentials");
      return {
        session: {
          token: "token",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          userId: "user",
          deviceId: "b".repeat(64),
        },
        deviceKeys: {
          identityPublicKey: derived.identity.publicKey,
          encryption: derived.encryption,
          historyKey: derived.historyKey,
          device: {
            privateKey: new Uint8Array(32),
            publicKey: new Uint8Array(32),
          },
        },
      };
    });
    await expect(
      registerDeviceWithRetry(derived, {
        register,
        sleep: vi.fn(async () => {}),
      }),
    ).resolves.toBeDefined();
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("returns other for 401 twice", async () => {
    const register = vi.fn(async () => {
      throw new ApiError(401, "invalid_credentials");
    });
    await expect(
      registerDeviceWithRetry(derived, { register }),
    ).rejects.toMatchObject({ kind: "other" });
    expect(register).toHaveBeenCalledTimes(2);
  });

  it("does not retry a non-retryable error", async () => {
    const register = vi.fn(async () => {
      throw new ApiError(400, "bad_request");
    });
    await expect(
      registerDeviceWithRetry(derived, { register }),
    ).rejects.toMatchObject({ kind: "other" });
    expect(register).toHaveBeenCalledTimes(1);
  });
});
