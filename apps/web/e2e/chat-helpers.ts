import type { Page } from "@playwright/test";

export async function startNewChatById(page: Page): Promise<void> {
  await page.getByRole("button", { name: /New chat/u }).click();
  await page.getByTestId("new-chat-by-id").click();
}
