import type { ChatMessage } from "../lib/chat-controller.js";
import { canEditMessage } from "../lib/message-edit.js";

/**
 * Small pencil action of your own bubble. A native button keeps the action
 * reachable from the keyboard, so it follows the retry action of failed
 * messages instead of a hover-only menu.
 */
export function EditMessageButton({
  message,
  userId,
  label,
  onEdit,
}: {
  message: ChatMessage;
  userId: string;
  label: string;
  onEdit: (message: ChatMessage) => void;
}) {
  if (!canEditMessage(message, userId)) return null;
  return (
    <button
      type="button"
      className="message-edit"
      data-testid="edit-message"
      aria-label={label}
      title={label}
      onClick={() => onEdit(message)}
    >
      <svg
        className="message-edit-icon"
        viewBox="0 0 16 16"
        aria-hidden="true"
        focusable="false"
      >
        <path
          d="M11.6 1.4a1.9 1.9 0 0 1 2.7 2.7l-.8.8-2.7-2.7.8-.8ZM9.6 3.4l2.7 2.7-6.7 6.7-3.4.7.7-3.4 6.7-6.7Z"
          fill="currentColor"
        />
      </svg>
      {label}
    </button>
  );
}

/** Row above the composer that shows what is being edited and how to stop. */
export function EditBanner({
  label,
  cancelLabel,
  onCancel,
}: {
  label: string;
  cancelLabel: string;
  onCancel: () => void;
}) {
  return (
    <div className="edit-banner" data-testid="edit-banner">
      <span className="edit-banner-label">{label}</span>
      <button
        type="button"
        className="text-button edit-banner-cancel"
        data-testid="cancel-edit"
        onClick={onCancel}
      >
        {cancelLabel}
      </button>
    </div>
  );
}

/** Muted "edited" note that sits in the time line of an edited bubble. */
export function EditedMark({ label }: { label: string }) {
  return (
    <span className="edited-mark" data-testid="edited-mark">
      {label}
    </span>
  );
}
