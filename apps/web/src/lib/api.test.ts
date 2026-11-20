import "fake-indexeddb/auto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bytesToHex,
  deriveKeys,
  signKeyBinding,
  verifyAuth,
  verifyKeyBinding,
  verifyDeviceRegistration,
  decryptDeviceLabel,
  generateDeviceKeys,
  userIdFromPublicKey,
  deviceIdFromPublicKey,
} from "@messages/crypto";
import { clearSession, restoreServerSession } from "../session.js";
import {
  deleteConversation,
  deleteMessage,
  eraseConversation,
  getHistoryChangedAfter,
  getUserKeys,
  loginToServer,
  updateMessage,
  verifyUserKeys,
  registerDevice,
  deviceLogin,
  DeviceRevokedError,
} from "./api.js";
import { resolveApiUrl } from "./api.js";

describe("API server address", () => {
  it("uses the configured API URL and keeps localhost as the development default", () => {
    expect(resolveApiUrl("https://messages-server.onrender.com/")).toBe(
      "https://messages-server.onrender.com",
    );
    expect(resolveApiUrl(undefined)).toBe("http://localhost:3000");
  });
});

const keys = deriveKeys(
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about",
);

describe("server API login", () => {
  afterEach(async () => clearSession());
  it("signs the challenge and binds the encryption key", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), init });
      if (String(input).endsWith("/auth/challenge"))
        return Response.json({
          challengeId: "01".repeat(16),
          challenge: "ab".repeat(32),
          expiresAt: new Date().toISOString(),
        });
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(
        verifyAuth(
          keys.identity.publicKey,
          body.challengeId!,
          "ab".repeat(32),
          Uint8Array.from(
            body.signature!.match(/../gu)!.map((v) => Number.parseInt(v, 16)),
          ),
        ),
      ).toBe(true);
      expect(
        verifyKeyBinding(
          keys.identity.publicKey,
          keys.encryption.publicKey,
          Uint8Array.from(
            body
              .keyBindingSignature!.match(/../gu)!
              .map((v) => Number.parseInt(v, 16)),
          ),
        ),
      ).toBe(true);
      expect(body.identityPublicKey).toBe(bytesToHex(keys.identity.publicKey));
      return Response.json({
        token: "T".repeat(43),
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: bytesToHex(keys.identity.publicKey),
      });
    };
    const session = await loginToServer(keys, fetcher);
    expect(calls.map((call) => call.url)).toEqual([
      "http://localhost:3000/auth/challenge",
      "http://localhost:3000/auth/login",
    ]);
    expect(await restoreServerSession(keys)).toEqual(session);
  });

  it("registers a device with the exact request fields and verifies its signature", async () => {
    const fetcher: typeof fetch = async (input, init) => {
      if (String(input).endsWith("/auth/challenge"))
        return Response.json({
          challengeId: "01".repeat(16),
          challenge: "ab".repeat(32),
        });
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      expect(Object.keys(body).sort()).toEqual(
        [
          "challengeId",
          "identityPublicKey",
          "encryptionPublicKey",
          "keyBindingSignature",
          "devicePublicKey",
          "deviceLabel",
          "signature",
        ].sort(),
      );
      const devicePublicKey = Uint8Array.from(
        body.devicePublicKey.match(/../gu)!.map((v) => Number.parseInt(v, 16)),
      );
      const signature = Uint8Array.from(
        body.signature.match(/../gu)!.map((v) => Number.parseInt(v, 16)),
      );
      expect(
        verifyDeviceRegistration(
          keys.identity.publicKey,
          body.challengeId,
          "ab".repeat(32),
          devicePublicKey,
          signature,
        ),
      ).toBe(true);
      const deviceId = deviceIdFromPublicKey(devicePublicKey);
      expect(
        decryptDeviceLabel({
          historyKey: keys.historyKey,
          deviceId,
          blob: body.deviceLabel,
        }),
      ).toEqual({ browser: "unknown", os: "unknown" });
      return Response.json({
        token: "device-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
        deviceId,
      });
    };
    const result = await registerDevice(keys, fetcher);
    expect(result.session.deviceId).toBe(
      deviceIdFromPublicKey(result.deviceKeys.device.publicKey),
    );
  });

  it("rejects mismatched device registration response IDs", async () => {
    const fetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("/auth/challenge"))
        return Response.json({
          challengeId: "01".repeat(16),
          challenge: "ab".repeat(32),
        });
      return Response.json({
        token: "device-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: "00".repeat(32),
        deviceId: "11".repeat(32),
      });
    };
    await expect(registerDevice(keys, fetcher)).rejects.toThrow(
      "unexpected registration data",
    );
  });

  it("device login retries one 401 and converts repeated 401 and 403", async () => {
    const device = generateDeviceKeys();
    const deviceKeys = {
      identityPublicKey: keys.identity.publicKey,
      encryption: keys.encryption,
      historyKey: keys.historyKey,
      device,
    };
    let challenge = 0;
    let login = 0;
    const retryFetcher: typeof fetch = async (input) => {
      if (String(input).endsWith("/auth/challenge")) {
        challenge++;
        return Response.json({
          challengeId: String(challenge).padStart(16, "0"),
          challenge: "cd".repeat(32),
        });
      }
      login++;
      if (login === 1)
        return Response.json({ error: "invalid_credentials" }, { status: 401 });
      const deviceId = deviceIdFromPublicKey(device.publicKey);
      return Response.json({
        token: "device-token",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        userId: userIdFromPublicKey(keys.identity.publicKey),
        deviceId,
      });
    };
    await expect(deviceLogin(deviceKeys, retryFetcher)).resolves.toMatchObject({
      deviceId: deviceIdFromPublicKey(device.publicKey),
    });
    expect(challenge).toBe(2);

    const revokedFetcher: typeof fetch = async (input) =>
      String(input).endsWith("/auth/challenge")
        ? Response.json({
            challengeId: "01".repeat(16),
            challenge: "ab".repeat(32),
          })
        : Response.json({ error: "device_revoked" }, { status: 403 });
    await expect(
      deviceLogin(deviceKeys, revokedFetcher),
    ).rejects.toBeInstanceOf(DeviceRevokedError);

    const twiceUnauthorized: typeof fetch = async (input) =>
      String(input).endsWith("/auth/challenge")
        ? Response.json({
            challengeId: "01".repeat(16),
            challenge: "ab".repeat(32),
          })
        : Response.json({ error: "invalid_credentials" }, { status: 401 });
    await expect(
      deviceLogin(deviceKeys, twiceUnauthorized),
    ).rejects.toBeInstanceOf(DeviceRevokedError);

    const limited: typeof fetch = async (input) =>
      String(input).endsWith("/auth/challenge")
        ? Response.json({
            challengeId: "01".repeat(16),
            challenge: "ab".repeat(32),
          })
        : Response.json({ error: "rate_limit" }, { status: 429 });
    await expect(deviceLogin(deviceKeys, limited)).rejects.toMatchObject({
      status: 429,
    });
  });
});

describe("peer key verification", () => {
  it("refuses a key whose identity binding signature is invalid", () => {
    const peerId = bytesToHex(keys.identity.publicKey);
    const peerKeys = {
      userId: peerId,
      encryptionPublicKey: bytesToHex(keys.encryption.publicKey),
      keyBindingSignature: "00".repeat(64),
    };
    expect(() => verifyUserKeys(peerId, peerKeys)).toThrow(
      "key_binding_invalid",
    );
    expect(
      verifyUserKeys(peerId, {
        ...peerKeys,
        keyBindingSignature: bytesToHex(
          signKeyBinding(keys.identity.privateKey, keys.encryption.publicKey),
        ),
      }),
    ).toEqual(keys.encryption.publicKey);
  });
});

describe("API request timeout", () => {
  afterEach(() => vi.useRealTimers());
  it("aborts a request after ten seconds with network_timeout", async () => {
    vi.useFakeTimers();
    const fetcher: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError")),
        );
      });
    const pending = getUserKeys("0".repeat(64), "token", fetcher);
    const assertion = expect(pending).rejects.toMatchObject({
      status: 0,
      code: "network_timeout",
    });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
  });
});

describe("edit in place API", () => {
  it("sends the two ciphertexts as JSON to the row of the message", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    await updateMessage(
      "row-id",
      "cipher-text",
      "sender-copy",
      "session-token",
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(null, { status: 204 });
      },
    );
    expect(requestUrl).toBe("http://localhost:3000/messages/row-id");
    expect(requestInit?.method).toBe("PUT");
    expect(new Headers(requestInit?.headers).get("Content-Type")).toBe(
      "application/json",
    );
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer session-token",
    );
    expect(JSON.parse(String(requestInit?.body))).toEqual({
      ciphertext: "cipher-text",
      senderCopy: "sender-copy",
    });
  });

  it("reads changed rows with the changedAfter cursor and a page of one hundred", async () => {
    let requestUrl = "";
    const page = await getHistoryChangedAfter(
      "ab".repeat(32),
      "session-token",
      "42",
      async (input) => {
        requestUrl = String(input);
        return Response.json({ messages: [], hasMore: false });
      },
    );
    expect(requestUrl).toBe(
      `http://localhost:3000/history/${"ab".repeat(32)}?limit=100&changedAfter=42`,
    );
    expect(page).toEqual({ messages: [], hasMore: false });
  });
});

describe("delete own message API", () => {
  it("sends a bare DELETE to the server row without a body or Content-Type", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await deleteMessage(
      "row-id",
      "session-token",
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(null, { status: 204 });
      },
    );
    expect(requestUrl).toBe("http://localhost:3000/messages/row-id");
    expect(requestInit?.method).toBe("DELETE");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Content-Type")).toBeNull();
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    expect(requestInit?.body).toBeUndefined();
    expect(result).toBeUndefined();
  });
});

describe("delete conversation API", () => {
  it("sends an authenticated DELETE and returns the server clear boundary", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await deleteConversation(
      "ab".repeat(32),
      "session-token",
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({ clearedBeforeSeq: "100" });
      },
    );
    expect(requestUrl).toBe(
      `http://localhost:3000/conversations/${"ab".repeat(32)}`,
    );
    expect(requestInit?.method).toBe("DELETE");
    expect(new Headers(requestInit?.headers).get("Authorization")).toBe(
      "Bearer session-token",
    );
    expect(result).toEqual({ clearedBeforeSeq: "100" });
  });

  it("sends an authenticated JSON POST to erase the conversation", async () => {
    let requestUrl = "";
    let requestInit: RequestInit | undefined;
    const result = await eraseConversation(
      "ab".repeat(32),
      "session-token",
      async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return Response.json({ erased: 3, clearedBeforeSeq: "100" });
      },
    );
    expect(requestUrl).toBe(
      `http://localhost:3000/conversations/${"ab".repeat(32)}/erase`,
    );
    expect(requestInit?.method).toBe("POST");
    const headers = new Headers(requestInit?.headers);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(headers.get("Authorization")).toBe("Bearer session-token");
    expect(requestInit?.body).toBe("{}");
    expect(result).toEqual({ erased: 3, clearedBeforeSeq: "100" });
  });
});
