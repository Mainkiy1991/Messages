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
  await page.getByTestId("profile").click();
  await page.getByTestId("profile-devices").click();
  await expect(
    page.getByText("Devices where you are signed in", { exact: false }),
  ).toBeVisible();
}

async function contextPage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  return { context, page };
}

let sharedPhrase = "";

test.describe.serial("devices", () => {
  test.beforeAll(async ({ browser }) => {
    const setup = await contextPage(browser);
    sharedPhrase = await createAccount(setup.page);
    await setup.context.close();
  });

  test("shows current and signed-in other devices", async ({ browser }) => {
    const first = await contextPage(browser);
    await signIn(first.page, sharedPhrase);
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
  });

  test("revokes one device with confirmation", async ({ browser }) => {
    const first = await contextPage(browser);
    await signIn(first.page, sharedPhrase);
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    await openDevices(first.page);

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
  });

  test("revokes all other devices with three contexts", async ({ browser }) => {
    const first = await contextPage(browser);
    await signIn(first.page, sharedPhrase);
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    const third = await contextPage(browser);
    await signIn(third.page, sharedPhrase);

    await openDevices(first.page);
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
  });

  test("shows load error and retries after route is removed", async ({
    browser,
  }) => {
    const setup = await contextPage(browser);
    await signIn(setup.page, sharedPhrase);
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
    const first = await contextPage(browser);
    await signIn(first.page, sharedPhrase);
    const second = await contextPage(browser);
    await signIn(second.page, sharedPhrase);
    await first.page.setViewportSize({ width: 360, height: 740 });
    await openDevices(first.page);
    const panel = first.page.locator(".profile-panel");
    const sizes = await panel.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
    }));
    expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
    for (const button of await first.page.getByTestId("device-revoke").all()) {
      await expect(button).toBeVisible();
    }
  });
});
