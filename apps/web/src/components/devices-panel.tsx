import { useEffect, useState } from "react";
import type { ChatController, DevicesError } from "../lib/chat-controller.js";
import type { DeviceInfo } from "../lib/devices.js";
import type { Language } from "../i18n.js";
import { supportedLanguages } from "../i18n.js";

export type DevicesPanelStrings = {
  devicesTitle: string;
  devicesHint: string;
  devicesLoading: string;
  devicesCurrent: string;
  devicesUnknown: string;
  devicesUnknownLabel: string;
  devicesLastSeen: string;
  devicesCreated: string;
  devicesRevoke: string;
  devicesRevokeConfirmTitle: string;
  devicesRevokeOthers: string;
  devicesRevokeOthersConfirmTitle: string;
  devicesNotice: string;
  devicesOthersNotice: string;
  devicesLoadError: string;
  devicesRevokeError: string;
  devicesRateLimited: string;
  devicesRetry: string;
  cancel: string;
};

export function DevicesPanel({
  controller,
  language,
  strings,
}: {
  controller: Pick<
    ChatController,
    "listDevices" | "revokeDevice" | "revokeOtherDevices"
  >;
  language: Language;
  strings: DevicesPanelStrings;
}) {
  const [devices, setDevices] = useState<DeviceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [operation, setOperation] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [revokeError, setRevokeError] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [confirmOthers, setConfirmOthers] = useState(false);

  async function load() {
    setLoading(true);
    setLoadError(false);
    const result = await controller.listDevices();
    if (result.ok) setDevices(result.devices);
    else setLoadError(result.error !== "busy");
    setLoading(false);
  }

  useEffect(() => {
    void load();
  }, []);

  function formatDate(value: string): string {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return value;
    try {
      const locale =
        supportedLanguages.find((item) => item.code === language)?.locale ??
        "en-US";
      return date.toLocaleString(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      });
    } catch {
      return value;
    }
  }

  function errorText(error: DevicesError): void {
    setRateLimited(error === "rate_limited");
    setRevokeError(error !== "rate_limited" && error !== "busy");
  }

  async function revoke(id: string) {
    if (operation) return;
    setOperation(true);
    setRevokeError(false);
    setRateLimited(false);
    const result = await controller.revokeDevice(id);
    if (result.ok) {
      setConfirmId(null);
      await load();
      setNotice(strings.devicesNotice);
    } else {
      errorText(result.error);
    }
    setOperation(false);
  }

  async function revokeOthers() {
    if (operation) return;
    setOperation(true);
    setRevokeError(false);
    setRateLimited(false);
    const result = await controller.revokeOtherDevices();
    if (result.ok) {
      setConfirmOthers(false);
      await load();
      setNotice(strings.devicesOthersNotice);
    } else {
      errorText(result.error);
    }
    setOperation(false);
  }

  const hasCurrent = devices.some((device) => device.current);
  const hasOthers = devices.some((device) => !device.current);

  return (
    <div className="devices-panel">
      <p className="devices-hint">{strings.devicesHint}</p>
      {loading && <p className="devices-loading">{strings.devicesLoading}</p>}
      {loadError && (
        <div
          className="error devices-error"
          role="alert"
          data-testid="devices-error"
        >
          <span>{strings.devicesLoadError}</span>
          <button
            className="secondary"
            type="button"
            data-testid="devices-retry"
            disabled={operation}
            onClick={() => void load()}
          >
            {strings.devicesRetry}
          </button>
        </div>
      )}
      {revokeError && (
        <p className="error" role="alert" data-testid="devices-error">
          {strings.devicesRevokeError}
        </p>
      )}
      {rateLimited && (
        <p className="error" role="alert" data-testid="devices-error">
          {strings.devicesRateLimited}
        </p>
      )}
      {notice && (
        <p className="devices-notice" data-testid="devices-notice">
          {notice}
        </p>
      )}
      {!loading && !loadError && hasCurrent && hasOthers && (
        <>
          {!confirmOthers && (
            <button
              className="secondary devices-revoke-others"
              type="button"
              data-testid="devices-revoke-others"
              disabled={operation}
              onClick={() => setConfirmOthers(true)}
            >
              {strings.devicesRevokeOthers}
            </button>
          )}
          {confirmOthers && (
            <div className="devices-confirm">
              <span>{strings.devicesRevokeOthersConfirmTitle}</span>
              <div className="devices-confirm-actions">
                <button
                  className="secondary"
                  type="button"
                  data-testid="devices-revoke-others-confirm"
                  disabled={operation}
                  onClick={() => void revokeOthers()}
                >
                  {strings.devicesRevoke}
                </button>
                <button
                  className="secondary"
                  type="button"
                  data-testid="devices-revoke-others-cancel"
                  disabled={operation}
                  onClick={() => setConfirmOthers(false)}
                >
                  {strings.cancel}
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {!loading &&
        !loadError &&
        devices.map((device) => {
          const label = !device.labelKnown
            ? strings.devicesUnknownLabel
            : `${device.browser === "unknown" ? strings.devicesUnknown : device.browser} · ${
                device.os === "unknown" ? strings.devicesUnknown : device.os
              }`;
          return (
            <div
              className="device-row"
              data-testid="device-row"
              data-device-id={device.deviceId}
              key={device.deviceId}
            >
              <div className="device-label">{label}</div>
              {device.current && (
                <div className="device-current" data-testid="device-current">
                  {strings.devicesCurrent}
                </div>
              )}
              <div className="device-dates">
                <span>
                  {strings.devicesLastSeen} {formatDate(device.lastSeenAt)}
                </span>
                <span>
                  {strings.devicesCreated} {formatDate(device.createdAt)}
                </span>
              </div>
              {!device.current && confirmId !== device.deviceId && (
                <button
                  className="secondary device-revoke"
                  type="button"
                  data-testid="device-revoke"
                  disabled={operation}
                  onClick={() => setConfirmId(device.deviceId)}
                >
                  {strings.devicesRevoke}
                </button>
              )}
              {!device.current && confirmId === device.deviceId && (
                <div className="devices-confirm">
                  <span>{strings.devicesRevokeConfirmTitle}</span>
                  <div className="devices-confirm-actions">
                    <button
                      className="secondary"
                      type="button"
                      data-testid="device-revoke-confirm"
                      disabled={operation}
                      onClick={() => void revoke(device.deviceId)}
                    >
                      {strings.devicesRevoke}
                    </button>
                    <button
                      className="secondary"
                      type="button"
                      data-testid="device-revoke-cancel"
                      disabled={operation}
                      onClick={() => setConfirmId(null)}
                    >
                      {strings.cancel}
                    </button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
    </div>
  );
}
