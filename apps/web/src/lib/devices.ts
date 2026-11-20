import { decryptDeviceLabel } from "@messages/crypto";

export type DeviceInfo = {
  deviceId: string;
  browser: string;
  os: string;
  labelKnown: boolean;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

export type DeviceRow = {
  deviceId: string;
  labelCiphertext: string;
  createdAt: string;
  lastSeenAt: string;
  current: boolean;
};

export function decryptDevices(
  rows: readonly DeviceRow[],
  historyKey: Uint8Array,
): DeviceInfo[] {
  return rows.map((row) => {
    try {
      const label = decryptDeviceLabel({
        historyKey,
        deviceId: row.deviceId,
        blob: row.labelCiphertext,
      });
      return {
        deviceId: row.deviceId,
        browser: String(label.browser).slice(0, 32),
        os: String(label.os).slice(0, 32),
        labelKnown: true,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        current: row.current === true,
      };
    } catch {
      return {
        deviceId: row.deviceId,
        browser: "",
        os: "",
        labelKnown: false,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
        current: row.current === true,
      };
    }
  });
}
