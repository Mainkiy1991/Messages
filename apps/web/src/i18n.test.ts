import { describe, expect, it, vi } from "vitest";
import {
  chooseCheckPositions,
  detectLanguage,
  languageStorageKey,
  getInitialLanguage,
  saveLanguagePreference,
  strings,
} from "./i18n.js";

describe("localization", () => {
  it.each([
    ["ru-RU", "ru"],
    ["uk", "ru"],
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
    expect(getInitialLanguage(["ru-RU"], { getItem: () => "uk" })).toBe("ru");
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
  it("keeps Russian and English translation keys in sync", () => {
    expect(Object.keys(strings.ru).sort()).toEqual(
      Object.keys(strings.en).sort(),
    );
  });
  it("shows translated text after changing the selected language", () => {
    let language: "ru" | "en" = "ru";
    expect(strings[language].create).toBe("Создать аккаунт");
    language = "en";
    expect(strings[language].create).toBe("Create account");
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
});

describe("random word checks", () => {
  it("selects exactly three unique word positions", () => {
    const values = [0.8, 0.1, 0.5];
    const positions = chooseCheckPositions(12, () => values.shift()!);
    expect(positions).toEqual([1, 6, 9]);
  });
});
