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

export type DisplayMessage = {
  message: ChatMessage;
  deletedCount: number;
};

export function deletedMessageLabel(
  direction: "in" | "out",
  count: number,
  isSavedChat: boolean,
  labels: {
    own: string;
    ownPlural: string;
    peer: string;
    peerPlural: string;
    saved: string;
    savedPlural: string;
  },
): string {
  if (isSavedChat) return count === 1 ? labels.saved : labels.savedPlural;
  if (direction === "out") return count === 1 ? labels.own : labels.ownPlural;
  return count === 1 ? labels.peer : labels.peerPlural;
}

export function collapseDeletedMessages(
  messages: ChatMessage[],
): DisplayMessage[] {
  const result: DisplayMessage[] = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!;
    let deletedCount = 1;
    if (message.deleted) {
      while (
        messages[index + 1]?.deleted &&
        messages[index + 1]?.direction === message.direction
      ) {
        deletedCount++;
        index++;
      }
    }
    result.push({ message, deletedCount });
  }
  return result;
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
