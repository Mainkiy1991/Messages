import "fake-indexeddb/auto";
import { afterEach, describe, expect, it } from "vitest";
import {
  bytesToHex,
  deriveKeys,
  signKeyBinding,
  verifyAuth,
  verifyKeyBinding,
} from "@messages/crypto";
import { clearSession, restoreServerSession } from "../session.js";
import { loginToServer, verifyUserKeys } from "./api.js";

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
    expect(await restoreServerSession()).toEqual(session);
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
