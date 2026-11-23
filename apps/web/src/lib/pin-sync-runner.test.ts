import { describe, expect, it, vi } from "vitest";
import { encryptPinSettings } from "@messages/crypto";
import { ApiError, type PinSettingsResponse } from "./api.js";
import {
  createPinSyncRunner,
  type PinSyncDependencies,
} from "./pin-sync-runner.js";

const historyKey = new Uint8Array(32).fill(7);
const userId = "ab".repeat(32);
const block = (enabled: boolean, pin: string) =>
  encryptPinSettings({ historyKey, userId, enabled, pin, updatedAt: 1 });

function fixture(overrides: Partial<PinSyncDependencies> = {}) {
  let current: PinSettingsResponse = { version: "0", blob: null };
  let synced = "0";
  let localEnabled = false;
  let localPin = "local11";
  const putBlock = vi.fn(async (baseVersion: string, blob: string) => {
    if (baseVersion !== current.version)
      throw new ApiError(409, "version_conflict", current);
    current = { version: String(Number(current.version) + 1), blob };
    return { version: current.version };
  });
  const deps: PinSyncDependencies = {
    historyKey,
    userId,
    isPinEnabledLocally: () => localEnabled,
    getSyncedVersion: async () => synced,
    setSyncedVersion: async (value) => {
      synced = value;
    },
    getBlock: async () => current,
    putBlock,
    queuedCount: () => 0,
    verifyLocal: async (pin) => {
      if (pin !== localPin) throw Error("PIN_INVALID");
    },
    enableLocal: async (pin) => {
      localEnabled = true;
      localPin = pin;
    },
    changeLocal: async (_old, next) => {
      localPin = next;
    },
    disableLocal: async () => {
      localEnabled = false;
      localPin = "";
    },
    now: () => 1,
    ...overrides,
  };
  return {
    runner: createPinSyncRunner(deps),
    deps,
    putBlock,
    setBlock: (response: PinSettingsResponse) => {
      current = response;
    },
    setLocal: (enabled: boolean, pin: string) => {
      localEnabled = enabled;
      localPin = pin;
    },
    getLocal: () => ({ enabled: localEnabled, pin: localPin }),
    getSynced: () => synced,
  };
}

describe("pin sync runner", () => {
  it("skips a missing ephemeral PIN when local PIN is enabled", async () => {
    const f = fixture({ isPinEnabledLocally: () => true });
    await expect(f.runner.runPinSync({ pin: null })).resolves.toEqual({
      status: "skipped",
    });
  });
  it("returns offline without mutation when reading fails", async () => {
    const f = fixture({
      getBlock: async () => {
        throw Error("offline");
      },
    });
    await expect(f.runner.runPinSync({ pin: null })).resolves.toEqual({
      status: "offline",
    });
    expect(f.getSynced()).toBe("0");
  });
  it("publishes a local PIN when the server has no block", async () => {
    const f = fixture();
    await expect(f.runner.runPinSync({ pin: "secret1" })).resolves.toEqual({
      status: "published",
    });
    expect(f.getSynced()).toBe("1");
  });
  it("redecides once from a 409 response", async () => {
    const remote = block(true, "remote1");
    const f = fixture({
      getBlock: async () => ({ version: "0", blob: null }),
      putBlock: vi.fn(async () => {
        throw new ApiError(409, "version_conflict", {
          version: "1",
          blob: remote,
        });
      }),
    });
    const result = await f.runner.runPinSync({ pin: "local11" });
    expect(result).toEqual({ status: "pin_updated" });
    expect(f.getSynced()).toBe("1");
  });
  it("rejects a legacy PIN over the shared PIN limit", async () => {
    const f = fixture();
    expect(await f.runner.runPinSync({ pin: "x".repeat(65) })).toEqual({
      status: "pin_too_long",
    });
  });
  it("applies a server PIN before recording its version", async () => {
    const calls: string[] = [];
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
      enableLocal: async () => {
        calls.push("apply");
      },
      setSyncedVersion: async () => {
        calls.push("version");
      },
    });
    expect(await f.runner.runPinSync({ pin: null })).toEqual({
      status: "pin_updated",
    });
    expect(calls).toEqual(["apply", "version"]);
  });
  it("defers enable when queued messages exist", async () => {
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
      queuedCount: () => 2,
    });
    expect(await f.runner.runPinSync({ pin: null })).toEqual({
      status: "deferred_outbox",
    });
    expect(f.getSynced()).toBe("0");
  });
  it("changes and disables the local PIN from readable server state", async () => {
    const changed = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
    });
    changed.setLocal(true, "local11");
    expect(await changed.runner.runPinSync({ pin: "local11" })).toEqual({
      status: "pin_updated",
    });
    expect(changed.getLocal().pin).toBe("remote1");
    const disabled = fixture({
      getBlock: async () => ({ version: "1", blob: block(false, "") }),
    });
    disabled.setLocal(true, "local11");
    expect(await disabled.runner.runPinSync({ pin: "local11" })).toEqual({
      status: "pin_disabled",
    });
    expect(disabled.getLocal().enabled).toBe(false);
  });
  it("adopts version for matching PIN and ignores unreadable rollback", async () => {
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "local11") }),
    });
    f.setLocal(true, "local11");
    expect(await f.runner.runPinSync({ pin: "local11" })).toEqual({
      status: "adopted",
    });
    const old = fixture({
      getBlock: async () => ({ version: "1", blob: "invalid" }),
    });
    await old.runner.runPinSync({ pin: null });
    expect(old.getSynced()).toBe("0");
  });
  it("does not record a version after local apply fails", async () => {
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
      enableLocal: async () => {
        throw Error("apply");
      },
    });
    expect(await f.runner.runPinSync({ pin: null })).toEqual({
      status: "apply_failed",
    });
    expect(f.getSynced()).toBe("0");
  });
  it("does not write a version after an older server version rollback", async () => {
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
      getSyncedVersion: async () => "2",
    });
    expect(await f.runner.runPinSync({ pin: null })).toEqual({
      status: "none",
    });
    expect(f.getSynced()).toBe("0");
  });
  it("adopts an already shared PIN instead of the entered PIN", async () => {
    const f = fixture({
      getBlock: async () => ({ version: "1", blob: block(true, "remote1") }),
    });
    expect(await f.runner.enableShared({ pin: "entered1" })).toEqual({
      ok: true,
      adoptedExisting: true,
    });
    expect(f.getLocal().pin).toBe("remote1");
  });
  it("writes server state before locally enabling PIN", async () => {
    const f = fixture();
    expect(await f.runner.enableShared({ pin: "local11" })).toEqual({
      ok: true,
    });
    expect(f.putBlock).toHaveBeenCalledOnce();
    expect(f.getLocal()).toEqual({ enabled: true, pin: "local11" });
  });
  it("reports local enable failure after the server write as an operation error", async () => {
    const f = fixture({
      enableLocal: async () => {
        throw Error("local storage failed");
      },
    });
    expect(await f.runner.enableShared({ pin: "local11" })).toEqual({
      ok: false,
      reason: "operation",
    });
    expect(f.putBlock).toHaveBeenCalledOnce();
    expect(f.getSynced()).toBe("0");
  });
  it("checks current PIN before contacting server for a change", async () => {
    const f = fixture({
      verifyLocal: async () => {
        throw Error("PIN_INVALID");
      },
    });
    expect(
      await f.runner.changeShared({ oldPin: "bad", newPin: "next111" }),
    ).toEqual({ ok: false, reason: "pin_invalid" });
    expect(f.putBlock).not.toHaveBeenCalled();
  });
  it("returns changed elsewhere for a version mismatch and write conflict", async () => {
    const mismatch = fixture({
      getBlock: async () => ({ version: "2", blob: null }),
    });
    expect(
      await mismatch.runner.changeShared({
        oldPin: "local11",
        newPin: "next111",
      }),
    ).toEqual({ ok: false, reason: "changed_elsewhere" });
    expect(mismatch.putBlock).not.toHaveBeenCalled();
    const conflict = fixture({
      putBlock: async () => {
        throw new ApiError(409, "version_conflict", {
          version: "1",
          blob: block(true, "remote1"),
        });
      },
    });
    expect(
      await conflict.runner.changeShared({
        oldPin: "local11",
        newPin: "next111",
      }),
    ).toEqual({ ok: false, reason: "changed_elsewhere" });
  });
  it("writes an explicit disabled block when disabling from an empty server", async () => {
    const f = fixture();
    f.setLocal(true, "local11");
    expect(await f.runner.disableShared({ oldPin: "local11" })).toEqual({
      ok: true,
    });
    expect(f.putBlock).toHaveBeenCalledOnce();
    expect(f.getLocal().enabled).toBe(false);
  });
  it("records change and disable versions after local application", async () => {
    const changeOrder: string[] = [];
    const changed = fixture({
      changeLocal: async () => {
        changeOrder.push("local");
      },
      setSyncedVersion: async () => {
        changeOrder.push("version");
      },
    });
    expect(
      await changed.runner.changeShared({
        oldPin: "local11",
        newPin: "newPIN11",
      }),
    ).toEqual({ ok: true });
    expect(changeOrder).toEqual(["local", "version"]);

    const disableOrder: string[] = [];
    const disabled = fixture({
      disableLocal: async () => {
        disableOrder.push("local");
      },
      setSyncedVersion: async () => {
        disableOrder.push("version");
      },
    });
    expect(await disabled.runner.disableShared({ oldPin: "local11" })).toEqual({
      ok: true,
    });
    expect(disableOrder).toEqual(["local", "version"]);
  });
  it("validates new PIN length before network access", async () => {
    const getBlock = vi.fn(async () => ({ version: "0", blob: null }));
    const f = fixture({ getBlock });
    expect(await f.runner.enableShared({ pin: "short" })).toEqual({
      ok: false,
      reason: "too_short",
    });
    expect(
      await f.runner.changeShared({
        oldPin: "local11",
        newPin: "x".repeat(65),
      }),
    ).toEqual({ ok: false, reason: "too_long" });
    expect(getBlock).not.toHaveBeenCalled();
  });
  it("returns network for unavailable server on all user actions", async () => {
    const f = fixture({
      getBlock: async () => {
        throw Error("offline");
      },
    });
    expect(await f.runner.enableShared({ pin: "local11" })).toEqual({
      ok: false,
      reason: "network",
    });
    expect(
      await f.runner.changeShared({ oldPin: "local11", newPin: "next111" }),
    ).toEqual({ ok: false, reason: "network" });
    expect(await f.runner.disableShared({ oldPin: "local11" })).toEqual({
      ok: false,
      reason: "network",
    });
  });
  it("does not log request or PIN data", async () => {
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
    ];
    const f = fixture();
    await f.runner.enableShared({ pin: "secret1" });
    for (const log of logs) {
      expect(log).not.toHaveBeenCalled();
      log.mockRestore();
    }
  });
});
