import {
  bytesToHex,
  deriveKeys,
  generateMnemonic,
  signAuth,
  signKeyBinding,
} from "@messages/crypto";

const baseUrl = process.env.SMOKE_URL ?? "http://localhost:3000";
let step = "mnemonic and keys";

function pass(name: string): void {
  console.log(`PASS ${name}`);
}

async function expectStatus(
  response: Response,
  expected: number,
  name: string,
): Promise<void> {
  if (response.status !== expected) {
    throw new Error(`${name} returned status ${response.status}`);
  }
  pass(name);
}

try {
  const keys = deriveKeys(generateMnemonic(12));
  const identityPublicKey = bytesToHex(keys.identity.publicKey);
  const encryptionPublicKey = bytesToHex(keys.encryption.publicKey);

  step = "challenge";
  const challengeResponse = await fetch(new URL("/auth/challenge", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  await expectStatus(challengeResponse, 200, step);
  const challenge = (await challengeResponse.json()) as {
    challengeId: string;
    challenge: string;
  };

  step = "login";
  const loginResponse = await fetch(new URL("/auth/login", baseUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      challengeId: challenge.challengeId,
      identityPublicKey,
      encryptionPublicKey,
      keyBindingSignature: bytesToHex(
        signKeyBinding(keys.identity.privateKey, keys.encryption.publicKey),
      ),
      signature: bytesToHex(
        signAuth(
          keys.identity.privateKey,
          challenge.challengeId,
          challenge.challenge,
        ),
      ),
    }),
  });
  await expectStatus(loginResponse, 200, step);
  const login = (await loginResponse.json()) as {
    token: string;
    userId: string;
  };

  step = "/me";
  const meResponse = await fetch(new URL("/me", baseUrl), {
    headers: { authorization: `Bearer ${login.token}` },
  });
  await expectStatus(meResponse, 200, step);
  const me = (await meResponse.json()) as { userId: string };
  if (me.userId !== login.userId)
    throw new Error("/me user does not match login");

  step = "/users/:userId/keys";
  const keysResponse = await fetch(
    new URL(`/users/${encodeURIComponent(login.userId)}/keys`, baseUrl),
    { headers: { authorization: `Bearer ${login.token}` } },
  );
  await expectStatus(keysResponse, 200, step);

  step = "logout";
  const logoutResponse = await fetch(new URL("/auth/logout", baseUrl), {
    method: "POST",
    headers: { authorization: `Bearer ${login.token}` },
  });
  await expectStatus(logoutResponse, 204, step);

  step = "/me after logout";
  const afterLogoutResponse = await fetch(new URL("/me", baseUrl), {
    headers: { authorization: `Bearer ${login.token}` },
  });
  await expectStatus(afterLogoutResponse, 401, step);
} catch {
  console.error(`FAIL ${step}`);
  process.exitCode = 1;
}
