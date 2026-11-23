import { expect, test, type Browser, type Page } from "@playwright/test";

async function english(page: Page) {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
}

async function createAccount(page: Page): Promise<string> {
  await english(page);
  await page.goto("/");
  await page.getByTestId("create-account").click();
  await page.getByRole("button", { name: "Continue" }).click();
  const words = (
    await page
      .getByTestId("seed-phrase")
      .locator("li > span:last-child")
      .allTextContents()
  ).map((word) => word.trim());
  const inputs = page.locator('form input[autocomplete="off"]');
  for (let i = 0; i < (await inputs.count()); i++) {
    const prompt = await inputs.nth(i).locator("xpath=..").innerText();
    await inputs.nth(i).fill(words[Number(prompt.match(/#(\d+)/)?.[1]) - 1]!);
  }
  await page.getByLabel("I have saved the phrase").check();
  await page.getByRole("button", { name: "Finish account setup" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
  return words.join(" ");
}

async function signIn(page: Page, phrase: string) {
  await english(page);
  await page.goto("/");
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
}

async function openPin(page: Page) {
  const pinSection = page.getByRole("button", { name: "PIN", exact: true });
  if (!(await pinSection.isVisible()))
    await page.getByTestId("profile").click();
  if ((await pinSection.getAttribute("aria-expanded")) !== "true")
    await pinSection.click();
}

async function setPin(page: Page, value: string) {
  await openPin(page);
  await page.getByRole("button", { name: "Enable PIN" }).click();
  await page.getByLabel("New PIN").fill(value);
  await page.getByLabel("Confirm PIN").fill(value);
  await page.getByRole("button", { name: "Set PIN" }).click();
  await expect(page.getByRole("button", { name: "Change PIN" })).toBeVisible();
}

async function devices(browser: Browser) {
  const context = await browser.newContext();
  return { context, page: await context.newPage() };
}

test.describe.serial("shared PIN sync", () => {
  test("syncs the PIN from device A to a seed phrase login on B", async ({
    browser,
  }) => {
    const a = await devices(browser);
    const b = await devices(browser);
    try {
      const phrase = await createAccount(a.page);
      await setPin(a.page, "accountPin1");
      await signIn(b.page, phrase);
      await expect(b.page.getByTestId("pin-sync-notice")).toContainText(
        /^PIN updated/,
      );
      await b.page.reload();
      await expect(
        b.page.getByRole("heading", { name: "Enter your PIN to unlock" }),
      ).toBeVisible();
      await b.page.getByLabel("PIN").fill("accountPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(b.page.getByTestId("profile")).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("syncs a changed PIN after B unlocks with its previous PIN", async ({
    browser,
  }) => {
    const a = await devices(browser);
    const b = await devices(browser);
    try {
      const phrase = await createAccount(a.page);
      await setPin(a.page, "previousPin1");
      await signIn(b.page, phrase);
      await expect(b.page.getByTestId("pin-sync-notice")).toBeVisible();
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("previousPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(b.page.getByTestId("profile")).toBeVisible();
      await openPin(a.page);
      await a.page.getByRole("button", { name: "Change PIN" }).click();
      await a.page.getByLabel("Current PIN").fill("previousPin1");
      await a.page.getByLabel("New PIN").fill("replacement1");
      await a.page.getByLabel("Confirm PIN").fill("replacement1");
      await a.page.getByRole("button", { name: "Change", exact: true }).click();
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("previousPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(b.page.getByTestId("pin-sync-notice")).toContainText(
        /^PIN updated/,
      );
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("replacement1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(b.page.getByTestId("profile")).toBeVisible();
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("previousPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(
        b.page.getByRole("button", { name: "Incorrect PIN" }),
      ).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("syncs PIN disablement and removes B's lock on next reload", async ({
    browser,
  }) => {
    const a = await devices(browser);
    const b = await devices(browser);
    try {
      const phrase = await createAccount(a.page);
      await setPin(a.page, "accountPin1");
      await signIn(b.page, phrase);
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("accountPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await openPin(a.page);
      await a.page.getByRole("button", { name: "Disable PIN" }).click();
      await a.page.getByLabel("Current PIN").fill("accountPin1");
      await a.page
        .getByRole("button", { name: "Disable", exact: true })
        .click();
      await b.page.reload();
      await b.page.getByLabel("PIN").fill("accountPin1");
      await b.page.getByRole("button", { name: "Unlock" }).click();
      await expect(b.page.getByTestId("pin-sync-notice")).toContainText(
        /^PIN disabled/,
      );
      await b.page.reload();
      await expect(b.page.getByTestId("profile")).toBeVisible();
    } finally {
      await a.context.close();
      await b.context.close();
    }
  });

  test("reports an offline enable attempt in a visible error", async ({
    page,
    context,
  }) => {
    await createAccount(page);
    await openPin(page);
    await page.getByRole("button", { name: "Enable PIN" }).click();
    await page.getByLabel("New PIN").fill("offlinePin1");
    await page.getByLabel("Confirm PIN").fill("offlinePin1");
    await context.setOffline(true);
    await page.getByRole("button", { name: "Set PIN" }).click();
    const error = page.getByTestId("pin-error");
    await expect(error).toContainText(/^A server connection is required/);
    const visible = await error.evaluate((node) => {
      const style = getComputedStyle(node);
      return style.display !== "none" && style.color !== style.backgroundColor;
    });
    expect(visible).toBe(true);
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByTestId("profile")).toBeVisible();
  });

  test("rejects a 65 character PIN without enabling it", async ({ page }) => {
    await createAccount(page);
    await openPin(page);
    await page.getByRole("button", { name: "Enable PIN" }).click();
    await page.getByLabel("New PIN").fill("x".repeat(65));
    await page.getByLabel("Confirm PIN").fill("x".repeat(65));
    await page.getByRole("button", { name: "Set PIN" }).click();
    await expect(page.getByTestId("pin-error")).toContainText(
      /^The PIN must be no longer than 64 characters/,
    );
    await page.reload();
    await expect(page.getByTestId("profile")).toBeVisible();
  });
});
