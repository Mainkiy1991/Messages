import type { PinSettings } from "@messages/crypto";

export type PinSyncServer =
  | { kind: "none" }
  | { kind: "readable"; version: string; settings: PinSettings }
  | { kind: "unreadable"; version: string };

export type PinSyncLocal = { pin: string | null; syncedVersion: string };

export type PinSyncAction =
  | {
      type: "none";
      reason: "up_to_date" | "rollback" | "nothing_to_publish" | "unreadable";
    }
  | { type: "publish_local" }
  | { type: "adopt_version"; version: string }
  | { type: "enable_pin"; pin: string; version: string; notice: "pin_updated" }
  | { type: "change_pin"; pin: string; version: string; notice: "pin_updated" }
  | { type: "disable_pin"; version: string; notice: "pin_disabled" };

const VERSION_PATTERN = /^\d{1,19}$/u;

function parseVersion(version: string): bigint {
  if (typeof version !== "string" || !VERSION_PATTERN.test(version))
    throw new TypeError("Invalid PIN sync version");
  return BigInt(version);
}

export function decidePinSync(
  local: PinSyncLocal,
  server: PinSyncServer,
): PinSyncAction {
  const synced = parseVersion(local.syncedVersion);
  if (server.kind === "none") {
    if (synced > 0n) return { type: "none", reason: "rollback" };
    if (local.pin !== null) return { type: "publish_local" };
    return { type: "none", reason: "nothing_to_publish" };
  }
  const version = parseVersion(server.version);
  if (version < synced) return { type: "none", reason: "rollback" };
  if (server.kind === "unreadable")
    return { type: "none", reason: "unreadable" };
  if (version === synced) return { type: "none", reason: "up_to_date" };
  if (server.settings.enabled) {
    if (
      local.pin !== null &&
      local.pin.normalize("NFKC") === server.settings.pin
    )
      return { type: "adopt_version", version: server.version };
    if (local.pin === null)
      return {
        type: "enable_pin",
        pin: server.settings.pin,
        version: server.version,
        notice: "pin_updated",
      };
    return {
      type: "change_pin",
      pin: server.settings.pin,
      version: server.version,
      notice: "pin_updated",
    };
  }
  if (local.pin !== null)
    return {
      type: "disable_pin",
      version: server.version,
      notice: "pin_disabled",
    };
  return { type: "adopt_version", version: server.version };
}
