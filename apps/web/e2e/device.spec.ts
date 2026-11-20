import { expect, test, type Page } from "@playwright/test";

async function addEnglish(page: Page) {
  await page.addInitScript(() => {
    try {
      localStorage.setItem("messages-lang", "en");
    } catch {
      /* About:blank has no origin. */
    }
  });
}

async function createAccount(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-account").click();
  await page.getByRole("button", { name: "Continue" }).click();
  const words = await page
    .getByTestId("seed-phrase")
    .locator("li > span:last-child")
    .allTextContents();
  const inputs = page.locator('form input[autocomplete="off"]');
  for (let i = 0; i < (await inputs.count()); i++) {
    const prompt = await inputs.nth(i).locator("xpath=..").innerText();
    const position = Number(prompt.match(/#(\d+)/)?.[1]);
    await inputs.nth(i).fill(words[position - 1]!.trim());
  }
  await page.getByLabel("I have saved the phrase").check();
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  return words.map((word) => word.trim()).join(" ");
}

async function signIn(page: Page, phrase: string) {
  await page.goto("/");
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
}

async function readSessionStore(
  page: Page,
): Promise<{ keys: unknown[]; values: unknown }> {
  return page.evaluate(async () => {
    const databases = await indexedDB.databases();
    if (!databases.some((database) => database.name === "messages-session"))
      return { keys: [], values: {} };
    const request = indexedDB.open("messages-session");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    if (!db.objectStoreNames.contains("keys")) {
      db.close();
      return { keys: [], values: {} };
    }
    const keys = await new Promise<string[]>((resolve, reject) => {
      const get = db.transaction("keys").objectStore("keys").getAllKeys();
      get.onsuccess = () => resolve(get.result as string[]);
      get.onerror = () => reject(get.error);
    });
    const values = await new Promise<Record<string, unknown>>(
      (resolve, reject) => {
        const store = db.transaction("keys").objectStore("keys");
        const output: Record<string, unknown> = {};
        let pending = keys.length;
        if (!pending) {
          db.close();
          resolve(output);
          return;
        }
        for (const key of keys) {
          const get = store.get(key);
          get.onsuccess = () => {
            output[key] = get.result;
            pending--;
            if (!pending) {
              db.close();
              resolve(output);
            }
          };
          get.onerror = () => reject(get.error);
        }
      },
    );
    return { keys, values };
  });
}

test("new account stores device keys and reload keeps the device login", async ({
  page,
}) => {
  await addEnglish(page);
  await createAccount(page);
  const stored = await readSessionStore(page);
  expect(stored.keys).toContain("deviceKeys");
  expect(stored.keys).not.toContain("derivedKeys");
  expect(stored.values.deviceKeys).not.toHaveProperty("identity");
  await page.reload();
  await expect(page.getByTestId("profile")).toBeVisible();
});

test("revoke-others signs out another device and allows sign-in again", async ({
  browser,
}) => {
  const first = await browser.newContext();
  await first.addInitScript(() => {
    try {
      localStorage.setItem("messages-lang", "en");
    } catch {
      /* About:blank has no origin. */
    }
  });
  const firstPage = await first.newPage();
  const phrase = await createAccount(firstPage);

  const second = await browser.newContext();
  await second.addInitScript(() => {
    try {
      localStorage.setItem("messages-lang", "en");
    } catch {
      /* About:blank has no origin. */
    }
  });
  const secondPage = await second.newPage();
  await signIn(secondPage, phrase);
  const secondStore = await readSessionStore(secondPage);
  const session = secondStore.values.serverSession as { token: string };

  await secondPage.evaluate(async (token) => {
    await fetch("http://localhost:3000/devices/revoke-others", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: "{}",
    });
  }, session.token);

  await expect(firstPage.getByTestId("device-revoked-notice")).toBeVisible();
  expect((await readSessionStore(firstPage)).keys).toHaveLength(0);
  await signIn(firstPage, phrase);
});

test("429 registration error is visible and no keys are saved", async ({
  page,
}) => {
  await addEnglish(page);
  await page.route("**/auth/challenge", (route) =>
    route.fulfill({
      status: 429,
      contentType: "application/json",
      body: JSON.stringify({ error: "rate_limit" }),
    }),
  );
  await page.goto("/");
  await page.getByTestId("create-account").click();
  await page.getByRole("button", { name: "Continue" }).click();
  const words = await page
    .getByTestId("seed-phrase")
    .locator("li > span:last-child")
    .allTextContents();
  const inputs = page.locator('form input[autocomplete="off"]');
  for (let i = 0; i < (await inputs.count()); i++) {
    const prompt = await inputs.nth(i).locator("xpath=..").innerText();
    const position = Number(prompt.match(/#(\d+)/)?.[1]);
    await inputs.nth(i).fill(words[position - 1]!.trim());
  }
  await page.getByLabel("I have saved the phrase").check();
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(
    page.getByRole("alert").filter({ hasText: /^Could not sign in/ }),
  ).toBeVisible();
  expect((await readSessionStore(page)).keys).not.toContain("deviceKeys");

  await page.unroute("**/auth/challenge");
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
});

test("PIN unlock works with a device account", async ({ page }) => {
  await addEnglish(page);
  await createAccount(page);
  await page.getByTestId("profile").click();
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  await page.getByRole("button", { name: "Enable PIN" }).click();
  await page.getByPlaceholder("New PIN").first().fill("secure123");
  await page.getByPlaceholder("Confirm PIN").first().fill("secure123");
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByRole("button", { name: "Change PIN" })).toBeVisible();

  expect((await readSessionStore(page)).keys).not.toContain("deviceKeys");
  await page.reload();
  await page.getByLabel("PIN").fill("secure123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await expect(page.getByTestId("connection-status")).toHaveAttribute(
    "data-state",
    "connected",
  );
});
