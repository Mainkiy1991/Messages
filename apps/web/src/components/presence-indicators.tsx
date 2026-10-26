import { formatPresence } from "../lib/presence.js";
import type { Language } from "../i18n.js";
import type { SocketState } from "../lib/websocket.js";

export type PresenceValue = {
  online: boolean;
  lastSeenAt: string | null;
};

export function PresenceDot({
  connectionState,
  presence,
  onlineLabel,
}: {
  connectionState: SocketState;
  presence?: PresenceValue;
  onlineLabel: string;
}) {
  if (connectionState !== "connected" || !presence?.online) return null;
  return (
    <span
      className="presence-dot"
      aria-label={onlineLabel}
      data-testid="presence-dot"
    />
  );
}

export function PresenceLabel({
  connectionState,
  presence,
  language,
  now,
}: {
  connectionState: SocketState;
  presence?: PresenceValue;
  language: Language;
  now?: number;
}) {
  if (connectionState !== "connected") return null;
  const label = formatPresence(
    presence?.online ?? false,
    presence?.lastSeenAt ?? null,
    language,
    now,
  );
  if (!label) return null;
  return (
    <small className="presence-label" data-testid="presence-label">
      {label}
    </small>
  );
}
