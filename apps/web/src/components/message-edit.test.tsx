import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/chat-controller.js";
import { EditBanner, EditMessageButton, EditedMark } from "./message-edit.js";

const aliceId = "a".repeat(64);
const bobId = "b".repeat(64);

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "row-1",
    replayId: "cmVwbGF5LWlk",
    replayAuthor: aliceId,
    text: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    direction: "out",
    status: "sent",
    arrivalOrder: 1,
    ...overrides,
  };
}

function renderAction(message: ChatMessage) {
  return renderToStaticMarkup(
    <EditMessageButton
      message={message}
      userId={aliceId}
      label="Изменить"
      onEdit={() => undefined}
    />,
  );
}

describe("message edit action", () => {
  it("renders a keyboard reachable icon-only pencil with an aria-label", () => {
    const html = renderAction(chatMessage());
    expect(html).toContain('data-testid="edit-message"');
    expect(html).toContain('type="button"');
    expect(html).toContain('<svg class="message-edit-icon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain('aria-label="Изменить"');
    expect(html).toContain('title="Изменить"');
    // No visible caption: the button contains the icon and nothing else.
    expect(html).toContain("</svg></button>");
    expect(html.replace(/<[^>]+>/gu, "")).toBe("");
  });

  it("renders nothing for a foreign message", () => {
    expect(renderAction(chatMessage({ direction: "in" }))).toBe("");
    expect(renderAction(chatMessage({ replayAuthor: bobId }))).toBe("");
  });

  it("renders nothing for an unsent, failed or undecrypted message", () => {
    expect(renderAction(chatMessage({ replayId: undefined }))).toBe("");
    expect(renderAction(chatMessage({ status: "sending" }))).toBe("");
    expect(renderAction(chatMessage({ status: "error" }))).toBe("");
    expect(renderAction(chatMessage({ decryptFailed: true }))).toBe("");
  });
});

describe("message edit banner", () => {
  it("shows the editing label and the cancel button", () => {
    const html = renderToStaticMarkup(
      <EditBanner
        label="Правка сообщения"
        cancelLabel="Отмена"
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="edit-banner"');
    expect(html).toContain("Правка сообщения");
    expect(html).toContain('data-testid="cancel-edit"');
    expect(html).toContain(">Отмена</button>");
  });
});

describe("edited mark", () => {
  it("renders the muted note as its own line under the status", () => {
    const html = renderToStaticMarkup(<EditedMark label="изменено" />);
    expect(html).toContain('class="edited-mark"');
    expect(html).toContain('data-testid="edited-mark"');
    expect(html).toContain("изменено</span>");
    expect(html).not.toContain("·");
  });
});
