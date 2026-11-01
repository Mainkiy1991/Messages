import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { formatPresence } from "../lib/presence.js";
import {
  PresenceDot,
  PresenceLabel,
  type PresenceValue,
} from "./presence-indicators.js";

const now = Date.parse("2026-10-26T12:00:00.000Z");
const online: PresenceValue = { online: true, lastSeenAt: null };
const offline: PresenceValue = {
  online: false,
  lastSeenAt: new Date(now - 10 * 60_000).toISOString(),
};

function renderIndicators(
  connectionState: "connected" | "offline",
  presence?: PresenceValue,
) {
  return renderToStaticMarkup(
    <>
      <PresenceDot
        connectionState={connectionState}
        presence={presence}
        onlineLabel="online"
      />
      <PresenceLabel
        connectionState={connectionState}
        presence={presence}
        language="en"
        now={now}
      />
    </>,
  );
}

describe("chat presence indicators", () => {
  it("formats Ukrainian online and last-seen labels", () => {
    expect(formatPresence(true, null, "uk", now)).toBe("у мережі");
    expect(formatPresence(false, offline.lastSeenAt, "uk", now)).toBe(
      "був(ла) в мережі 10 хв тому",
    );
  });

  it("shows online in the header and the green list dot", () => {
    const html = renderIndicators("connected", online);
    expect(html).toContain('data-testid="presence-dot"');
    expect(html).toContain('data-testid="presence-label"');
    expect(html).toContain(">online</small>");
  });

  it("shows last-seen time in the header and no green list dot", () => {
    const html = renderIndicators("connected", offline);
    expect(html).not.toContain('data-testid="presence-dot"');
    expect(html).toContain('data-testid="presence-label"');
    expect(html).toContain("last seen 10 min. ago");
  });

  it("shows no status when presence is unknown", () => {
    const html = renderIndicators("connected");
    expect(html).not.toContain("presence-dot");
    expect(html).not.toContain("presence-label");
  });

  it("hides statuses when the server connection is down", () => {
    const html = renderIndicators("offline", online);
    expect(html).not.toContain("presence-dot");
    expect(html).not.toContain("presence-label");
  });
});
