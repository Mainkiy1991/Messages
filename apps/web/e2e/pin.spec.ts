import { expect, test, type Page } from "@playwright/test";

async function createAccount(page: Page): Promise<string> {
  await page.goto("/");
  await page.getByTestId("create-account").click();
  await page.getByRole("button", { name: "Continue" }).click();
  const words = (
    await page.getByTestId("seed-phrase").locator("li").allTextContents()
  ).map((word) => word.trim());
  const inputs = page.locator('form input[autocomplete="off"]');
  for (let i = 0; i < (await inputs.count()); i++) {
    const prompt = await inputs.nth(i).locator("xpath=..").innerText();
    const position = Number(prompt.match(/#(\d+)/)?.[1]);
    await inputs.nth(i).fill(words[position - 1]!);
  }
  await page.getByLabel("I have saved the phrase").check();
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  return words.join(" ");
}
async function enablePin(page: Page) {
  await page.getByTestId("profile").click();
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  await page.getByRole("button", { name: "Enable PIN" }).click();
  await page.getByPlaceholder("New PIN").first().fill("secure123");
  await page.getByPlaceholder("Confirm PIN").first().fill("secure123");
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByRole("button", { name: "Change PIN" })).toBeVisible();
}

test("PIN locks the page on reload and unlocks after a wrong attempt", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  const phrase = await createAccount(page);
  await enablePin(page);
  const stored = await page.evaluate(async () => {
    const request = indexedDB.open("messages-session");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const values = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction("keys").objectStore("keys").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return JSON.stringify(values);
  });
  expect(stored).not.toContain("derivedKeys");
  expect(stored).not.toContain("historyKey");
  expect(stored).not.toContain(phrase);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Unlock" })).toBeVisible();
  await expect(page.getByTestId("profile")).toHaveCount(0);
  await page.clock.install();
  await page.getByLabel("PIN").fill("wrong000");
  await page.getByRole("button", { name: "Unlock" }).click();
  const unlockButton = page.getByRole("button", { name: "Incorrect PIN" });
  await expect(unlockButton).toBeVisible();
  await page.clock.fastForward(2000);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await page.getByLabel("PIN").fill("secure123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await page.clock.uninstall();
});

test("Forgot PIN clears local data and returns to the start page", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await enablePin(page);
  await page.reload();
  await page.getByRole("button", { name: "Forgot PIN?" }).click();
  await expect(
    page.getByText("You cannot continue this session without the PIN.", {
      exact: false,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByTestId("open-login")).toBeVisible();
});

test("profile PIN forms are mutually exclusive and can be collapsed", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await page.setViewportSize({ width: 360, height: 800 });
  await page.getByTestId("profile").click();
  const languageButton = page.getByRole("button", {
    name: "Language",
    exact: true,
  });
  const idButton = page.getByRole("button", { name: "User ID", exact: true });
  const pinButton = page.getByRole("button", { name: "PIN", exact: true });
  await expect(languageButton).toHaveAttribute("aria-expanded", "false");
  await languageButton.click();
  await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
  await expect(pinButton).toHaveAttribute("aria-expanded", "false");
  await idButton.click();
  await expect(page.getByTestId("user-id")).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(360);
  await expect(languageButton).toHaveAttribute("aria-expanded", "false");
  await idButton.click();
  await page.getByTestId("profile").click();
  await enablePin(page);
  await page.getByRole("button", { name: "Change PIN" }).click();
  await expect(page.getByLabel("Current PIN")).toBeVisible();
  await expect(page.getByLabel("New PIN")).toBeVisible();
  await expect(page.getByLabel("Confirm PIN")).toBeVisible();
  await page.getByRole("button", { name: "Disable PIN" }).click();
  await expect(page.getByLabel("Current PIN")).toBeVisible();
  await expect(page.getByLabel("New PIN")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Change PIN" }),
  ).toHaveAttribute("aria-expanded", "false");
  await page.getByRole("button", { name: "Disable PIN" }).click();
  await expect(page.getByLabel("Current PIN")).toHaveCount(0);
});

test("enabling PIN confirms and clears queued unsent messages", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await page.getByTestId("profile").click();
  await page.getByRole("button", { name: "User ID", exact: true }).click();
  const userId = await page.getByTestId("user-id").innerText();
  await page.evaluate(async (id) => {
    const request = indexedDB.open("messages-outbox", 1);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("frames"))
          request.result.createObjectStore("frames", { keyPath: "key" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("frames", "readwrite");
      tx.objectStore("frames").put({
        key: `${id}:pending`,
        userId: id,
        frame: { type: "send", clientMsgId: "pending" },
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, userId);
  await page.getByTestId("profile").click();
  await page.getByTestId("profile").click();
  await page.getByRole("button", { name: "PIN", exact: true }).click();
  await page.getByRole("button", { name: "Enable PIN" }).click();
  await page.getByPlaceholder("New PIN").fill("secure123");
  await page.getByPlaceholder("Confirm PIN").fill("secure123");
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe(
      "1 unsent message will be deleted. Continue?",
    );
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByRole("button", { name: "Change PIN" })).toBeVisible();
  const queued = await page.evaluate(async () => {
    const request = indexedDB.open("messages-outbox");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = await new Promise<unknown[]>((resolve, reject) => {
      const req = db.transaction("frames").objectStore("frames").getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return records;
  });
  expect(queued).toHaveLength(0);
});

test("the unlock button displays and enforces a persisted countdown", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await enablePin(page);
  await page.evaluate(async () => {
    const request = indexedDB.open("messages-session");
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("keys", "readwrite");
      const store = tx.objectStore("keys");
      const get = store.get("pinState");
      get.onsuccess = () => {
        store.put(
          { ...get.result, failedAttempts: 4, nextAttemptAt: 0 },
          "pinState",
        );
      };
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
  await page.reload();
  await page.clock.install();
  await page.getByLabel("PIN").fill("wrong000");
  await page.getByRole("button", { name: "Unlock" }).click();
  const unlockButton = page.getByRole("button", { name: /^Wait \d+:\d{2}$/ });
  await expect(unlockButton).toBeVisible();
  await expect(unlockButton).toBeDisabled();
  await page.clock.fastForward(5 * 60_000);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeEnabled();
  await page.getByLabel("PIN").fill("secure123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  await page.clock.uninstall();
});
