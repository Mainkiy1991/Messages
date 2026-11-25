import { useEffect, useRef, useState } from "react";
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
  contactsAdd: string;
  contactsAdding: string;
  contactsId: string;
  contactsName: string;
  contactsNotePlaceholder: string;
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
  { view: "list" } | { view: "add" } | { view: "card"; peerId: string };
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
}: ContactsScreenProps) {
  const [view, setView] = useState<ContactsInitialView>(
    initialView ?? { view: "list" },
  );
  const [peerId, setPeerId] = useState(
    initialView?.view === "card" ? initialView.peerId : "",
  );
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<"name" | "note" | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [copied, setCopied] = useState(false);
  const idRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);
  const copyTimer = useRef<number | undefined>(undefined);
  const locale =
    supportedLanguages.find((x) => x.code === language)?.locale ?? "en-US";
  useEffect(() => {
    if (view.view === "add") idRef.current?.focus();
  }, [view]);
  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);
  useEffect(() => () => window.clearTimeout(copyTimer.current), []);
  useEffect(() => {
    if (view.view === "card" && !Object.hasOwn(contacts, view.peerId))
      setView({ view: "list" });
  }, [contacts, view]);
  function back() {
    if (editing) setEditing(null);
    else if (confirmRemove) setConfirmRemove(false);
    else if (view.view !== "list") setView({ view: "list" });
    else onClose();
  }
  async function add() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await controller.addContact(id, name, note);
      if (r.ok) {
        setId("");
        setName("");
        setNote("");
        setView({ view: "list" });
      } else setError(contactErrorText(strings, r.error));
    } finally {
      setBusy(false);
    }
  }
  async function save(field: "name" | "note", value: string) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r =
        field === "name"
          ? await controller.renameContact(peerId, value)
          : await controller.saveContactNote(peerId, value);
      if (r.ok) setEditing(null);
      else setError(contactErrorText(strings, r.error));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const r = await controller.removeContact(peerId);
      if (r.ok) {
        setConfirmRemove(false);
        setView({ view: "list" });
      } else setError(contactErrorText(strings, r.error));
    } finally {
      setBusy(false);
    }
  }
  async function write() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await controller.openChat(peerId);
      const snapshot = controller.getSnapshot();
      if (snapshot.activePeer === peerId && !snapshot.error)
        onChatOpened(peerId);
      else
        setError(
          snapshot.error ? chatErrorText(snapshot.error as ChatError) : "",
        );
    } finally {
      setBusy(false);
    }
  }
  async function copyId() {
    if (await copyText(peerId)) {
      setCopied(true);
      window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
    } else setError(strings.idCopyFailed);
  }
  const sorted = Object.entries(contacts).sort(
    ([aId, a], [bId, b]) =>
      new Intl.Collator(locale, { sensitivity: "base" }).compare(a, b) ||
      aId.localeCompare(bId),
  );
  return (
    <div
      className="contacts-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={strings.contactsTitle}
      data-testid="contacts-screen"
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          back();
        }
      }}
    >
      <header className="contacts-header">
        <button
          className="secondary"
          data-testid="contacts-back"
          disabled={busy}
          onClick={back}
        >
          {strings.back}
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
                setError("");
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
                    setError("");
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
        {view.view === "add" && (
          <form
            className="contacts-form"
            onSubmit={(e) => {
              e.preventDefault();
              void add();
            }}
          >
            <label>
              {strings.contactsId}
              <input
                ref={idRef}
                data-testid="contact-add-id"
                value={id}
                disabled={busy}
                onChange={(e) => setId(e.target.value)}
              />
            </label>
            <label>
              {strings.contactsName}
              <input
                data-testid="contact-add-name"
                value={name}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label>
              {strings.contactsNotePlaceholder}
              <input
                data-testid="contact-add-note"
                value={note}
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
            {error && (
              <p className="error" role="alert" data-testid="contact-add-error">
                {error}
              </p>
            )}
          </form>
        )}
        {view.view === "card" && contacts[view.peerId] !== undefined && (
          <div className="contacts-card">
            <section>
              <strong data-testid="contact-card-name">
                {contacts[peerId]}
              </strong>
              <button
                className="secondary"
                disabled={busy}
                onClick={() => {
                  setName(contacts[peerId] ?? "");
                  setError("");
                  setEditing("name");
                }}
              >
                {strings.contactsEditName}
              </button>
              {editing === "name" && (
                <div>
                  <input
                    ref={editRef}
                    data-testid="contact-name-input"
                    value={name}
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <button
                    className="primary"
                    data-testid="contact-save-name"
                    disabled={busy}
                    onClick={() => void save("name", name)}
                  >
                    {strings.contactsSave}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {strings.cancel}
                  </button>
                  {error && (
                    <p
                      className="error"
                      role="alert"
                      data-testid="contact-name-error"
                    >
                      {error}
                    </p>
                  )}
                </div>
              )}
            </section>
            <code data-testid="contact-card-id">{peerId}</code>
            <button
              className="secondary"
              disabled={busy}
              onClick={() => void copyId()}
            >
              {copied ? strings.copied : strings.copy}
            </button>
            {error === strings.idCopyFailed && (
              <p className="error" role="alert">
                {error}
              </p>
            )}
            <section>
              <h2>{strings.contactsMyNote}</h2>
              {editing !== "note" && (
                <>
                  <p
                    data-testid="contact-card-note"
                    className={!notes[peerId] ? "muted" : ""}
                  >
                    {notes[peerId] || strings.contactsNoNote}
                  </p>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => {
                      setNote(notes[peerId] ?? "");
                      setError("");
                      setEditing("note");
                    }}
                  >
                    {strings.contactsEditNote}
                  </button>
                </>
              )}
              {editing === "note" && (
                <div>
                  <input
                    ref={editRef}
                    data-testid="contact-note-input"
                    value={note}
                    disabled={busy}
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        e.stopPropagation();
                        setEditing(null);
                      }
                    }}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button
                    className="primary"
                    data-testid="contact-save-note"
                    disabled={busy}
                    onClick={() => void save("note", note)}
                  >
                    {strings.contactsSave}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => setEditing(null)}
                  >
                    {strings.cancel}
                  </button>
                  {error && (
                    <p
                      className="error"
                      role="alert"
                      data-testid="contact-note-error"
                    >
                      {error}
                    </p>
                  )}
                </div>
              )}
            </section>
            <button
              className="primary"
              data-testid="contact-write"
              disabled={busy}
              onClick={() => void write()}
            >
              {strings.contactsWrite}
            </button>
            {error && !editing && error !== strings.idCopyFailed && (
              <p
                className="error"
                role="alert"
                data-testid="contact-write-error"
              >
                {error}
              </p>
            )}
            {!confirmRemove ? (
              <button
                className="danger"
                data-testid="contact-remove"
                disabled={busy}
                onClick={() => {
                  setError("");
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
                  onClick={() => setConfirmRemove(false)}
                >
                  {strings.cancel}
                </button>
                {error && (
                  <p
                    className="error"
                    role="alert"
                    data-testid="contact-remove-error"
                  >
                    {error}
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
