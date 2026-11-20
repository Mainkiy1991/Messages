import { describe, expect, it } from "vitest";
import { detectDeviceLabel } from "./device-label.js";

describe("detectDeviceLabel", () => {
  it.each([
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36",
      { browser: "Chrome", os: "Windows" },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
      { browser: "Firefox", os: "Linux" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15",
      { browser: "Safari", os: "macOS" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 Version/17.6 Safari/604.1",
      { browser: "Safari", os: "iOS" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36",
      { browser: "Chrome", os: "Android" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Edg/131.0",
      { browser: "Edge", os: "Windows" },
    ],
    [
      "Mozilla/5.0 (X11; Linux x86_64) Opera/105.0",
      { browser: "unknown", os: "Linux" },
    ],
  ])("detects %s", (_ua, expected) => {
    expect(detectDeviceLabel(_ua)).toEqual(expected);
  });
});
