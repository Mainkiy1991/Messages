import {
  DecryptError,
  decryptPinSettings,
  encryptPinSettings,
} from "@messages/crypto";
import { ApiError, type PinSettingsResponse } from "./api.js";
import { decidePinSync, type PinSyncServer } from "./pinSync.js";

export type PinSyncStatus =
  | "none"
  | "published"
  | "adopted"
  | "pin_updated"
  | "pin_disabled"
  | "deferred_outbox"
  | "skipped"
  | "offline"
  | "apply_failed"
  | "pin_too_long";
export type PinSharedReason =
  | "network"
  | "changed_elsewhere"
  | "pin_invalid"
  | "too_long"
  | "too_short"
  | "operation";
type SharedResult =
  | { ok: true; adoptedExisting?: boolean }
  | { ok: false; reason: PinSharedReason };

export type PinSyncDependencies = {
  historyKey: Uint8Array;
  userId: string;
  isPinEnabledLocally: () => Promise<boolean> | boolean;
  getSyncedVersion: () => Promise<string>;
  setSyncedVersion: (version: string) => Promise<void>;
  getBlock: () => Promise<PinSettingsResponse>;
  putBlock: (baseVersion: string, blob: string) => Promise<{ version: string }>;
  queuedCount: () => Promise<number> | number;
  verifyLocal: (pin: string) => Promise<unknown>;
  enableLocal: (pin: string) => Promise<void>;
  changeLocal: (oldPin: string, newPin: string) => Promise<void>;
  disableLocal: (oldPin: string) => Promise<void>;
  now: () => number;
};

function parseServer(
  deps: PinSyncDependencies,
  response: PinSettingsResponse,
): PinSyncServer {
  if (response.version === "0" && response.blob === null)
    return { kind: "none" };
  if (!/^\d{1,19}$/u.test(response.version) || response.blob === null)
    return { kind: "unreadable", version: response.version };
  try {
    const settings = decryptPinSettings({
      historyKey: deps.historyKey,
      userId: deps.userId,
      blob: response.blob,
    });
    return { kind: "readable", version: response.version, settings };
  } catch (error) {
    if (error instanceof DecryptError)
      return { kind: "unreadable", version: response.version };
    throw error;
  }
}

function isConflict(
  error: unknown,
): error is ApiError & { data: Record<string, unknown> } {
  return (
    error instanceof ApiError &&
    error.status === 409 &&
    error.code === "version_conflict" &&
    typeof error.data?.version === "string" &&
    (typeof error.data.blob === "string" || error.data.blob === null)
  );
}

function validPin(pin: string): PinSharedReason | null {
  const size = Array.from(pin.normalize("NFKC")).length;
  return size > 64 ? "too_long" : size < 6 ? "too_short" : null;
}

export function createPinSyncRunner(deps: PinSyncDependencies) {
  const encrypt = (enabled: boolean, pin: string) =>
    encryptPinSettings({
      historyKey: deps.historyKey,
      userId: deps.userId,
      enabled,
      pin,
      updatedAt: deps.now(),
    });

  async function runPinSync({
    pin,
  }: {
    pin: string | null;
  }): Promise<{ status: PinSyncStatus }> {
    const locallyEnabled = await deps.isPinEnabledLocally();
    if (locallyEnabled && pin === null) return { status: "skipped" };
    let response: PinSettingsResponse;
    try {
      response = await deps.getBlock();
    } catch {
      return { status: "offline" };
    }

    const decide = async (serverResponse: PinSettingsResponse) => {
      const server = parseServer(deps, serverResponse);
      const action = decidePinSync(
        { pin, syncedVersion: await deps.getSyncedVersion() },
        server,
      );
      return { action, server };
    };
    let decision: Awaited<ReturnType<typeof decide>>;
    try {
      decision = await decide(response);
    } catch {
      return { status: "none" };
    }
    let { action } = decision;
    if (action.type === "none") return { status: "none" };
    if (action.type === "publish_local") {
      if (pin === null) return { status: "none" };
      let blob: string;
      try {
        blob = encrypt(true, pin);
      } catch (error) {
        if (error instanceof TypeError) return { status: "pin_too_long" };
        return { status: "offline" };
      }
      try {
        const result = await deps.putBlock("0", blob);
        await deps.setSyncedVersion(result.version);
        return { status: "published" };
      } catch (error) {
        if (!isConflict(error)) return { status: "offline" };
        response = {
          version: error.data.version as string,
          blob: error.data.blob as string | null,
        };
        try {
          ({ action } = await decide(response));
        } catch {
          return { status: "offline" };
        }
      }
    }
    if (action.type === "publish_local") return { status: "offline" };
    try {
      if (action.type === "none") return { status: "none" };
      if (action.type === "adopt_version") {
        await deps.setSyncedVersion(action.version);
        return { status: "adopted" };
      }
      if (action.type === "enable_pin") {
        if ((await deps.queuedCount()) > 0)
          return { status: "deferred_outbox" };
        await deps.enableLocal(action.pin);
        await deps.setSyncedVersion(action.version);
        return { status: "pin_updated" };
      }
      if (action.type === "change_pin") {
        if (pin === null) return { status: "skipped" };
        await deps.changeLocal(pin, action.pin);
        await deps.setSyncedVersion(action.version);
        return { status: "pin_updated" };
      }
      await deps.disableLocal(pin ?? "");
      await deps.setSyncedVersion(action.version);
      return { status: "pin_disabled" };
    } catch {
      return { status: "apply_failed" };
    }
  }

  async function readForAction(): Promise<{
    response: PinSettingsResponse;
    server: PinSyncServer;
  }> {
    const response = await deps.getBlock();
    return { response, server: parseServer(deps, response) };
  }

  async function enableShared({ pin }: { pin: string }): Promise<SharedResult> {
    const invalid = validPin(pin);
    if (invalid) return { ok: false, reason: invalid };
    let current: Awaited<ReturnType<typeof readForAction>>;
    try {
      current = await readForAction();
    } catch {
      return { ok: false, reason: "network" };
    }
    if (current.server.kind === "unreadable")
      return { ok: false, reason: "changed_elsewhere" };
    if (current.server.kind === "readable" && current.server.settings.enabled) {
      try {
        await deps.enableLocal(current.server.settings.pin);
        await deps.setSyncedVersion(current.response.version);
        return { ok: true, adoptedExisting: true };
      } catch {
        return { ok: false, reason: "operation" };
      }
    }
    let blob: string;
    try {
      blob = encrypt(true, pin);
      const result = await deps.putBlock(current.response.version, blob);
      await deps.enableLocal(pin);
      await deps.setSyncedVersion(result.version);
      return { ok: true };
    } catch (error) {
      if (isConflict(error)) return { ok: false, reason: "changed_elsewhere" };
      if (error instanceof TypeError) return { ok: false, reason: "too_long" };
      return { ok: false, reason: "operation" };
    }
  }

  async function changeShared({
    oldPin,
    newPin,
  }: {
    oldPin: string;
    newPin: string;
  }): Promise<SharedResult> {
    const invalid = validPin(newPin);
    if (invalid) return { ok: false, reason: invalid };
    try {
      await deps.verifyLocal(oldPin);
    } catch {
      return { ok: false, reason: "pin_invalid" };
    }
    let current: Awaited<ReturnType<typeof readForAction>>;
    let synced: string;
    try {
      current = await readForAction();
      synced = await deps.getSyncedVersion();
    } catch {
      return { ok: false, reason: "network" };
    }
    if (current.server.kind === "unreadable")
      return { ok: false, reason: "changed_elsewhere" };
    if (current.response.version !== synced)
      return { ok: false, reason: "changed_elsewhere" };
    try {
      const version = await deps.putBlock(
        current.response.version,
        encrypt(true, newPin),
      );
      await deps.changeLocal(oldPin, newPin);
      await deps.setSyncedVersion(version.version);
      return { ok: true };
    } catch (error) {
      if (isConflict(error)) return { ok: false, reason: "changed_elsewhere" };
      if (error instanceof TypeError) return { ok: false, reason: "too_long" };
      return { ok: false, reason: "operation" };
    }
  }

  async function disableShared({
    oldPin,
  }: {
    oldPin: string;
  }): Promise<SharedResult> {
    try {
      await deps.verifyLocal(oldPin);
    } catch {
      return { ok: false, reason: "pin_invalid" };
    }
    let current: Awaited<ReturnType<typeof readForAction>>;
    let synced: string;
    try {
      current = await readForAction();
      synced = await deps.getSyncedVersion();
    } catch {
      return { ok: false, reason: "network" };
    }
    if (current.server.kind === "unreadable")
      return { ok: false, reason: "changed_elsewhere" };
    if (current.response.version !== synced)
      return { ok: false, reason: "changed_elsewhere" };
    try {
      const version = await deps.putBlock(
        current.response.version,
        encrypt(false, ""),
      );
      await deps.disableLocal(oldPin);
      await deps.setSyncedVersion(version.version);
      return { ok: true };
    } catch (error) {
      if (isConflict(error)) return { ok: false, reason: "changed_elsewhere" };
      return { ok: false, reason: "operation" };
    }
  }

  return { runPinSync, enableShared, changeShared, disableShared };
}
