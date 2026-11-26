import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ChatController,
  ChatError,
  ContactError,
} from "../lib/chat-controller.js";
import { copyText } from "../lib/clipboard.js";
import type { Language } from "../i18n.js";
import { supportedLanguages } from "../i18n.js";

export type ContactsScreenStrings = {
  contactsTitle: string;
  contactsAddToContacts: string;
  contactsNotInContacts: string;
  contactsOpenCard: string;
  contactsAdd: string;
  contactsAdding: string;
  contactsId: string;
  contactsName: string;
  contactsNoteLabel: string;
  contactsNoteHint: string;
  contactsCopyId: string;
  contactsCount: (count: number) => string;
  contactsNoNote: string;
  contactsMyNote: string;
  contactsWrite: string;
  contactsEditName: string;
  contactsEditNote: string;
  contactsSave: string;
  contactsRemove: string;
  contactsRemovePrompt: string;
  contactsRemoveConfirm: string;
  contactsEmpty: string;
  contactsLoading: string;
  contactsLoadFailed: string;
  back: string;
  cancel: string;
  copy: string;
  copied: string;
  idCopyFailed: string;
  contactsErrorInvalidId: string;
  contactsErrorOwnId: string;
  contactsErrorNotLoaded: string;
  contactsErrorNameRequired: string;
  contactsErrorNameTooLong: string;
  contactsErrorNameInvalid: string;
  contactsErrorNoteTooLong: string;
  contactsErrorNoteInvalid: string;
  contactsErrorNotContact: string;
  contactsErrorAlreadyContact: string;
  contactsErrorLimit: string;
  contactsErrorBookLarge: string;
  contactsErrorUserNotFound: string;
  contactsErrorBadPeerKey: string;
  contactsErrorServer: string;
  contactsErrorSave: string;
};
export type ContactsInitialView =
  | { view: "list" }
  | { view: "add" }
  | { view: "card"; peerId: string }
  | { view: "peer"; peerId: string }
  | { view: "peerAdd"; peerId: string };
type ContactsBackState = {
  busy: boolean;
  editing: boolean;
  confirmRemove: boolean;
  view: ContactsInitialView;
  fromChat: boolean;
};
export function contactsBackAction({
  busy,
  editing,
  confirmRemove,
  view,
  fromChat,
}: ContactsBackState): "stay" | "edit" | "remove" | "peer" | "close" | "list" {
  if (busy) return "stay";
  if (editing) return "edit";
  if (confirmRemove) return "remove";
  if (view.view === "peerAdd") return "peer";
  if (view.view === "peer") return "close";
  if (view.view === "card") return fromChat ? "close" : "list";
  if (view.view === "add") return "list";
  return "close";
}
export function peerCardFromContacts(
  view: ContactsInitialView,
  contacts: Record<string, string>,
): string | null {
  return (view.view === "peer" || view.view === "peerAdd") &&
    Object.hasOwn(contacts, view.peerId)
    ? view.peerId
    : null;
}
type ContactScreenError = {
  place: "add" | "name" | "note" | "write" | "remove" | "copy";
  text: string;
};
const contactCollators = new Map<string, Intl.Collator>();
function getContactCollator(locale: string): Intl.Collator {
  let collator = contactCollators.get(locale);
  if (!collator) {
    collator = new Intl.Collator(locale, { sensitivity: "base" });
    contactCollators.set(locale, collator);
  }
  return collator;
}
const contactErrorKeys: Record<ContactError, keyof ContactsScreenStrings> = {
  invalid_id: "contactsErrorInvalidId",
  own_id: "contactsErrorOwnId",
  contacts_not_loaded: "contactsErrorNotLoaded",
  name_required: "contactsErrorNameRequired",
  name_too_long: "contactsErrorNameTooLong",
  name_invalid: "contactsErrorNameInvalid",
  note_too_long: "contactsErrorNoteTooLong",
  note_invalid: "contactsErrorNoteInvalid",
  not_a_contact: "contactsErrorNotContact",
  already_contact: "contactsErrorAlreadyContact",
  limit_reached: "contactsErrorLimit",
  book_too_large: "contactsErrorBookLarge",
  user_not_found: "contactsErrorUserNotFound",
  bad_peer_key: "contactsErrorBadPeerKey",
  server_unavailable: "contactsErrorServer",
  save_failed: "contactsErrorSave",
};
export function contactErrorText(
  strings: ContactsScreenStrings,
  error: ContactError,
): string {
  switch (error) {
    case "invalid_id":
    case "own_id":
    case "contacts_not_loaded":
    case "name_required":
    case "name_too_long":
    case "name_invalid":
    case "note_too_long":
    case "note_invalid":
    case "not_a_contact":
    case "already_contact":
    case "limit_reached":
    case "book_too_large":
    case "user_not_found":
    case "bad_peer_key":
    case "server_unavailable":
    case "save_failed":
      return String(strings[contactErrorKeys[error]]);
  }
}
export type ContactsScreenProps = {
  controller: Pick<
    ChatController,
    | "addContact"
    | "renameContact"
    | "saveContactNote"
    | "removeContact"
    | "openChat"
    | "getSnapshot"
  >;
  contacts: Record<string, string>;
  notes: Record<string, string>;
  ready: boolean;
  loadFailed: boolean;
  language: Language;
  strings: ContactsScreenStrings;
  chatErrorText: (error: ChatError) => string;
  onClose: () => void;
  onChatOpened: (peerId: string) => void;
  initialView?: ContactsInitialView;
  chatPeerId?: string;
};
export function ContactsScreen({
  controller,
  contacts,
  notes,
  ready,
  loadFailed,
  language,
  strings,
  chatErrorText,
  onClose,
  onChatOpened,
  initialView,
  chatPeerId,
}: ContactsScreenProps) {
  const [view, setView] = useState<ContactsInitialView>(
    initialView ?? { view: "list" },
  );
  const [peerId, setPeerId] = useState(
    initialView && "peerId" in initialView ? initialView.peerId : "",
  );
  const [fromChat, setFromChat] = useState(chatPeerId !== undefined);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ContactScreenError | null>(null);
  const [editing, setEditing] = useState<"name" | "note" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);
  const addNameRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const nameEditButtonRef = useRef<HTMLButtonElement>(null);
  const noteEditButtonRef = useRef<HTMLButtonElement>(null);
  const focusEditButtonOnClose = useRef<"name" | "note" | null>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const locale =
    supportedLanguages.find((x) => x.code === language)?.locale ?? "en-US";
  useEffect(() => {
    if (view.view === "add") idRef.current?.focus();
    if (view.view === "peerAdd") addNameRef.current?.focus();
  }, [view]);
  useEffect(() => {
    if (view.view === "list") setFromChat(false);
  }, [view]);
  useEffect(() => {
    if (editing) editRef.current?.focus();
    else if (focusEditButtonOnClose.current) {
      const field = focusEditButtonOnClose.current;
      focusEditButtonOnClose.current = null;
      (field === "name"
        ? nameEditButtonRef
        : noteEditButtonRef
      ).current?.focus();
    }
  }, [editing]);
  useEffect(() => {
    if (editing && error?.place === editing) editRef.current?.focus();
  }, [editing, error]);
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      back();
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [busy, editing, confirmRemove, view, fromChat]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => {
    const contactPeerId = peerCardFromContacts(view, contacts);
    if (contactPeerId) {
      setPeerId(contactPeerId);
      setView({ view: "card", peerId: contactPeerId });
      setName("");
      setNote("");
    }
  }, [contacts, view]);
  useEffect(() => {
    if (view.view === "card" && !Object.hasOwn(contacts, view.peerId)) {
      setError(null);
      setView({ view: "list" });
    }
  }, [contacts, view]);
  function back() {
    if (busy) return;
    setError(null);
    const action = contactsBackAction({
      busy,
      editing: Boolean(editing),
      confirmRemove,
      view,
      fromChat,
    });
    if (action === "edit") setEditing(null);
    else if (action === "remove") setConfirmRemove(false);
    else if (action === "peer" && view.view === "peerAdd")
      setView({ view: "peer", peerId: view.peerId });
    else if (action === "list") setView({ view: "list" });
    else if (action === "close") onClose();
  }
  async function add() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await controller.addContact(id, name, note);
      if (r.ok) {
        setId("");
        setName("");
        setNote("");
        setView({ view: "list" });
      } else
        setError({ place: "add", text: contactErrorText(strings, r.error) });
    } finally {
      setBusy(false);
    }
  }
  async function addPeer(targetPeerId: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await controller.addContact(targetPeerId, name, note);
      if (!r.ok)
        setError({ place: "add", text: contactErrorText(strings, r.error) });
    } finally {
      setBusy(false);
    }
  }
  async function save(field: "name" | "note", value: string) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r =
        field === "name"
          ? await controller.renameContact(peerId, value)
          : await controller.saveContactNote(peerId, value);
      if (r.ok) {
        focusEditButtonOnClose.current = field;
        setEditing(null);
      } else
        setError({
          place: field,
          text: contactErrorText(strings, r.error),
        });
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await controller.removeContact(peerId);
      if (r.ok) {
        setConfirmRemove(false);
        setView({ view: "list" });
      } else
        setError({ place: "remove", text: contactErrorText(strings, r.error) });
    } finally {
      setBusy(false);
    }
  }
  async function write() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await controller.openChat(peerId);
      const snapshot = controller.getSnapshot();
      if (snapshot.activePeer === peerId && !snapshot.error)
        onChatOpened(peerId);
      else
        setError({
          place: "write",
          text: snapshot.error
            ? chatErrorText(snapshot.error as ChatError)
            : "",
        });
    } finally {
      setBusy(false);
    }
  }
  async function copyPeerId(targetPeerId = peerId) {
    setError(null);
    if (await copyText(targetPeerId)) {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } else setError({ place: "copy", text: strings.idCopyFailed });
  }
  async function copyId() {
    return copyPeerId(peerId);
  }
  const sorted = useMemo(() => {
    const collator = getContactCollator(locale);
    return Object.entries(contacts).sort(
      ([aId, a], [bId, b]) => collator.compare(a, b) || aId.localeCompare(bId),
    );
  }, [contacts, locale]);
  return (
    <div
      className="contacts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={strings.contactsTitle}
      data-testid="contacts-screen"
    >
      <header className="contacts-header">
        <button
          className="text-button"
          data-testid="contacts-back"
          disabled={busy}
          onClick={back}
          aria-label={strings.back}
          title={strings.back}
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
        <h1>{strings.contactsTitle}</h1>
      </header>
      <main className="contacts-body">
        {(view.view === "list" ||
          (view.view === "card" && !Object.hasOwn(contacts, view.peerId))) && (
          <>
            <button
              className="primary"
              data-testid="contact-add-open"
              disabled={!ready || busy}
              onClick={() => {
                setError(null);
                setView({ view: "add" });
              }}
            >
              {strings.contactsAdd}
            </button>
            {!ready && !loadFailed && <p>{strings.contactsLoading}</p>}
            {loadFailed && (
              <p className="error" role="alert">
                {strings.contactsLoadFailed}
              </p>
            )}
            {ready && !loadFailed && !sorted.length && (
              <p>{strings.contactsEmpty}</p>
            )}
            {ready &&
              sorted.map(([pid, label]) => (
                <button
                  className="contact-row"
                  data-testid="contact-row"
                  data-peer-id={pid}
                  key={pid}
                  onClick={() => {
                    setPeerId(pid);
                    setError(null);
                    setView({ view: "card", peerId: pid });
                  }}
                >
                  <strong>{label}</strong>
                  <span className="contact-tail">{pid.slice(-10)}</span>
                  {notes[pid] && (
                    <span className="contact-row-note">{notes[pid]}</span>
                  )}
                </button>
              ))}
          </>
        )}
        {view.view === "peer" && (
          <>
            <p data-testid="contact-peer-title">
              {strings.contactsNotInContacts}
            </p>
            <button
              type="button"
              className="contact-id-button"
              data-testid="contact-card-id"
              aria-label={strings.contactsCopyId}
              title={strings.contactsCopyId}
              disabled={busy}
              onClick={() => void copyPeerId(view.peerId)}
            >
              <code>{view.peerId}</code>
            </button>
            {copied && (
              <span role="status" className="contact-copy-status">
                {strings.copied}
              </span>
            )}
            {error?.place === "copy" && (
              <p
                className="error"
                role="alert"
                data-testid="contact-copy-error"
              >
                {error.text}
              </p>
            )}
            {!ready && !loadFailed && <p>{strings.contactsLoading}</p>}
            {loadFailed && (
              <p className="error" role="alert">
                {strings.contactsLoadFailed}
              </p>
            )}
            <button
              type="button"
              className="primary"
              data-testid="contact-peer-add"
              disabled={!ready || busy}
              onClick={() => {
                setError(null);
                setView({ view: "peerAdd", peerId: view.peerId });
              }}
            >
              {strings.contactsAddToContacts}
            </button>
          </>
        )}
        {(view.view === "add" || view.view === "peerAdd") && (
          <form
            className="contacts-form"
            onSubmit={(e) => {
              e.preventDefault();
              void (view.view === "peerAdd" ? addPeer(view.peerId) : add());
            }}
          >
            <label>
              {strings.contactsId}
              <input
                ref={view.view === "add" ? idRef : undefined}
                data-testid="contact-add-id"
                value={view.view === "peerAdd" ? view.peerId : id}
                readOnly={view.view === "peerAdd"}
                disabled={busy}
                onChange={(e) => setId(e.target.value)}
              />
            </label>
            <label>
              {strings.contactsName}
              <input
                ref={view.view === "peerAdd" ? addNameRef : undefined}
                data-testid="contact-add-name"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {strings.contactsNoteLabel}
              <input
                data-testid="contact-add-note"
                value={note}
                placeholder={strings.contactsNoteHint}
                disabled={busy}
                onChange={(e) => setNote(e.target.value)}
              />
              <small>{strings.contactsCount(Array.from(note).length)}</small>
            </label>
            <button
              className="primary"
              data-testid="contact-add-submit"
              disabled={busy}
            >
              {busy ? strings.contactsAdding : strings.contactsAdd}
            </button>
            {error?.place === "add" && (
              <p className="error" role="alert" data-testid="contact-add-error">
                {error.text}
              </p>
            )}
          </form>
        )}
        {view.view === "card" && contacts[view.peerId] !== undefined && (
          <div className="contacts-card">
            <section>
              <div className="contact-name-row">
                {editing === "name" ? (
                  <>
                    <input
                      ref={editRef}
                      className="contact-inline-input contact-name-input"
                      data-testid="contact-name-input"
                      value={name}
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          focusEditButtonOnClose.current = "name";
                          setError(null);
                          setEditing(null);
                        } else if (e.key === "Enter" && !e.shiftKey && !busy) {
                          e.preventDefault();
                          void save("name", name);
                        }
                      }}
                      onChange={(e) => setName(e.target.value)}
                    />
                    <button
                      className="contact-icon-button"
                      type="button"
                      data-testid="contact-save-name"
                      aria-label={strings.contactsSave}
                      title={strings.contactsSave}
                      disabled={busy}
                      onClick={() => void save("name", name)}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                    </button>
                    <button
                      className="contact-icon-button"
                      type="button"
                      data-testid="contact-cancel-name"
                      aria-label={strings.cancel}
                      title={strings.cancel}
                      disabled={busy}
                      onClick={() => {
                        focusEditButtonOnClose.current = "name";
                        setError(null);
                        setEditing(null);
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m18 6-12 12M6 6l12 12" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <>
                    <strong data-testid="contact-card-name">
                      {contacts[peerId]}
                    </strong>
                    <button
                      ref={nameEditButtonRef}
                      className="contact-icon-button"
                      type="button"
                      disabled={busy}
                      aria-label={strings.contactsEditName}
                      title={strings.contactsEditName}
                      onClick={() => {
                        setName(contacts[peerId] ?? "");
                        setError(null);
                        setEditing("name");
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M17 3a2.828 2.828 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              {error?.place === "name" && (
                <p
                  className="error"
                  role="alert"
                  data-testid="contact-name-error"
                >
                  {error.text}
                </p>
              )}
            </section>
            <button
              type="button"
              className="contact-id-button"
              data-testid="contact-card-id"
              aria-label={strings.contactsCopyId}
              title={strings.contactsCopyId}
              disabled={busy}
              onClick={() => void copyId()}
            >
              <code>{peerId}</code>
              <svg
                aria-hidden="true"
                focusable="false"
                viewBox="0 0 24 24"
                width="18"
                height="18"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </button>
            {copied && (
              <span role="status" className="contact-copy-status">
                {strings.copied}
              </span>
            )}
            {error?.place === "copy" && (
              <p
                className="error"
                role="alert"
                data-testid="contact-copy-error"
              >
                {error.text}
              </p>
            )}
            <section>
              <h2>{strings.contactsMyNote}</h2>
              <div className="contact-note-row">
                {editing === "note" ? (
                  <>
                    <input
                      ref={editRef}
                      className="contact-inline-input contact-note-input"
                      data-testid="contact-note-input"
                      value={note}
                      disabled={busy}
                      onKeyDown={(e) => {
                        if (e.key === "Escape") {
                          e.stopPropagation();
                          focusEditButtonOnClose.current = "note";
                          setError(null);
                          setEditing(null);
                        } else if (e.key === "Enter" && !e.shiftKey && !busy) {
                          e.preventDefault();
                          void save("note", note);
                        }
                      }}
                      onChange={(e) => setNote(e.target.value)}
                    />
                    <button
                      className="contact-icon-button"
                      type="button"
                      data-testid="contact-save-note"
                      aria-label={strings.contactsSave}
                      title={strings.contactsSave}
                      disabled={busy}
                      onClick={() => void save("note", note)}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m5 12 4 4L19 6" />
                      </svg>
                    </button>
                    <button
                      className="contact-icon-button"
                      type="button"
                      data-testid="contact-cancel-note"
                      aria-label={strings.cancel}
                      title={strings.cancel}
                      disabled={busy}
                      onClick={() => {
                        focusEditButtonOnClose.current = "note";
                        setError(null);
                        setEditing(null);
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="m18 6-12 12M6 6l12 12" />
                      </svg>
                    </button>
                  </>
                ) : (
                  <>
                    <p
                      data-testid="contact-card-note"
                      className={!notes[peerId] ? "muted" : ""}
                    >
                      {notes[peerId] || strings.contactsNoNote}
                    </p>
                    <button
                      ref={noteEditButtonRef}
                      className="contact-icon-button"
                      type="button"
                      disabled={busy}
                      aria-label={strings.contactsEditNote}
                      title={strings.contactsEditNote}
                      onClick={() => {
                        setNote(notes[peerId] ?? "");
                        setError(null);
                        setEditing("note");
                      }}
                    >
                      <svg
                        aria-hidden="true"
                        focusable="false"
                        viewBox="0 0 24 24"
                        width="20"
                        height="20"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M17 3a2.828 2.828 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                      </svg>
                    </button>
                  </>
                )}
              </div>
              {error?.place === "note" && (
                <p
                  className="error"
                  role="alert"
                  data-testid="contact-note-error"
                >
                  {error.text}
                </p>
              )}
            </section>
            {!fromChat && (
              <button
                className="primary"
                data-testid="contact-write"
                disabled={busy}
                onClick={() => void write()}
              >
                {strings.contactsWrite}
              </button>
            )}
            {error?.place === "write" && (
              <p
                className="error"
                role="alert"
                data-testid="contact-write-error"
              >
                {error.text}
              </p>
            )}
            {!confirmRemove ? (
              <button
                className="danger"
                data-testid="contact-remove"
                disabled={busy}
                onClick={() => {
                  setError(null);
                  setConfirmRemove(true);
                }}
              >
                {strings.contactsRemove}
              </button>
            ) : (
              <div>
                <p>{strings.contactsRemovePrompt}</p>
                <button
                  className="danger"
                  data-testid="contact-remove-confirm"
                  disabled={busy}
                  onClick={() => void remove()}
                >
                  {strings.contactsRemoveConfirm}
                </button>
                <button
                  className="secondary"
                  data-testid="contact-remove-cancel"
                  disabled={busy}
                  onClick={() => {
                    setError(null);
                    setConfirmRemove(false);
                  }}
                >
                  {strings.cancel}
                </button>
                {error?.place === "remove" && (
                  <p
                    className="error"
                    role="alert"
                    data-testid="contact-remove-error"
                  >
                    {error.text}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
