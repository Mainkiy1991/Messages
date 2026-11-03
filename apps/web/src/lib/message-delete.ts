import type { Chat, ChatMessage } from "./chat-controller.js";

/**
 * The delete request is shown only where the controller would accept it: your
 * own delivered v2 message in a chat with somebody else, without a request in
 * flight and without a previous answer. The saved-messages chat is excluded
 * because deleting there has no second person to ask.
 */
export function canRequestDeletion(input: {
  message: Pick<
    ChatMessage,
    | "direction"
    | "status"
    | "replayId"
    | "replayAuthor"
    | "decryptFailed"
    | "deletion"
  >;
  userId: string;
  peerId: string;
}): boolean {
  const { message, userId, peerId } = input;
  if (message.direction !== "out") return false;
  if (!userId || !peerId) return false;
  if (peerId === userId) return false;
  if (message.replayAuthor !== userId) return false;
  if (!message.replayId) return false;
  if (message.decryptFailed) return false;
  if (message.status === "sending" || message.status === "error") return false;
  if (message.deletion !== undefined) return false;
  return true;
}

/**
 * The other person agreed to hide the message, so its text and the "edited"
 * note are replaced by a stub. A declined request changes nothing.
 */
export function isDeletedIncoming(
  message: Pick<ChatMessage, "direction" | "deletion">,
): boolean {
  return message.direction === "in" && message.deletion === "accepted";
}

/**
 * The chat list shows the text of the last message, which would reveal a
 * message the other person has just agreed to hide. `null` keeps the ordinary
 * preview of `chatPreview`.
 */
export function chatPreviewAfterDeletion(
  chat: Pick<Chat, "loadingHistory" | "messages">,
  messageDeleted: string,
): string | null {
  if (chat.loadingHistory) return null;
  const latest = chat.messages.at(-1);
  if (!latest || !isDeletedIncoming(latest)) return null;
  return messageDeleted;
}
