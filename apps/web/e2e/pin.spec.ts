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
  await page.addInitScript(() => {
    if (!localStorage.getItem("messages-lang")) {
      localStorage.setItem("messages-lang", "en");
    }
  });
  const phrase = await createAccount(page);
  await enablePin(page);
  const logoutColor = await page
    .getByTestId("logout")
    .evaluate((button) => getComputedStyle(button).color);
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
  await expect(
    page.getByRole("heading", { name: "Enter your PIN to unlock" }),
  ).toBeVisible();
  await expect(page.getByLabel("PIN")).toBeVisible();
  await expect(page.getByText("PIN", { exact: true })).toHaveCount(0);
  await expect(page.getByTestId("profile")).toHaveCount(0);
  await page.clock.install();
  await page.getByLabel("PIN").fill("wrong000");
  await page.getByRole("button", { name: "Unlock" }).click();
  const unlockButton = page.getByRole("button", { name: "Incorrect PIN" });
  await expect(unlockButton).toBeVisible();
  await expect(unlockButton).toHaveClass(/pin-action-error/);
  await expect
    .poll(() =>
      unlockButton.evaluate((button) => getComputedStyle(button).color),
    )
    .toBe(logoutColor);
  await expect(unlockButton).toHaveCSS("opacity", "1");
  await expect(unlockButton).toHaveCSS(
    "background-color",
    "rgb(255, 250, 250)",
  );
  await expect(page.getByLabel("PIN")).toHaveClass(/pin-input-incorrect/);
  await expect(page.getByLabel("PIN")).toHaveValue("");
  await expect(page.getByLabel("PIN")).toBeFocused();
  await page.clock.fastForward(2000);
  await expect(page.getByRole("button", { name: "Unlock" })).toBeVisible();
  await page.getByLabel("PIN").fill("secure123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByTestId("profile")).toBeVisible();
});

test("locked PIN controls keep their geometry at 360px in every language", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await page.addInitScript(() => {
    if (!localStorage.getItem("messages-lang")) {
      localStorage.setItem("messages-lang", "en");
    }
  });
  await createAccount(page);
  await enablePin(page);
  await page.clock.install();

  for (const language of ["ru", "en", "uk"] as const) {
    await page.evaluate(
      (value) => localStorage.setItem("messages-lang", value),
      language,
    );
    await page.reload();
    const panel = page.locator(".pin-lock-screen");
    const button = panel.locator(".pin-action");
    const forgotLink = panel.locator(".text-button");
    await expect(panel).toBeVisible();
    await expect(button).toBeVisible();
    await expect(forgotLink).toBeVisible();

    const before = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(
        ".pin-lock-screen .pin-action",
      )!;
      const link = document.querySelector<HTMLElement>(
        ".pin-lock-screen .text-button",
      )!;
      const card = document.querySelector<HTMLElement>(".card")!;
      const rect = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return { button: rect(button), link: rect(link), card: rect(card) };
    });
    await page.getByLabel("PIN").fill("wrong000");
    await button.click();
    await expect(button).toHaveClass(/pin-action-error/);
    await expect(button).toContainText(
      language === "ru"
        ? "Неверный PIN"
        : language === "uk"
          ? "Невірний PIN"
          : "Incorrect PIN",
    );
    const after = await page.evaluate(() => {
      const button = document.querySelector<HTMLElement>(
        ".pin-lock-screen .pin-action",
      )!;
      const link = document.querySelector<HTMLElement>(
        ".pin-lock-screen .text-button",
      )!;
      const card = document.querySelector<HTMLElement>(".card")!;
      const rect = (element: HTMLElement) => {
        const bounds = element.getBoundingClientRect();
        return {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
        };
      };
      return {
        button: rect(button),
        link: rect(link),
        card: rect(card),
        textFits: button.scrollWidth <= button.clientWidth,
      };
    });
    for (const key of ["x", "y", "width", "height"] as const) {
      expect(
        Math.abs(after.button[key] - before.button[key]),
      ).toBeLessThanOrEqual(1);
    }
    expect(Math.abs(after.link.y - before.link.y)).toBeLessThanOrEqual(1);
    expect(
      Math.abs(after.card.height - before.card.height),
    ).toBeLessThanOrEqual(1);
    expect(after.textFits).toBe(true);

    await page.clock.fastForward(2100);
    await page.getByLabel("PIN").fill("secure123");
    await button.click();
    await expect(page.getByTestId("profile")).toBeVisible();
  }
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
    page.getByText("You cannot continue this session without your PIN.", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(page.locator("#forgot-pin-message p")).toHaveCount(3);
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

test("profile PIN errors shake only the current PIN field", async ({
  page,
}) => {
  await page.addInitScript(() => localStorage.setItem("messages-lang", "en"));
  await createAccount(page);
  await enablePin(page);
  const logoutColor = await page
    .getByTestId("logout")
    .evaluate((button) => getComputedStyle(button).color);
  await page.getByRole("button", { name: "Change PIN" }).click();
  const currentPin = page.getByLabel("Current PIN");
  await currentPin.fill("wrong000");
  await page.getByLabel("New PIN").fill("secure456");
  await page.getByLabel("Confirm PIN").fill("secure456");
  const changeButton = page.getByRole("button", {
    name: "Change",
    exact: true,
  });
  await changeButton.click();
  await expect(page.getByRole("button", { name: "Incorrect PIN" })).toHaveClass(
    /pin-action-error/,
  );
  const changeErrorButton = page.getByRole("button", {
    name: "Incorrect PIN",
  });
  await expect
    .poll(() =>
      changeErrorButton.evaluate((button) => getComputedStyle(button).color),
    )
    .toBe(logoutColor);
  await expect(changeErrorButton).toHaveCSS("opacity", "1");
  await expect(currentPin).toHaveClass(/pin-input-incorrect/);
  await expect(currentPin).toHaveValue("");
  await expect(page.getByLabel("New PIN")).not.toHaveClass(
    /pin-input-incorrect/,
  );

  await page.getByLabel("New PIN").fill("secure456");
  await page.getByLabel("Confirm PIN").fill("other789");
  await changeButton.click();
  await expect(
    page.getByRole("button", { name: "PINs do not match" }),
  ).toHaveClass(/pin-action-error/);
  await expect(currentPin).not.toHaveClass(/pin-input-incorrect/);

  await page.getByRole("button", { name: "Disable PIN" }).click();
  const disableCurrentPin = page.getByLabel("Current PIN");
  await disableCurrentPin.fill("wrong000");
  const disableButton = page.getByRole("button", {
    name: "Disable",
    exact: true,
  });
  await disableButton.click();
  const disableErrorButton = page.getByRole("button", {
    name: "Incorrect PIN",
  });
  await expect
    .poll(() =>
      disableErrorButton.evaluate((button) => getComputedStyle(button).color),
    )
    .toBe(logoutColor);
  await expect(disableErrorButton).toHaveCSS("opacity", "1");
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
    if (!db.objectStoreNames.contains("frames")) {
      db.close();
      return [];
    }
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
});
