import type { ChatMessage } from "../lib/chat-controller.js";
import { canDeleteMessage } from "../lib/message-delete.js";

/**
 * Basket action of your own bubble. It sits next to the pencil and is icon-only:
 * the caption lives in `aria-label`/`title` so the bubble never grows. It is
 * hidden while the message is being edited and wherever deletion makes no sense
 * (foreign, unsent, failed, already erased).
 */
export function DeleteMessageButton({
  message,
  label,
  editing,
  onDelete,
}: {
  message: ChatMessage;
  label: string;
  editing?: boolean;
  onDelete: (message: ChatMessage) => void;
}) {
  if (editing) return null;
  if (!canDeleteMessage(message)) return null;
  return (
    <button
      type="button"
      className="message-delete"
      data-testid="delete-message"
      aria-label={label}
      title={label}
      onClick={() => onDelete(message)}
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
          data-testid="confirm-delete-message"
          onClick={onSend}
        >
          {sendLabel}
        </button>
        <button
          type="button"
          className="text-button edit-banner-cancel"
          data-testid="cancel-delete-message"
          onClick={onCancel}
        >
          {cancelLabel}
        </button>
      </span>
    </div>
  );
}

/** Stub that replaces the text of an erased message. */
export function DeletedMessageText({ label }: { label: string }) {
  return (
    <span className="message-deleted" data-testid="message-deleted">
      {label}
    </span>
  );
}
