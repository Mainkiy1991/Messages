import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  deriveKeys,
  generateMnemonic,
  normalizeMnemonic,
  userIdFromPublicKey,
  validateMnemonic,
  type DerivedKeys,
} from "@messages/crypto";
import {
  chooseCheckPositions,
  getInitialLanguage,
  strings,
  type Language,
} from "./i18n.js";
import {
  clearSession,
  restoreSession,
  restoreServerSession,
  saveSession,
} from "./session.js";
import {
  ChatController,
  chatPreview,
  contactLabel,
  type ChatControllerState,
} from "./lib/chat-controller.js";
import type { ChatMessage } from "./lib/chat-controller.js";
import "./style.css";

type Screen = "welcome" | "create" | "verify" | "login" | "home";
function App() {
  const [language, setLanguage] = useState<Language>(() =>
    getInitialLanguage(localStorage, navigator.language),
  );
  const t = strings[language];
  const [screen, setScreen] = useState<Screen>("welcome");
  const [keys, setKeys] = useState<DerivedKeys | null>(null);
  const [count, setCount] = useState<12 | 24>(12);
  const [phrase, setPhrase] = useState("");
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [hasError, setHasError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [chatState, setChatState] = useState<ChatControllerState>({
    chats: [],
    activePeer: "",
    connectionState: "offline",
    error: "",
    contacts: {},
    contactsError: false,
  });
  const [peerInput, setPeerInput] = useState("");
  const [newContactName, setNewContactName] = useState("");
  const [contactNameDraft, setContactNameDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState("");
  const [mobileChat, setMobileChat] = useState(false);
  const controllerRef = useRef<ChatController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const previousPeerRef = useRef("");
  const preserveScrollRef = useRef(false);

  useEffect(() => {
    void restoreSession().then(async (saved) => {
      if (saved) {
        setKeys(saved);
        setScreen("home");
      }
    });
  }, []);
  function changeLanguage(next: Language) {
    setLanguage(next);
    localStorage.setItem("messages-language", next);
  }

  async function enter(mnemonic: string) {
    const derived = deriveKeys(normalizeMnemonic(mnemonic));
    await saveSession(derived);
    setKeys(derived);
    setChatState({
      chats: [],
      activePeer: "",
      connectionState: "offline",
      error: "",
      contacts: {},
      contactsError: false,
    });
    setPhrase("");
    setScreen("home");
    setHasError(false);
  }

  function beginCreate() {
    const words = generateMnemonic(count);
    setPhrase(words);
    setPositions(chooseCheckPositions(count));
    setAnswers(["", "", ""]);
    setHasError(false);
    setScreen("verify");
  }

  async function handleLogin(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setHasError(false);
    const clean = normalizeMnemonic(phrase);
    if (!validateMnemonic(clean)) {
      setHasError(true);
      return;
    }
    try {
      await enter(clean);
    } catch {
      setHasError(true);
    }
  }

  async function finishCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const words = phrase.split(" ");
    if (
      !answers.every(
        (answer, i) => normalizeMnemonic(answer) === words[positions[i]],
      )
    ) {
      setHasError(true);
      return;
    }
    try {
      await enter(phrase);
    } catch {
      setHasError(true);
    }
  }

  async function confirmLogout() {
    await controllerRef.current?.logout();
    controllerRef.current = null;
    await clearSession();
    setKeys(null);
    setChatState({
      chats: [],
      activePeer: "",
      connectionState: "offline",
      error: "",
      contacts: {},
      contactsError: false,
    });
    setPhrase("");
    setShowLogoutConfirmation(false);
    setScreen("welcome");
  }

  const userId = keys ? userIdFromPublicKey(keys.identity.publicKey) : "";
  const chats = chatState.chats;
  const activePeer = chatState.activePeer;
  const socketState = chatState.connectionState;
  const activeChat = chats.find((chat) => chat.peerId === activePeer);
  const activeMessages = activeChat?.messages ?? [];
  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (!list) return;
    if (previousPeerRef.current !== activePeer) {
      previousPeerRef.current = activePeer;
      list.scrollTop = list.scrollHeight;
      wasNearBottomRef.current = true;
      return;
    }
    if (preserveScrollRef.current) return;
    if (wasNearBottomRef.current) list.scrollTop = list.scrollHeight;
  }, [activePeer, activeMessages]);
  const errorText = (code: string) =>
    code === "invalid_id"
      ? t.invalidId
      : code === "self_chat"
        ? t.selfChat
        : code === "user_not_found"
          ? t.userNotFound
          : code === "server_unavailable"
            ? t.serverUnavailable
            : code === "invalid_text"
              ? t.invalidText
              : code === "send_failed"
                ? t.sendFailed
                : t.badPeerKey;
  useEffect(() => {
    if (!keys || screen !== "home") return;
    let cancelled = false;
    void restoreServerSession().then((session) => {
      if (cancelled) return;
      const controller = new ChatController(keys, userId, session, {
        onChange: setChatState,
      });
      controllerRef.current = controller;
      controller.start();
    });
    return () => {
      cancelled = true;
      controllerRef.current?.stop();
      controllerRef.current = null;
    };
  }, [keys, screen, userId]);

  async function openChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    await controllerRef.current?.openChat(peerInput);
    const next = controllerRef.current?.getSnapshot();
    setChatError(next?.error ? errorText(next.error) : "");
    if (next?.activePeer) {
      if (newContactName.trim()) {
        const saved = await controllerRef.current?.saveContactName(
          next.activePeer,
          newContactName,
        );
        if (!saved) setChatError(t.contactSaveFailed);
      }
      setPeerInput("");
      setNewContactName("");
      setContactNameDraft(chatState.contacts[next.activePeer] ?? "");
      setMobileChat(true);
    }
  }

  async function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft;
    await controllerRef.current?.sendText(text);
    setDraft((current) => (current === text ? "" : current));
    const error = controllerRef.current?.getSnapshot().error;
    setChatError(error ? errorText(error) : "");
  }

  function retryMessage(message: ChatMessage) {
    if (!message.clientMsgId || !activePeer) return;
    controllerRef.current?.retryMessage(activePeer, message.clientMsgId);
  }
  return (
    <main className="shell">
      <header>
        <a
          className="brand"
          onClick={() => screen === "welcome" && setScreen("welcome")}
        >
          {t.title}
        </a>
        <div className="language">
          <span>{t.language}</span>
          <button
            onClick={() => changeLanguage("ru")}
            aria-pressed={language === "ru"}
          >
            RU
          </button>
          <button
            onClick={() => changeLanguage("en")}
            aria-pressed={language === "en"}
          >
            EN
          </button>
        </div>
      </header>
      <section className="card">
        {screen === "welcome" && (
          <>
            <h1>{t.welcome}</h1>
            <button
              data-testid="create-account"
              className="primary"
              onClick={() => setScreen("create")}
            >
              {t.create}
            </button>
            <button
              data-testid="open-login"
              className="secondary"
              onClick={() => {
                setPhrase("");
                setHasError(false);
                setScreen("login");
              }}
            >
              {t.login}
            </button>
          </>
        )}
        {screen === "create" && (
          <>
            <h1>{t.createTitle}</h1>
            <label>
              {t.words}
              <select
                value={count}
                onChange={(e) => setCount(Number(e.target.value) as 12 | 24)}
              >
                <option value={12}>{t.twelve}</option>
                <option value={24}>{t.twentyFour}</option>
              </select>
            </label>
            <button className="primary" onClick={beginCreate}>
              {t.next}
            </button>
          </>
        )}
        {screen === "verify" && (
          <form onSubmit={finishCreate}>
            <h1>{t.verify}</h1>
            <p className="warning">{t.warning}</p>
            <ol className="seed-list" data-testid="seed-phrase">
              {phrase.split(" ").map((word, i) => (
                <li key={i}>
                  <span>{word}</span>
                </li>
              ))}
            </ol>
            <label className="checkbox">
              <input type="checkbox" required />
              {t.saved}
            </label>
            {positions.map((position, i) => (
              <label key={position}>
                {t.enterWord(position + 1)}
                <input
                  value={answers[i]}
                  onChange={(e) =>
                    setAnswers(
                      answers.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                  autoComplete="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  required
                />
              </label>
            ))}
            {hasError && <p className="error">{t.invalid}</p>}
            <button className="primary">{t.finish}</button>
          </form>
        )}
        {screen === "login" && (
          <form onSubmit={handleLogin}>
            <h1>{t.loginTitle}</h1>
            <label>
              {t.phrase}
              <textarea
                rows={4}
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                required
              />
            </label>
            {hasError && <p className="error">{t.invalid}</p>}
            <button className="primary">{t.signIn}</button>
          </form>
        )}
        {screen === "home" && (
          <>
            <h1>{t.title}</h1>
            <p
              className="muted"
              data-testid="connection-status"
              data-state={socketState}
            >
              {t.chats} ·{" "}
              {socketState === "connected"
                ? t.connected
                : socketState === "connecting"
                  ? t.connecting
                  : t.offline}
            </p>
            <div className="id-box">
              <label>{t.userId}</label>
              <code data-testid="user-id">{userId}</code>
              <button
                className="secondary"
                onClick={() => {
                  void navigator.clipboard.writeText(userId).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1600);
                  });
                }}
              >
                {copied ? t.copied : t.copy}
              </button>
            </div>
            <section className={`messenger ${mobileChat ? "show-chat" : ""}`}>
              <aside className="chat-sidebar">
                <form
                  onSubmit={(event) => void openChat(event)}
                  className="new-chat"
                  data-testid="new-chat-form"
                >
                  <input
                    aria-label={t.peerId}
                    data-testid="peer-id-input"
                    value={peerInput}
                    onChange={(event) => setPeerInput(event.target.value)}
                    placeholder={t.peerId}
                  />
                  <input
                    aria-label={t.contactName}
                    value={newContactName}
                    onChange={(event) => setNewContactName(event.target.value)}
                    placeholder={t.contactName}
                  />
                  <button data-testid="new-chat" className="secondary">
                    {t.newChat}
                  </button>
                </form>
                {chatError && <p className="error">{chatError}</p>}
                <div data-testid="chat-list">
                  {chats.map((chat) => (
                    <button
                      data-testid="chat-item"
                      data-peer-id={chat.peerId}
                      className={`chat-list-item ${chat.peerId === activePeer ? "selected" : ""}`}
                      key={chat.peerId}
                      onClick={() => {
                        controllerRef.current?.selectChat(chat.peerId);
                        setContactNameDraft(
                          chatState.contacts[chat.peerId] ?? "",
                        );
                        setMobileChat(true);
                      }}
                    >
                      <strong>
                        {contactLabel(chat.peerId, chatState.contacts)}
                      </strong>
                      <span>{chatPreview(chat, t)}</span>
                      {chat.unreadCount > 0 && (
                        <b className="unread-count" data-testid="unread-count">
                          {chat.unreadCount}
                        </b>
                      )}
                      {(chat.messages.at(-1)?.createdAt ??
                        chat.lastCreatedAt) && (
                        <small>
                          {new Date(
                            chat.messages.at(-1)?.createdAt ??
                              chat.lastCreatedAt!,
                          ).toLocaleTimeString(
                            language === "ru" ? "ru-RU" : "en-US",
                            { hour: "2-digit", minute: "2-digit" },
                          )}
                        </small>
                      )}
                    </button>
                  ))}
                </div>
              </aside>
              <section className="conversation">
                {activePeer ? (
                  <>
                    <div className="conversation-head">
                      <button
                        className="text-button mobile-back"
                        onClick={() => {
                          controllerRef.current?.closeActiveChat();
                          setMobileChat(false);
                        }}
                      >
                        {t.back}
                      </button>
                      <strong>
                        {contactLabel(activePeer, chatState.contacts)}
                      </strong>
                      <form
                        className="contact-name-form"
                        onSubmit={async (event) => {
                          event.preventDefault();
                          const saved =
                            await controllerRef.current?.saveContactName(
                              activePeer,
                              contactNameDraft,
                            );
                          if (!saved) setChatError(t.contactSaveFailed);
                          else setChatError("");
                        }}
                      >
                        <input
                          aria-label={t.contactName}
                          value={contactNameDraft}
                          onChange={(event) =>
                            setContactNameDraft(event.target.value)
                          }
                          placeholder={
                            chatState.contacts[activePeer] ||
                            activePeer.slice(-10)
                          }
                        />
                        <button className="text-button">{t.saveName}</button>
                      </form>
                    </div>
                    <div
                      className="message-list"
                      ref={messageListRef}
                      onScroll={(event) => {
                        const list = event.currentTarget;
                        wasNearBottomRef.current =
                          list.scrollHeight -
                            list.scrollTop -
                            list.clientHeight <=
                          80;
                      }}
                    >
                      {activeChat?.hasMore && (
                        <button
                          className="secondary load-more"
                          disabled={activeChat.loadingHistory}
                          onClick={async () => {
                            const list = messageListRef.current;
                            if (!list) return;
                            const oldHeight = list.scrollHeight;
                            const oldTop = list.scrollTop;
                            preserveScrollRef.current = true;
                            await controllerRef.current?.loadHistory(
                              activePeer,
                            );
                            requestAnimationFrame(() => {
                              const updated = messageListRef.current;
                              if (updated)
                                updated.scrollTop =
                                  oldTop + updated.scrollHeight - oldHeight;
                              preserveScrollRef.current = false;
                              wasNearBottomRef.current = false;
                            });
                          }}
                        >
                          {activeChat.loadingHistory ? t.loading : t.loadMore}
                        </button>
                      )}
                      {activeMessages.map((message) => (
                        <article
                          data-testid="message"
                          data-status={message.status}
                          data-direction={message.direction}
                          className={`message ${message.direction}`}
                          key={message.id}
                        >
                          <div className="message-text">
                            {message.decryptFailed
                              ? t.decryptFailed
                              : message.text}
                          </div>
                          <small data-testid="message-status">
                            {new Date(message.createdAt).toLocaleTimeString(
                              language === "ru" ? "ru-RU" : "en-US",
                              { hour: "2-digit", minute: "2-digit" },
                            )}{" "}
                            {message.direction === "out" &&
                              (message.status === "delivered"
                                ? t.delivered
                                : message.status === "sent"
                                  ? t.sent
                                  : message.status === "error"
                                    ? t.failed
                                    : t.sending)}
                          </small>
                          {message.status === "error" && (
                            <>
                              <span className="error">
                                {errorText(message.error ?? "send_failed")}
                              </span>
                              <button
                                className="text-button"
                                onClick={() => retryMessage(message)}
                              >
                                {t.retry}
                              </button>
                            </>
                          )}
                        </article>
                      ))}
                    </div>
                    <form
                      className="composer"
                      onSubmit={(event) => void sendMessage(event)}
                    >
                      <textarea
                        value={draft}
                        data-testid="message-input"
                        maxLength={4000}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            void sendMessage();
                          }
                        }}
                        placeholder={t.messagePlaceholder}
                      />
                      <button
                        data-testid="send-message"
                        className="primary"
                        disabled={!draft.trim()}
                      >
                        {t.send}
                      </button>
                    </form>
                  </>
                ) : (
                  <p className="muted empty-chat">{t.selectChat}</p>
                )}
              </section>
            </section>
            {chatState.contactsError && (
              <p className="error">{t.contactsDecryptError}</p>
            )}
            <button
              data-testid="logout"
              className="danger"
              onClick={() => setShowLogoutConfirmation(true)}
            >
              {t.logout}
            </button>
            {showLogoutConfirmation && (
              <div
                className="confirm-panel"
                role="alertdialog"
                aria-labelledby="logout-message"
              >
                <p id="logout-message">{t.confirmLogout}</p>
                <button
                  data-testid="confirm-logout"
                  className="danger"
                  onClick={() => void confirmLogout()}
                >
                  {t.confirm}
                </button>
                <button
                  className="secondary"
                  onClick={() => setShowLogoutConfirmation(false)}
                >
                  {t.cancel}
                </button>
              </div>
            )}
          </>
        )}
        {(screen === "login" || screen === "create" || screen === "verify") && (
          <button
            className="text-button"
            onClick={() => {
              setHasError(false);
              setScreen(screen === "verify" ? "create" : "welcome");
            }}
          >
            {t.back}
          </button>
        )}
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
