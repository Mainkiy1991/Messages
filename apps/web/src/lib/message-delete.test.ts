import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat-controller.js";
import {
  canDeleteMessage,
  chatPreviewAfterDeletion,
} from "./message-delete.js";
import { canEditMessage, toggleEditAction } from "./message-edit.js";

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

function canDelete(overrides: Partial<ChatMessage> = {}): boolean {
  return canDeleteMessage(chatMessage(overrides));
}

describe("delete action visibility", () => {
  it("allows deleting your own message that the server already knows", () => {
    expect(canDelete()).toBe(true);
    expect(canDelete({ status: "delivered" })).toBe(true);
    expect(canDelete({ status: "read" })).toBe(true);
    expect(canDelete({ status: undefined })).toBe(true);
    expect(canDelete({ replayId: undefined })).toBe(true);
  });

  it("hides the basket on a foreign, unsent, failed or erased message", () => {
    expect(canDelete({ direction: "in" })).toBe(false);
    expect(canDelete({ status: "sending" })).toBe(false);
    expect(canDelete({ status: "error" })).toBe(false);
    expect(canDelete({ deleted: true })).toBe(false);
  });

  it("hides the basket while the row has no server sequence", () => {
    expect(canDelete({ seq: undefined, status: "sending" })).toBe(false);
    expect(canDelete({ seq: undefined, status: "sent" })).toBe(false);
  });
});

describe("edit action after an erased message", () => {
  it("keeps the pencil off an erased message", () => {
    expect(canEditMessage(chatMessage(), aliceId)).toBe(true);
    expect(canEditMessage(chatMessage({ deleted: true }), aliceId)).toBe(false);
  });

  it("lets the caller replace the built-in check of the touch toggle", () => {
    const erased = chatMessage({ id: "row-2", deleted: true });
    const editable = chatMessage({ id: "row-3" });
    expect(
      toggleEditAction({
        current: null,
        message: erased,
        userId: aliceId,
        hasSelection: false,
      }),
    ).toBeNull();
    expect(
      toggleEditAction({
        current: null,
        message: erased,
        userId: aliceId,
        hasSelection: false,
        actionable: true,
      }),
    ).toBe("row-2");
    expect(
      toggleEditAction({
        current: null,
        message: editable,
        userId: aliceId,
        hasSelection: false,
        actionable: false,
      }),
    ).toBeNull();
    // A selection still wins over the explicit answer.
    expect(
      toggleEditAction({
        current: "row-3",
        message: editable,
        userId: aliceId,
        hasSelection: true,
        actionable: true,
      }),
    ).toBe("row-3");
  });
});

describe("chat preview of an erased message", () => {
  it("shows the deleted note when the last record is erased", () => {
    const chat = {
      loadingHistory: false,
      messages: [
        chatMessage({ direction: "out", text: "hi" }),
        chatMessage({ direction: "in", deleted: true, text: "" }),
      ],
    };
    expect(chatPreviewAfterDeletion(chat, "Message deleted")).toBe(
      "Message deleted",
    );
    expect(
      chatPreviewAfterDeletion(
        {
          ...chat,
          messages: [
            chatMessage({ direction: "out", deleted: true, text: "" }),
          ],
        },
        "Message deleted",
      ),
    ).toBe("Message deleted");
  });

  it("keeps the ordinary preview in every other case", () => {
    const chat = {
      loadingHistory: false,
      messages: [chatMessage({ direction: "in" })],
    };
    expect(chatPreviewAfterDeletion(chat, "Message deleted")).toBeNull();
    expect(
      chatPreviewAfterDeletion(
        {
          ...chat,
          messages: [chatMessage({ direction: "in", deleted: true, text: "" })],
          loadingHistory: true,
        },
        "Message deleted",
      ),
    ).toBeNull();
    expect(
      chatPreviewAfterDeletion({ loadingHistory: false, messages: [] }, "x"),
    ).toBeNull();
  });
});
