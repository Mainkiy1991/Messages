import { describe, expect, it } from "vitest";
import { formatPresence } from "./presence.js";

describe("formatPresence", () => {
  const now = new Date(2026, 2, 13, 12).getTime();

  it("formats online and unknown states in Russian and English", () => {
    expect(formatPresence(true, null, "ru", now)).toBe("в сети");
    expect(formatPresence(true, null, "en", now)).toBe("online");
    expect(formatPresence(false, null, "ru", now)).toBe("");
  });

  it("formats recent minutes and yesterday", () => {
    expect(
      formatPresence(
        false,
        new Date(now - 5 * 60_000).toISOString(),
        "ru",
        now,
      ),
    ).toBe("был(а) в сети 5 мин. назад");
    expect(
      formatPresence(
        false,
        new Date(now - 5 * 60_000).toISOString(),
        "en",
        now,
      ),
    ).toBe("last seen 5 min. ago");
    expect(
      formatPresence(
        false,
        new Date(2026, 2, 12, 14, 30).toISOString(),
        "ru",
        now,
      ),
    ).toContain("был(а) в сети вчера в");
  });

  it("formats older calendar dates", () => {
    expect(
      formatPresence(false, new Date(2026, 2, 11, 12).toISOString(), "en", now),
    ).toContain("last seen March 11");
    expect(formatPresence(false, "not-a-date", "en", now)).toBe("");
  });
});
