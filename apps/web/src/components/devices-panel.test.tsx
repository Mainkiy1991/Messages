import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { strings } from "../i18n.js";
import { DevicesPanel } from "./devices-panel.js";

describe("devices panel", () => {
  it("renders the loading state and hint", () => {
    const html = renderToStaticMarkup(
      <DevicesPanel
        controller={{
          listDevices: async () => ({ ok: true, devices: [] }),
          revokeDevice: async () => ({ ok: true }),
          revokeOtherDevices: async () => ({
            ok: true,
            revoked: 0,
            endedLegacySessions: 0,
          }),
        }}
        language="ru"
        strings={strings.ru}
      />,
    );
    expect(html).toContain("Загружаем список…");
    expect(html).toContain("Устройства, на которых выполнен вход");
  });
});
