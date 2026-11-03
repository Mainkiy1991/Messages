import { describe, expect, it, vi } from "vitest";
import type { ChatMessage, SendEditResult } from "./chat-controller.js";
import {
  canEditMessage,
  canSubmitEdit,
  draftAfterEdit,
  startMessageEdit,
  submitMessageEdit,
} from "./message-edit.js";

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

function editSender(result: SendEditResult) {
  return vi.fn<(...args: [string, string, string]) => Promise<SendEditResult>>(
    () => Promise.resolve(result),
  );
}

function editState(overrides: { composerDraft?: string } = {}) {
  return startMessageEdit({
    peerId: bobId,
    message: chatMessage(),
    composerDraft: overrides.composerDraft ?? "",
    userId: aliceId,
  })!;
}

describe("message edit mode", () => {
  it("enters the mode with the message text and remembers the unsent draft", () => {
    const state = editState({ composerDraft: "half written answer" });
    expect(state).toEqual({
      peerId: bobId,
      targetId: "cmVwbGF5LWlk",
      originalText: "hello",
      savedDraft: "half written answer",
    });
  });

  it("returns the previous draft when the mode is left by Escape or Cancel", () => {
    const state = editState({ composerDraft: "half written answer" });
    expect(draftAfterEdit(state)).toBe("half written answer");
    expect(draftAfterEdit(editState())).toBe("");
  });

  it("sends the edit for the target message through the controller", async () => {
    const sendEdit = editSender({ ok: true });
    const result = await submitMessageEdit({
      state: editState(),
      draft: "hello v2",
      sendEdit,
    });
    expect(sendEdit).toHaveBeenCalledTimes(1);
    expect(sendEdit).toHaveBeenCalledWith(bobId, "cmVwbGF5LWlk", "hello v2");
    expect(result).toEqual({ ok: true });
  });

  it("keeps sending disabled for empty and unchanged text", async () => {
    const state = editState();
    expect(canSubmitEdit(state, "")).toBe(false);
    expect(canSubmitEdit(state, "   ")).toBe(false);
    expect(canSubmitEdit(state, "hello")).toBe(false);
    expect(canSubmitEdit(state, "hello v2")).toBe(true);
    const sendEdit = editSender({ ok: true });
    expect(
      await submitMessageEdit({ state, draft: "hello", sendEdit }),
    ).toEqual({ ok: false, error: "invalid_text" });
    expect(sendEdit).not.toHaveBeenCalled();
  });

  it("passes controller edit errors through untouched", async () => {
    for (const error of [
      "unknown_message",
      "not_editable",
      "edit_pending",
      "edit_limit",
      "server_unavailable",
    ] as const) {
      const sendEdit = editSender({ ok: false, error });
      expect(
        await submitMessageEdit({
          state: editState(),
          draft: "hello v3",
          sendEdit,
        }),
      ).toEqual({ ok: false, error });
    }
  });
});

describe("message edit action visibility", () => {
  it("shows the action on your own delivered message", () => {
    expect(canEditMessage(chatMessage(), aliceId)).toBe(true);
    expect(canEditMessage(chatMessage({ status: "read" }), aliceId)).toBe(true);
    expect(canEditMessage(chatMessage({ status: undefined }), aliceId)).toBe(
      true,
    );
  });

  it("shows the action in Saved messages", () => {
    expect(
      canEditMessage(chatMessage({ replayAuthor: aliceId }), aliceId),
    ).toBe(true);
    expect(
      startMessageEdit({
        peerId: aliceId,
        message: chatMessage(),
        composerDraft: "",
        userId: aliceId,
      }),
    ).not.toBeNull();
  });

  it("hides the action on a foreign message", () => {
    expect(canEditMessage(chatMessage({ direction: "in" }), aliceId)).toBe(
      false,
    );
    expect(canEditMessage(chatMessage({ replayAuthor: bobId }), aliceId)).toBe(
      false,
    );
    expect(
      startMessageEdit({
        peerId: bobId,
        message: chatMessage({ direction: "in" }),
        composerDraft: "",
        userId: aliceId,
      }),
    ).toBeNull();
  });

  it("hides the action on an unsent, failed or undecrypted message", () => {
    expect(canEditMessage(chatMessage({ replayId: undefined }), aliceId)).toBe(
      false,
    );
    expect(canEditMessage(chatMessage({ status: "sending" }), aliceId)).toBe(
      false,
    );
    expect(canEditMessage(chatMessage({ status: "error" }), aliceId)).toBe(
      false,
    );
    expect(canEditMessage(chatMessage({ decryptFailed: true }), aliceId)).toBe(
      false,
    );
  });
});
