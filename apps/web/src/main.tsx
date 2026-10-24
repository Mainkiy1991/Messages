import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  deriveKeys,
  generateMnemonic,
  normalizeMnemonic,
  userIdFromPublicKey,
  validateMnemonic,
  decryptTextMessage,
  encryptHistoryEntry,
  encryptTextMessage,
  newClientMsgId,
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
  saveSession,
  restoreServerSession,
  type ServerSession,
} from "./session.js";
import {
  ApiError,
  getUserKeys,
  loginToServer,
  logoutFromServer,
  verifyUserKeys,
} from "./lib/api.js";
import {
  ChatConnection,
  type IncomingFrame,
  type SocketState,
} from "./lib/websocket.js";
import "./style.css";

type Screen = "welcome" | "create" | "verify" | "login" | "home";
type ChatMessage = {
  id: string;
  clientMsgId?: string;
  text: string;
  createdAt: string;
  direction: "in" | "out";
  status?: "sending" | "sent" | "delivered" | "error";
  error?: string;
  frame?: {
    type: "send";
    clientMsgId: string;
    to: string;
    ciphertext: string;
    senderCopy: string;
  };
};
type Chat = { peerId: string; messages: ChatMessage[] };

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
  const [serverSession, setServerSession] = useState<ServerSession | null>(
    null,
  );
  const [chats, setChats] = useState<Chat[]>([]);
  const [activePeer, setActivePeer] = useState("");
  const [peerInput, setPeerInput] = useState("");
  const [draft, setDraft] = useState("");
  const [chatError, setChatError] = useState("");
  const [socketState, setSocketState] = useState<SocketState>("offline");
  const [mobileChat, setMobileChat] = useState(false);
  const connectionRef = useRef<ChatConnection | null>(null);
  const verifiedKeys = useRef(new Map<string, Uint8Array>());
  const tRef = useRef(t);
  tRef.current = t;

  useEffect(() => {
    void Promise.all([restoreSession(), restoreServerSession()]).then(
      async ([saved, savedServer]) => {
        if (saved) {
          setKeys(saved);
          let session = savedServer;
          try {
            if (!session || Date.parse(session.expiresAt) <= Date.now())
              session = await loginToServer(saved);
          } catch {
            setChatError(tRef.current.serverUnavailable);
          }
          if (session) setServerSession(session);
          setScreen("home");
        }
      },
    );
  }, []);
  function changeLanguage(next: Language) {
    setLanguage(next);
    localStorage.setItem("messages-language", next);
  }

  async function enter(mnemonic: string) {
    const derived = deriveKeys(normalizeMnemonic(mnemonic));
    await saveSession(derived);
    const online = await loginToServer(derived);
    setKeys(derived);
    setServerSession(online);
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
    connectionRef.current?.stop();
    connectionRef.current = null;
    if (serverSession?.token) {
      try {
        await logoutFromServer(serverSession.token);
      } catch {
        /* Best effort logout */
      }
    }
    await clearSession();
    setKeys(null);
    setServerSession(null);
    setChats([]);
    setActivePeer("");
    verifiedKeys.current.clear();
    setSocketState("offline");
    setPhrase("");
    setShowLogoutConfirmation(false);
    setScreen("welcome");
  }

  const userId = keys ? userIdFromPublicKey(keys.identity.publicKey) : "";
  useEffect(() => {
    if (!keys || !serverSession || screen !== "home") return;
    const connection = new ChatConnection(keys, serverSession, {
      onState: setSocketState,
      onMessageId: (clientMsgId) =>
        setChats((all) =>
          all.map((chat) => ({
            ...chat,
            messages: chat.messages.map((m) =>
              m.clientMsgId === clientMsgId ? { ...m, status: "sent" } : m,
            ),
          })),
        ),
      onFrame: async (frame: IncomingFrame) => {
        if (
          frame.type === "message" &&
          typeof frame.from === "string" &&
          typeof frame.ciphertext === "string" &&
          typeof frame.createdAt === "string" &&
          typeof frame.id === "string"
        ) {
          let text: string = tRef.current.decryptFailed;
          try {
            let peerKey = verifiedKeys.current.get(frame.from);
            if (!peerKey) {
              const pub = await getUserKeys(frame.from, serverSession.token);
              peerKey = verifyUserKeys(frame.from, pub);
              verifiedKeys.current.set(frame.from, peerKey);
            }
            text = decryptTextMessage({
              recipientEncryptionPrivateKey: keys.encryption.privateKey,
              senderEncryptionPublicKey: peerKey,
              senderId: frame.from,
              recipientId: userId,
              ciphertext: frame.ciphertext,
            }).text;
          } catch {
            /* Never expose ciphertext or key errors */
          }
          setChats((all) => {
            const found = all.find((chat) => chat.peerId === frame.from);
            const next = {
              id: frame.id as string,
              text,
              createdAt: frame.createdAt as string,
              direction: "in" as const,
            };
            return found
              ? all.map((chat) =>
                  chat.peerId === frame.from
                    ? { ...chat, messages: [...chat.messages, next] }
                    : chat,
                )
              : [...all, { peerId: frame.from as string, messages: [next] }];
          });
          setActivePeer(frame.from);
          setMobileChat(true);
          return;
        }
        if (
          frame.type === "sent" &&
          typeof frame.clientMsgId === "string" &&
          typeof frame.id === "string" &&
          typeof frame.createdAt === "string"
        ) {
          setChats((all) =>
            all.map((chat) => ({
              ...chat,
              messages: chat.messages.map((m) =>
                m.clientMsgId === frame.clientMsgId
                  ? {
                      ...m,
                      id: frame.id as string,
                      createdAt: frame.createdAt as string,
                      status: "sent",
                    }
                  : m,
              ),
            })),
          );
          return;
        }
        if (
          frame.type === "delivered" &&
          typeof frame.clientMsgId === "string"
        ) {
          setChats((all) =>
            all.map((chat) => ({
              ...chat,
              messages: chat.messages.map((m) =>
                m.clientMsgId === frame.clientMsgId
                  ? { ...m, status: "delivered" }
                  : m,
              ),
            })),
          );
          return;
        }
        if (frame.type === "error" && typeof frame.clientMsgId === "string") {
          const code =
            typeof frame.code === "string" ? frame.code : "internal_error";
          const reason =
            code === "recipient_not_found"
              ? tRef.current.userNotFound
              : tRef.current.sendFailed;
          setChats((all) =>
            all.map((chat) => ({
              ...chat,
              messages: chat.messages.map((m) =>
                m.clientMsgId === frame.clientMsgId
                  ? { ...m, status: "error", error: reason }
                  : m,
              ),
            })),
          );
          return;
        }
      },
    });
    connectionRef.current = connection;
    connection.start();
    return () => {
      connection.stop();
      if (connectionRef.current === connection) connectionRef.current = null;
    };
  }, [keys, serverSession, screen, userId]);

  async function openChat(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setChatError("");
    const peerId = peerInput.trim();
    if (!/^[0-9a-f]{64}$/u.test(peerId)) {
      setChatError(t.invalidId);
      return;
    }
    if (peerId === userId) {
      setChatError(t.selfChat);
      return;
    }
    try {
      const keysValue = await getUserKeys(peerId, serverSession!.token);
      verifiedKeys.current.set(peerId, verifyUserKeys(peerId, keysValue));
      setChats((all) =>
        all.some((chat) => chat.peerId === peerId)
          ? all
          : [...all, { peerId, messages: [] }],
      );
      setActivePeer(peerId);
      setMobileChat(true);
      setPeerInput("");
    } catch (error) {
      setChatError(
        error instanceof ApiError && error.status === 404
          ? t.userNotFound
          : t.badPeerKey,
      );
    }
  }

  function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    const text = draft;
    if (!keys || !activePeer || !text.trim() || Array.from(text).length > 4000)
      return;
    const peerPublic = verifiedKeys.current.get(activePeer);
    if (!peerPublic) {
      setChatError(t.badPeerKey);
      return;
    }
    const clientMsgId = newClientMsgId();
    const sentAt = Date.now();
    const ciphertext = encryptTextMessage({
      senderEncryptionPrivateKey: keys.encryption.privateKey,
      recipientEncryptionPublicKey: peerPublic,
      senderId: userId,
      recipientId: activePeer,
      text,
      sentAt,
    });
    const senderCopy = encryptHistoryEntry({
      historyKey: keys.historyKey,
      clientMsgId,
      peerId: activePeer,
      text,
      sentAt,
    });
    const frame = {
      type: "send" as const,
      clientMsgId,
      to: activePeer,
      ciphertext,
      senderCopy,
    };
    setChats((all) =>
      all.map((chat) =>
        chat.peerId === activePeer
          ? {
              ...chat,
              messages: [
                ...chat.messages,
                {
                  id: clientMsgId,
                  clientMsgId,
                  text,
                  createdAt: new Date(sentAt).toISOString(),
                  direction: "out",
                  status: "sending",
                  frame,
                },
              ],
            }
          : chat,
      ),
    );
    connectionRef.current?.send(frame);
    setDraft("");
    setChatError("");
  }

  function retryMessage(message: ChatMessage) {
    if (!message.frame) return;
    setChats((all) =>
      all.map((chat) => ({
        ...chat,
        messages: chat.messages.map((m) =>
          m === message ? { ...m, status: "sending", error: undefined } : m,
        ),
      })),
    );
    connectionRef.current?.retryMessage(message.frame);
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
            <button className="primary" onClick={() => setScreen("create")}>
              {t.create}
            </button>
            <button
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
            <ol className="seed-list">
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
            <p className="muted">
              {t.chats} ·{" "}
              {socketState === "connected"
                ? t.connected
                : socketState === "connecting"
                  ? t.connecting
                  : t.offline}
            </p>
            <div className="id-box">
              <label>{t.userId}</label>
              <code>{userId}</code>
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
                >
                  <input
                    aria-label={t.peerId}
                    value={peerInput}
                    onChange={(event) => setPeerInput(event.target.value)}
                    placeholder={t.peerId}
                  />
                  <button className="secondary">{t.newChat}</button>
                </form>
                {chatError && <p className="error">{chatError}</p>}
                {chats
                  .slice()
                  .sort((a, b) =>
                    (b.messages.at(-1)?.createdAt ?? "").localeCompare(
                      a.messages.at(-1)?.createdAt ?? "",
                    ),
                  )
                  .map((chat) => (
                    <button
                      className={`chat-list-item ${chat.peerId === activePeer ? "selected" : ""}`}
                      key={chat.peerId}
                      onClick={() => {
                        setActivePeer(chat.peerId);
                        setMobileChat(true);
                      }}
                    >
                      <strong>{chat.peerId.slice(-10)}</strong>
                      <span>{chat.messages.at(-1)?.text ?? t.noMessages}</span>
                    </button>
                  ))}
              </aside>
              <section className="conversation">
                {activePeer ? (
                  <>
                    <div className="conversation-head">
                      <button
                        className="text-button mobile-back"
                        onClick={() => setMobileChat(false)}
                      >
                        {t.back}
                      </button>
                      <strong>{activePeer.slice(-10)}</strong>
                    </div>
                    <div className="message-list">
                      {(
                        chats.find((chat) => chat.peerId === activePeer)
                          ?.messages ?? []
                      ).map((message) => (
                        <article
                          className={`message ${message.direction}`}
                          key={message.id}
                        >
                          <div className="message-text">{message.text}</div>
                          <small>
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
                              <span className="error">{message.error}</span>
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
                    <form className="composer" onSubmit={sendMessage}>
                      <textarea
                        value={draft}
                        maxLength={4000}
                        onChange={(event) => setDraft(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" && !event.shiftKey) {
                            event.preventDefault();
                            sendMessage();
                          }
                        }}
                        placeholder={t.messagePlaceholder}
                      />
                      <button className="primary" disabled={!draft.trim()}>
                        {t.send}
                      </button>
                    </form>
                  </>
                ) : (
                  <p className="muted empty-chat">{t.selectChat}</p>
                )}
              </section>
            </section>
            <button
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
                <button className="danger" onClick={() => void confirmLogout()}>
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
