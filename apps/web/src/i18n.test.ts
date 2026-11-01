import { describe, expect, it, vi } from "vitest";
import {
  chooseCheckPositions,
  detectLanguage,
  languageStorageKey,
  getInitialLanguage,
  saveLanguagePreference,
  strings,
  ukrainianPlural,
} from "./i18n.js";

describe("localization", () => {
  it.each([
    ["ru-RU", "ru"],
    ["uk", "uk"],
    ["uk-UA", "uk"],
    ["be", "ru"],
    ["en-US", "en"],
    ["de", "en"],
  ] as const)("detects %s as %s", (browserLanguage, expected) => {
    expect(detectLanguage([browserLanguage])).toBe(expected);
  });
  it("uses navigator language order and defaults an empty list to English", () => {
    expect(detectLanguage(["fr-FR", "ru-RU", "en-US"])).toBe("ru");
    expect(detectLanguage([])).toBe("en");
  });
  it("uses a saved language preference before browser detection", () => {
    expect(getInitialLanguage(["ru-RU"], { getItem: () => "en" })).toBe("en");
    expect(getInitialLanguage(["en-US"], { getItem: () => "ru" })).toBe("ru");
  });
  it("ignores a damaged saved preference", () => {
    expect(getInitialLanguage(["ru-RU"], { getItem: () => "invalid" })).toBe(
      "ru",
    );
  });
  it("falls back to browser detection when local storage is unavailable", () => {
    expect(
      getInitialLanguage(["ru-RU"], {
        getItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).toBe("ru");
    expect(() =>
      saveLanguagePreference("en", {
        setItem: () => {
          throw new Error("storage disabled");
        },
      }),
    ).not.toThrow();
  });
  it("keeps all translation keys in sync", () => {
    expect(Object.keys(strings.ru).sort()).toEqual(
      Object.keys(strings.en).sort(),
    );
    expect(Object.keys(strings.uk).sort()).toEqual(
      Object.keys(strings.en).sort(),
    );
  });
  it("shows translated text after changing the selected language", () => {
    let language: "ru" | "en" | "uk" = "ru";
    expect(strings[language].create).toBe("Создать аккаунт");
    language = "en";
    expect(strings[language].create).toBe("Create account");
    language = "uk";
    expect(strings[language].create).toBe("Створити обліковий запис");
  });
  it("saves the manual language under the expected preference key", () => {
    const setItem = vi.fn();
    saveLanguagePreference("ru", { setItem });
    expect(setItem).toHaveBeenCalledWith(languageStorageKey, "ru");
  });
  it("provides translated visible labels", () => {
    expect(strings.ru.login).not.toBe(strings.en.login);
    expect(strings.ru.deleteChatMenu).toBe("Удалить чат");
    expect(strings.ru.delete).toBe("Удалить");
    expect(strings.ru.cancel).toBe("Отмена");
    expect(strings.ru.confirmDeleteChat).toContain(
      "Неотправленные сообщения этого чата тоже будут удалены.",
    );
    expect(strings.en.confirmDeleteChat).toContain(
      "Unsent messages in this chat will also be deleted.",
    );
    expect(strings.en.deleteChatFailed).toContain("try again");
  });
  it("uses Ukrainian plural forms, including 11–14 exceptions", () => {
    expect(ukrainianPlural(1, "one", "few", "many")).toBe("one");
    expect(ukrainianPlural(2, "one", "few", "many")).toBe("few");
    expect(ukrainianPlural(4, "one", "few", "many")).toBe("few");
    for (const count of [5, 11, 12, 13, 14, 25]) {
      expect(ukrainianPlural(count, "one", "few", "many")).toBe("many");
    }
  });
  it("formats Ukrainian dates with the Ukrainian locale", async () => {
    const { getLanguageLocale } = await import("./i18n.js");
    expect(getLanguageLocale("uk")).toBe("uk-UA");
    expect(
      new Date("2026-03-08T12:00:00Z").toLocaleDateString("uk-UA", {
        month: "long",
      }),
    ).toBe("березень");
  });
});

describe("random word checks", () => {
  it("selects exactly three unique word positions", () => {
    const values = [0.8, 0.1, 0.5];
    const positions = chooseCheckPositions(12, () => values.shift()!);
    expect(positions).toEqual([1, 6, 9]);
  });
});
