import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type BrowserContextOptions,
  type Locator,
  type Page,
} from "@playwright/test";
import { createRequire } from "node:module";
import { strings } from "../src/i18n.js";
import { startNewChatById } from "./chat-helpers.js";

const require = createRequire(import.meta.url);
const { Pool } = require("../../server/node_modules/pg") as {
  Pool: new (options: { connectionString: string }) => {
    query(sql: string, values: unknown[]): Promise<unknown>;
    end(): Promise<void>;
  };
};

type User = {
  context: BrowserContext;
  page: Page;
  errors: string[];
  expectedDisconnect: boolean;
  expectedContactsFailure: boolean;
  expectedDeleteFailure: boolean;
  expectedEditFailure: boolean;
  expectedUserNotFoundFailure: boolean;
};
type Fixtures = {
  serverControl: { stop(): Promise<void>; start(): Promise<void> };
};
const test = base.extend<Fixtures>({
  serverControl: async ({ browser }, use) => {
    void browser;
    const control = async (action: "stop" | "start") => {
      const response = await fetch(`http://127.0.0.1:3001/${action}`, {
        method: "POST",
      });
      expect(response.ok, `API server ${action} request`).toBeTruthy();
    };
    await use({ stop: () => control("stop"), start: () => control("start") });
  },
});
let activeUsers: User[] = [];

async function openUser(
  browser: Browser,
  contextOptions?: BrowserContextOptions,
): Promise<User> {
  const context = await browser.newContext(contextOptions);
  await context.addInitScript(() => {
    if (localStorage.getItem("messages-lang") === null) {
      localStorage.setItem("messages-lang", "en");
    }
  });
  const page = await context.newPage();
  const user: User = {
    context,
    page,
    errors: [],
    expectedDisconnect: false,
    expectedContactsFailure: false,
    expectedDeleteFailure: false,
    expectedEditFailure: false,
    expectedUserNotFoundFailure: false,
  };
  page.on("pageerror", (error) =>
    user.errors.push(`pageerror: ${error.message}`),
  );
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const expectedSocketRefusal =
      user.expectedDisconnect &&
      /^WebSocket connection to 'ws:\/\/localhost:3000\/ws' failed: Error in connection establishment: net::ERR_CONNECTION_REFUSED$/u.test(
        message.text(),
      );
    const expectedApiRefusal =
      user.expectedDisconnect &&
      /localhost:3000|ERR_CONNECTION_REFUSED/u.test(message.text());
    const expectedContactsFailure =
      user.expectedContactsFailure &&
      /Failed to load resource: the server responded with a status of 500/u.test(
        message.text(),
      );
    // Chromium reports intentionally failed conversation requests as console errors.
    const expectedDeleteFailure =
      user.expectedDeleteFailure &&
      /Failed to load resource: net::ERR_(?:FAILED|INTERNET_DISCONNECTED)/u.test(
        message.text(),
      );
    // The same console error comes from the deliberately aborted edit request.
    const expectedEditFailure =
      user.expectedEditFailure &&
      message.text() === "Failed to load resource: net::ERR_FAILED";
    const expectedUserNotFoundFailure =
      user.expectedUserNotFoundFailure &&
      /Failed to load resource: the server responded with a status of 404/u.test(
        message.text(),
      );
    // Chromium emits this network diagnostic during the deliberately stopped-server window.
    if (
      !expectedSocketRefusal &&
      !expectedApiRefusal &&
      !expectedContactsFailure &&
      !expectedDeleteFailure &&
      !expectedEditFailure &&
      !expectedUserNotFoundFailure
    )
      user.errors.push(`console.error: ${message.text()}`);
  });
  await page.goto("/");
  activeUsers.push(user);
  return user;
}

async function showSeedPhrase(page: Page, wordCount: 12 | 24 = 12) {
  await page.getByTestId("create-account").click();
  await page.locator(".auth-card select").selectOption(String(wordCount));
  await page.locator(".auth-card > .primary").click();
  await expect(page.getByTestId("seed-phrase")).toBeVisible();
}

async function createAccount(
  page: Page,
  wordCount: 12 | 24 = 12,
): Promise<{ phrase: string; id: string }> {
  await showSeedPhrase(page, wordCount);
  const words = (
    await page
      .getByTestId("seed-phrase")
      .locator("li > span:last-child")
      .allTextContents()
  ).map((word) => word.trim());
  const phrase = words.join(" ");
  const verificationInputs = page.locator('[data-testid^="seed-answer-"]');
  const count = await verificationInputs.count();
  for (let index = 0; index < count; index++) {
    const labelText = await verificationInputs
      .nth(index)
      .locator("xpath=..")
      .innerText();
    const position = Number(labelText.match(/#(\d+)/)?.[1]);
    await verificationInputs.nth(index).fill(words[position - 1]!);
  }
  await page.getByLabel("I have saved the phrase").check();
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-state",
    "connected",
  );
  const id = await revealUserId(page);
  return { phrase, id };
}

async function revealUserId(page: Page): Promise<string> {
  await page.getByTestId("profile").click();
  await page.getByRole("button", { name: "User ID" }).click();
  const id = (await page.getByTestId("user-id").innerText()).trim();
  await page.getByTestId("profile").click();
  return id;
}

async function signIn(page: Page, phrase: string): Promise<string> {
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-state",
    "connected",
  );
  return revealUserId(page);
}

async function logout(page: Page, phrase: string): Promise<void> {
  await page.getByTestId("profile").click();
  await page.getByTestId("logout").click();
  await page.getByTestId("logout-phrase").fill(phrase);
  await page.getByTestId("logout-verify").click();
  await expect(page.getByTestId("open-login")).toBeVisible();
}

async function expectStackedButtons(
  page: Page,
  buttons: Locator[],
): Promise<void> {
  const panel = page.locator(".confirm-panel");
  await expect(panel).toHaveCount(1);
  const panelBox = await panel.boundingBox();
  if (!panelBox) throw new Error("The confirmation panel is not visible");
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("The viewport size is not set");
  expect(
    await panel.evaluate((element) => getComputedStyle(element).display),
  ).toBe("grid");
  expect(panelBox.x).toBeGreaterThanOrEqual(0);
  expect(panelBox.x + panelBox.width).toBeLessThanOrEqual(viewport.width);
  const boxes: { x: number; y: number; width: number; height: number }[] = [];
  for (const button of buttons) {
    const box = await button.boundingBox();
    if (!box) throw new Error("A stacked button is not visible");
    boxes.push(box);
  }
  expect(boxes).toHaveLength(buttons.length);
  for (const box of boxes) {
    expect(box.width).toBeGreaterThanOrEqual(panelBox.width - 48 - 2);
    expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThanOrEqual(2);
  }
  for (let index = 1; index < boxes.length; index += 1) {
    const previous = boxes[index - 1]!;
    expect(boxes[index]!.y).toBeGreaterThanOrEqual(
      previous.y + previous.height,
    );
  }
}

async function openChat(page: Page, peerId: string): Promise<void> {
  await startNewChatById(page);
  await page.getByTestId("peer-id-input").fill(peerId);
  await page.getByTestId("new-chat").click();
  await expect(page.locator(".conversation-head")).toContainText(
    peerId.slice(-10),
  );
}

async function send(page: Page, message: string): Promise<void> {
  await page.getByTestId("message-input").fill(message);
  await page.getByTestId("send-message").click();
}

function chatWith(page: Page, peerId: string) {
  return page.locator(`[data-testid="chat-item"][data-peer-id="${peerId}"]`);
}

function startsWithText(text: string): RegExp {
  return new RegExp(`^${text}`, "u");
}

test.describe("real browser chat", () => {
  test("seed phrase numbers and words fit their cells at mobile widths", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const page = user.page;

    for (const language of ["ru", "en", "uk"]) {
      await page.evaluate(
        (value) => localStorage.setItem("messages-lang", value),
        language,
      );
      await page.reload();

      for (const width of [360, 320]) {
        await page.setViewportSize({ width, height: 900 });
        for (const wordCount of [12, 24] as const) {
          await showSeedPhrase(page, wordCount);
          const seedList = page.getByTestId("seed-phrase");
          await expect(seedList.locator("li")).toHaveCount(wordCount);
          const selectionStyles = await seedList.evaluate((list) => {
            const number = getComputedStyle(list.querySelector(".seed-index")!);
            const word = getComputedStyle(
              list.querySelector("li span:last-child")!,
            );
            return {
              number: number.userSelect || number.webkitUserSelect,
              word: word.userSelect || word.webkitUserSelect,
            };
          });
          expect(selectionStyles.number).toBe("none");
          expect(selectionStyles.word).not.toBe("none");
          const layout = await seedList.evaluate((list) => {
            const items = [...list.querySelectorAll("li")];
            const rect = (element: Element) => {
              const box = element.getBoundingClientRect();
              return { left: box.left, right: box.right, width: box.width };
            };
            return items.map((item) => {
              const number = item.querySelector(".seed-index")!;
              const word = item.querySelector("span:last-child")!;
              return {
                item: rect(item),
                number: rect(number),
                word: rect(word),
                wordScrollWidth: word.scrollWidth,
                wordClientWidth: word.clientWidth,
              };
            });
          });

          for (const item of layout) {
            expect(item.number.right).toBeLessThanOrEqual(item.item.right + 1);
            expect(item.word.right).toBeLessThanOrEqual(item.item.right + 1);
            expect(item.wordScrollWidth).toBeLessThanOrEqual(
              item.wordClientWidth,
            );
          }
          const leftColumn = layout.filter((_, index) => index % 2 === 0);
          const rightColumn = layout.filter((_, index) => index % 2 === 1);
          expect(
            Math.max(...leftColumn.map((item) => item.item.right)),
          ).toBeLessThanOrEqual(
            Math.min(...rightColumn.map((item) => item.item.left)) + 1,
          );

          await seedList
            .locator("li span:last-child")
            .first()
            .evaluate((word) => {
              word.textContent = "absolute";
            });
          const longWord = await seedList
            .locator("li span:last-child")
            .first()
            .evaluate((word) => ({
              scrollWidth: word.scrollWidth,
              clientWidth: word.clientWidth,
              right: word.getBoundingClientRect().right,
              itemRight: word.parentElement!.getBoundingClientRect().right,
            }));
          expect(longWord.scrollWidth).toBeLessThanOrEqual(
            longWord.clientWidth,
          );
          expect(longWord.right).toBeLessThanOrEqual(longWord.itemRight + 1);

          await page.goto("/");
        }
      }
    }
  });

  test("welcome controls keep one full-width layout in every language", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const page = user.page;
    const languageSelect = page.locator(".welcome-language-select");

    for (const width of [360, 1280]) {
      await page.setViewportSize({ width, height: 800 });
      for (const language of ["ru", "en", "uk"]) {
        await languageSelect.selectOption(language);
        await expect(page.locator("html")).toHaveAttribute("lang", language);
        const layout = await page.evaluate(() => {
          const card = document.querySelector(".auth-card")!;
          const elements = [
            document.querySelector('[data-testid="create-account"]')!,
            document.querySelector('[data-testid="open-login"]')!,
            document.querySelector(".welcome-language-select")!,
          ];
          const cardRect = card.getBoundingClientRect();
          return {
            card: { left: cardRect.left, right: cardRect.right },
            elements: elements.map((element) => {
              const rect = element.getBoundingClientRect();
              return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                right: rect.right,
                scrollWidth: element.scrollWidth,
                clientWidth: element.clientWidth,
              };
            }),
          };
        });
        const [create, login, select] = layout.elements;
        for (const element of layout.elements) {
          expect(Math.abs(element.x - create!.x)).toBeLessThanOrEqual(1);
          expect(Math.abs(element.width - create!.width)).toBeLessThanOrEqual(
            1,
          );
          expect(element.height).toBe(44);
          expect(element.x).toBeGreaterThanOrEqual(layout.card.left);
          expect(element.right).toBeLessThanOrEqual(layout.card.right);
          expect(element.scrollWidth).toBeLessThanOrEqual(element.clientWidth);
        }
        expect(login!.y).toBeGreaterThan(create!.y);
        expect(select!.y).toBeGreaterThan(login!.y);

        if (language === "ru") {
          const baseline = layout.elements.map(({ x, y, width, height }) => ({
            x,
            y,
            width,
            height,
          }));
          for (const nextLanguage of ["en", "uk"]) {
            await languageSelect.selectOption(nextLanguage);
            const changed = await page.evaluate(() =>
              [
                document.querySelector('[data-testid="create-account"]')!,
                document.querySelector('[data-testid="open-login"]')!,
                document.querySelector(".welcome-language-select")!,
              ].map((element) => {
                const rect = element.getBoundingClientRect();
                return {
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                };
              }),
            );
            changed.forEach((item, index) => {
              expect(Math.abs(item.y - baseline[index]!.y)).toBeLessThanOrEqual(
                1,
              );
              expect(Math.abs(item.x - baseline[index]!.x)).toBeLessThanOrEqual(
                1,
              );
              expect(
                Math.abs(item.width - baseline[index]!.width),
              ).toBeLessThanOrEqual(1);
            });
          }
          await languageSelect.selectOption("ru");
        }
      }
    }

    await languageSelect.selectOption("uk");
    await expect(page.locator("html")).toHaveAttribute("lang", "uk");
    expect(
      await page.evaluate(() => localStorage.getItem("messages-lang")),
    ).toBe("uk");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "uk");
    await expect(page.locator(".welcome-language-select")).toHaveValue("uk");
  });

  test.beforeEach(async ({ serverControl }) => {
    activeUsers = [];
    await serverControl.stop();
    await serverControl.start();
  });

  test("shows live and persisted read receipts", async ({ browser }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    let pageLoads = 0;
    a.page.on("load", () => pageLoads++);

    await openChat(a.page, bob.id);
    await send(a.page, "Read this while online");
    await openChat(b.page, alice.id);
    await expect(
      a.page.locator('[data-testid="message"][data-direction="out"]'),
    ).toHaveAttribute("data-status", "read");
    await expect(
      a.page.getByTestId("message-status").filter({ hasText: "Read" }),
    ).toBeVisible();

    await logout(b.page, bob.phrase);
    await send(a.page, "Read this after reconnecting");
    await expect(
      a.page.locator(
        '[data-testid="message"][data-direction="out"][data-status="sent"]',
      ),
    ).toContainText("Read this after reconnecting");
    await logout(a.page, alice.phrase);
    expect(await signIn(b.page, bob.phrase)).toBe(bob.id);
    await chatWith(b.page, alice.id).click();
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("Read this after reconnecting") }),
    ).toBeVisible();
    expect(await signIn(a.page, alice.phrase)).toBe(alice.id);
    await chatWith(a.page, bob.id).click();
    await expect(
      a.page
        .locator('[data-testid="message"][data-direction="out"]')
        .filter({ hasText: startsWithText("Read this after reconnecting") }),
    ).toHaveAttribute("data-status", "read");
  });

  test("syncs own messages instantly across devices and keeps reply order", async ({
    browser,
  }) => {
    const firstDevice = await openUser(browser);
    const alice = await createAccount(firstDevice.page);
    const secondDevice = await openUser(browser);
    expect(await signIn(secondDevice.page, alice.phrase)).toBe(alice.id);
    const bobUser = await openUser(browser);
    const bob = await createAccount(bobUser.page);

    await openChat(firstDevice.page, bob.id);
    await openChat(secondDevice.page, bob.id);
    await send(firstDevice.page, "Alice device one");
    const secondDeviceMessages = secondDevice.page.locator(
      ".message-list .message-text",
    );
    await expect(
      secondDeviceMessages.filter({ hasText: /^Alice device one/u }),
    ).toBeVisible();

    await openChat(bobUser.page, alice.id);
    await send(bobUser.page, "Bob replies");
    await send(firstDevice.page, "Alice follows up");

    for (const page of [firstDevice.page, secondDevice.page]) {
      const messages = page.locator(".message-list .message-text");
      await expect(messages).toHaveText([
        /^Alice device one/u,
        /^Bob replies/u,
        /^Alice follows up/u,
      ]);
    }
  });

  test("chat controls and long message fit a 360px viewport", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const { page } = user;
    await createAccount(page);
    const bob = await createAccount((await openUser(browser)).page);
    await page.setViewportSize({ width: 360, height: 780 });
    await openChat(page, bob.id);

    const backButton = page.getByTestId("mobile-back");
    await expect(backButton).toBeVisible();
    await expect(backButton).toHaveAccessibleName("Back");
    await expect(backButton).toHaveAttribute("title", "Back");
    await expect(backButton).toHaveText("");
    const backBox = await backButton.boundingBox();
    expect(backBox).not.toBeNull();
    expect(backBox!.width).toBeGreaterThanOrEqual(44);
    expect(backBox!.height).toBeGreaterThanOrEqual(44);

    await page.getByTestId("chat-menu").click();
    const menu = page.locator(".conversation-menu-panel");
    const clearButton = page.getByTestId("clear-chat");
    const deleteButton = page.getByTestId("delete-chat");
    await expect(clearButton).toBeVisible();
    await expect(deleteButton).toBeVisible();
    expect(
      await menu.evaluate((element) => getComputedStyle(element).display),
    ).toBe("grid");
    const menuBox = await menu.boundingBox();
    const clearBox = await clearButton.boundingBox();
    const deleteBox = await deleteButton.boundingBox();
    expect(menuBox).not.toBeNull();
    expect(clearBox).not.toBeNull();
    expect(deleteBox).not.toBeNull();
    expect(deleteBox!.y).toBeGreaterThan(clearBox!.y);
    expect(Math.abs(deleteBox!.x - clearBox!.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(deleteBox!.width - clearBox!.width)).toBeLessThanOrEqual(1);
    expect(menuBox!.x).toBeGreaterThanOrEqual(0);
    expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(360);
    await page.getByTestId("chat-menu").click();

    const text = Array.from({ length: 34 }, () => "ordinary").join(" ");
    await send(page, text);
    const message = page.locator(
      '[data-testid="message"][data-direction="out"]',
    );
    await expect(message).toContainText(text);
    const listBox = await page.locator(".message-list").boundingBox();
    const messageBox = await message.boundingBox();
    expect(listBox).not.toBeNull();
    expect(messageBox).not.toBeNull();
    const widthRatio = messageBox!.width / listBox!.width;
    expect(widthRatio).toBeGreaterThan(0.78);
    expect(widthRatio).toBeLessThanOrEqual(0.9);
    const rowBox = await message.locator("xpath=..").boundingBox();
    expect(rowBox).not.toBeNull();
    expect(Math.abs(rowBox!.width - messageBox!.width)).toBeLessThanOrEqual(1);
    expect(
      await message.evaluate((element) => {
        const style = getComputedStyle(element);
        return { overflowWrap: style.overflowWrap, wordBreak: style.wordBreak };
      }),
    ).toEqual({ overflowWrap: "anywhere", wordBreak: "normal" });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  });

  test("copies the full peer ID from the chat menu", async ({ browser }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await a.context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await openChat(a.page, bob.id);
    await a.page.getByTestId("chat-menu").click();
    const copyButton = a.page.getByTestId("copy-peer-id");
    await copyButton.click();

    await expect(copyButton).toHaveText("ID copied");
    await expect(a.page.locator(".conversation-menu-panel")).toBeVisible();
    expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(
      bob.id,
    );
    await expect(a.page.locator(".contact-name-trigger small")).toHaveText(
      bob.id.slice(-10),
    );
    await expect(a.page.locator(".conversation-menu-panel")).toHaveCount(0, {
      timeout: 3000,
    });
  });

  test("shows the full peer ID manually when clipboard copying fails on mobile", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    await createAccount(user.page);
    const bob = await createAccount((await openUser(browser)).page);
    await user.page.setViewportSize({ width: 360, height: 780 });
    await openChat(user.page, bob.id);
    await user.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("blocked")) },
      });
      document.execCommand = () => false;
    });

    await user.page.getByTestId("chat-menu").click();
    await user.page.getByTestId("copy-peer-id").click();

    const failure = user.page.getByTestId("id-copy-failed");
    const fallback = user.page.getByTestId("id-copy-fallback");
    await expect(user.page.locator(".conversation-menu-panel")).toHaveCount(0);
    await expect(failure).toContainText(
      /^Could not copy automatically\. Select and copy the ID manually:/u,
    );
    await expect(fallback).toHaveText(bob.id);
    const box = await failure.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    expect(
      await user.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  });

  test("hides peer ID copying in Saved messages and keeps profile copying", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const alice = await createAccount(user.page);
    await user.context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await startNewChatById(user.page);
    await user.page.getByTestId("peer-id-input").fill(alice.id);
    await user.page.getByTestId("new-chat").click();
    await expect(user.page.getByTestId("saved-chat-title")).toBeVisible();

    await user.page.getByTestId("chat-menu").click();
    await expect(user.page.getByTestId("copy-peer-id")).toHaveCount(0);
    await user.page.getByTestId("chat-menu").click();
    await user.page.getByTestId("profile").click();
    await user.page.getByRole("button", { name: "User ID" }).click();
    await user.page.locator(".copy-button").click();

    await expect(user.page.locator(".copy-button")).toHaveText(/^Copied/u);
    expect(await user.page.evaluate(() => navigator.clipboard.readText())).toBe(
      alice.id,
    );
  });

  test("copies an ID from a conversation initiated by the other account", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await a.context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await openChat(b.page, alice.id);
    await send(b.page, "Started by Bob");
    const aliceChat = chatWith(a.page, bob.id);
    await expect(aliceChat).toBeVisible();
    await aliceChat.click();
    await a.page.getByTestId("chat-menu").click();
    const copyButton = a.page.getByTestId("copy-peer-id");
    await copyButton.click();

    await expect(copyButton).toHaveText("ID copied");
    await expect(a.page.locator(".conversation-menu-panel")).toBeVisible();
    expect(await a.page.evaluate(() => navigator.clipboard.readText())).toBe(
      bob.id,
    );
    await expect(a.page.locator(".conversation-menu-panel")).toHaveCount(0, {
      timeout: 3000,
    });
  });

  test("resets copy feedback when switching to another chat", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    await createAccount(user.page);
    const bob = await createAccount((await openUser(browser)).page);
    const carol = await createAccount((await openUser(browser)).page);
    await user.context.grantPermissions(["clipboard-read", "clipboard-write"]);

    await openChat(user.page, bob.id);
    await user.page.getByTestId("chat-menu").click();
    const copyButton = user.page.getByTestId("copy-peer-id");
    await copyButton.click();
    await expect(copyButton).toHaveText("ID copied");
    await openChat(user.page, carol.id);
    await expect(copyButton).toHaveText("Copy ID");

    await copyButton.click();
    await expect(copyButton).toHaveText("ID copied");
    expect(await user.page.evaluate(() => navigator.clipboard.readText())).toBe(
      carol.id,
    );
  });

  test("shows a visible profile copy error when automatic copying fails", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const alice = await createAccount(user.page);
    await user.page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: () => Promise.reject(new Error("blocked")) },
      });
      document.execCommand = () => false;
    });

    await user.page.getByTestId("profile").click();
    await user.page.getByRole("button", { name: "User ID" }).click();
    await user.page.locator(".copy-button").click();

    await expect(user.page.getByTestId("profile-id-copy-failed")).toContainText(
      /^Could not copy automatically\. Select and copy the ID manually:/u,
    );
    await expect(user.page.getByTestId("user-id")).toHaveText(alice.id);
  });

  test("keeps a cleared chat in the interface after reload and shows Bob's new message", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Old conversation");
    await openChat(b.page, alice.id);
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Old conversation/u }),
    ).toBeVisible();

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("clear-chat").click();
    await expect(a.page.getByRole("alertdialog")).toContainText(
      "The conversation will be cleared only for you, on all your devices,",
    );
    await a.page.getByRole("button", { name: "Cancel" }).click();
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(a.page.locator(".message-list .message-text")).toContainText(
      "Old conversation",
    );

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("clear-chat").click();
    await a.page.getByTestId("confirm-clear-chat").click();
    await expect(a.page.getByTestId("chat-cleared-notice")).toHaveText(
      "You cleared this chat",
    );
    await expect(chatWith(a.page, bob.id)).toContainText("Chat cleared");
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Old conversation/u }),
    ).toBeVisible();

    await a.page.reload();
    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(chatWith(a.page, bob.id)).toContainText("Chat cleared");
    await send(b.page, "A new conversation");
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await chatWith(a.page, bob.id).click();
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^A new conversation/u }),
    ).toBeVisible();
  });

  test("keeps the chat on network failure and allows retry from the confirmation dialog", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Keep me if deletion fails");

    const deleteRoute = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "DELETE") await route.abort();
      else await route.continue();
    };
    await a.page.route("**/conversations/**", deleteRoute);
    a.expectedDeleteFailure = true;
    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("clear-chat").click();
    await a.page.getByTestId("confirm-clear-chat").click();
    await expect(a.page.getByTestId("chat-error")).toBeVisible();
    await expect(a.page.getByTestId("chat-error")).toHaveText(
      "Could not clear the chat. Check your connection and try again.",
    );
    a.expectedDeleteFailure = false;
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Keep me if deletion fails/u }),
    ).toBeVisible();

    await a.page.unroute("**/conversations/**", deleteRoute);
    await a.page.getByTestId("confirm-clear-chat").click();
    await expect(a.page.getByTestId("chat-cleared-notice")).toBeVisible();
    await expect(chatWith(a.page, bob.id)).toContainText("Chat cleared");
  });

  test("erases Alice's messages for Bob as one stub and keeps Bob's own message", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Erase group one");
    await send(a.page, "Erase group two");
    await send(a.page, "Erase group three");
    await openChat(b.page, alice.id);
    const bobMessages = b.page.locator(".message-list .message-text");
    for (const text of [
      "Erase group one",
      "Erase group two",
      "Erase group three",
    ])
      await expect(
        bobMessages.filter({ hasText: new RegExp(`^${text}`, "u") }),
      ).toBeVisible();

    await send(b.page, "Bob's own message");
    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await expect(a.page.getByRole("alertdialog")).toContainText(
      "all your messages in it will be erased from the server",
    );
    await a.page.getByTestId("confirm-delete-chat").click();

    await expect(b.page.getByTestId("message-deleted")).toHaveCount(1);
    await expect(b.page.getByTestId("message-deleted")).toHaveText(
      "The other person deleted these messages",
    );
    await expect(
      bobMessages.filter({ hasText: /^Bob's own message/u }),
    ).toBeVisible();
    await expect(b.page.locator('[data-testid="message-row"]')).toHaveCount(2);
  });

  test("shows a visible error and keeps the chat when delete-chat is offline", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const bob = await createAccount(b.page);
    await createAccount(a.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Keep this while offline");
    a.expectedDeleteFailure = true;
    await a.context.setOffline(true);

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    const error = a.page.getByTestId("chat-error");
    await expect(error).toBeVisible();
    expect(
      await error.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      }),
    ).toBe(true);
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Keep this while offline/u }),
    ).toBeVisible();
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    a.expectedDeleteFailure = false;
    await a.context.setOffline(false);
  });

  test("updates another window without reloading and fits the cleared notice at 360px", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Across Alice's windows");

    const secondWindow = await a.context.newPage();
    await secondWindow.goto("/");
    await expect(secondWindow.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(chatWith(secondWindow, bob.id)).toBeVisible();
    await a.page.setViewportSize({ width: 360, height: 780 });
    await a.page.getByTestId("chat-menu").click();
    await expect(a.page.getByTestId("chat-menu")).toBeVisible();
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await a.page.getByTestId("clear-chat").click();
    await a.page.getByTestId("confirm-clear-chat").click();
    const notice = a.page.getByTestId("chat-cleared-notice");
    await expect(notice).toBeVisible();
    await expect(chatWith(a.page, bob.id)).toContainText("Chat cleared");
    await expect(chatWith(secondWindow, bob.id)).toContainText("Chat cleared");
    const noticeBox = await notice.boundingBox();
    expect(noticeBox).not.toBeNull();
    expect(noticeBox!.x).toBeGreaterThanOrEqual(0);
    expect(noticeBox!.x + noticeBox!.width).toBeLessThanOrEqual(360);
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
  });

  test("delete chat removes it immediately in both windows", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Delete from both windows");

    const secondWindow = await a.context.newPage();
    await secondWindow.goto("/");
    await expect(secondWindow.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(chatWith(secondWindow, bob.id)).toBeVisible();

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await expect(chatWith(secondWindow, bob.id)).toHaveCount(0);
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);
  });

  test("deletes a chat from the list with hover, keyboard focus, and confirmation", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(b.page, alice.id);
    await send(b.page, "Hover delay test");
    await send(b.page, "Delete from the list");

    const secondWindow = await a.context.newPage();
    await secondWindow.goto("/");
    await expect(secondWindow.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(chatWith(secondWindow, bob.id)).toBeVisible();
    const row = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    const item = chatWith(a.page, bob.id);
    const basket = row.getByTestId("chat-row-delete");
    expect(await row.locator("button button").count()).toBe(0);
    await expect
      .poll(() =>
        basket.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("0");
    await row.hover();
    const opacity = () =>
      basket.evaluate((element) => getComputedStyle(element).opacity);
    await expect.poll(opacity).toBe("1");
    await item.focus();
    await a.page.keyboard.press("Tab");
    await expect(basket).toBeFocused();
    expect(await opacity()).toBe("1");
    await expect(basket).toHaveAttribute("aria-label", "Delete chat");

    await basket.click();
    const dialog = a.page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "all your messages in it will be erased from the server",
    );
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await expect(chatWith(secondWindow, bob.id)).toHaveCount(0);
  });

  test("chat row basket appears only after a delayed mouse hover", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(b.page, alice.id);
    await send(b.page, "Hover delay test");

    const row = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    const basket = row.getByTestId("chat-row-delete");
    const opacity = () =>
      basket.evaluate((element) => getComputedStyle(element).opacity);
    await expect(row).toBeVisible();
    await row.hover();
    expect(await opacity()).toBe("0");
    await a.page.waitForTimeout(300);
    expect(await opacity()).toBe("0");
    await expect.poll(opacity, { timeout: 3000 }).toBe("1");

    await a.page.mouse.move(0, 0);
    await expect.poll(opacity).toBe("0");
  });

  test("selected chat basket hides after the mouse leaves its row", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(b.page, alice.id);
    await send(b.page, "Selected chat hover");

    const row = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    const item = row.getByTestId("chat-item");
    const basket = row.getByTestId("chat-row-delete");
    const opacity = () =>
      basket.evaluate((element) => getComputedStyle(element).opacity);
    await expect(item).toBeVisible();
    await item.click();
    await expect(item).toHaveClass(/selected/u);
    await a.page.getByTestId("message-input").hover();
    await a.page.waitForTimeout(1500);
    await expect.poll(opacity).toBe("0");
  });

  test("deleting an unopened list chat leaves the open chat selected", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const c = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    const charlie = await createAccount(c.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Bob remains unopened");
    await openChat(a.page, charlie.id);

    const bobRow = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    await bobRow.hover();
    const basket = bobRow.getByTestId("chat-row-delete");
    await expect
      .poll(() =>
        basket.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await basket.click();
    await a.page.getByTestId("confirm-delete-chat").click();

    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await expect(a.page.locator(".messenger")).toHaveClass(/show-chat/u);
    await expect(a.page.locator(".chat-list-item.selected")).toHaveAttribute(
      "data-peer-id",
      charlie.id,
    );
  });

  test("shows list deletion failure in the dialog and succeeds on retry", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Keep this after list delete fails");

    const deleteRoute = async (route: import("@playwright/test").Route) => {
      if (
        route.request().method() === "POST" &&
        route.request().url().includes("/erase")
      )
        await route.abort();
      else await route.continue();
    };
    await a.page.route("**/conversations/**", deleteRoute);
    a.expectedDeleteFailure = true;
    const row = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    await row.hover();
    const basket = row.getByTestId("chat-row-delete");
    await expect
      .poll(() =>
        basket.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await basket.click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(a.page.getByTestId("chat-error")).toHaveText(
      "Could not delete the chat. Check your connection and try again.",
    );
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Keep this after list delete fails/u }),
    ).toBeVisible();
    a.expectedDeleteFailure = false;

    await a.page.unroute("**/conversations/**", deleteRoute);
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
  });

  test("long press reveals the list basket on touch without opening the chat", async ({
    browser,
  }) => {
    const a = await openUser(browser, {
      viewport: { width: 360, height: 780 },
      isMobile: true,
      hasTouch: true,
    });
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Touch list basket");
    await a.page.getByTestId("mobile-back").click();
    await openChat(b.page, alice.id);
    await send(b.page, "Unread mobile preview");

    const row = a.page.locator(`.chat-row[data-peer-id="${bob.id}"]`);
    const item = chatWith(a.page, bob.id);
    const basket = row.getByTestId("chat-row-delete");
    const unread = row.getByTestId("unread-count");
    await expect(unread).toBeVisible();
    const itemBox = await item.boundingBox();
    expect(itemBox).not.toBeNull();
    await item.dispatchEvent("pointerdown", {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: itemBox!.x + 20,
      clientY: itemBox!.y + 20,
    });
    await a.page.waitForTimeout(600);
    await item.dispatchEvent("pointerup", {
      pointerId: 7,
      pointerType: "touch",
      isPrimary: true,
      clientX: itemBox!.x + 20,
      clientY: itemBox!.y + 20,
    });
    await expect(basket).toHaveCSS("opacity", "1");
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);

    await item.click();
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);
    await expect(basket).toHaveCSS("opacity", "1");

    const basketBox = await basket.boundingBox();
    const timeBox = await row.locator("small").boundingBox();
    const unreadBox = await unread.boundingBox();
    expect(basketBox).not.toBeNull();
    expect(timeBox).not.toBeNull();
    expect(unreadBox).not.toBeNull();
    expect(
      basketBox!.x < timeBox!.x + timeBox!.width &&
        basketBox!.x + basketBox!.width > timeBox!.x,
    ).toBe(false);
    expect(
      basketBox!.x < unreadBox!.x + unreadBox!.width &&
        basketBox!.x + basketBox!.width > unreadBox!.x &&
        basketBox!.y < unreadBox!.y + unreadBox!.height &&
        basketBox!.y + basketBox!.height > unreadBox!.y,
    ).toBe(false);
    expect(basketBox!.x).toBeGreaterThanOrEqual(0);
    expect(basketBox!.x + basketBox!.width).toBeLessThanOrEqual(360);
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);

    await chatWith(a.page, alice.id).click();
    await expect(basket).toHaveCSS("opacity", "0");
    await a.page.getByTestId("mobile-back").click();
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);
    await item.click();
    await expect(a.page.locator(".messenger")).toHaveClass(/show-chat/u);
  });

  test("Saved messages has a list basket and remains after deletion", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const user = await createAccount(a.page);
    const row = a.page.locator(`.chat-row[data-peer-id="${user.id}"]`);
    await expect(row.getByTestId("chat-row-delete")).toHaveCount(1);
    await row.hover();
    const basket = row.getByTestId("chat-row-delete");
    await expect
      .poll(() =>
        basket.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await basket.click();
    const dialog = a.page.getByRole("alertdialog");
    await expect(dialog).toContainText(
      "Your notes will be cleared on all your devices",
    );
    await expect(dialog).not.toContainText("other person");
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(dialog).toHaveCount(0);
    await expect(row).toHaveCount(1);
  });

  test("a new message restores a chat after deletion", async ({ browser }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Initial message before deletion");
    await openChat(b.page, alice.id);

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);

    await send(b.page, "Message restores the chat");
    await expect(chatWith(a.page, bob.id)).toContainText(
      "Message restores the chat",
    );
    await chatWith(a.page, bob.id).click();
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: /^Message restores the chat/u }),
    ).toBeVisible();
  });

  test("shows presence only after two-way chat and updates after reconnect", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    let b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await expect(a.page.getByTestId("presence-label")).toHaveCount(0);
    await expect(
      chatWith(a.page, bob.id).getByTestId("presence-dot"),
    ).toHaveCount(0);
    await send(a.page, "Hello Bob");
    await openChat(b.page, alice.id);
    await send(b.page, "Hello Alice");

    await expect(a.page.getByTestId("presence-label")).toHaveText("online");
    await expect(
      chatWith(a.page, bob.id).getByTestId("presence-dot"),
    ).toBeVisible();

    await b.context.close();
    await expect(a.page.getByTestId("presence-label")).toContainText(
      "last seen",
    );
    await expect(
      chatWith(a.page, bob.id).getByTestId("presence-dot"),
    ).toHaveCount(0);
    b = await openUser(browser);
    await signIn(b.page, bob.phrase);
    await expect(a.page.getByTestId("presence-label")).toHaveText("online");
    await expect(
      chatWith(a.page, bob.id).getByTestId("presence-dot"),
    ).toBeVisible();
  });

  test("updates presence after the first reply without reloading", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    let pageLoads = 0;
    a.page.on("load", () => pageLoads++);

    await openChat(a.page, bob.id);
    await expect(a.page.getByTestId("presence-label")).toHaveCount(0);
    await send(a.page, "First message from Alice");
    await openChat(b.page, alice.id);
    await send(b.page, "First reply from Bob");

    await expect(a.page.getByTestId("presence-label")).toHaveText("online");
    expect(pageLoads).toBe(0);
    await expect(
      chatWith(a.page, bob.id).getByTestId("presence-dot"),
    ).toBeVisible();
  });

  test("saved messages open from your own ID, stay single and sync to a second device", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const alice = await createAccount(a.page);

    await startNewChatById(a.page);
    await a.page.getByTestId("peer-id-input").fill(alice.id);
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("saved-chat-title")).toHaveText(
      "Saved messages",
    );

    await send(a.page, "Note to myself");
    const notes = a.page.locator(".message-list .message-text");
    await expect(notes).toHaveText(["Note to myself"]);
    await expect(a.page.getByTestId("unread-count")).toHaveCount(0);
    const status = a.page.getByTestId("message-status");
    await expect(status).toHaveCount(1);
    expect(await status.innerText()).not.toMatch(
      /(sending|sent|delivered|read)/u,
    );
    await expect(a.page.getByTestId("presence-label")).toHaveCount(0);
    await expect(a.page.getByTestId("presence-dot")).toHaveCount(0);

    await a.page.reload();
    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await chatWith(a.page, alice.id).click();
    await expect(a.page.locator(".message-list .message-text")).toHaveText([
      "Note to myself",
    ]);
    await expect(a.page.getByTestId("unread-count")).toHaveCount(0);

    const second = await openUser(browser);
    expect(await signIn(second.page, alice.phrase)).toBe(alice.id);
    await chatWith(second.page, alice.id).click();
    await expect(second.page.locator(".message-list .message-text")).toHaveText(
      ["Note to myself"],
    );
    await expect(second.page.getByTestId("unread-count")).toHaveCount(0);
  });

  test("message buttons appear on keyboard focus only (focus-visible)", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const alice = await createAccount(a.page);

    await startNewChatById(a.page);
    await a.page.getByTestId("peer-id-input").fill(alice.id);
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("saved-chat-title")).toHaveText(
      "Saved messages",
    );

    const messageText = `Keyboard focus message ${Date.now()}`;
    await send(a.page, messageText);
    const row = a.page
      .getByTestId("message-row")
      .filter({ hasText: startsWithText(messageText) });
    const edit = row.getByTestId("edit-message");
    const remove = row.getByTestId("delete-message");
    await expect(edit).toBeVisible();
    await a.page.mouse.move(0, 0);
    await expect
      .poll(() => edit.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("0");

    await a.page.getByTestId("chat-menu").focus();
    let focusedEdit = false;
    for (let index = 0; index < 10; index += 1) {
      await a.page.keyboard.press("Tab");
      focusedEdit = await a.page.evaluate(
        () =>
          document.activeElement?.getAttribute("data-testid") ===
          "edit-message",
      );
      if (focusedEdit) break;
    }
    expect(focusedEdit).toBe(true);
    await expect
      .poll(() => edit.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("1");

    await a.page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    await expect
      .poll(() =>
        remove.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await expect
      .poll(() => edit.evaluate((element) => getComputedStyle(element).opacity))
      .toBe("0");
  });

  test("shows the empty saved messages row first with a hint", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const alice = await createAccount(a.page);

    const rows = a.page.locator('[data-testid="chat-item"]');
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute("data-peer-id", alice.id);
    await chatWith(a.page, alice.id).click();
    await expect(a.page.getByTestId("saved-chat-title")).toHaveText(
      "Saved messages",
    );
    await expect(a.page.getByTestId("saved-hint")).toHaveText(
      "Notes to yourself. They are stored encrypted and available on all your devices.",
    );
    await expect(a.page.getByLabel("Contact name (optional)")).toHaveCount(0);

    const b = await openUser(browser);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "A newer chat with Bob");
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(
      a.page.locator('[data-testid="chat-item"]').first(),
    ).toHaveAttribute("data-peer-id", alice.id);
    await expect(chatWith(a.page, alice.id)).toContainText("Saved messages");
  });

  test.afterEach(async () => {
    const errors = activeUsers.flatMap((user, index) =>
      user.errors.map((error) => `user ${index + 1}: ${error}`),
    );
    await Promise.all(activeUsers.map((user) => user.context.close()));
    expect(errors, "pageerror or console.error from any test user").toEqual([]);
  });

  test("two users exchange a message, get delivery status and unread count without auto-opening", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Hello from Alice");
    await expect(
      a.page.locator('[data-testid="message"][data-status="delivered"]'),
    ).toContainText("Hello from Alice");
    await expect(chatWith(b.page, alice.id)).toContainText("Hello from Alice");
    await expect(
      chatWith(b.page, alice.id).getByTestId("unread-count"),
    ).toHaveText("1");
    await expect(b.page.locator(".conversation-head")).toHaveCount(0);

    await chatWith(b.page, alice.id).click();
    await expect(b.page.getByTestId("message")).toContainText(
      "Hello from Alice",
    );
    await send(b.page, "Hi Alice");
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("Hi Alice") }),
    ).toBeVisible();
  });

  test("keeps the composer visible with long history and restores the latest preview", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);

    await a.page.setViewportSize({ width: 360, height: 760 });
    for (let index = 1; index <= 15; index++) {
      await send(a.page, `Long history message ${index}`);
      await expect(
        a.page
          .locator(".message-list .message-text")
          .filter({ hasText: startsWithText(`Long history message ${index}`) }),
      ).toBeVisible();
    }

    const input = a.page.getByTestId("message-input");
    const sendButton = a.page.getByTestId("send-message");
    await expect(input).toBeInViewport();
    await expect(sendButton).toBeInViewport();
    const messageList = a.page.locator(".message-list");
    expect(
      await messageList.evaluate(
        (list) => list.scrollHeight > list.clientHeight,
      ),
    ).toBe(true);
    expect(
      await messageList.evaluate((list) => list.scrollTop),
    ).toBeGreaterThan(0);
    await expect(
      a.page
        .locator('[data-testid="message"][data-direction="out"]')
        .filter({ hasText: startsWithText("Long history message 15") }),
    ).toHaveAttribute("data-status", /^(sent|delivered)$/u);

    await a.page.setViewportSize({ width: 1440, height: 900 });
    await expect(input).toBeInViewport();
    await expect(sendButton).toBeInViewport();
    await a.page.reload();
    const preview = chatWith(a.page, bob.id);
    await expect(preview).toContainText("Long history message 15");
    await expect(a.page.locator(".conversation-head")).toContainText(
      bob.id.slice(-10),
    );
    await expect(preview.locator(".chat-item-copy > span")).toHaveCSS(
      "white-space",
      "nowrap",
    );
  });

  test("restores every message after reload and sign-in across history pages", async ({
    browser,
  }) => {
    test.setTimeout(180_000);

    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await openChat(b.page, alice.id);

    const expected: string[] = [];
    for (let index = 1; index <= 52; index++) {
      const text = `Reload history ${String(index).padStart(2, "0")}`;
      const sender = index % 2 ? a.page : b.page;
      await send(sender, text);
      await expect(
        sender
          .locator(".message-list .message-text")
          .filter({ hasText: startsWithText(text) }),
      ).toBeVisible();
      await expect(
        sender
          .locator('[data-testid="message"][data-direction="out"]')
          .filter({ hasText: startsWithText(text) }),
      ).toHaveAttribute("data-status", /^(sent|delivered|read)$/u);
      expected.push(text);
    }

    await a.page.reload();
    await b.page.reload();
    for (const user of [a, b]) {
      await expect(user.page.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
    }
    await logout(a.page, alice.phrase);
    await logout(b.page, bob.phrase);
    expect(await signIn(a.page, alice.phrase)).toBe(alice.id);
    expect(await signIn(b.page, bob.phrase)).toBe(bob.id);

    for (const [user, peerId] of [
      [a, bob.id],
      [b, alice.id],
    ] as const) {
      await chatWith(user.page, peerId).click();
      await expect(user.page.locator(".conversation-head")).toContainText(
        peerId.slice(-10),
      );
      const messageTexts = user.page.locator(".message-list .message-text");
      await expect
        .poll(() => messageTexts.count())
        .toBeGreaterThanOrEqual(Math.min(50, expected.length));
      while ((await messageTexts.count()) < expected.length) {
        const previousCount = await messageTexts.count();
        const loadMore = user.page.locator(".message-list .load-more");
        await expect(loadMore).toBeVisible();
        await expect(loadMore).toBeEnabled();
        await loadMore.click();
        await expect
          .poll(() => messageTexts.count())
          .toBeGreaterThan(previousCount);
      }
      await expect(messageTexts).toHaveText(expected);
    }
  });

  test("offline mailbox delivers exactly two queued messages after sign-in", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    expect(await a.page.evaluate(() => history.state)).toEqual({
      chat: bob.id,
    });
    expect(a.page.url()).not.toContain(bob.id);
    await logout(b.page, bob.phrase);
    await send(a.page, "Queued one");
    await send(a.page, "Queued two");

    expect(await signIn(b.page, bob.phrase)).toBe(bob.id);
    const bobChat = chatWith(b.page, alice.id);
    await expect(bobChat).toBeVisible();
    await bobChat.click();
    await expect(b.page.locator(".message-list .message-text")).toHaveText([
      "Queued one",
      "Queued two",
    ]);
  });

  test("does not show a replayed ciphertext after reload", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await openChat(b.page, alice.id);
    await send(a.page, "Replay once");
    const bobMessages = b.page.locator(".message-list .message-text");
    await expect(bobMessages).toHaveText(["Replay once"]);

    const pool = new Pool({ connectionString: process.env.E2E_DATABASE_URL! });
    try {
      await pool.query(
        `INSERT INTO messages(sender_id, recipient_id, client_msg_id, ciphertext, sender_copy)
         SELECT sender_id, recipient_id, $3, ciphertext, sender_copy
         FROM messages WHERE sender_id=$1 AND recipient_id=$2
         ORDER BY seq DESC LIMIT 1`,
        [alice.id, bob.id, `replay-${crypto.randomUUID()}`],
      );
    } finally {
      await pool.end();
    }

    await b.page.reload();
    await openChat(b.page, alice.id);
    await expect(b.page.locator(".message-list .message-text")).toHaveText([
      "Replay once",
    ]);
  });

  test("restores conversations and encrypted contacts in a clean browser context", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await logout(b.page, bob.phrase);
    await send(a.page, "History survives a reload");
    await expect(
      a.page
        .locator('[data-testid="message"]')
        .filter({ hasText: /^History survives a reload/u }),
    ).toBeVisible();
    await a.page.locator(".contact-name-trigger").click();
    await expect(a.page.getByTestId("contact-peer-title")).toHaveText(
      "Not in your contacts",
    );
    await a.page.getByTestId("contact-peer-add").click();
    await a.page.getByTestId("contact-add-name").fill("Bob Contact");
    await a.page.getByTestId("contact-add-submit").click();
    await expect(a.page.getByTestId("contact-card-name")).toHaveText(
      "Bob Contact",
    );
    await a.page.getByTestId("contacts-back").click();
    await expect(a.page.locator(".conversation-head")).toContainText(
      "Bob Contact",
    );
    await a.page.goBack();
    await expect(a.page.locator(".chat-sidebar")).toBeVisible();
    await expect(a.page.locator(".empty-chat")).toBeVisible();
    await chatWith(a.page, bob.id).click();
    await expect(a.page.locator(".conversation-head")).toContainText(
      "Bob Contact",
    );
    await a.page.addInitScript(() => {
      const descriptor = Object.getOwnPropertyDescriptor(
        IDBRequest.prototype,
        "onsuccess",
      );
      const get = IDBObjectStore.prototype.get;
      IDBObjectStore.prototype.get = function (key) {
        const request = get.call(this, key);
        if (
          (key === "deviceKeys" || key === "derivedKeys") &&
          descriptor?.set
        ) {
          let callback: ((event: Event) => void) | null = null;
          Object.defineProperty(request, "onsuccess", {
            configurable: true,
            get: () => callback,
            set: (value: ((event: Event) => void) | null) => {
              callback = value;
              descriptor.set!.call(request, (event: Event) => {
                setTimeout(() => callback?.call(request, event), 500);
              });
            },
          });
        }
        return request;
      };
    });
    await a.page.reload();
    await expect(a.page.getByTestId("create-account")).toHaveCount(0);
    await expect(a.page.getByTestId("profile")).toBeVisible();
    await expect(chatWith(a.page, bob.id)).toContainText("Bob Contact");
    await chatWith(a.page, bob.id).click();
    await expect(a.page.locator(".message-list .message-text")).toContainText(
      "History survives a reload",
    );

    expect(await signIn(b.page, bob.phrase)).toBe(bob.id);
    const bobChat = chatWith(b.page, alice.id);
    await expect(bobChat).toBeVisible();
    await bobChat.click();
    await expect(b.page.locator(".message-list .message-text")).toContainText(
      "History survives a reload",
    );

    const clean = await openUser(browser);
    expect(await signIn(clean.page, alice.phrase)).toBe(alice.id);
    await expect(
      clean.page
        .locator('[data-testid="chat-item"]')
        .filter({ hasText: "Bob Contact" }),
    ).toBeVisible();
  });

  test("shows chats and sent history when contacts return 500 after reload", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await logout(b.page, bob.phrase);
    await send(a.page, "Persisted outgoing history");
    await expect(
      a.page.locator('[data-testid="message"][data-status="sent"]'),
    ).toContainText("Persisted outgoing history");

    a.expectedContactsFailure = true;
    await a.page.route("**/contacts", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: "{}",
      }),
    );
    await a.page.reload();
    const restoredChat = chatWith(a.page, bob.id);
    await expect(restoredChat).toBeVisible();
    await restoredChat.click();
    const restoredMessage = a.page
      .locator('[data-testid="message"]')
      .filter({ hasText: startsWithText("Persisted outgoing history") });
    await expect(restoredMessage).toBeVisible();
    await expect(restoredMessage).toHaveAttribute(
      "data-status",
      /^(sent|delivered)$/u,
    );
    await expect(
      a.page.getByText("Could not load contacts. Chats are shown with IDs."),
    ).toBeVisible();
  });

  test("both clients reconnect after the server restarts without reloading", async ({
    browser,
    serverControl,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Before outage");
    await expect(
      a.page.locator('[data-testid="message"][data-status="delivered"]'),
    ).toBeVisible();
    await openChat(b.page, alice.id);
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("Before outage") }),
    ).toBeVisible();

    a.expectedDisconnect = true;
    b.expectedDisconnect = true;
    await serverControl.stop();
    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "offline",
      { timeout: 20_000 },
    );
    await expect(b.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "offline",
      { timeout: 20_000 },
    );
    await send(b.page, "During outage");
    await expect(
      b.page.locator('[data-testid="message"][data-status="sending"]'),
    ).toContainText("During outage");
    await b.page.reload();
    try {
      await expect(b.page.getByTestId("profile")).toBeVisible();
      await expect(b.page.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "offline",
        { timeout: 20_000 },
      );
      const restoredChat = chatWith(b.page, alice.id);
      await expect(restoredChat).toBeVisible();
      await restoredChat.click();
      await expect(
        b.page.locator('[data-testid="message"][data-status="sending"]'),
      ).toContainText("During outage");
    } finally {
      await serverControl.start();
    }

    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
      { timeout: 45_000 },
    );
    await expect(b.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
      { timeout: 45_000 },
    );
    a.expectedDisconnect = false;
    b.expectedDisconnect = false;
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("During outage") }),
    ).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("Before outage") }),
    ).toBeVisible();
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: startsWithText("Before outage") }),
    ).toBeVisible();
  });

  test("incoming message from a third user does not change the active chat", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const c = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    const charlie = await createAccount(c.page);
    await openChat(a.page, bob.id);
    await startNewChatById(b.page);
    await b.page.getByTestId("peer-id-input").fill(alice.id);
    await b.page.getByTestId("new-chat").click();
    await startNewChatById(c.page);
    await c.page.getByTestId("peer-id-input").fill(alice.id);
    await c.page.getByTestId("new-chat").click();
    await send(c.page, "Hello Alice from Charlie");

    await expect(a.page.locator(".conversation-head")).toContainText(
      bob.id.slice(-10),
    );
    await expect(
      chatWith(a.page, charlie.id).getByTestId("unread-count"),
    ).toHaveText("1");
    await expect(a.page.locator(".message-list")).not.toContainText(
      "Hello Alice from Charlie",
    );
  });

  test("sign-out deletes IndexedDB session and re-entry preserves the account ID", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const account = await createAccount(user.page);
    await logout(user.page, account.phrase);
    const sessionDatabases = await user.page.evaluate(async () =>
      (await indexedDB.databases()).filter(
        (database) => database.name === "messages-session",
      ),
    );
    expect(sessionDatabases).toEqual([]);
    expect(await signIn(user.page, account.phrase)).toBe(account.id);
  });
  test("a wrong seed phrase keeps the session and shows an error", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    await createAccount(user.page);
    await user.page.getByTestId("profile").click();
    await user.page.getByTestId("logout").click();
    const phraseInput = user.page.getByTestId("logout-phrase");
    const wrongPhrase =
      "legal winner thank year wave sausage worth useful legal winner thank yellow";
    await phraseInput.fill(wrongPhrase);
    await user.page.getByTestId("logout-verify").click();
    await expect(user.page.getByTestId("logout-error")).toHaveText(
      "This phrase does not match your account. Check the words and their order.",
    );
    await expect(phraseInput).toHaveValue(wrongPhrase);
    await expect(user.page.getByTestId("profile")).toBeVisible();
    await expect(user.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(user.page.getByTestId("open-login")).toHaveCount(0);
  });

  test("signing out without checking shows the warning before leaving", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const account = await createAccount(user.page);
    await user.page.getByTestId("profile").click();
    await user.page.getByTestId("logout").click();
    await user.page.getByTestId("logout-skip").click();
    const skipPanel = user.page.getByRole("alertdialog");
    await expect(skipPanel).toContainText(
      "you will not be able to sign in to this account again",
    );
    await skipPanel.getByRole("button", { name: "Back" }).click();
    await expect(user.page.getByTestId("logout-phrase")).toBeVisible();
    await user.page.getByTestId("logout-skip").click();
    await user.page.getByTestId("confirm-logout").click();
    await expect(user.page.getByTestId("open-login")).toBeVisible();
    expect(account.id).toHaveLength(64);
  });

  test("logout panels stack their buttons at desktop and 360px", async ({
    browser,
  }) => {
    const buttonColors = async (button: Locator) =>
      button.evaluate((element) => {
        const style = getComputedStyle(element);
        return { backgroundColor: style.backgroundColor, color: style.color };
      });
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 360, height: 640 },
    ]) {
      const user = await openUser(browser);
      const page = user.page;
      await page.setViewportSize(viewport);
      await createAccount(page);
      await page.getByTestId("profile").click();
      await page.getByTestId("logout").click();
      await expectStackedButtons(page, [
        page.getByTestId("logout-verify"),
        page.getByTestId("logout-skip"),
        page.getByRole("button", { name: "Cancel", exact: true }),
      ]);
      const verifyColors = await buttonColors(
        page.getByTestId("logout-verify"),
      );
      const skipColors = await buttonColors(page.getByTestId("logout-skip"));
      expect(verifyColors.backgroundColor).not.toBe(skipColors.backgroundColor);
      expect(
        await page
          .getByTestId("logout-skip")
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
      ).not.toBe("0px");
      await page.getByTestId("logout-skip").click();
      await expectStackedButtons(page, [
        page.getByTestId("confirm-logout"),
        page.getByRole("button", { name: "Back", exact: true }),
      ]);
      expect(await buttonColors(page.getByTestId("confirm-logout"))).toEqual(
        skipColors,
      );
    }
  });

  test("Ukrainian profile language persists and fits a 360px viewport", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    const page = user.page;
    await page.setViewportSize({ width: 360, height: 740 });
    await createAccount(page);
    await page.getByTestId("profile").click();
    await page.getByRole("button", { name: "Language" }).click();
    await page.getByLabel("Language").selectOption("uk");
    await expect(page.locator("html")).toHaveAttribute("lang", "uk");
    await expect(page.getByTestId("profile")).toHaveAttribute(
      "aria-label",
      "Профіль",
    );
    await expect(page.getByTestId("connection-status")).toHaveAttribute(
      "aria-label",
      "підключено",
    );
    expect(
      await page.evaluate(() => localStorage.getItem("messages-lang")),
    ).toBe("uk");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("lang", "uk");
    await expect(page.getByRole("button", { name: "Новий чат" })).toBeVisible();

    const overflow = await page.evaluate(() => {
      const viewportWidth = document.documentElement.clientWidth;
      return [...document.querySelectorAll("h1, h2, button")]
        .filter((element) => {
          const style = getComputedStyle(element);
          return style.display !== "none" && style.visibility !== "hidden";
        })
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            text: element.textContent?.trim(),
            left: rect.left,
            right: rect.right,
            scrollWidth: element.scrollWidth,
            clientWidth: element.clientWidth,
            overflowX: getComputedStyle(element).overflowX,
          };
        })
        .filter(
          ({ left, right, scrollWidth, clientWidth, overflowX }) =>
            left < 0 ||
            right > viewportWidth ||
            (scrollWidth > clientWidth &&
              overflowX !== "auto" &&
              overflowX !== "scroll"),
        );
    });
    expect(overflow).toEqual([]);
  });

  test("new chat button fits the mobile viewport", async ({ browser }) => {
    const user = await openUser(browser);
    await user.page.setViewportSize({ width: 360, height: 640 });
    await createAccount(user.page);
    const fab = user.page.getByTestId("new-chat-toggle");
    await expect(fab).toBeVisible();
    const bounds = await fab.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.width).toBeGreaterThanOrEqual(40);
    expect(bounds!.height).toBeGreaterThanOrEqual(40);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(360 - 8);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(640 - 8);
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
  });

  test("new chat button hides while scrolling down and returns while scrolling up", async ({
    browser,
  }) => {
    const user = await openUser(browser);
    await user.page.setViewportSize({ width: 360, height: 640 });
    await createAccount(user.page);
    const fab = user.page.getByTestId("new-chat-toggle");
    const sidebar = user.page.locator(".chat-sidebar");
    await expect(fab).toBeVisible();
    await user.page.evaluate(() => {
      const sidebar = document.querySelector(".chat-sidebar");
      const spacer = document.createElement("div");
      spacer.style.height = "2000px";
      sidebar?.append(spacer);
    });
    await sidebar.evaluate((element) => {
      element.scrollTop = 600;
    });
    await expect(fab).toBeHidden();
    await sidebar.evaluate((element) => {
      element.scrollTop = 450;
    });
    await expect(fab).toBeVisible();
    await sidebar.evaluate((element) => {
      element.scrollTop = 0;
    });
    await expect(fab).toBeVisible();
  });

  test("new chat button stays in the desktop sidebar", async ({ browser }) => {
    const user = await openUser(browser);
    await user.page.setViewportSize({ width: 1280, height: 720 });
    await createAccount(user.page);
    const fab = user.page.getByTestId("new-chat-toggle");
    await expect(fab).toBeVisible();
    const bounds = await fab.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x + bounds!.width / 2).toBeLessThan(320);
    expect(bounds!.y).toBeGreaterThan(720 / 2);
  });

  test("chat layout, compact forms, profile controls and responsive navigation", async ({
    browser,
  }, testInfo) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    await expect(a.page.getByLabel("Language")).toHaveValue("en");
    await a.page.getByLabel("Language").selectOption("ru");
    await expect(
      a.page.getByRole("heading", { name: "Добро пожаловать" }),
    ).toBeVisible();
    await expect(a.page.locator("html")).toHaveAttribute("lang", "ru");
    await expect(a.page.locator("header")).not.toContainText("RU");
    await a.page.getByLabel("Язык").selectOption("en");
    await expect(
      a.page.getByRole("heading", { name: "Welcome" }),
    ).toBeVisible();
    await expect(a.page.locator("html")).toHaveAttribute("lang", "en");
    expect(
      await a.page.evaluate(() => localStorage.getItem("messages-lang")),
    ).toBe("en");
    await a.page.reload();
    await expect(
      a.page.getByRole("heading", { name: "Welcome" }),
    ).toBeVisible();
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await send(a.page, "Keep the chat in the conversation list");
    await expect(
      a.page.locator('[data-testid="message"][data-direction="out"]').filter({
        hasText: startsWithText("Keep the chat in the conversation list"),
      }),
    ).toHaveAttribute("data-status", /^(sent|delivered)$/u);
    await logout(a.page, alice.phrase);
    await a.page.setViewportSize({ width: 360, height: 640 });
    expect(await signIn(a.page, alice.phrase)).toBe(alice.id);
    await expect(a.page.locator(".chat-sidebar")).toBeVisible();
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(
      a.page.getByRole("button", { name: /New chat/u }),
    ).toBeVisible();
    await expect(
      a.page.getByText("Select a chat or start a new one."),
    ).toBeHidden();

    await a.page.setViewportSize({ width: 1280, height: 720 });
    await expect(a.page.locator(".chat-sidebar")).toBeVisible();
    await expect(
      a.page.getByText("Select a chat or start a new one."),
    ).toBeVisible();
    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "aria-label",
      "connected",
    );
    await expect(a.page.getByTestId("new-chat-form")).toHaveCount(0);
    await a.page.getByRole("button", { name: /New chat/u }).click();
    await expect(a.page.getByTestId("new-chat-screen")).toBeVisible();
    await expect(a.page.getByRole("button", { name: "Cancel" })).toHaveCount(0);
    await expect(a.page.getByTestId("new-chat-form")).toHaveCount(0);
    await expect(a.page.getByTestId("new-chat-by-id")).toBeVisible();
    await expect(a.page.getByTestId("new-chat-from-contacts")).toBeVisible();
    await a.page.getByTestId("new-chat-by-id").click();
    await expect(a.page.getByTestId("new-chat-form")).toBeVisible();
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("new-chat-error")).toBeVisible();
    await a.page.getByTestId("peer-id-input").fill(bob.id);
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("new-chat-form")).toHaveCount(0);
    await expect(a.page.locator(".conversation-head")).toContainText(
      bob.id.slice(-10),
    );

    await a.page.setViewportSize({ width: 360, height: 640 });
    await a.page.locator(".contact-name-trigger").click();
    const contactsBounds = await a.page
      .getByTestId("contacts-screen")
      .boundingBox();
    expect(contactsBounds).not.toBeNull();
    expect(contactsBounds!.x + contactsBounds!.width).toBeLessThanOrEqual(360);
    await a.page.keyboard.press("Escape");
    await expect(a.page.locator(".contact-name-trigger")).toBeVisible();

    await a.page.setViewportSize({ width: 1280, height: 720 });
    await expect(a.page.getByTestId("message-input")).toBeInViewport();
    await expect(a.page.getByTestId("send-message")).toBeInViewport();
    expect(
      await a.page
        .locator(".chat-sidebar")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(504);
    expect(
      await a.page
        .locator(".conversation")
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBeGreaterThanOrEqual(504);
    await a.page.screenshot({
      path: testInfo.outputPath("chat-desktop.png"),
      fullPage: true,
    });

    await a.page.setViewportSize({ width: 360, height: 640 });
    await expect(a.page.locator(".chat-sidebar")).toBeHidden();
    await expect(a.page.getByTestId("message-input")).toBeInViewport();
    expect(
      await a.page
        .locator(".conversation-head")
        .evaluate((el) => el.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(360);
    await a.page.getByTestId("profile").click();
    await a.page.getByRole("button", { name: "Language", exact: true }).click();
    await a.page.getByLabel("Language").selectOption("ru");
    await expect(a.page.locator("html")).toHaveAttribute("lang", "ru");
    await a.page.getByTestId("profile").click();
    await a.page.getByTestId("chat-menu").click();
    await expect(a.page.getByTestId("chat-menu-contact")).toHaveText(
      "Добавить в контакты",
    );
    await a.page.getByTestId("chat-menu-contact").click();
    await expect(a.page.getByTestId("contact-peer-title")).toHaveText(
      "Нет в ваших контактах",
    );
    await a.page.keyboard.press("Escape");
    await a.page.getByTestId("profile").click();
    await a.page.getByRole("button", { name: "Язык", exact: true }).click();
    await a.page.getByLabel("Язык").selectOption("en");
    await expect(a.page.locator("html")).toHaveAttribute("lang", "en");
    await a.page.getByTestId("profile").click();
    await a.page.screenshot({
      path: testInfo.outputPath("chat-mobile.png"),
      fullPage: true,
    });
    await a.page.getByRole("button", { name: "Back" }).click();
    await expect(a.page.locator(".chat-sidebar")).toBeVisible();
    await expect(a.page.locator(".conversation")).toBeHidden();
    await expect(
      a.page.getByRole("button", { name: /New chat/u }),
    ).toBeVisible();

    await a.page.getByTestId("profile").click();
    await expect(a.page.getByTestId("profile")).toHaveAttribute(
      "aria-label",
      "Profile",
    );
    await expect(a.page.getByTestId("profile")).toHaveAttribute(
      "title",
      "Profile",
    );
    expect(await a.page.getByTestId("profile").innerText()).toBe("");
    await a.page.getByRole("button", { name: "Language", exact: true }).click();
    await expect(a.page.getByLabel("Language")).toHaveValue("en");
    await a.page.getByLabel("Language").selectOption("ru");
    await expect(a.page.getByTestId("profile")).toHaveAttribute(
      "aria-label",
      "Профиль",
    );
    await expect(a.page.getByTestId("profile")).toHaveAttribute(
      "title",
      "Профиль",
    );
    await a.page.getByLabel("Язык").selectOption("en");
    await expect(a.page.getByTestId("user-id")).toHaveCount(0);
    await a.page.getByRole("button", { name: "User ID" }).click();
    await expect(a.page.getByTestId("user-id")).toBeVisible();
    await a.page.getByTestId("logout").click();
    await expect(a.page.getByRole("alertdialog")).toBeVisible();
    await a.page.getByRole("button", { name: "Cancel" }).click();
    await expect(a.page.getByTestId("profile")).toBeVisible();
    expect(alice.id).toHaveLength(64);
  });

  test("edits a sent message from the hover pencil and marks it for both users", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "First version");
    await send(a.page, "Width compare");
    await openChat(b.page, alice.id);
    const bobText = b.page.locator(".message-list .message-text");
    /* A row is matched by the beginning of its text, not by a substring. */
    const rowStart = (text: string) => new RegExp(`^${text}`, "u");
    await expect(
      bobText.filter({ hasText: rowStart("First version") }),
    ).toBeVisible();

    const rows = a.page.locator('[data-testid="message-row"]');
    const firstRow = rows.filter({ hasText: rowStart("First version") });
    const widthRow = rows.filter({ hasText: rowStart("Width compare") });
    const firstBubble = firstRow.getByTestId("message");
    const widthBubble = widthRow.getByTestId("message");
    await expect(firstBubble).toHaveAttribute("data-status", "read");
    await expect(widthBubble).toHaveAttribute("data-status", "read");

    // The pencil overlays the bubble's top edge.
    const pencil = firstRow.getByTestId("edit-message");
    const opacity = () =>
      pencil.evaluate((element) => getComputedStyle(element).opacity);
    const outline = (locator: typeof firstBubble) =>
      locator.evaluate((element) => getComputedStyle(element).outlineStyle);
    // The hover-only pencil stays in the DOM but is invisible until hovered.
    expect(await opacity()).toBe("0");
    await firstBubble.hover();
    await expect.poll(opacity).toBe("1");

    // Icon only: no caption, a 32x32 hit area and a 14-16px icon.
    expect((await pencil.innerText()).trim()).toBe("");
    expect(await pencil.getAttribute("aria-label")).toBe("Edit");
    const pencilBox = (await pencil.boundingBox())!;
    expect(pencilBox.width).toBeGreaterThanOrEqual(32);
    expect(pencilBox.height).toBeGreaterThanOrEqual(32);
    const iconSize = await pencil
      .locator("svg")
      .evaluate((icon) => Number.parseFloat(getComputedStyle(icon).width));
    expect(iconSize).toBeGreaterThanOrEqual(14);
    expect(iconSize).toBeLessThanOrEqual(16);

    // The draft written before the edit comes back when the mode is left.
    await a.page.getByTestId("message-input").fill("draft to keep");
    await firstBubble.hover();
    await pencil.click();
    await expect(a.page.getByTestId("edit-banner")).toContainText(
      "Editing message",
    );
    await expect(a.page.getByTestId("message-input")).toHaveValue(
      "First version",
    );
    await expect(a.page.getByTestId("message-input")).not.toBeFocused();
    // Only the message that is being edited gets the accent outline.
    expect(await outline(firstBubble)).toBe("solid");
    expect(await outline(widthBubble)).toBe("none");
    await a.page.getByTestId("message-input").press("Escape");
    await expect(a.page.getByTestId("edit-banner")).toHaveCount(0);
    expect(await outline(firstBubble)).toBe("none");
    await expect(a.page.getByTestId("message-input")).toHaveValue(
      "draft to keep",
    );

    // Empty and unchanged text cannot be sent.
    await a.page.getByTestId("message-input").fill("");
    await firstBubble.hover();
    await pencil.click();
    await expect(a.page.getByTestId("edit-banner")).toBeVisible();
    await expect(a.page.getByTestId("send-message")).toBeDisabled();
    await a.page.getByTestId("message-input").fill("");
    await expect(a.page.getByTestId("send-message")).toBeDisabled();
    await a.page.getByTestId("message-input").fill("Width compare");
    await expect(a.page.getByTestId("send-message")).toBeEnabled();
    await a.page.getByTestId("send-message").click();

    // Both users see the new text instead of the old one.
    await expect(a.page.getByTestId("edit-banner")).toHaveCount(0);
    await expect(a.page.getByTestId("message-input")).toHaveValue("");
    await expect(
      bobText.filter({ hasText: rowStart("First version") }),
    ).toHaveCount(0);
    await expect(
      bobText.filter({ hasText: rowStart("Width compare") }),
    ).toHaveCount(2);
    await expect(a.page.locator(".message-text")).toHaveCount(2);
    await expect(a.page.getByTestId("edited-mark")).toHaveCount(1);
    await expect(b.page.getByTestId("edited-mark")).toHaveCount(1);
    await expect(b.page.getByTestId("edited-mark")).toHaveText("edited");
    /* The edit replaced the same row: the peer has no extra bubble. */
    const bobRows = b.page.locator('[data-testid="message-row"]');
    await expect(bobRows).toHaveCount(2);
    await expect(rows).toHaveCount(2);
    await expect(bobRows.nth(0).locator(".message-text")).toHaveText(
      "Width compare",
    );

    // "edited" is a separate line under the status, with the same type.
    const markLayout = await b.page
      .getByTestId("edited-mark")
      .evaluate((element) => {
        const bubble = element.closest(".message")!;
        const status = bubble.querySelector('[data-testid="message-status"]')!;
        const text = bubble.querySelector(".message-text")!;
        const markStyle = getComputedStyle(element);
        const statusStyle = getComputedStyle(status);
        return {
          markTop: element.getBoundingClientRect().top,
          statusBottom: status.getBoundingClientRect().bottom,
          markDisplay: markStyle.display,
          markSize: Number.parseFloat(markStyle.fontSize),
          statusSize: Number.parseFloat(statusStyle.fontSize),
          markColor: markStyle.color,
          statusColor: statusStyle.color,
          textSize: Number.parseFloat(getComputedStyle(text).fontSize),
          textColor: getComputedStyle(text).color,
        };
      });
    expect(markLayout.markTop).toBeGreaterThanOrEqual(
      markLayout.statusBottom - 1,
    );
    expect(markLayout.markDisplay).toBe("block");
    expect(markLayout.markSize).toBe(markLayout.statusSize);
    expect(markLayout.markColor).toBe(markLayout.statusColor);
    expect(markLayout.markSize).toBeLessThan(markLayout.textSize);
    expect(markLayout.markColor).not.toBe(markLayout.textColor);

    // The note never widens a bubble: same text and status, different marks.
    const editedRow = rows.filter({ has: a.page.getByTestId("edited-mark") });
    const plainRow = rows.filter({
      hasNot: a.page.getByTestId("edited-mark"),
    });
    const editedBubble = editedRow.getByTestId("message");
    const plainBubble = plainRow.getByTestId("message");
    await expect(editedBubble).toHaveCount(1);
    await expect(plainBubble).toHaveCount(1);
    expect(await editedBubble.getAttribute("data-status")).toBe(
      await plainBubble.getAttribute("data-status"),
    );
    expect(await editedBubble.locator(".message-text").innerText()).toBe(
      await plainBubble.locator(".message-text").innerText(),
    );
    const editedBox = (await editedBubble.boundingBox())!;
    const plainBox = (await plainBubble.boundingBox())!;
    expect(editedBox.width).toBeLessThanOrEqual(plainBox.width + 1);

    // Narrow screen: the pencil overlays the bubble's top edge without overflow.
    await a.page.setViewportSize({ width: 360, height: 640 });
    await editedBubble.hover();
    const editedPencil = editedRow.getByTestId("edit-message");
    await expect
      .poll(() =>
        editedPencil.evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    const narrowPencil = (await editedPencil.boundingBox())!;
    const narrowBubble = (await editedBubble.boundingBox())!;
    const conversation = (await a.page.locator(".conversation").boundingBox())!;
    const messageList = a.page.locator(".message-list");
    const messageListBox = (await messageList.boundingBox())!;
    expect(narrowPencil.x).toBeGreaterThanOrEqual(conversation.x);
    expect(narrowPencil.x + narrowPencil.width).toBeLessThanOrEqual(
      conversation.x + conversation.width,
    );
    const pencilCenterX = narrowPencil.x + narrowPencil.width / 2;
    expect(pencilCenterX).toBeGreaterThanOrEqual(narrowBubble.x);
    expect(pencilCenterX).toBeLessThanOrEqual(
      narrowBubble.x + narrowBubble.width,
    );
    expect(narrowPencil.y).toBeLessThan(narrowBubble.y);
    expect(narrowPencil.y + narrowPencil.height).toBeGreaterThan(
      narrowBubble.y,
    );
    expect(narrowPencil.y + narrowPencil.height).toBeLessThanOrEqual(
      narrowBubble.y + 10,
    );
    expect(narrowPencil.y).toBeGreaterThanOrEqual(messageListBox.y);
    expect(narrowBubble.width / messageListBox.width).toBeLessThan(0.75);
    expect(
      await messageList.evaluate((list) => list.scrollWidth - list.clientWidth),
    ).toBeLessThanOrEqual(0);

    await editedPencil.click();
    const banner = a.page.getByTestId("edit-banner");
    await expect(banner).toBeVisible();
    const bannerBox = (await banner.boundingBox())!;
    expect(bannerBox.x).toBeGreaterThanOrEqual(0);
    expect(bannerBox.width).toBeLessThanOrEqual(360);
    expect(
      await banner.evaluate(
        (element) => element.scrollWidth - element.clientWidth,
      ),
    ).toBeLessThanOrEqual(0);
    expect(await outline(editedBubble)).toBe("solid");
    await a.page.getByTestId("cancel-edit").click();
    await expect(banner).toHaveCount(0);
    expect(await outline(editedBubble)).toBe("none");
    await expect(a.page.getByTestId("message-input")).toHaveValue("");
  });

  test("keeps the edit draft and shows the failure above the composer at 360px", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    /* A row is matched by the beginning of its text, not by a substring. */
    const rowStart = (text: string) => new RegExp(`^${text}`, "u");

    await openChat(a.page, bob.id);
    await send(a.page, "Version with connection");
    await expect(
      a.page.locator('[data-testid="message"][data-status="delivered"]'),
    ).toContainText("Version with connection");
    await openChat(b.page, alice.id);
    const bobText = b.page.locator(".message-list .message-text");
    await expect(
      bobText.filter({ hasText: rowStart("Version with connection") }),
    ).toBeVisible();

    await a.page.setViewportSize({ width: 360, height: 640 });
    const oldRow = a.page
      .getByTestId("message-row")
      .filter({ hasText: rowStart("Version with connection") });
    await oldRow.getByTestId("message").hover();
    await oldRow.getByTestId("edit-message").click();
    await expect(a.page.getByTestId("edit-banner")).toBeVisible();
    const edited = "Version without connection";
    await a.page.getByTestId("message-input").fill(edited);

    // Without a connection the PUT is cut off; the draft and the mode stay.
    const editRoute = async (route: import("@playwright/test").Route) => {
      if (route.request().method() === "PUT") await route.abort();
      else await route.continue();
    };
    await a.page.route("**/messages/**", editRoute);
    a.expectedEditFailure = true;
    await a.page.getByTestId("send-message").click();
    const composerError = a.page.getByTestId("composer-error");
    await expect(composerError).toHaveText(strings.en.serverUnavailable);
    a.expectedEditFailure = false;
    await expect(a.page.getByTestId("edit-banner")).toBeVisible();
    await expect(a.page.getByTestId("message-input")).toHaveValue(edited);
    const errorBox = (await composerError.boundingBox())!;
    expect(errorBox.x).toBeGreaterThanOrEqual(0);
    expect(errorBox.y).toBeGreaterThanOrEqual(0);
    expect(errorBox.width).toBeLessThanOrEqual(360);
    expect(errorBox.x + errorBox.width).toBeLessThanOrEqual(360);
    expect(errorBox.y + errorBox.height).toBeLessThanOrEqual(640);

    // The same tap goes through once the route is gone.
    await a.page.unroute("**/messages/**", editRoute);
    await a.page.getByTestId("send-message").click();
    await expect(a.page.getByTestId("composer-error")).toHaveCount(0);
    await expect(a.page.getByTestId("edit-banner")).toHaveCount(0);
    await expect(bobText.filter({ hasText: rowStart(edited) })).toBeVisible();
    await expect(
      bobText.filter({ hasText: rowStart("Version with connection") }),
    ).toHaveCount(0);
  });

  test("erases your own message for both sides and keeps the stub after reload", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Stays in the chat");
    await send(a.page, "Secret to erase");
    await openChat(b.page, alice.id);
    /* A row is matched by the beginning of its text, not by a substring. */
    const rowStart = (text: string) => new RegExp(`^${text}`, "u");
    const bobText = b.page.locator(".message-list .message-text");
    await expect(
      bobText.filter({ hasText: rowStart("Secret to erase") }),
    ).toBeVisible();

    const rows = a.page.locator('[data-testid="message-row"]');
    const rowWith = (text: string) => rows.filter({ hasText: rowStart(text) });
    const secretRow = rowWith("Secret to erase");
    const basket = secretRow.getByTestId("delete-message");
    /* The basket is icon-only and appears on hover of its own row. */
    await expect(basket).toHaveCount(1);
    expect((await basket.innerText()).trim()).toBe("");
    expect(await basket.getAttribute("aria-label")).toBe("Delete message");
    const opacity = (locator: typeof basket) =>
      locator.evaluate((element) => getComputedStyle(element).opacity);
    expect(await opacity(basket)).toBe("0");
    await secretRow.getByTestId("message").hover();
    await expect.poll(() => opacity(basket)).toBe("1");
    await basket.click();

    /* Nothing is erased before the confirmation. */
    const confirm = a.page.getByTestId("delete-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(
      "Delete this message? Its text will be erased on the server and for the other person.",
    );
    await expect(
      a.page.locator(".message-list .message-text").filter({
        hasText: rowStart("Secret to erase"),
      }),
    ).toBeVisible();
    await a.page.getByTestId("confirm-delete-message").click();

    /* Your own row keeps its place and becomes a stub. */
    await expect(a.page.getByTestId("message-deleted")).toHaveCount(1);
    await expect(a.page.getByTestId("message-deleted")).toHaveText(
      "You deleted this message",
    );
    await expect(rows).toHaveCount(2);
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: rowStart("Stays in the chat") }),
    ).toBeVisible();

    /* The peer gets the stub of an erased message instead of the text. */
    await expect(b.page.locator('[data-testid="message-row"]')).toHaveCount(2);
    await expect(b.page.getByTestId("message-deleted")).toHaveCount(1);
    await expect(b.page.getByTestId("message-deleted")).toHaveText(
      "The other person deleted this message",
    );

    /* Neither the chat nor the list of chats keeps the text anywhere. */
    expect(await a.page.content()).not.toContain("Secret to erase");
    expect(await b.page.content()).not.toContain("Secret to erase");
    await expect(
      chatWith(a.page, bob.id).locator(".chat-item-copy > span"),
    ).toHaveText("Message deleted");
    await expect(
      chatWith(b.page, alice.id).locator(".chat-item-copy > span"),
    ).toHaveText("Message deleted");

    /* After a reload the stub comes from the history on both sides. */
    await a.page.reload();
    await b.page.reload();
    for (const user of [a, b]) {
      await expect(user.page.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
      );
    }
    await expect(a.page.getByTestId("message-deleted")).toHaveText(
      "You deleted this message",
    );
    await expect(b.page.getByTestId("message-deleted")).toHaveText(
      "The other person deleted this message",
    );
    await expect(a.page.locator('[data-testid="message-row"]')).toHaveCount(2);
    await expect(b.page.locator('[data-testid="message-row"]')).toHaveCount(2);
    expect(await a.page.content()).not.toContain("Secret to erase");
    expect(await b.page.content()).not.toContain("Secret to erase");
  });
  test("uses a Saved messages deletion confirmation without peer wording", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const alice = await createAccount(a.page);
    await startNewChatById(a.page);
    await a.page.getByTestId("peer-id-input").fill(alice.id);
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("saved-chat-title")).toHaveText(
      "Saved messages",
    );
    await send(a.page, "Saved-only note");
    const row = a.page
      .locator('[data-testid="message-row"]')
      .filter({ hasText: /^Saved-only note/u });
    await row.getByTestId("message").hover();
    await row.getByTestId("delete-message").click();

    const confirmation = a.page.getByTestId("delete-confirm");
    await expect(confirmation).toBeVisible();
    await expect(confirmation).toContainText("Delete this note?");
    expect(await confirmation.innerText()).not.toMatch(/peer|other person/u);
    await a.page.getByTestId("cancel-delete-message").click();
  });
  test("shows the stub to a peer who was away when the message was erased", async ({
    browser,
  }) => {
    test.setTimeout(180_000);
    const a = await openUser(browser);
    let b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Erased while away");
    await openChat(b.page, alice.id);
    const rowStart = (text: string) => new RegExp(`^${text}`, "u");
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: rowStart("Erased while away") }),
    ).toBeVisible();

    /* Bob closes the tab, so the frame of the deletion reaches nobody. */
    await b.context.close();

    const rows = a.page.locator('[data-testid="message-row"]');
    const rowWith = (text: string) => rows.filter({ hasText: rowStart(text) });
    await rowWith("Erased while away").getByTestId("message").hover();
    await rowWith("Erased while away").getByTestId("delete-message").click();
    await a.page.getByTestId("confirm-delete-message").click();
    await expect(a.page.getByTestId("message-deleted")).toHaveText(
      "You deleted this message",
    );

    /* Bob opens the app again: the history gives a stub instead of the text. */
    b = await openUser(browser);
    await signIn(b.page, bob.phrase);
    await openChat(b.page, alice.id);
    await expect(b.page.locator('[data-testid="message-row"]')).toHaveCount(1);
    await expect(b.page.getByTestId("message-deleted")).toHaveCount(1);
    await expect(b.page.getByTestId("message-deleted")).toHaveText(
      "The other person deleted this message",
    );
    expect(await b.page.content()).not.toContain("Erased while away");
  });
  test.describe("contacts screen", () => {
    async function openContacts(page: Page) {
      await page.getByTestId("profile").click();
      await page.getByTestId("profile-contacts").click();
      await expect(page.getByTestId("contacts-screen")).toBeVisible();
    }
    async function addContact(
      page: Page,
      id: string,
      name: string,
      note: string,
    ) {
      await page.getByTestId("contact-add-open").click();
      await page.getByTestId("contact-add-id").fill(id);
      await page.getByTestId("contact-add-name").fill(name);
      await page.getByTestId("contact-add-note").fill(note);
      await page.getByTestId("contact-add-submit").click();
    }

    test("adds, edits, copies, removes, and persists a contact", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      const aliceAccount = await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await alice.context.grantPermissions([
        "clipboard-read",
        "clipboard-write",
      ]);
      await openContacts(alice.page);
      await expect(alice.page.getByText("No contacts yet.")).toBeVisible();
      await addContact(alice.page, "bad-id", "Bob", "");
      await expect(alice.page.getByTestId("contact-add-error")).toBeVisible();
      await alice.page.getByTestId("contacts-back").click();
      await addContact(alice.page, aliceAccount.id, "Me", "");
      await expect(alice.page.getByTestId("contact-add-error")).toBeVisible();
      await alice.page.getByTestId("contacts-back").click();
      alice.expectedUserNotFoundFailure = true;
      await addContact(alice.page, "f".repeat(64), "Unknown", "");
      await expect(alice.page.getByTestId("contact-add-error")).toBeVisible();
      alice.expectedUserNotFoundFailure = false;
      await alice.page.getByTestId("contacts-back").click();
      await addContact(alice.page, bobAccount.id, "", "");
      await expect(alice.page.getByTestId("contact-add-error")).toBeVisible();
      await alice.page.getByTestId("contact-add-name").fill("Bob Contact");
      await alice.page
        .getByTestId("contact-add-note")
        .fill("Met at the station");
      await alice.page.getByTestId("contact-add-submit").click();
      const row = alice.page.locator(
        `[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`,
      );
      await expect(row).toContainText("Bob Contact");
      await expect(row).toContainText(bobAccount.id.slice(-10));
      await expect(row).toContainText("Met at the station");
      await row.click();
      await expect(alice.page.getByTestId("contact-card-id")).toHaveText(
        bobAccount.id,
      );
      await expect(alice.page.getByTestId("contact-card-note")).toHaveText(
        "Met at the station",
      );
      await alice.page.getByTestId("contacts-back").click();
      await expect(row).toBeVisible();
      await expect(alice.page.getByTestId("contact-card-id")).toHaveCount(0);
      await expect(alice.page.getByTestId("contacts-screen")).toBeVisible();
      await alice.page.getByTestId("contact-add-open").click();
      await alice.page.getByTestId("contacts-back").click();
      await expect(row).toBeVisible();
      await expect(alice.page.getByTestId("contacts-screen")).toBeVisible();
      await row.click();
      await alice.page
        .getByRole("button", { name: "Edit description" })
        .click();
      await alice.page.getByTestId("contact-note-input").press("Escape");
      await expect(alice.page.getByTestId("contact-card-id")).toBeVisible();
      await expect(
        alice.page.getByRole("button", { name: "Edit description" }),
      ).toBeFocused();
      await alice.page.keyboard.press("Escape");
      await expect(row).toBeVisible();
      await expect(alice.page.getByTestId("contacts-screen")).toBeVisible();
      await row.click();
      await alice.page.getByRole("button", { name: "Edit name" }).click();
      await alice.page.getByTestId("contact-name-input").fill("Robert");
      await alice.page.getByTestId("contact-save-name").click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Robert",
      );
      await expect(
        alice.page.getByRole("button", { name: "Edit name" }),
      ).toBeFocused();
      await alice.page.keyboard.press("Escape");
      await expect(row).toBeVisible();
      await row.click();
      await alice.page
        .getByRole("button", { name: "Edit description" })
        .click();
      await alice.page
        .getByTestId("contact-note-input")
        .fill("Long-time friend");
      await alice.page.getByTestId("contact-note-input").press("Enter");
      await expect(alice.page.getByTestId("contact-card-note")).toHaveText(
        "Long-time friend",
      );
      await alice.page.getByRole("button", { name: "Edit name" }).click();
      await alice.page.getByTestId("contact-name-input").fill("");
      await alice.page.getByTestId("contact-save-name").click();
      await expect(alice.page.getByTestId("contact-name-error")).toBeVisible();
      await expect(alice.page.getByTestId("contact-name-input")).toBeVisible();
      await alice.page.getByRole("button", { name: "Cancel" }).click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Robert",
      );
      await alice.page.getByRole("button", { name: "Copy ID" }).click();
      await expect
        .poll(() => alice.page.evaluate(() => navigator.clipboard.readText()))
        .toBe(bobAccount.id);
      await alice.page.getByTestId("contact-remove").click();
      await expect(
        alice.page.getByTestId("contact-remove-confirm"),
      ).toBeVisible();
      await alice.page.getByTestId("contacts-back").click();
      await expect(
        alice.page.getByTestId("contact-remove-confirm"),
      ).toHaveCount(0);
      await expect(alice.page.getByTestId("contact-card-id")).toBeVisible();
      await alice.page.getByTestId("contact-remove").click();
      await alice.page.getByTestId("contact-remove-confirm").click();
      await expect(alice.page.getByText("No contacts yet.")).toBeVisible();
      await addContact(
        alice.page,
        bobAccount.id,
        "Robert",
        "Keep after reload",
      );
      await alice.page.reload();
      await openContacts(alice.page);
      await row.click();
      await expect(alice.page.getByTestId("contact-card-note")).toHaveText(
        "Keep after reload",
      );
    });

    test("phone keyboard line break saves an edited contact name", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page.getByRole("button", { name: "Edit name" }).click();
      await alice.page.getByTestId("contact-name-input").evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(field, "New name\n");
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertCompositionText",
            data: "\n",
          }),
        );
      });
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "New name",
      );
      await expect(alice.page.getByTestId("contact-name-input")).toHaveCount(0);
    });

    test("phone keyboard line break saves an edited contact description", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page
        .getByRole("button", { name: "Edit description" })
        .click();
      await alice.page.getByTestId("contact-note-input").evaluate((element) => {
        const field = element as HTMLTextAreaElement;
        const setter = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        )!.set!;
        setter.call(field, "New description\n");
        field.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertCompositionText",
            data: "\n",
          }),
        );
      });
      await expect(alice.page.getByTestId("contact-card-note")).toHaveText(
        "New description",
      );
      await expect(alice.page.getByTestId("contact-note-input")).toHaveCount(0);
    });

    test("writing opens the chat and deleting chat preserves contact", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page.getByTestId("contact-write").click();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await expect(alice.page.locator(".conversation-head")).toContainText(
        "Bob",
      );
      await send(alice.page, "Delete this chat");
      await alice.page.getByTestId("chat-menu").click();
      await alice.page.getByTestId("delete-chat").click();
      await alice.page.getByTestId("confirm-delete-chat").click();
      await expect(chatWith(alice.page, bobAccount.id)).toHaveCount(0);
      await openContacts(alice.page);
      await expect(
        alice.page.locator(
          `[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`,
        ),
      ).toBeVisible();
    });

    test("shows each contact card error once, in its own place", async ({
      browser,
      serverControl,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      const bobAccount = await createAccount(bob.page);
      await createAccount(alice.page);
      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "Description");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();

      const card = alice.page.locator(".contacts-card");
      const expectOneCardAlert = async () => {
        await expect(card.locator('[role="alert"]:visible')).toHaveCount(1);
      };

      await alice.page
        .getByRole("button", { name: "Edit description" })
        .click();
      await alice.page.getByTestId("contact-note-input").fill("x".repeat(201));
      await alice.page.getByTestId("contact-save-note").click();
      await expect(alice.page.getByTestId("contact-note-error")).toBeVisible();
      await expectOneCardAlert();
      await expect(alice.page.getByTestId("contact-write-error")).toHaveCount(
        0,
      );
      await expect(alice.page.getByTestId("contact-remove-error")).toHaveCount(
        0,
      );
      await alice.page.getByRole("button", { name: "Cancel" }).click();

      await alice.page.evaluate(() => {
        Object.defineProperty(navigator, "clipboard", {
          configurable: true,
          value: { writeText: () => Promise.reject(new Error("blocked")) },
        });
        document.execCommand = () => false;
      });
      await alice.page.getByRole("button", { name: "Copy ID" }).click();
      await expect(alice.page.getByTestId("contact-copy-error")).toBeVisible();
      await expectOneCardAlert();

      alice.expectedDisconnect = true;
      await serverControl.stop();
      try {
        await alice.page.getByTestId("contact-remove").click();
        await alice.page.getByTestId("contact-remove-confirm").click();
        await expect(
          alice.page.getByTestId("contact-remove-error"),
        ).toBeVisible();
        await expectOneCardAlert();
        await expect(alice.page.getByTestId("contact-write-error")).toHaveCount(
          0,
        );
        await alice.page.getByTestId("contact-remove-cancel").click();
      } finally {
        await serverControl.start();
      }
      await expect(alice.page.getByTestId("connection-status")).toHaveAttribute(
        "data-state",
        "connected",
        { timeout: 45_000 },
      );
      alice.expectedDisconnect = false;
      await alice.page.getByTestId("contact-remove").click();
      await alice.page.getByTestId("contact-remove-confirm").click();
      await expect(alice.page.getByText("No contacts yet.")).toBeVisible();
    });

    test("contacts window closes with the phone Back button", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await alice.page.setViewportSize({ width: 360, height: 800 });
      const url = alice.page.url();

      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page.goBack();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await expect(alice.page.getByTestId("contact-card-id")).toHaveCount(0);
      await expect(alice.page.getByTestId("contact-row")).toHaveCount(0);
      await expect(alice.page.getByTestId("profile")).toBeVisible();
      await expect(alice.page.locator(".messenger")).not.toHaveClass(
        /show-chat/u,
      );
      expect(alice.page.url()).toBe(url);

      await openContacts(alice.page);
      await alice.page.getByTestId("contacts-back").click();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      expect(
        await alice.page.evaluate(
          () => (history.state as { contacts?: boolean } | null)?.contacts,
        ),
      ).not.toBe(true);

      await openContacts(alice.page);
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page.getByTestId("contact-write").click();
      await expect(alice.page.locator(".conversation-head")).toContainText(
        "Bob",
      );
      await openContacts(alice.page);
      await alice.page.goBack();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await expect(alice.page.locator(".conversation-head")).toContainText(
        "Bob",
      );
    });

    test("chat header opens contact card, menu item and Back keep the chat", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await alice.page.setViewportSize({ width: 360, height: 800 });
      await openChat(alice.page, bobAccount.id);

      await alice.page.getByTestId("chat-menu").click();
      await expect(alice.page.getByTestId("chat-menu-contact")).toHaveText(
        "Add to contacts",
      );
      await alice.page.getByTestId("chat-menu-contact").click();
      await expect(alice.page.getByTestId("contact-peer-title")).toHaveText(
        "Not in your contacts",
      );
      await expect(alice.page.getByTestId("contact-write")).toHaveCount(0);
      await alice.page.getByTestId("contact-peer-add").click();
      await alice.page.getByTestId("contact-add-submit").click();
      await expect(alice.page.getByTestId("contact-add-error")).toBeVisible();
      await alice.page.getByTestId("contact-add-name").fill("Bob Contact");
      await alice.page.getByTestId("contact-add-submit").click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Bob Contact",
      );
      await expect(alice.page.getByTestId("contact-write")).toHaveCount(0);
      await alice.page.getByTestId("contacts-back").click();
      await expect(alice.page.locator(".contact-name-trigger")).toContainText(
        "Bob Contact",
      );

      await alice.page.getByTestId("chat-menu").click();
      await expect(alice.page.getByTestId("chat-menu-contact")).toHaveText(
        "Contact card",
      );
      await alice.page.getByTestId("chat-menu-contact").click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Bob Contact",
      );
      await alice.page.goBack();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await expect(alice.page.locator(".contact-name-trigger")).toBeVisible();
      await expect(alice.page.locator(".chat-sidebar")).toBeHidden();
    });

    test("contact card from the header closes with Escape and shows no Write button", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await openChat(alice.page, bobAccount.id);
      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob Contact", "");
      await alice.page.getByTestId("contacts-back").click();

      await alice.page.locator(".contact-name-trigger").click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Bob Contact",
      );
      await expect(alice.page.getByTestId("contact-write")).toHaveCount(0);
      await alice.page.keyboard.press("Escape");
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await expect(alice.page.locator(".conversation-head")).toBeVisible();

      await openContacts(alice.page);
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await expect(alice.page.getByTestId("contact-card-name")).toHaveText(
        "Bob Contact",
      );
      await expect(alice.page.getByTestId("contact-write")).toBeVisible();
      await alice.page.getByTestId("contacts-back").click();
      await expect(alice.page.getByTestId("contact-row")).toBeVisible();
    });

    test("chat opened from contacts goes back to the chat list", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await alice.page.setViewportSize({ width: 360, height: 800 });
      const url = alice.page.url();

      await openContacts(alice.page);
      await addContact(alice.page, bobAccount.id, "Bob", "");
      await alice.page
        .locator(`[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`)
        .click();
      await alice.page.getByTestId("contact-write").click();
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      await alice.page.goBack();
      await expect(alice.page.locator(".messenger")).not.toHaveClass(
        /show-chat/u,
      );
      await expect(alice.page.getByTestId("contacts-screen")).toHaveCount(0);
      expect(alice.page.url()).toBe(url);
    });

    test("contact card editor and name row do not stick together", async ({
      browser,
    }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);

      for (const width of [360, 1280]) {
        await alice.page.setViewportSize({ width, height: 800 });
        await openContacts(alice.page);
        await addContact(alice.page, bobAccount.id, "Bob", "Description");
        await alice.page
          .locator(
            `[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`,
          )
          .click();
        const measureAnchors = () =>
          alice.page.evaluate(() => {
            const id = document.querySelector<HTMLElement>(
              "[data-testid=contact-card-id]",
            )!;
            const write = document.querySelector<HTMLElement>(
              "[data-testid=contact-write]",
            )!;
            return {
              idY: id.getBoundingClientRect().top,
              writeY: write.getBoundingClientRect().top,
            };
          });
        const assertInlineEditor = async (
          fieldTestId: string,
          saveTestId: string,
          cancelTestId: string,
        ) => {
          const before = await measureAnchors();
          await alice.page
            .getByRole("button", {
              name:
                fieldTestId === "contact-name-input"
                  ? "Edit name"
                  : "Edit description",
            })
            .click();
          const field = alice.page.getByTestId(fieldTestId);
          const saveButton = alice.page.getByTestId(saveTestId);
          const cancelButton = alice.page.getByTestId(cancelTestId);
          await expect(field).toBeVisible();
          await expect(saveButton).toBeVisible();
          await expect(cancelButton).toBeVisible();
          const layout = await alice.page.evaluate(
            ({ fieldTestId, saveTestId, cancelTestId }) => {
              const field = document
                .querySelector<HTMLElement>(`[data-testid=${fieldTestId}]`)!
                .getBoundingClientRect();
              const buttons = [saveTestId, cancelTestId].map((testId) =>
                document
                  .querySelector<HTMLElement>(`[data-testid=${testId}]`)!
                  .getBoundingClientRect(),
              );
              const body =
                document.querySelector<HTMLElement>(".contacts-body")!;
              const id = document.querySelector<HTMLElement>(
                "[data-testid=contact-card-id]",
              )!;
              const write = document.querySelector<HTMLElement>(
                "[data-testid=contact-write]",
              )!;
              return {
                fieldRight: field.right,
                buttonRects: buttons.map((rect) => ({
                  left: rect.left,
                  right: rect.right,
                  width: rect.width,
                  height: rect.height,
                })),
                idY: id.getBoundingClientRect().top,
                writeY: write.getBoundingClientRect().top,
                bodyScrollWidth: body.scrollWidth,
                bodyClientWidth: body.clientWidth,
              };
            },
            { fieldTestId, saveTestId, cancelTestId },
          );
          expect(
            layout.buttonRects.every(
              (rect) => rect.width >= 40 && rect.height >= 40,
            ),
          ).toBe(true);
          expect(
            Math.min(...layout.buttonRects.map((rect) => rect.left)) -
              layout.fieldRight,
          ).toBeGreaterThanOrEqual(8);
          expect(layout.buttonRects.at(-1)!.right).toBeLessThanOrEqual(width);
          expect(Math.abs(layout.idY - before.idY)).toBeLessThanOrEqual(1);
          expect(Math.abs(layout.writeY - before.writeY)).toBeLessThanOrEqual(
            1,
          );
          expect(layout.bodyScrollWidth).toBeLessThanOrEqual(
            layout.bodyClientWidth,
          );
          await cancelButton.click();
          const after = await measureAnchors();
          expect(Math.abs(after.idY - before.idY)).toBeLessThanOrEqual(1);
          expect(Math.abs(after.writeY - before.writeY)).toBeLessThanOrEqual(1);
        };

        const controls = await alice.page.evaluate(() => {
          const nameEdit = document.querySelector<HTMLElement>(
            "[aria-label='Edit name']",
          )!;
          const noteEdit = document.querySelector<HTMLElement>(
            "[aria-label='Edit description']",
          )!;
          const back = document.querySelector<HTMLElement>(
            "[data-testid=contacts-back]",
          )!;
          const body = document.querySelector<HTMLElement>(".contacts-body")!;
          return {
            nameEdit: nameEdit.getBoundingClientRect().toJSON(),
            noteEdit: noteEdit.getBoundingClientRect().toJSON(),
            back: back.getBoundingClientRect().toJSON(),
            bodyScrollWidth: body.scrollWidth,
            bodyClientWidth: body.clientWidth,
          };
        });
        for (const rect of [
          controls.nameEdit,
          controls.noteEdit,
          controls.back,
        ]) {
          expect(rect.width).toBeGreaterThanOrEqual(40);
          expect(rect.height).toBeGreaterThanOrEqual(40);
        }
        expect(controls.bodyScrollWidth).toBeLessThanOrEqual(
          controls.bodyClientWidth,
        );
        await assertInlineEditor(
          "contact-name-input",
          "contact-save-name",
          "contact-cancel-name",
        );
        await assertInlineEditor(
          "contact-note-input",
          "contact-save-note",
          "contact-cancel-note",
        );

        await alice.page.getByTestId("contact-remove").click();
        await alice.page.getByTestId("contact-remove-confirm").click();
        await alice.page.reload();
      }
    });

    test("wraps the contact card at 360px", async ({ browser }) => {
      const alice = await openUser(browser);
      const bob = await openUser(browser);
      await createAccount(alice.page);
      const bobAccount = await createAccount(bob.page);
      await alice.page.setViewportSize({ width: 360, height: 800 });
      await openContacts(alice.page);
      await addContact(
        alice.page,
        bobAccount.id,
        "A".repeat(64),
        "N".repeat(200),
      );
      const row = alice.page.locator(
        `[data-testid="contact-row"][data-peer-id="${bobAccount.id}"]`,
      );
      const listLayout = await row.evaluate((element) => {
        const body = document.querySelector<HTMLElement>(".contacts-body")!;
        const name = element.querySelector<HTMLElement>("strong")!;
        return {
          row: element.getBoundingClientRect().toJSON(),
          name: {
            right: name.getBoundingClientRect().right,
            scrollWidth: name.scrollWidth,
            clientWidth: name.clientWidth,
          },
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
        };
      });
      expect(listLayout.row.height).toBeGreaterThanOrEqual(44);
      expect(listLayout.row.right).toBeLessThanOrEqual(360);
      expect(listLayout.name.scrollWidth).toBeLessThanOrEqual(
        listLayout.name.clientWidth,
      );
      expect(listLayout.name.right).toBeLessThanOrEqual(360);
      expect(listLayout.bodyScrollWidth).toBeLessThanOrEqual(
        listLayout.bodyClientWidth,
      );
      await row.click();
      const layout = await alice.page.evaluate(() => {
        const overlay = document.querySelector<HTMLElement>(
          "[data-testid=contacts-screen]",
        )!;
        const id = document.querySelector<HTMLElement>(
          "[data-testid=contact-card-id]",
        )!;
        const name = document.querySelector<HTMLElement>(
          "[data-testid=contact-card-name]",
        )!;
        const note = document.querySelector<HTMLElement>(
          "[data-testid=contact-card-note]",
        )!;
        const body = document.querySelector<HTMLElement>(".contacts-body")!;
        const buttons = [
          ...document.querySelectorAll<HTMLElement>(".contacts-card button"),
        ];
        return {
          rect: overlay.getBoundingClientRect().toJSON(),
          position: getComputedStyle(overlay).position,
          pageWidth: document.documentElement.scrollWidth,
          idScroll: id.scrollWidth,
          idClient: id.clientWidth,
          bodyScrollWidth: body.scrollWidth,
          bodyClientWidth: body.clientWidth,
          nameRight: name.getBoundingClientRect().right,
          nameScrollWidth: name.scrollWidth,
          nameClientWidth: name.clientWidth,
          noteRight: note.getBoundingClientRect().right,
          noteScrollWidth: note.scrollWidth,
          noteClientWidth: note.clientWidth,
          buttons: buttons.map((b) => ({
            height: b.getBoundingClientRect().height,
            right: b.getBoundingClientRect().right,
          })),
        };
      });
      expect(layout.position).toBe("fixed");
      expect(layout.rect.x).toBe(0);
      expect(layout.rect.width).toBe(360);
      expect(layout.pageWidth).toBeLessThanOrEqual(360);
      expect(layout.bodyScrollWidth).toBeLessThanOrEqual(
        layout.bodyClientWidth,
      );
      expect(layout.idScroll).toBeLessThanOrEqual(layout.idClient);
      expect(layout.nameScrollWidth).toBeLessThanOrEqual(
        layout.nameClientWidth,
      );
      expect(layout.nameRight).toBeLessThanOrEqual(360);
      expect(layout.noteScrollWidth).toBeLessThanOrEqual(
        layout.noteClientWidth,
      );
      expect(layout.noteRight).toBeLessThanOrEqual(360);
      expect(
        layout.buttons.every(
          (button) => button.height >= 40 && button.right <= 360,
        ),
      ).toBe(true);
    });
  });

  test("new chat from contacts opens the chosen contact", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.getByTestId("profile").click();
    await alice.page.getByTestId("profile-contacts").click();
    await expect(alice.page.getByTestId("contacts-screen")).toBeVisible();
    await alice.page.getByTestId("contact-add-open").click();
    await alice.page.getByTestId("contact-add-id").fill(bobAccount.id);
    await alice.page.getByTestId("contact-add-name").fill("Bob Contact");
    await alice.page.getByTestId("contact-add-submit").click();
    await expect(alice.page.getByTestId("contact-row")).toContainText(
      "Bob Contact",
    );
    await alice.page.getByTestId("contacts-back").click();

    await alice.page.setViewportSize({ width: 360, height: 640 });
    await alice.page.getByRole("button", { name: /New chat/u }).click();
    const modalBounds = await alice.page
      .getByTestId("new-chat-screen")
      .boundingBox();
    expect(modalBounds).not.toBeNull();
    expect(Math.abs(modalBounds!.width - 360)).toBeLessThanOrEqual(1);
    const choices = [
      alice.page.getByTestId("new-chat-from-contacts"),
      alice.page.getByTestId("new-chat-by-id"),
    ];
    for (const choice of choices) {
      const box = await choice.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.height).toBeGreaterThanOrEqual(40);
      expect(box!.x + box!.width).toBeLessThanOrEqual(360);
    }
    await expect(
      alice.page.getByRole("button", { name: "Cancel" }),
    ).toHaveCount(0);
    await alice.page.getByTestId("new-chat-from-contacts").click();
    await expect(alice.page.getByTestId("new-chat-screen")).toBeVisible();
    await expect(
      alice.page.getByRole("heading", { name: "Choose a contact" }),
    ).toBeVisible();
    await alice.page.getByTestId("contact-row").click();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await expect(alice.page.locator(".conversation-head")).toBeVisible();
    await expect(alice.page.locator(".contact-name-trigger")).toContainText(
      "Bob Contact",
    );
    await alice.page.goBack();
    await expect(alice.page.locator(".chat-sidebar")).toBeVisible();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await alice.page.setViewportSize({ width: 1280, height: 720 });
    await expect(alice.page.locator(".empty-chat")).toBeVisible();
  });

  test("new chat menu text is centered and ID fields do not autofocus", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    await createAccount(alice.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await alice.page.getByRole("button", { name: /New chat/u }).click();
    const idChoice = alice.page.getByRole("button", { name: /^By ID/u });
    const textCenterDifference = await idChoice.evaluate((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const textBounds = range.getBoundingClientRect();
      const buttonBounds = button.getBoundingClientRect();
      return Math.abs(
        textBounds.left +
          textBounds.width / 2 -
          (buttonBounds.left + buttonBounds.width / 2),
      );
    });
    expect(textCenterDifference).toBeLessThanOrEqual(2);
    await idChoice.click();
    await expect(alice.page.getByTestId("peer-id-input")).not.toBeFocused();
    await expect(
      alice.page.getByLabel(/^Name \(optional\)$/u),
    ).not.toBeFocused();
  });

  test("new chat ID fields are single-line textareas on a phone viewport", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    await createAccount(alice.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await startNewChatById(alice.page);

    for (const field of [
      alice.page.getByTestId("peer-id-input"),
      alice.page.getByLabel(/^Name \(optional\)$/u),
    ]) {
      const layout = await field.evaluate((element) => ({
        tagName: element.tagName,
        scrollHeight: element.scrollHeight,
        clientHeight: element.clientHeight,
        height: element.getBoundingClientRect().height,
      }));
      expect(layout.tagName).toBe("TEXTAREA");
      expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight);
      expect(layout.height).toBeGreaterThanOrEqual(36);
      expect(layout.height).toBeLessThanOrEqual(56);
    }
  });

  test("Enter submits the new chat ID without adding a line break", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await startNewChatById(alice.page);
    const idField = alice.page.getByTestId("peer-id-input");
    await idField.fill(bobAccount.id);
    await idField.press("Enter");
    expect(await idField.inputValue()).not.toMatch(/[\r\n]/u);
    await expect(alice.page.locator(".conversation-head")).toBeVisible();
  });

  test("phone keyboard line break submits the new chat ID", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await startNewChatById(alice.page);
    await alice.page.getByTestId("peer-id-input").evaluate((element, id) => {
      const field = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(field, `${id}\n`);
      field.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertCompositionText",
          data: "\n",
        }),
      );
    }, bobAccount.id);
    await expect(alice.page.locator(".conversation-head")).toBeVisible();
  });

  test("pasted line breaks are stripped without submitting the new chat ID", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    await createAccount(alice.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await startNewChatById(alice.page);
    const field = alice.page.getByTestId("peer-id-input");
    await field.evaluate((element) => {
      const textarea = element as HTMLTextAreaElement;
      const setter = Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        "value",
      )!.set!;
      setter.call(textarea, "ab\ncd");
      textarea.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertFromPaste",
          data: "ab\ncd",
        }),
      );
    });
    await expect(field).toBeVisible();
    await expect(field).toHaveValue("abcd");
    await expect(alice.page.locator(".conversation-head")).toHaveCount(0);
  });

  test("contact add forms open without focusing their fields", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });

    await alice.page.getByTestId("profile").click();
    await alice.page.getByTestId("profile-contacts").click();
    await expect(alice.page.getByTestId("contacts-screen")).toBeVisible();
    await alice.page.getByTestId("contact-add-open").click();
    await expect(alice.page.getByTestId("contact-add-id")).toBeVisible();
    await expect(alice.page.getByTestId("contact-add-id")).not.toBeFocused();
    await alice.page.getByTestId("contacts-back").click();
    await alice.page.getByTestId("contacts-back").click();

    await openChat(alice.page, bobAccount.id);
    await alice.page.locator(".contact-name-trigger").click();
    await expect(alice.page.getByTestId("contact-peer-title")).toBeVisible();
    await alice.page.getByTestId("contact-peer-add").click();
    await expect(alice.page.getByTestId("contact-add-name")).toBeVisible();
    await expect(alice.page.getByTestId("contact-add-name")).not.toBeFocused();
  });

  test("new chat from contacts shows a hint when there are no contacts", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await alice.page.getByRole("button", { name: /New chat/u }).click();
    await alice.page.getByTestId("new-chat-from-contacts").click();
    await expect(
      alice.page.getByText("No contacts yet. Start a chat by ID."),
    ).toBeVisible();
    await alice.page.keyboard.press("Escape");
    await expect(alice.page.getByTestId("new-chat-by-id")).toBeVisible();
    await alice.page.keyboard.press("Escape");
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await startNewChatById(alice.page);
    await expect(alice.page.getByTestId("new-chat-name-hint")).toBeVisible();
    const hintLayout = await alice.page
      .getByTestId("new-chat-name-hint")
      .evaluate((el) => ({
        height: el.getBoundingClientRect().height,
        line: Number.parseFloat(getComputedStyle(el).lineHeight),
        scroll: el.scrollWidth,
        client: el.clientWidth,
      }));
    expect(hintLayout.height).toBeGreaterThanOrEqual(hintLayout.line);
    expect(hintLayout.scroll).toBeLessThanOrEqual(hintLayout.client);
    await alice.page.getByTestId("peer-id-input").fill(bobAccount.id);
    await alice.page.getByLabel("Name (optional)").fill("Zed");
    await alice.page.getByTestId("new-chat").click();
    await expect(alice.page.locator(".conversation-head")).toBeVisible();
    await expect(alice.page.locator(".contact-name-trigger")).toContainText(
      "Zed",
    );
  });

  test("new chat window: arrow and phone Back go step by step", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    await createAccount(alice.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await alice.page.evaluate(() => {
      const originalPushState = window.history.pushState.bind(window.history);
      const trackedWindow = window as Window & { __pushCount: number };
      trackedWindow.__pushCount = 0;
      window.history.pushState = (...args) => {
        trackedWindow.__pushCount += 1;
        originalPushState(...args);
      };
    });
    const initialPushCount = await alice.page.evaluate(
      () => (window as Window & { __pushCount: number }).__pushCount,
    );
    const open = () =>
      alice.page.getByRole("button", { name: /New chat/u }).click();
    await open();
    const pushCountAfterOpen = await alice.page.evaluate(
      () => (window as Window & { __pushCount: number }).__pushCount,
    );
    expect(pushCountAfterOpen).toBe(initialPushCount + 1);
    const url = alice.page.url();
    await alice.page.getByTestId("new-chat-by-id").click();
    await alice.page.goBack();
    await alice.page.waitForFunction(() => history.state?.newChat === true);
    await expect(alice.page.getByTestId("new-chat-screen")).toBeVisible();
    const pushCountAfterFirstBack = await alice.page.evaluate(
      () => (window as Window & { __pushCount: number }).__pushCount,
    );
    expect(pushCountAfterFirstBack).toBe(pushCountAfterOpen);
    await expect(alice.page.getByTestId("new-chat-form")).toHaveCount(0);
    await expect(alice.page.getByTestId("new-chat-by-id")).toBeVisible();
    await expect(alice.page.getByTestId("new-chat-screen")).toBeVisible();
    expect(alice.page.url()).toBe(url);
    await alice.page.goBack();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await expect(alice.page.getByTestId("chat-list")).toBeVisible();
    await open();
    await alice.page.getByTestId("new-chat-from-contacts").click();
    await alice.page.getByTestId("new-chat-back").click();
    await expect(alice.page.getByTestId("new-chat-by-id")).toBeVisible();
    await alice.page.getByTestId("new-chat-back").click();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await open();
    await alice.page.keyboard.press("Escape");
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
  });

  test("phone Back from new chat contacts returns to menu, then closes window", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    await createAccount(alice.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await alice.page.getByRole("button", { name: /New chat/u }).click();
    await alice.page.getByTestId("new-chat-from-contacts").click();
    await expect(
      alice.page.getByText("No contacts yet. Start a chat by ID."),
    ).toBeVisible();

    await alice.page.goBack();
    await alice.page.waitForFunction(() => history.state?.newChat === true);
    await expect(alice.page.getByTestId("new-chat-by-id")).toBeVisible();
    await alice.page.goBack();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await expect(alice.page.getByTestId("chat-list")).toBeVisible();
  });

  test("new chat window opens a chat and Back returns to the chat list", async ({
    browser,
  }) => {
    const alice = await openUser(browser);
    const bob = await openUser(browser);
    await createAccount(alice.page);
    const bobAccount = await createAccount(bob.page);
    await alice.page.setViewportSize({ width: 360, height: 640 });
    await startNewChatById(alice.page);
    await alice.page.getByTestId("peer-id-input").fill(bobAccount.id);
    await alice.page.getByLabel("Name (optional)").fill("Zed");
    await alice.page.getByTestId("new-chat").click();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await expect(alice.page.locator(".contact-name-trigger")).toContainText(
      "Zed",
    );
    await alice.page.goBack();
    await expect(alice.page.locator(".chat-sidebar")).toBeVisible();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
    await alice.page.getByRole("button", { name: /New chat/u }).click();
    await alice.page.getByTestId("new-chat-from-contacts").click();
    await alice.page
      .getByTestId("contact-row")
      .filter({ hasText: "Zed" })
      .click();
    await expect(alice.page.locator(".contact-name-trigger")).toContainText(
      "Zed",
    );
    await alice.page.goBack();
    await expect(alice.page.locator(".chat-sidebar")).toBeVisible();
    await expect(alice.page.getByTestId("new-chat-screen")).toHaveCount(0);
  });

  test("syncs renamed and removed contacts to another device without reloading", async ({
    browser,
  }) => {
    const first = await openUser(browser);
    const bobUser = await openUser(browser);
    const alice = await createAccount(first.page);
    const bob = await createAccount(bobUser.page);
    await openChat(first.page, bob.id);
    await first.page.getByTestId("profile").click();
    await first.page.getByTestId("profile-contacts").click();
    await first.page.getByTestId("contact-add-open").click();
    await first.page.getByTestId("contact-add-id").fill(bob.id);
    await first.page.getByTestId("contact-add-name").fill("Bob Original");
    await first.page.getByTestId("contact-add-submit").click();
    await expect(first.page.getByTestId("contact-row")).toContainText(
      "Bob Original",
    );
    await first.page.getByTestId("contact-row").click();
    await first.page.getByTestId("contacts-back").click();
    await first.page.getByTestId("contacts-back").click();
    await expect(first.page.locator(".contact-name-trigger")).toContainText(
      "Bob Original",
    );

    const second = await openUser(browser);
    expect(await signIn(second.page, alice.phrase)).toBe(alice.id);
    const secondChat = chatWith(second.page, bob.id);
    await expect(secondChat).toHaveText(startsWithText("Bob Original"));

    await first.page.locator(".contact-name-trigger").click();
    await first.page.getByRole("button", { name: "Edit name" }).click();
    await first.page.getByTestId("contact-name-input").fill("Bob Renamed");
    await first.page.getByTestId("contact-save-name").click();
    await expect(first.page.getByTestId("contact-card-name")).toHaveText(
      "Bob Renamed",
    );
    await first.page.getByTestId("contacts-back").click();
    await expect(secondChat).toHaveText(startsWithText("Bob Renamed"));

    await first.page.locator(".contact-name-trigger").click();
    await first.page.getByTestId("contact-remove").click();
    await first.page.getByTestId("contact-remove-confirm").click();
    await expect(first.page.getByTestId("contact-peer-title")).toBeVisible();
    await first.page.getByTestId("contacts-back").click();
    await expect(secondChat).toHaveText(startsWithText(bob.id.slice(-10)));
  });
});
