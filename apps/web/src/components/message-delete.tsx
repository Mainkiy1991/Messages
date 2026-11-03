import type { ChatMessage, DeletionStatus } from "../lib/chat-controller.js";
import { canRequestDeletion } from "../lib/message-delete.js";

/**
 * Basket action of your own bubble. It sits next to the pencil and is icon-only:
 * the caption lives in `aria-label`/`title` so the bubble never grows. It is
 * hidden while the message is being edited and wherever a request makes no
 * sense (foreign, unsent, failed, already asked or answered, saved messages).
 */
export function DeleteRequestButton({
  message,
  userId,
  peerId,
  label,
  editing,
  onRequest,
}: {
  message: ChatMessage;
  userId: string;
  peerId: string;
  label: string;
  editing?: boolean;
  onRequest: (message: ChatMessage) => void;
}) {
  if (editing) return null;
  if (!canRequestDeletion({ message, userId, peerId })) return null;
  return (
    <button
      type="button"
      className="message-delete"
      data-testid="request-delete"
      aria-label={label}
      title={label}
      onClick={() => onRequest(message)}
    >
      <svg
        className="message-delete-icon"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M6.2 1h3.6l.5 1H13v1.5H3V2h2.7l.5-1ZM4.1 4.5h7.8l-.6 9.3a1.2 1.2 0 0 1-1.2 1.1H5.9a1.2 1.2 0 0 1-1.2-1.1l-.6-9.3Zm2.4 1.8v6.4h1.1V6.3H6.5Zm2.2 0v6.4h1.1V6.3H8.7Z"
          fill="currentColor"
        />
      </svg>
    </button>
  );
}

/** Row above the composer that asks for the final confirmation. */
export function DeleteConfirmBar({
  text,
  sendLabel,
  cancelLabel,
  onSend,
  onCancel,
}: {
  text: string;
  sendLabel: string;
  cancelLabel: string;
  onSend: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="edit-banner delete-confirm" data-testid="delete-confirm">
      <span className="edit-banner-label">{text}</span>
      <span className="delete-confirm-actions">
        <button
          type="button"
          className="text-button delete-confirm-send"
          data-testid="confirm-delete-request"
          onClick={onSend}
        >
          {sendLabel}
        </button>
        <button
          type="button"
          className="text-button edit-banner-cancel"
          data-testid="cancel-delete-request"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </span>
    </div>
  );
}

/** Notice inside the bubble of the recipient: delete here or keep it. */
export function DeleteRequestNotice({
  text,
  acceptLabel,
  keepLabel,
  onAccept,
  onKeep,
}: {
  text: string;
  acceptLabel: string;
  keepLabel: string;
  onAccept: () => void;
  onKeep: () => void;
}) {
  return (
    <div className="delete-notice" data-testid="delete-notice">
      <span className="delete-notice-text">{text}</span>
      <span className="delete-notice-actions">
        <button
          type="button"
          className="text-button delete-notice-accept"
          data-testid="accept-delete"
          onClick={onAccept}
        >
          {acceptLabel}
        </button>
        <button
          type="button"
          className="text-button delete-notice-keep"
          data-testid="keep-message"
          onClick={onKeep}
        >
          {keepLabel}
        </button>
      </span>
    </div>
  );
}

/** State of the request under the status of your own message. */
export function DeletionMark({
  status,
  label,
}: {
  status: DeletionStatus;
  label: string;
}) {
  return (
    <span
      className="edited-mark"
      data-testid="deletion-mark"
      data-deletion={status}
    >
      {label}
    </span>
  );
}

/** Stub that replaces the text the other person agreed to hide. */
export function DeletedMessageText({ label }: { label: string }) {
  return (
    <span className="message-deleted" data-testid="message-deleted">
      {label}
    </span>
  );
}
