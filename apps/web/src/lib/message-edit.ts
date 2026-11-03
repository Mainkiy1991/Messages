import type { ChatMessage, SendEditResult } from "./chat-controller.js";

/**
 * Everything the composer needs while it edits an already sent message.
 * `savedDraft` keeps the ordinary unsent text so leaving the mode can put it
 * back instead of losing it.
 */
export type MessageEditState = {
  peerId: string;
  targetId: string;
  originalText: string;
  savedDraft: string;
};

/**
 * Only your own delivered text message can be edited. Foreign, undecrypted,
 * pending and failed messages are hidden from the action instead of failing
 * after a tap, because the controller and the server reject them anyway. A
 * delete request that is waiting for an answer or has been accepted freezes the
 * text; after a refusal the controller allows edits again.
 */
export function canEditMessage(
  message: Pick<
    ChatMessage,
    | "direction"
    | "status"
    | "replayId"
    | "decryptFailed"
    | "replayAuthor"
    | "deletion"
  >,
  userId?: string,
): boolean {
  if (message.direction !== "out") return false;
  if (message.decryptFailed) return false;
  if (!message.replayId) return false;
  if (message.status === "sending" || message.status === "error") return false;
  if (message.deletion === "pending" || message.deletion === "accepted")
    return false;
  if (userId && message.replayAuthor && message.replayAuthor !== userId)
    return false;
  return true;
}

/** Enters the edit mode, or returns null when the message is not editable. */
export function startMessageEdit(input: {
  peerId: string;
  message: ChatMessage;
  composerDraft: string;
  userId?: string;
}): MessageEditState | null {
  if (!canEditMessage(input.message, input.userId)) return null;
  return {
    peerId: input.peerId,
    targetId: input.message.replayId!,
    originalText: input.message.text,
    savedDraft: input.composerDraft,
  };
}

/**
 * Touch screens have no hover, so the actions of an own bubble are revealed by
 * tapping the bubble. Only one message can be active: tapping the same bubble
 * again hides the actions, tapping another own bubble moves them there and
 * tapping a message without actions hides them. A tap that finishes a text
 * selection changes nothing, so selecting text never flashes the actions.
 *
 * `actionable` lets the caller decide on the set of actions: the bubble is
 * active when at least one of its actions is allowed, so a message that cannot
 * be edited but can be asked to be deleted still shows its basket.
 */
export function toggleEditAction(input: {
  current: string | null;
  message: Pick<
    ChatMessage,
    | "id"
    | "direction"
    | "status"
    | "replayId"
    | "decryptFailed"
    | "replayAuthor"
    | "deletion"
  >;
  userId?: string;
  hasSelection: boolean;
  actionable?: boolean;
}): string | null {
  if (input.hasSelection) return input.current;
  const actionable =
    input.actionable ?? canEditMessage(input.message, input.userId);
  if (!actionable) return null;
  return input.current === input.message.id ? null : input.message.id;
}

/**
 * The outline marks only the message that is being edited right now. Messages
 * of the old v1 format have no `replayId` and can never be a target: comparing
 * two missing IDs would otherwise outline all of them while the mode is off.
 */
export function isEditingMessage(
  state: MessageEditState | null,
  message: Pick<ChatMessage, "replayId">,
): boolean {
  if (!state) return false;
  const targetId = message.replayId;
  if (typeof targetId !== "string" || targetId.length === 0) return false;
  return targetId === state.targetId;
}

/** Sending stays disabled while the text is empty or was not changed. */
export function canSubmitEdit(state: MessageEditState, draft: string): boolean {
  return draft.trim().length > 0 && draft !== state.originalText;
}

/** Leaving the mode never sends anything and brings the old draft back. */
export function draftAfterEdit(state: MessageEditState): string {
  return state.savedDraft;
}

/** Sends the edit through the controller and reports its error untouched. */
export async function submitMessageEdit(input: {
  state: MessageEditState;
  draft: string;
  sendEdit: (
    peerId: string,
    targetId: string,
    text: string,
  ) => Promise<SendEditResult>;
}): Promise<SendEditResult> {
  if (!canSubmitEdit(input.state, input.draft))
    return { ok: false, error: "invalid_text" };
  return input.sendEdit(input.state.peerId, input.state.targetId, input.draft);
}
