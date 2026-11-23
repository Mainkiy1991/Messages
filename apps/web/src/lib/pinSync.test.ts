import { describe, expect, it } from "vitest";
import {
  decidePinSync,
  type PinSyncLocal,
  type PinSyncServer,
} from "./pinSync.js";
import type { PinSettings } from "@messages/crypto";

const active: PinSettings = { enabled: true, pin: "123456", updatedAt: 10 };
const disabled: PinSettings = { enabled: false, pin: "", updatedAt: 11 };
const readable = (version: string, settings = active): PinSyncServer => ({
  kind: "readable",
  version,
  settings,
});
const unreadable = (version: string): PinSyncServer => ({
  kind: "unreadable",
  version,
});
const local = (
  pin: string | null = null,
  syncedVersion = "0",
): PinSyncLocal => ({ pin, syncedVersion });

describe("decidePinSync", () => {
  it("rule 1: treats a missing server block as rollback after a sync", () =>
    expect(decidePinSync(local("123456", "1"), { kind: "none" })).toEqual({
      type: "none",
      reason: "rollback",
    }));
  it("rule 2: publishes a local PIN when the server has no block", () =>
    expect(decidePinSync(local("123456"), { kind: "none" })).toEqual({
      type: "publish_local",
    }));
  it("rule 3: does nothing when neither side has PIN settings", () =>
    expect(decidePinSync(local(), { kind: "none" })).toEqual({
      type: "none",
      reason: "nothing_to_publish",
    }));
  it("rule 4: rejects an older server version as rollback", () =>
    expect(decidePinSync(local(null, "3"), readable("2"))).toEqual({
      type: "none",
      reason: "rollback",
    }));
  it("rule 5: reports an unreadable server block", () =>
    expect(decidePinSync(local(), unreadable("1"))).toEqual({
      type: "none",
      reason: "unreadable",
    }));
  it("rule 6: reports an equal version as up to date", () =>
    expect(decidePinSync(local("123456", "1"), readable("1"))).toEqual({
      type: "none",
      reason: "up_to_date",
    }));
  it("rule 7: adopts the version when local PIN matches", () =>
    expect(decidePinSync(local("123456"), readable("1"))).toEqual({
      type: "adopt_version",
      version: "1",
    }));
  it("rule 8: enables a missing local PIN from the server", () =>
    expect(decidePinSync(local(), readable("1"))).toEqual({
      type: "enable_pin",
      pin: "123456",
      version: "1",
      notice: "pin_updated",
    }));
  it("rule 9: changes a different local PIN to the server PIN", () =>
    expect(decidePinSync(local("654321"), readable("1"))).toEqual({
      type: "change_pin",
      pin: "123456",
      version: "1",
      notice: "pin_updated",
    }));
  it("rule 10: disables a local PIN when the server PIN is disabled", () =>
    expect(decidePinSync(local("123456"), readable("1", disabled))).toEqual({
      type: "disable_pin",
      version: "1",
      notice: "pin_disabled",
    }));
  it("rule 11: adopts a disabled version if local PIN is already off", () =>
    expect(decidePinSync(local(), readable("1", disabled))).toEqual({
      type: "adopt_version",
      version: "1",
    }));
  it("checks rollback before unreadable for an older block", () =>
    expect(decidePinSync(local(null, "3"), unreadable("2"))).toEqual({
      type: "none",
      reason: "rollback",
    }));
  it("compares versions above Number precision", () =>
    expect(
      decidePinSync(
        local("123456", "9223372036854775805"),
        readable("9223372036854775806"),
      ),
    ).toEqual({ type: "adopt_version", version: "9223372036854775806" }));
  it.each(["", "0.5", "-1", "1".repeat(20)])(
    "rejects invalid version %s",
    (version) =>
      expect(() =>
        decidePinSync(local(null, version), { kind: "none" }),
      ).toThrow(TypeError),
  );
  it("compares local PINs after NFKC normalization", () =>
    expect(decidePinSync(local("１２３４５６"), readable("1"))).toEqual({
      type: "adopt_version",
      version: "1",
    }));
  it("does not mutate frozen inputs", () => {
    const settings = Object.freeze({ ...active });
    const server = Object.freeze({
      kind: "readable" as const,
      version: "1",
      settings,
    });
    const device = Object.freeze({ pin: "123456", syncedVersion: "0" });
    expect(decidePinSync(device, server)).toEqual({
      type: "adopt_version",
      version: "1",
    });
    expect(device).toEqual({ pin: "123456", syncedVersion: "0" });
    expect(server.settings).toBe(settings);
  });
});
