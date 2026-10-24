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
    localStorage.setItem("messages-language", "en");
  });
  const page = await context.newPage();
  const user: User = { context, page, errors: [], expectedDisconnect: false };
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
    // Chromium emits this network diagnostic during the deliberately stopped-server window.
    if (!expectedSocketRefusal && !expectedApiRefusal)
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
  await expect(page.getByTestId("user-id")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-state",
    "connected",
  );
  return { phrase, id: (await page.getByTestId("user-id").innerText()).trim() };
}

async function signIn(page: Page, phrase: string): Promise<string> {
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("user-id")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-state",
    "connected",
  );
  return (await page.getByTestId("user-id").innerText()).trim();
}

async function logout(page: Page): Promise<void> {
  await page.getByTestId("logout").click();
  await page.getByTestId("confirm-logout").click();
  await expect(page.getByTestId("open-login")).toBeVisible();
}

async function openChat(page: Page, peerId: string): Promise<void> {
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
  test.beforeEach(() => {
    activeUsers = [];
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

  test("offline mailbox delivers exactly two queued messages after sign-in", async ({
    browser,
  }) => {
    const a = await openUser(browser);
    const b = await openUser(browser);
    const alice = await createAccount(a.page);
    const bob = await createAccount(b.page);
    await openChat(a.page, bob.id);
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
      .getByLabel("Contact name (optional)")
      .fill("Bob Contact");
    await a.page.getByRole("button", { name: "Save name" }).click();
    await expect(a.page.locator(".conversation-head")).toContainText(
      "Bob Contact",
    );
    await a.page.reload();
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
    await b.page.reload();
    try {
      await expect(b.page.getByTestId("user-id")).toBeVisible();
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
    await b.page.getByTestId("peer-id-input").fill(alice.id);
    await b.page.getByTestId("new-chat").click();
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
});
