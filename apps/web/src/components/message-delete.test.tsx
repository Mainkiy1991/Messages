import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/chat-controller.js";
import {
  DeleteConfirmBar,
  DeleteMessageButton,
  DeletedMessageText,
} from "./message-delete.js";

const aliceId = "a".repeat(64);

function chatMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "row-1",
    replayId: "cmVwbGF5LWlk",
    replayAuthor: aliceId,
    text: "hello",
    createdAt: "2026-01-01T00:00:00.000Z",
    direction: "out",
    status: "sent",
    seq: "7",
    arrivalOrder: 1,
    ...overrides,
  };
}

function renderAction(message: ChatMessage, editing = false): string {
  return renderToStaticMarkup(
    <DeleteMessageButton
      message={message}
      label="Удалить сообщение"
      editing={editing}
      onDelete={() => undefined}
    />,
  );
}

describe("delete message action", () => {
  it("renders a keyboard reachable icon-only basket with an aria-label", () => {
    const html = renderAction(chatMessage());
    expect(html).toContain('data-testid="delete-message"');
    expect(html).toContain('type="button"');
    expect(html).toContain('class="message-delete"');
    expect(html).toContain('<svg class="message-delete-icon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("currentColor");
    expect(html).toContain('aria-label="Удалить сообщение"');
    expect(html).toContain('title="Удалить сообщение"');
    // No visible caption: the button contains the icon and nothing else.
    expect(html).toContain("</svg></button>");
    expect(html.replace(/<[^>]+>/gu, "")).toBe("");
  });

  it("renders nothing for a foreign, unsent, failed or erased message", () => {
    expect(renderAction(chatMessage({ direction: "in" }))).toBe("");
    expect(renderAction(chatMessage({ status: "sending" }))).toBe("");
    expect(renderAction(chatMessage({ status: "error" }))).toBe("");
    expect(renderAction(chatMessage({ deleted: true }))).toBe("");
    expect(renderAction(chatMessage({ seq: undefined }))).toBe("");
  });

  it("renders nothing while the message is being edited", () => {
    expect(renderAction(chatMessage(), true)).toBe("");
  });
});

describe("delete confirmation bar", () => {
  it("shows the confirmation text and both buttons", () => {
    const html = renderToStaticMarkup(
      <DeleteConfirmBar
        text="Удалить это сообщение?"
        sendLabel="Удалить"
        cancelLabel="Отмена"
        onSend={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="delete-confirm"');
    expect(html).toContain('class="edit-banner delete-confirm"');
    expect(html).toContain("Удалить это сообщение?");
    expect(html).toContain('data-testid="confirm-delete-message"');
    expect(html).toContain(">Удалить</button>");
    expect(html).toContain('data-testid="cancel-delete-message"');
    expect(html).toContain(">Отмена</button>");
  });
});

describe("deleted message stub", () => {
  it("renders the muted stub instead of the text", () => {
    const html = renderToStaticMarkup(
      <DeletedMessageText label="Вы удалили сообщение" />,
    );
    expect(html).toContain('class="message-deleted"');
    expect(html).toContain('data-testid="message-deleted"');
    expect(html).toContain("Вы удалили сообщение</span>");
    /* The stub is the note alone: no text of the erased message is rendered. */
    expect(html.replace(/<[^>]+>/gu, "")).toBe("Вы удалили сообщение");
  });
});
