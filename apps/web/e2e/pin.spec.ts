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
  await page.getByPlaceholder("New PIN").first().fill("secure123");
  await page.getByPlaceholder("Confirm PIN").first().fill("secure123");
  await page.getByRole("button", { name: "Enable PIN" }).click();
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
  await page.getByLabel("Current PIN").fill("wrong000");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert")).toContainText("Incorrect");
  await page.waitForTimeout(1100);
  await page.getByLabel("Current PIN").fill("secure123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
});

test("Forgot PIN clears local data and returns to the start page", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await enablePin(page);
  await page.reload();
  page.on("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Forgot PIN?" }).click();
  await expect(page.getByRole("heading", { name: "Welcome" })).toBeVisible();
  await expect(page.getByTestId("open-login")).toBeVisible();
});
