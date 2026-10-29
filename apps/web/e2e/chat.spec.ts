import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type User = {
  context: BrowserContext;
  page: Page;
  errors: string[];
  expectedDisconnect: boolean;
  expectedContactsFailure: boolean;
  expectedDeleteFailure: boolean;
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

async function openUser(browser: Browser): Promise<User> {
  const context = await browser.newContext();
  await context.addInitScript(() => {
    localStorage.setItem("messages-lang", "en");
  });
  const page = await context.newPage();
  const user: User = {
    context,
    page,
    errors: [],
    expectedDisconnect: false,
    expectedContactsFailure: false,
    expectedDeleteFailure: false,
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
    // Chromium reports the intentionally aborted DELETE route as a console error.
    const expectedDeleteFailure =
      user.expectedDeleteFailure &&
      message.text() === "Failed to load resource: net::ERR_FAILED";
    // Chromium emits this network diagnostic during the deliberately stopped-server window.
    if (
      !expectedSocketRefusal &&
      !expectedApiRefusal &&
      !expectedContactsFailure &&
      !expectedDeleteFailure
    )
      user.errors.push(`console.error: ${message.text()}`);
  });
  await page.goto("/");
  activeUsers.push(user);
  return user;
}

async function createAccount(
  page: Page,
): Promise<{ phrase: string; id: string }> {
  await page.getByTestId("create-account").click();
  await page.getByLabel("Number of words").selectOption("12");
  await page.getByRole("button", { name: "Continue" }).click();
  const words = (
    await page.getByTestId("seed-phrase").locator("li").allTextContents()
  ).map((word) => word.trim());
  const phrase = words.join(" ");
  const verificationInputs = page.locator('form input[autocomplete="off"]');
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

async function logout(page: Page): Promise<void> {
  await page.getByTestId("profile").click();
  await page.getByTestId("logout").click();
  await page.getByTestId("confirm-logout").click();
  await expect(page.getByTestId("open-login")).toBeVisible();
}

async function openChat(page: Page, peerId: string): Promise<void> {
  await page.getByRole("button", { name: /New chat/u }).click();
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

test.describe("real browser chat", () => {
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

    await logout(b.page);
    await send(a.page, "Read this after reconnecting");
    await expect(
      a.page.locator(
        '[data-testid="message"][data-direction="out"][data-status="sent"]',
      ),
    ).toContainText("Read this after reconnecting");
    await logout(a.page);
    expect(await signIn(b.page, bob.phrase)).toBe(bob.id);
    await chatWith(b.page, alice.id).click();
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: "Read this after reconnecting" }),
    ).toBeVisible();
    expect(await signIn(a.page, alice.phrase)).toBe(alice.id);
    await chatWith(a.page, bob.id).click();
    await expect(
      a.page
        .locator('[data-testid="message"][data-direction="out"]')
        .filter({ hasText: "Read this after reconnecting" }),
    ).toHaveAttribute("data-status", "read");
  });

  test("deletes a chat only for Alice, keeps it deleted after reload, and shows Bob's new message", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);

    await openChat(a.page, bob.id);
    await send(a.page, "Old conversation");
    await openChat(b.page, alice.id);
    await expect(b.page.locator(".message-list .message-text")).toContainText(
      "Old conversation",
    );

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await expect(a.page.getByRole("alertdialog")).toContainText(
      "The conversation will be deleted only for you, on all your devices.",
    );
    await a.page.getByRole("button", { name: "Cancel" }).click();
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(a.page.locator(".message-list .message-text")).toContainText(
      "Old conversation",
    );

    await a.page.getByTestId("chat-menu").click();
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await expect(b.page.locator(".message-list .message-text")).toContainText(
      "Old conversation",
    );

    await a.page.reload();
    await expect(a.page.getByTestId("connection-status")).toHaveAttribute(
      "data-state",
      "connected",
    );
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await send(b.page, "A new conversation");
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await chatWith(a.page, bob.id).click();
    await expect(a.page.locator(".message-list .message-text")).toHaveText([
      "A new conversation",
    ]);
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
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(a.page.getByRole("alertdialog")).toContainText(
      "Could not delete the conversation. Check your connection and try again.",
    );
    a.expectedDeleteFailure = false;
    await expect(chatWith(a.page, bob.id)).toBeVisible();
    await expect(a.page.locator(".message-list .message-text")).toContainText(
      "Keep me if deletion fails",
    );

    await a.page.unroute("**/conversations/**", deleteRoute);
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
  });

  test("removes a cleared chat from another window without reloading at 360px", async ({
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
    await expect(chatWith(secondWindow, bob.id)).toBeVisible();
    await a.page.setViewportSize({ width: 360, height: 780 });
    await a.page.getByTestId("chat-menu").click();
    await expect(a.page.getByTestId("chat-menu")).toBeVisible();
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(360);
    await a.page.getByTestId("delete-chat").click();
    await a.page.getByTestId("confirm-delete-chat").click();
    await expect(chatWith(a.page, bob.id)).toHaveCount(0);
    await expect(chatWith(secondWindow, bob.id)).toHaveCount(0);
    await expect(a.page.locator(".messenger")).not.toHaveClass(/show-chat/u);
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
        .filter({ hasText: "Hi Alice" }),
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
          .filter({ hasText: `Long history message ${index}` }),
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
        .filter({ hasText: "Long history message 15" }),
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
        sender.locator(".message-list .message-text").filter({ hasText: text }),
      ).toBeVisible();
      await expect(
        sender
          .locator('[data-testid="message"][data-direction="out"]')
          .filter({ hasText: text }),
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
    await logout(a.page);
    await logout(b.page);
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
    await logout(b.page);
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

  test("restores conversations and encrypted contacts in a clean browser context", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
    await logout(b.page);
    await send(a.page, "History survives a reload");
    await expect(
      a.page
        .locator('[data-testid="message"]')
        .filter({ hasText: "History survives a reload" }),
    ).toBeVisible();
    await a.page
      .locator(".conversation-head")
      .locator(".contact-name-trigger")
      .click();
    await a.page
      .locator(".conversation-head")
      .getByLabel("Contact name (optional)")
      .fill("Bob Contact");
    await a.page.getByRole("button", { name: "Save name" }).click();
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
        if (key === "derivedKeys" && descriptor?.set) {
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
    await logout(b.page);
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
      .filter({ hasText: "Persisted outgoing history" });
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
        .filter({ hasText: "Before outage" }),
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
        .filter({ hasText: "During outage" }),
    ).toBeVisible({
      timeout: 45_000,
    });
    await expect(
      a.page
        .locator(".message-list .message-text")
        .filter({ hasText: "Before outage" }),
    ).toBeVisible();
    await expect(
      b.page
        .locator(".message-list .message-text")
        .filter({ hasText: "Before outage" }),
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
    await b.page.getByRole("button", { name: /New chat/u }).click();
    await b.page.getByTestId("peer-id-input").fill(alice.id);
    await b.page.getByTestId("new-chat").click();
    await c.page.getByRole("button", { name: /New chat/u }).click();
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
    await logout(user.page);
    const sessionDatabases = await user.page.evaluate(async () =>
      (await indexedDB.databases()).filter(
        (database) => database.name === "messages-session",
      ),
    );
    expect(sessionDatabases).toEqual([]);
    expect(await signIn(user.page, account.phrase)).toBe(account.id);
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
      a.page
        .locator('[data-testid="message"][data-direction="out"]')
        .filter({ hasText: "Keep the chat in the conversation list" }),
    ).toHaveAttribute("data-status", /^(sent|delivered)$/u);
    await logout(a.page);
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
    await expect(a.page.getByTestId("new-chat-form")).toBeVisible();
    await a.page.getByTestId("peer-id-input").fill(bob.id);
    await a.page.getByTestId("new-chat").click();
    await expect(a.page.getByTestId("new-chat-form")).toHaveCount(0);
    await expect(a.page.locator(".conversation-head")).toContainText(
      bob.id.slice(-10),
    );

    const nameButton = a.page.locator(".contact-name-trigger");
    await expect(a.page.getByRole("button", { name: "Save name" })).toHaveCount(
      0,
    );
    await nameButton.click();
    await a.page.getByLabel("Contact name (optional)").fill("Bob named");
    await expect(
      a.page.getByRole("button", { name: "Save name" }),
    ).toBeVisible();

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
    const mobileNameInput = a.page.getByLabel("Contact name (optional)");
    await expect(mobileNameInput).toBeInViewport();
    const inputBox = await mobileNameInput.boundingBox();
    const saveBox = await a.page
      .getByRole("button", { name: "Save name" })
      .boundingBox();
    expect(inputBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(inputBox!.width).toBeGreaterThan(250);
    expect(saveBox!.y).toBeGreaterThan(inputBox!.y);
    expect(
      await a.page
        .locator(".conversation-head")
        .evaluate((el) => el.getBoundingClientRect().right),
    ).toBeLessThanOrEqual(360);
    await a.page.getByRole("button", { name: "Cancel" }).click();
    await a.page.getByTestId("profile").click();
    await a.page.getByLabel("Language").selectOption("ru");
    await expect(a.page.locator("html")).toHaveAttribute("lang", "ru");
    await a.page.getByTestId("profile").click();
    await a.page.locator(".contact-name-trigger").click();
    await a.page.getByLabel("Имя контакта (необязательно)").fill("Боб");
    await expect(
      a.page.getByRole("button", { name: "Сохранить имя" }),
    ).toBeVisible();
    await a.page.getByRole("button", { name: "Отмена" }).click();
    await a.page.getByTestId("profile").click();
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
    await a.page.getByTestId("profile").click();
    await expect(a.page.getByTestId("user-id")).toHaveCount(0);
    await a.page.getByRole("button", { name: "User ID" }).click();
    await expect(a.page.getByTestId("user-id")).toBeVisible();
    await a.page.getByTestId("logout").click();
    await expect(a.page.getByRole("alertdialog")).toBeVisible();
    await a.page.getByRole("button", { name: "Cancel" }).click();
    await expect(a.page.getByTestId("profile")).toBeVisible();
    expect(alice.id).toHaveLength(64);
  });
});
