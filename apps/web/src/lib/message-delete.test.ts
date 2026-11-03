import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./chat-controller.js";
import {
  canRequestDeletion,
  chatPreviewAfterDeletion,
  isDeletedIncoming,
} from "./message-delete.js";
import { canEditMessage, toggleEditAction } from "./message-edit.js";

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

function canRequest(
  overrides: Partial<ChatMessage> = {},
  peerId = bobId,
): boolean {
  return canRequestDeletion({
    message: chatMessage(overrides),
    userId: aliceId,
    peerId,
  });
}

describe("delete request visibility", () => {
  it("allows the request on your own delivered message", () => {
    expect(canRequest()).toBe(true);
    expect(canRequest({ status: "delivered" })).toBe(true);
    expect(canRequest({ status: "read" })).toBe(true);
    expect(canRequest({ status: undefined })).toBe(true);
  });

  it("hides the request on a foreign, unsent, failed or undecrypted message", () => {
    expect(canRequest({ direction: "in" })).toBe(false);
    expect(canRequest({ status: "sending" })).toBe(false);
    expect(canRequest({ status: "error" })).toBe(false);
    expect(canRequest({ decryptFailed: true })).toBe(false);
    expect(canRequest({ replayId: undefined })).toBe(false);
  });

  it("hides the request without a known author, in saved messages and without a peer", () => {
    expect(canRequest({ replayAuthor: undefined })).toBe(false);
    expect(canRequest({ replayAuthor: bobId })).toBe(false);
    expect(canRequest({}, aliceId)).toBe(false);
    expect(canRequest({}, "")).toBe(false);
    expect(
      canRequestDeletion({ message: chatMessage(), userId: "", peerId: bobId }),
    ).toBe(false);
  });

  it("hides the request once it was sent, accepted or declined", () => {
    expect(canRequest({ deletion: "pending" })).toBe(false);
    expect(canRequest({ deletion: "accepted" })).toBe(false);
    expect(canRequest({ deletion: "declined" })).toBe(false);
  });
});

describe("edit action after a delete request", () => {
  it("keeps the pencil off while the request waits or was accepted", () => {
    expect(canEditMessage(chatMessage(), aliceId)).toBe(true);
    expect(canEditMessage(chatMessage({ deletion: "pending" }), aliceId)).toBe(
      false,
    );
    expect(canEditMessage(chatMessage({ deletion: "accepted" }), aliceId)).toBe(
      false,
    );
  });

  it("allows the pencil again after a refusal", () => {
    expect(canEditMessage(chatMessage({ deletion: "declined" }), aliceId)).toBe(
      true,
    );
  });

  it("lets the caller replace the built-in edit check of the touch toggle", () => {
    const waiting = chatMessage({ id: "row-2", deletion: "pending" });
    const editable = chatMessage({ id: "row-3" });
    expect(
      toggleEditAction({
        current: null,
        message: waiting,
        userId: aliceId,
        hasSelection: false,
      }),
    ).toBeNull();
    expect(
      toggleEditAction({
        current: null,
        message: waiting,
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

describe("deleted incoming message", () => {
  it("marks only the incoming accepted message as deleted", () => {
    expect(
      isDeletedIncoming(chatMessage({ direction: "in", deletion: "accepted" })),
    ).toBe(true);
    expect(
      isDeletedIncoming(
        chatMessage({ direction: "out", deletion: "accepted" }),
      ),
    ).toBe(false);
    expect(
      isDeletedIncoming(chatMessage({ direction: "in", deletion: "pending" })),
    ).toBe(false);
    expect(isDeletedIncoming(chatMessage({ direction: "in" }))).toBe(false);
  });

  it("hides the preview of the chat whose last incoming message was deleted", () => {
    const chat = {
      loadingHistory: false,
      messages: [
        chatMessage({ direction: "out", text: "hi" }),
        chatMessage({ direction: "in", deletion: "accepted", text: "" }),
      ],
    };
    expect(chatPreviewAfterDeletion(chat, "Message deleted")).toBe(
      "Message deleted",
    );
    expect(
      chatPreviewAfterDeletion(
        { ...chat, messages: [chatMessage({ direction: "in" })] },
        "Message deleted",
      ),
    ).toBeNull();
    expect(
      chatPreviewAfterDeletion(
        {
          ...chat,
          messages: [
            chatMessage({ direction: "in", deletion: "accepted", text: "" }),
          ],
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
