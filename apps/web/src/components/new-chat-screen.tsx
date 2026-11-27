import { useEffect, useMemo, useState } from "react";
import type { Language } from "../i18n.js";
import { supportedLanguages } from "../i18n.js";
import { sortContactEntries } from "./contacts-screen.js";

export type NewChatView = "menu" | "pick" | "id";
export type NewChatScreenStrings = {
  newChat: string;
  newChatFromContacts: string;
  newChatById: string;
  contactsPickTitle: string;
  contactsPickEmpty: string;
  contactsLoading: string;
  contactsLoadFailed: string;
  back: string;
  peerId: string;
  contactName: string;
  newChatNameHint: string;
  createChat: string;
};
export type NewChatScreenProps = {
  view: NewChatView;
  strings: NewChatScreenStrings;
  contacts: Record<string, string>;
  contactsReady: boolean;
  contactsLoadFailed: boolean;
  language: Language;
  onBack: () => void;
  onChooseView: (view: NewChatView) => void;
  onPickContact: (peerId: string) => Promise<string>;
  onSubmitId: (id: string, name: string) => Promise<string>;
};

export function NewChatScreen(props: NewChatScreenProps) {
  const {
    view,
    strings: t,
    contacts,
    contactsReady,
    contactsLoadFailed,
    language,
    onBack,
    onChooseView,
    onPickContact,
    onSubmitId,
  } = props;
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const locale =
    supportedLanguages.find((x) => x.code === language)?.locale ?? "en-US";
  const sorted = useMemo(
    () => sortContactEntries(contacts, locale),
    [contacts, locale],
  );
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onBack();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [onBack]);
  useEffect(() => {
    if (view !== "id") {
      setId("");
      setName("");
      setError("");
      setBusy(false);
    }
  }, [view]);
  async function run(action: () => Promise<string>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      setError(await action());
    } finally {
      setBusy(false);
    }
  }
  const title =
    view === "pick"
      ? t.contactsPickTitle
      : view === "id"
        ? t.newChatById
        : t.newChat;
  return (
    <div
      className="contacts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t.newChat}
      data-testid="new-chat-screen"
    >
      <header className="contacts-header">
        <button
          className="text-button"
          data-testid="new-chat-back"
          onClick={onBack}
          aria-label={t.back}
          title={t.back}
        >
          <svg
            aria-hidden="true"
            focusable="false"
            viewBox="0 0 24 24"
            width="24"
            height="24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M19 12H5M12 19l-7-7 7-7" />
          </svg>
        </button>
        <h1>{title}</h1>
      </header>
      <main className="contacts-body new-chat-screen-body">
        {view === "menu" && (
          <>
            <button
              className="secondary new-chat-menu-item"
              data-testid="new-chat-from-contacts"
              onClick={() => onChooseView("pick")}
            >
              {t.newChatFromContacts}
            </button>
            <button
              className="secondary new-chat-menu-item"
              data-testid="new-chat-by-id"
              onClick={() => onChooseView("id")}
            >
              {t.newChatById}
            </button>
          </>
        )}
        {view === "pick" && (
          <>
            {!contactsReady && !contactsLoadFailed && (
              <p>{t.contactsLoading}</p>
            )}
            {contactsLoadFailed && (
              <p className="error" role="alert">
                {t.contactsLoadFailed}
              </p>
            )}
            {contactsReady && !contactsLoadFailed && sorted.length === 0 && (
              <p>{t.contactsPickEmpty}</p>
            )}
            {contactsReady &&
              sorted.map(([peerId, label]) => (
                <button
                  className="contact-row"
                  data-testid="contact-row"
                  data-peer-id={peerId}
                  key={peerId}
                  disabled={busy}
                  onClick={() => void run(() => onPickContact(peerId))}
                >
                  <strong>{label}</strong>
                  <span className="contact-tail">{peerId.slice(-10)}</span>
                </button>
              ))}
            {error && (
              <p className="error" role="alert" data-testid="new-chat-error">
                {error}
              </p>
            )}
          </>
        )}
        {view === "id" && (
          <form
            className="new-chat-screen-form"
            data-testid="new-chat-form"
            onSubmit={(event) => {
              event.preventDefault();
              void run(() => onSubmitId(id, name));
            }}
          >
            <input
              aria-label={t.peerId}
              placeholder={t.peerId}
              data-testid="peer-id-input"
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              value={id}
              disabled={busy}
              onChange={(event) => setId(event.target.value)}
            />
            <input
              aria-label={t.contactName}
              placeholder={t.contactName}
              autoComplete="off"
              data-lpignore="true"
              data-1p-ignore="true"
              data-form-type="other"
              value={name}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
            <p className="hint" data-testid="new-chat-name-hint">
              {t.newChatNameHint}
            </p>
            <button data-testid="new-chat" className="primary" disabled={busy}>
              {t.createChat}
            </button>
            {error && (
              <p className="error" role="alert" data-testid="new-chat-error">
                {error}
              </p>
            )}
          </form>
        )}
      </main>
    </div>
  );
}
