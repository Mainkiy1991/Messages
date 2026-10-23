import { describe, expect, it } from "vitest";
import {
  chooseCheckPositions,
  detectLanguage,
  getInitialLanguage,
  strings,
} from "./i18n.js";

describe("localization", () => {
  it("detects English and defaults other languages to Russian", () => {
    expect(detectLanguage("en-US")).toBe("en");
    expect(detectLanguage("ru-RU")).toBe("ru");
    expect(detectLanguage(undefined)).toBe("ru");
  });
  it("uses a saved language preference", () => {
    expect(getInitialLanguage({ getItem: () => "en" }, "ru-RU")).toBe("en");
    expect(getInitialLanguage({ getItem: () => null }, "en-GB")).toBe("en");
  });
  it("provides translated visible labels", () => {
    expect(strings.ru.login).not.toBe(strings.en.login);
  });
});

describe("random word checks", () => {
  it("selects exactly three unique word positions", () => {
    const values = [0.8, 0.1, 0.5];
    const positions = chooseCheckPositions(12, () => values.shift()!);
    expect(positions).toEqual([1, 6, 9]);
  });
});
