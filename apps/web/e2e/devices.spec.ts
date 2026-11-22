import { expect, test, type Browser, type Page } from "@playwright/test";

async function setEnglish(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("messages-lang", "en");
  });
}

async function createAccount(page: Page): Promise<string> {
  await setEnglish(page);
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
  await setEnglish(page);
  await page.goto("/");
  await page.getByTestId("open-login").click();
  await page.getByLabel("Seed phrase").fill(phrase);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
}

async function openDevices(page: Page) {
  const panel = page.locator(".profile-panel");
  if (!(await panel.isVisible())) {
    await page.getByTestId("profile").click();
  }
  const devicesButton = page.getByTestId("profile-devices");
  if ((await devicesButton.getAttribute("aria-expanded")) === "true") {
    await devicesButton.click();
    await expect(devicesButton).toHaveAttribute("aria-expanded", "false");
  }
  await devicesButton.click();
  await expect(
    page.getByText("Devices where you are signed in", { exact: false }),
  ).toBeVisible();
}

async function contextPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

let sharedContext: Awaited<ReturnType<typeof contextPage>> | null = null;
let sharedPhrase = "";

test.describe.serial("devices", () => {
  test.beforeAll(async ({ browser }) => {
    sharedContext = await contextPage(browser);
    sharedPhrase = await createAccount(sharedContext.page);
  });

  test("does not reopen the previous account chat after the device is ended", async ({
    browser,
  }) => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const first = sharedContext;
    const profileButton = first.page.getByTestId("profile");
    if ((await profileButton.getAttribute("aria-expanded")) !== "true") {
      await profileButton.click();
    }
    const userIdButton = first.page.getByRole("button", { name: "User ID" });
    if ((await userIdButton.getAttribute("aria-expanded")) !== "true") {
      await userIdButton.click();
    }
    const accountAId = await first.page.getByTestId("user-id").innerText();
    await profileButton.click();
    await first.page.getByRole("button", { name: /New chat/u }).click();
    await first.page.getByTestId("peer-id-input").fill(accountAId);
    await first.page.getByTestId("new-chat").click();
    await expect(first.page.getByTestId("saved-chat-title")).toBeVisible();

    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    await openDevices(second.page);
    await second.page.getByTestId("devices-revoke-others").click();
    await expect(
      second.page.getByText("Sign out on all other devices?"),
    ).toBeVisible();
    await second.page.getByTestId("devices-revoke-others-confirm").click();

    await expect(first.page.getByTestId("device-revoked-notice")).toBeVisible();
    await expect(first.page.getByTestId("create-account")).toBeVisible();
    await first.page.getByTestId("create-account").click();
    await first.page.getByRole("button", { name: "Continue" }).click();
    const words = await first.page
      .getByTestId("seed-phrase")
      .locator("li > span:last-child")
      .allTextContents();
    const inputs = first.page.locator('form input[autocomplete="off"]');
    for (let i = 0; i < (await inputs.count()); i++) {
      const prompt = await inputs.nth(i).locator("xpath=..").innerText();
      const position = Number(prompt.match(/#(\d+)/)?.[1]);
      await inputs.nth(i).fill(words[position - 1]!.trim());
    }
    await first.page.getByLabel("I have saved the phrase").check();
    await first.page
      .getByRole("button", { name: "Finish account setup" })
      .click();
    await expect(first.page.getByTestId("profile")).toBeVisible();
    await expect(first.page.getByTestId("saved-chat-title")).toHaveCount(0);
    await expect(first.page.locator(".messenger.show-chat")).toHaveCount(0);
    await expect(first.page.locator("body")).not.toContainText(accountAId);

    sharedContext = second;
    await first.context.close();
  });

  test.afterAll(async () => {
    await sharedContext?.context.close();
    sharedContext = null;
    // Let the server's per-IP auth-challenge minute window reset before PIN specs.
    await new Promise((resolve) => setTimeout(resolve, 61_000));
  });

  test("shows current and signed-in other devices", async ({ browser }) => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const first = sharedContext;
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);

    await openDevices(first.page);
    await expect(first.page.getByTestId("device-row")).toHaveCount(2);
    await expect(first.page.getByTestId("device-current")).toBeVisible();
    await expect(
      first.page
        .getByTestId("device-row")
        .filter({ hasText: /Chrome/ })
        .first(),
    ).toBeVisible();
    await first.page.getByTestId("device-revoke").first().click();
    await first.page.getByTestId("device-revoke-confirm").click();
    await expect(first.page.getByTestId("device-row")).toHaveCount(1);
    await second.context.close();
  });

  test("revokes one device with confirmation", async ({ browser }) => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const first = sharedContext;
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    await openDevices(first.page);
    await expect(first.page.getByTestId("device-row")).toHaveCount(2);
    await expect(first.page.getByTestId("device-revoke").first()).toBeVisible();

    await first.page.getByTestId("device-revoke").first().click();
    await expect(
      first.page.getByText("Sign out on this device?"),
    ).toBeVisible();
    await first.page.getByTestId("device-revoke-cancel").click();
    await first.page.getByTestId("device-revoke").first().click();
    await first.page.getByTestId("device-revoke-confirm").click();
    await expect(first.page.getByTestId("devices-notice")).toBeVisible();
    await expect(first.page.getByTestId("device-row")).toHaveCount(1);
    await expect(
      second.page.getByTestId("device-revoked-notice"),
    ).toBeVisible();
    await second.context.close();
  });

  test("revokes all other devices with three contexts", async ({ browser }) => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const first = sharedContext;
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    const third = await contextPage(browser);
    await signIn(third.page, sharedPhrase);

    await openDevices(first.page);
    await expect(first.page.getByTestId("device-row")).toHaveCount(3);
    await first.page.getByTestId("devices-revoke-others").click();
    await expect(
      first.page.getByText("Sign out on all other devices?"),
    ).toBeVisible();
    await first.page.getByTestId("devices-revoke-others-confirm").click();
    await expect(first.page.getByTestId("device-row")).toHaveCount(1);
    await expect(first.page.getByTestId("devices-revoke-others")).toHaveCount(
      0,
    );
    await expect(
      second.page.getByTestId("device-revoked-notice"),
    ).toBeVisible();
    await expect(third.page.getByTestId("device-revoked-notice")).toBeVisible();
    await second.context.close();
    await third.context.close();
  });

  test("shows load error and retries after route is removed", async () => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const setup = sharedContext;
    await setup.page.route("**/devices", (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "server_error" }),
      }),
    );
    await openDevices(setup.page);
    await expect(setup.page.getByTestId("devices-error")).toBeVisible();
    await setup.page.unroute("**/devices");
    await setup.page.getByTestId("devices-retry").click();
    await expect(setup.page.getByTestId("device-row")).toBeVisible();
  });

  test("devices section fits 360px viewport", async ({ browser }) => {
    if (!sharedContext) throw new Error("Devices setup did not run");
    const first = sharedContext;
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    await first.page.setViewportSize({ width: 360, height: 740 });
    await openDevices(first.page);
    await expect(first.page.getByTestId("device-row")).toHaveCount(2);
    const panel = first.page.locator(".profile-panel");
    const sizes = await panel.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
    for (const button of await first.page.getByTestId("device-revoke").all()) {
      await expect(button).toBeVisible();
    }
    await second.context.close();
  });
});
