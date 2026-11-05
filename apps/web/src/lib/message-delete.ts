import type { Chat, ChatMessage } from "./chat-controller.js";

/**
 * The basket is shown only where the controller would accept the deletion: your
 * own row that the server already knows, that is neither on its way nor failed
 * and that is not erased yet. Saved messages are deletable too: their author is
 * you, so nothing has to be agreed with a second person.
 */
export function canDeleteMessage(
  message: Pick<ChatMessage, "direction" | "status" | "deleted" | "seq">,
): boolean {
  if (message.direction !== "out") return false;
  if (message.deleted) return false;
  if (message.status === "sending" || message.status === "error") return false;
  return Boolean(message.seq);
}

/**
 * The chat list shows the text of the last message, which would reveal a
 * message that was erased. `null` keeps the ordinary preview of `chatPreview`.
 */
export function chatPreviewAfterDeletion(
  chat: Pick<Chat, "loadingHistory" | "messages">,
  messageDeleted: string,
): string | null {
  if (chat.loadingHistory) return null;
  const latest = chat.messages.at(-1);
  if (!latest?.deleted) return null;
  return messageDeleted;
}
