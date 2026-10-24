import {
  expect,
  test as base,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

type User = { context: BrowserContext; page: Page; errors: string[] };
type Fixtures = {
  serverControl: { stop(): Promise<void>; start(): Promise<void> };
};
const test = base.extend<Fixtures>({
  serverControl: async ({}, use) => {
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
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error")
      errors.push(`console.error: ${message.text()}`);
  });
  await page.goto("/");
  const user = { context, page, errors };
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
  return { phrase, id: (await page.getByTestId("user-id").innerText()).trim() };
}

async function signIn(page: Page, phrase: string): Promise<string> {
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("user-id")).toBeVisible();
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
  return page
    .locator('[data-testid="chat-item"]')
    .filter({ has: page.locator(`text=${peerId.slice(-10)}`) });
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
    await expect(b.page.getByTestId("message")).toContainText(
      "Hello from Alice",
    );
    await expect(
      chatWith(b.page, alice.id).getByTestId("unread-count"),
    ).toHaveText("1");
    await expect(b.page.locator(".conversation-head")).toHaveCount(0);

    await chatWith(b.page, alice.id).click();
    await send(b.page, "Hi Alice");
    await expect(a.page.getByTestId("message")).toContainText("Hi Alice");
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
    await expect(
      b.page
        .locator('[data-testid="message"]')
        .filter({ hasText: /^Queued (one|two)$/ }),
    ).toHaveCount(2);
    await expect(b.page.getByTestId("message")).toContainText([
      "Queued one",
      "Queued two",
    ]);
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
    await b.page.getByTestId("peer-id-input").fill(alice.id);
    await b.page.getByTestId("new-chat").click();

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
    await serverControl.start();

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
    await expect(a.page.getByTestId("message")).toContainText("During outage", {
      timeout: 45_000,
    });
    await expect(a.page.getByTestId("message")).toContainText("Before outage");
    await expect(b.page.getByTestId("message")).toContainText("Before outage");
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
    await expect(a.page.getByTestId("message")).not.toContainText(
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
