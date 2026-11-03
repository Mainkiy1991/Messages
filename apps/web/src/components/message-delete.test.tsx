import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../lib/chat-controller.js";
import {
  DeleteConfirmBar,
  DeleteRequestButton,
  DeleteRequestNotice,
  DeletedMessageText,
  DeletionMark,
} from "./message-delete.js";

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

function renderAction(
  message: ChatMessage,
  peerId = bobId,
  editing = false,
): string {
  return renderToStaticMarkup(
    <DeleteRequestButton
      message={message}
      userId={aliceId}
      peerId={peerId}
      label="Запросить удаление у собеседника"
      editing={editing}
      onRequest={() => undefined}
    />,
  );
}

describe("delete request action", () => {
  it("renders a keyboard reachable icon-only basket with an aria-label", () => {
    const html = renderAction(chatMessage());
    expect(html).toContain('data-testid="request-delete"');
    expect(html).toContain('type="button"');
    expect(html).toContain('class="message-delete"');
    expect(html).toContain('<svg class="message-delete-icon"');
    expect(html).toContain('aria-hidden="true"');
    expect(html).toContain("currentColor");
    expect(html).toContain('aria-label="Запросить удаление у собеседника"');
    expect(html).toContain('title="Запросить удаление у собеседника"');
    // No visible caption: the button contains the icon and nothing else.
    expect(html).toContain("</svg></button>");
    expect(html.replace(/<[^>]+>/gu, "")).toBe("");
  });

  it("renders nothing for a message that cannot be asked about", () => {
    expect(renderAction(chatMessage({ direction: "in" }))).toBe("");
    expect(renderAction(chatMessage({ status: "sending" }))).toBe("");
    expect(renderAction(chatMessage({ status: "error" }))).toBe("");
    expect(renderAction(chatMessage({ decryptFailed: true }))).toBe("");
    expect(renderAction(chatMessage({ replayId: undefined }))).toBe("");
    expect(renderAction(chatMessage({ replayAuthor: bobId }))).toBe("");
    expect(renderAction(chatMessage({ deletion: "pending" }))).toBe("");
    expect(renderAction(chatMessage({ deletion: "accepted" }))).toBe("");
    expect(renderAction(chatMessage({ deletion: "declined" }))).toBe("");
    expect(renderAction(chatMessage(), aliceId)).toBe("");
  });

  it("renders nothing while the message is being edited", () => {
    expect(renderAction(chatMessage(), bobId, true)).toBe("");
  });
});

describe("delete confirmation bar", () => {
  it("shows the confirmation text and both buttons", () => {
    const html = renderToStaticMarkup(
      <DeleteConfirmBar
        text="Попросить собеседника удалить это сообщение?"
        sendLabel="Отправить запрос"
        cancelLabel="Отмена"
        onSend={() => undefined}
        onCancel={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="delete-confirm"');
    expect(html).toContain('class="edit-banner delete-confirm"');
    expect(html).toContain("Попросить собеседника удалить это сообщение?");
    expect(html).toContain('data-testid="confirm-delete-request"');
    expect(html).toContain(">Отправить запрос</button>");
    expect(html).toContain('data-testid="cancel-delete-request"');
    expect(html).toContain(">Отмена</button>");
  });
});

describe("delete request notice", () => {
  it("shows the request text with the accept and keep buttons", () => {
    const html = renderToStaticMarkup(
      <DeleteRequestNotice
        text="Собеседник просит удалить это сообщение"
        acceptLabel="Удалить у меня"
        keepLabel="Оставить"
        onAccept={() => undefined}
        onKeep={() => undefined}
      />,
    );
    expect(html).toContain('data-testid="delete-notice"');
    expect(html).toContain("Собеседник просит удалить это сообщение");
    expect(html).toContain('data-testid="accept-delete"');
    expect(html).toContain(">Удалить у меня</button>");
    expect(html).toContain('data-testid="keep-message"');
    expect(html).toContain(">Оставить</button>");
  });
});

describe("deletion mark", () => {
  it("renders the note as its own line with the deletion status", () => {
    const html = renderToStaticMarkup(
      <DeletionMark status="accepted" label="собеседник удалил у себя" />,
    );
    expect(html).toContain('class="edited-mark"');
    expect(html).toContain('data-testid="deletion-mark"');
    expect(html).toContain('data-deletion="accepted"');
    expect(html).toContain("собеседник удалил у себя</span>");
    expect(html).not.toContain("·");
  });
});

describe("deleted message stub", () => {
  it("renders the muted stub instead of the text", () => {
    const html = renderToStaticMarkup(
      <DeletedMessageText label="Сообщение удалено" />,
    );
    expect(html).toContain('class="message-deleted"');
    expect(html).toContain('data-testid="message-deleted"');
    expect(html).toContain("Сообщение удалено</span>");
  });
});
