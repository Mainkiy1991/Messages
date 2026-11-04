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
  getLanguageLocale,
  getInitialLanguage,
  saveLanguagePreference,
  strings,
  supportedLanguages,
  type Language,
} from "./i18n.js";
import {
  clearSession,
  restoreSession,
  restoreServerSession,
  saveSession,
  getPinState,
  unlockWithPin,
  enablePin,
  changePin,
  disablePin,
} from "./session.js";
import { indexedDbOutbox } from "./lib/outbox.js";
import { phraseMatchesAccount } from "./lib/seed-check.js";
import {
  ChatController,
  chatPreview,
  contactLabel,
  type Chat,
  type ChatControllerState,
} from "./lib/chat-controller.js";
import type { ChatMessage } from "./lib/chat-controller.js";
import {
  PresenceDot,
  PresenceLabel,
} from "./components/presence-indicators.js";
import {
  EditBanner,
  EditMessageButton,
  EditedMark,
} from "./components/message-edit.js";
import {
  DeleteConfirmBar,
  DeleteRequestButton,
  DeleteRequestNotice,
  DeletedMessageText,
  DeletionMark,
} from "./components/message-delete.js";
import {
  canEditMessage,
  canSubmitEdit,
  draftAfterEdit,
  isEditingMessage,
  startMessageEdit,
  submitMessageEdit,
  toggleEditAction,
  type MessageEditState,
} from "./lib/message-edit.js";
import {
  canRequestDeletion,
  chatPreviewAfterDeletion,
  isDeletedIncoming,
} from "./lib/message-delete.js";
import "./style.css";

type Screen =
  "loading" | "locked" | "welcome" | "create" | "verify" | "login" | "home";
function App() {
  const [language, setLanguage] = useState<Language>(() =>
    getInitialLanguage(
      typeof navigator === "undefined" ? [] : navigator.languages,
    ),
  );
  const t = strings[language];
  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);
  const [screen, setScreen] = useState<Screen>("loading");
  const [keys, setKeys] = useState<DerivedKeys | null>(null);
  const [count, setCount] = useState<12 | 24>(12);
  const [phrase, setPhrase] = useState("");
  const [pin, setPin] = useState("");
  const [pinConfirm, setPinConfirm] = useState("");
  const [oldPin, setOldPin] = useState("");
  const [pinButtonError, setPinButtonError] = useState<
    "incorrect" | "tooShort" | "mismatch" | "verification" | "operation" | null
  >(null);
  const [pinInputIncorrect, setPinInputIncorrect] = useState(false);
  const [pinOperation, setPinOperation] = useState<
    "enable" | "change" | "disable" | "unlock" | null
  >(null);
  const [pinEnabled, setPinEnabled] = useState(false);
  const [pinNextAttemptAt, setPinNextAttemptAt] = useState(0);
  const [pinCountdown, setPinCountdown] = useState(0);
  const [positions, setPositions] = useState<number[]>([]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [hasError, setHasError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showLogoutConfirmation, setShowLogoutConfirmation] = useState(false);
  const [showLogoutSkipWarning, setShowLogoutSkipWarning] = useState(false);
  const [logoutPhrase, setLogoutPhrase] = useState("");
  const [logoutError, setLogoutError] = useState(false);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState(false);
  const [showForgotPinConfirmation, setShowForgotPinConfirmation] =
    useState(false);
  const [chatMenuOpen, setChatMenuOpen] = useState(false);
  const [chatState, setChatState] = useState<ChatControllerState>({
    chats: [],
    activePeer: "",
    connectionState: "offline",
    error: "",
    contacts: {},
    contactsError: false,
    waking: false,
    presence: {},
  });
  const [peerInput, setPeerInput] = useState("");
  const [newContactName, setNewContactName] = useState("");
  const [contactNameDraft, setContactNameDraft] = useState("");
  const [draft, setDraft] = useState("");
  const [editState, setEditState] = useState<MessageEditState | null>(null);
  const [activeEditId, setActiveEditId] = useState<string | null>(null);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState("");
  const [chatError, setChatError] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileSection, setProfileSection] = useState<
    "language" | "pin" | "id" | null
  >(null);
  const [pinForm, setPinForm] = useState<
    "enable" | "change" | "disable" | null
  >(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [presenceClock, setPresenceClock] = useState(Date.now());
  const profileRef = useRef<HTMLDivElement | null>(null);
  const pinErrorTimerRef = useRef<number | null>(null);
  const pinInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<ChatController | null>(null);
  const messageListRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const wasNearBottomRef = useRef(true);
  const previousPeerRef = useRef("");
  const preserveScrollRef = useRef(false);
  const chatHistoryRef = useRef(false);

  useEffect(() => {
    const timer = window.setInterval(
      () => setPresenceClock(Date.now()),
      60_000,
    );
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const updateCountdown = () =>
      setPinCountdown(
        Math.max(0, Math.ceil((pinNextAttemptAt - Date.now()) / 1000)),
      );
    updateCountdown();
    const timer = window.setInterval(updateCountdown, 1000);
    return () => window.clearInterval(timer);
  }, [pinNextAttemptAt]);
  useEffect(
    () => () => {
      if (pinErrorTimerRef.current !== null)
        window.clearTimeout(pinErrorTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (!profileOpen) return;
    const outside = (event: PointerEvent) => {
      if (!profileRef.current?.contains(event.target as Node)) {
        setProfileSection(null);
        setPinForm(null);
        setProfileOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProfileSection(null);
        setPinForm(null);
        setProfileOpen(false);
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [profileOpen]);

  useEffect(() => {
    const updateVisibility = () => controllerRef.current?.visibilityChanged();
    document.addEventListener("visibilitychange", updateVisibility);
    return () =>
      document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    void getPinState()
      .then(async (pinState) => {
        setPinEnabled(Boolean(pinState));
        setPinNextAttemptAt(pinState?.nextAttemptAt ?? 0);
        if (pinState) {
          setScreen("locked");
          return false;
        }
        return restoreSession();
      })
      .then((saved) => {
        if (saved) {
          setKeys(saved);
          setScreen("home");
        } else if (saved !== false) setScreen("welcome");
      })
      .catch(() => setScreen("welcome"));
  }, []);
  function changeLanguage(next: Language) {
    setLanguage(next);
    saveLanguagePreference(next);
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
      waking: false,
      presence: {},
    });
    setPhrase("");
    setScreen("home");
    setHasError(false);
  }

  function showPinButtonError(
    error: "incorrect" | "tooShort" | "mismatch" | "verification" | "operation",
  ) {
    if (pinErrorTimerRef.current !== null)
      window.clearTimeout(pinErrorTimerRef.current);
    setPinButtonError(error);
    pinErrorTimerRef.current = window.setTimeout(() => {
      setPinButtonError(null);
      setPinInputIncorrect(false);
    }, 2000);
    if (error === "incorrect") {
      setPinInputIncorrect(true);
      setPin("");
      setOldPin("");
      window.requestAnimationFrame(() => pinInputRef.current?.focus());
    }
  }
  async function refreshPinCooldown(): Promise<boolean> {
    const state = await getPinState();
    const nextAttemptAt = state?.nextAttemptAt ?? 0;
    setPinNextAttemptAt(nextAttemptAt);
    setPinCountdown(
      Math.max(0, Math.ceil((nextAttemptAt - Date.now()) / 1000)),
    );
    return Date.now() >= nextAttemptAt;
  }
  async function waitForPaint() {
    await new Promise<void>((resolve) =>
      window.requestAnimationFrame(() => window.setTimeout(resolve, 0)),
    );
  }
  function formatPinCountdown(seconds: number): string {
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  }
  async function submitPin() {
    if (pinOperation) return;
    try {
      if (!(await refreshPinCooldown())) return;
    } catch {
      showPinButtonError("operation");
      return;
    }
    setPinButtonError(null);
    setPinOperation("unlock");
    await waitForPaint();
    try {
      const restored = await unlockWithPin(pin);
      setKeys(restored);
      setPin("");
      setScreen("home");
    } catch (error) {
      try {
        await refreshPinCooldown();
      } catch {
        showPinButtonError("operation");
        return;
      }
      if (error instanceof Error && error.message === "PIN_INVALID")
        showPinButtonError("incorrect");
      else if (error instanceof Error && error.message === "PIN_KDF_FAILED")
        showPinButtonError("verification");
      else if (!(
        error instanceof Error && error.message === "PIN_ATTEMPT_DELAY"
      ))
        showPinButtonError("operation");
    } finally {
      setPinOperation(null);
    }
  }
  async function managePin(action: "enable" | "change" | "disable") {
    if (pinOperation) return;
    if (action !== "enable") {
      try {
        if (!(await refreshPinCooldown())) return;
      } catch {
        showPinButtonError("operation");
        return;
      }
    }
    setPinButtonError(null);
    if (action !== "disable") {
      if (Array.from(pin).length < 6) {
        showPinButtonError("tooShort");
        return;
      }
      if (pin.normalize("NFKC") !== pinConfirm.normalize("NFKC")) {
        showPinButtonError("mismatch");
        return;
      }
    }
    if (action === "enable") {
      let queuedCount: number;
      try {
        queuedCount = (await indexedDbOutbox.list(userId)).length;
      } catch {
        showPinButtonError("operation");
        return;
      }
      if (queuedCount && !window.confirm(t.pinQueueConfirm(queuedCount)))
        return;
    }
    setPinOperation(action);
    await waitForPaint();
    try {
      if (!keys) return;
      if (action === "enable") {
        await enablePin(keys, pin);
        setPinEnabled(true);
        setPinNextAttemptAt(0);
      } else if (action === "change") {
        await changePin(keys, oldPin, pin);
      } else {
        await disablePin(oldPin);
        setPinEnabled(false);
      }
      setPin("");
      setPinConfirm("");
      setOldPin("");
      setPinForm(null);
    } catch (error) {
      try {
        await refreshPinCooldown();
      } catch {
        showPinButtonError("operation");
        return;
      }
      if (error instanceof Error && error.message === "PIN_INVALID")
        showPinButtonError("incorrect");
      else if (error instanceof Error && error.message === "PIN_TOO_SHORT")
        showPinButtonError("tooShort");
      else if (error instanceof Error && error.message === "PIN_KDF_FAILED")
        showPinButtonError("verification");
      else showPinButtonError("operation");
    } finally {
      setPinOperation(null);
    }
  }
  function toggleProfileSection(section: "language" | "pin" | "id") {
    const closing = profileSection === section;
    setProfileSection(closing ? null : section);
    if (section !== "pin" || closing) setPinForm(null);
  }
  function togglePinForm(form: "enable" | "change" | "disable") {
    setPinButtonError(null);
    if (pinForm === form) {
      setPinForm(null);
      return;
    }
    setPin("");
    setPinConfirm("");
    setOldPin("");
    setPinForm(form);
  }
  async function forgotPin() {
    setShowForgotPinConfirmation(true);
  }
  async function finishForgotPin() {
    await clearSession();
    setKeys(null);
    setPinEnabled(false);
    setPin("");
    setShowForgotPinConfirmation(false);
    setScreen("welcome");
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

  function openLogoutCheck() {
    setLogoutPhrase("");
    setLogoutError(false);
    setShowLogoutSkipWarning(false);
    setShowLogoutConfirmation(true);
  }

  function cancelLogout() {
    setLogoutPhrase("");
    setLogoutError(false);
    setShowLogoutSkipWarning(false);
    setShowLogoutConfirmation(false);
  }

  function backToLogoutCheck() {
    setLogoutPhrase("");
    setLogoutError(false);
    setShowLogoutSkipWarning(false);
  }

  function verifyAndLogout() {
    if (!phraseMatchesAccount(logoutPhrase, userId)) {
      setLogoutError(true);
      return;
    }
    void confirmLogout();
  }

  async function confirmLogout() {
    await controllerRef.current?.logout();
    controllerRef.current = null;
    await clearSession();
    window.history.replaceState(null, "", window.location.href);
    chatHistoryRef.current = false;
    setKeys(null);
    setChatState({
      chats: [],
      activePeer: "",
      connectionState: "offline",
      error: "",
      contacts: {},
      contactsError: false,
      waking: false,
      presence: {},
    });
    setPhrase("");
    setLogoutPhrase("");
    setLogoutError(false);
    setShowLogoutSkipWarning(false);
    setShowLogoutConfirmation(false);
    setScreen("welcome");
  }

  const userId = keys ? userIdFromPublicKey(keys.identity.publicKey) : "";
  const pinErrorText = pinButtonError
    ? pinButtonError === "incorrect"
      ? t.pinIncorrect
      : pinButtonError === "tooShort"
        ? t.pinTooShort
        : pinButtonError === "mismatch"
          ? t.pinMismatch
          : pinButtonError === "verification"
            ? t.pinCheckFailed
            : t.pinOperationFailed
    : "";
  function pinActionText(
    label: string,
    operation: "enable" | "change" | "disable" | "unlock",
  ) {
    if (pinOperation === operation) {
      return operation === "enable"
        ? t.pinInstalling
        : operation === "change"
          ? t.pinChanging
          : operation === "disable"
            ? t.pinDisabling
            : t.pinUnlocking;
    }
    if (operation !== "enable" && pinCountdown > 0)
      return t.pinCountdown(formatPinCountdown(pinCountdown));
    return pinButtonError ? pinErrorText : label;
  }
  const pinActionDisabled = (operation: "enable" | "change" | "disable") =>
    Boolean(pinOperation || (operation !== "enable" && pinCountdown > 0));
  const chats = withSavedChat(chatState.chats, userId);
  const activePeer = chatState.activePeer;
  const socketState = chatState.connectionState;
  const isSavedChat = activePeer !== "" && activePeer === userId;
  const chatTitle = (peerId: string) =>
    peerId === userId
      ? t.savedMessages
      : contactLabel(peerId, chatState.contacts);
  const activeChat = chats.find((chat) => chat.peerId === activePeer);
  const activeMessages = activeChat?.messages ?? [];
  useEffect(() => {
    if (screen !== "home") return;
    const onPopState = (event: PopStateEvent) => {
      const peerId = (event.state as { chat?: unknown } | null)?.chat;
      chatHistoryRef.current = false;
      if (typeof peerId === "string" && /^[0-9a-f]{64}$/u.test(peerId))
        void controllerRef.current?.openChat(peerId);
      else controllerRef.current?.closeActiveChat();
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [screen]);
  useEffect(() => {
    if (screen !== "home" || !activePeer) return;
    const state = window.history.state as { chat?: unknown } | null;
    if (state?.chat === activePeer) {
      chatHistoryRef.current = true;
      return;
    }
    window.history.pushState({ chat: activePeer }, "", window.location.href);
    chatHistoryRef.current = true;
  }, [activePeer, screen]);
  useEffect(() => {
    if (!activePeer) {
      setChatMenuOpen(false);
      setShowDeleteConfirmation(false);
    }
  }, [activePeer]);
  useEffect(() => {
    // The edit target belongs to one chat, so leaving the chat ends the mode.
    if (!editState || editState.peerId === activePeer) return;
    setDraft(draftAfterEdit(editState));
    setEditState(null);
  }, [activePeer, editState]);
  useEffect(() => {
    setActiveEditId(null);
    setDeleteConfirmId(null);
    setDeleteError("");
  }, [activePeer]);
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
      : code === "user_not_found"
        ? t.userNotFound
        : code === "server_unavailable"
          ? t.serverUnavailable
          : code === "invalid_text"
            ? t.invalidText
            : code === "send_failed"
              ? t.sendFailed
              : code === "edit_limit"
                ? t.editLimit
                : code === "not_editable"
                  ? t.editNotEditable
                  : code === "edit_pending"
                    ? t.editPending
                    : code === "unknown_message"
                      ? t.editUnknownMessage
                      : code === "message_deleted"
                        ? t.editMessageDeleted
                        : code === "message_pending"
                          ? t.editPending
                          : code === "not_deletable"
                            ? t.deleteNotDeletable
                            : code === "already_requested"
                              ? t.deleteAlreadyRequested
                              : code === "no_request"
                                ? t.deleteNoRequest
                                : code === "already_answered"
                                  ? t.deleteAlreadyAnswered
                                  : t.badPeerKey;
  useEffect(() => {
    if (!keys || screen !== "home") return;
    let cancelled = false;
    void restoreServerSession(keys).then((session) => {
      if (cancelled) return;
      const controller = new ChatController(keys, userId, session, {
        onChange: setChatState,
        deferOutgoingUntilConversations: true,
      });
      controllerRef.current = controller;
      controller.start();
      const historyPeer = (window.history.state as { chat?: unknown } | null)
        ?.chat;
      if (
        typeof historyPeer === "string" &&
        /^[0-9a-f]{64}$/u.test(historyPeer)
      ) {
        chatHistoryRef.current = true;
        void controller.openChat(historyPeer);
      }
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
      if (newContactName.trim() && next.activePeer !== userId) {
        const saved = await controllerRef.current?.saveContactName(
          next.activePeer,
          newContactName,
        );
        if (!saved) setChatError(t.contactSaveFailed);
      }
      setPeerInput("");
      setNewContactName("");
      setNewChatOpen(false);
      setContactNameDraft(chatState.contacts[next.activePeer] ?? "");
    }
  }

  async function sendMessage(event?: React.FormEvent) {
    event?.preventDefault();
    if (editState) {
      if (!canSubmitEdit(editState, draft)) return;
      const result = await submitMessageEdit({
        state: editState,
        draft,
        sendEdit: async (peerId, targetId, text) =>
          (await controllerRef.current?.sendEdit(peerId, targetId, text)) ?? {
            ok: false,
            error: "server_unavailable",
          },
      });
      if (!result.ok) {
        setChatError(errorText(result.error));
        return;
      }
      setEditState(null);
      setDraft(draftAfterEdit(editState));
      setChatError("");
      window.requestAnimationFrame(resizeComposer);
      return;
    }
    const text = draft;
    await controllerRef.current?.sendText(text);
    setDraft((current) => (current === text ? "" : current));
    const error = controllerRef.current?.getSnapshot().error;
    setChatError(error ? errorText(error) : "");
  }

  function resizeComposer() {
    const input = composerRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 130)}px`;
  }

  function beginEdit(message: ChatMessage) {
    if (!activePeer) return;
    const next = startMessageEdit({
      peerId: activePeer,
      message,
      composerDraft: draft,
      userId,
    });
    if (!next) return;
    setEditState(next);
    setActiveEditId(null);
    setDeleteConfirmId(null);
    setDeleteError("");
    setDraft(message.text);
    setChatError("");
    window.requestAnimationFrame(() => {
      composerRef.current?.focus();
      resizeComposer();
    });
  }

  /**
   * Touch screens have no hover: a tap on an own bubble toggles its actions.
   * The bubble becomes active when the pencil or the basket is available.
   */
  function selectMessageForEdit(message: ChatMessage) {
    if (!window.matchMedia?.("(hover: none)").matches) return;
    const selection = window.getSelection();
    const hasSelection = Boolean(
      selection && !selection.isCollapsed && selection.toString().trim(),
    );
    setActiveEditId((current) =>
      toggleEditAction({
        current,
        message,
        userId,
        hasSelection,
        actionable:
          canEditMessage(message, userId) ||
          (canRequestDeletion({ message, userId, peerId: activePeer }) &&
            !editState),
      }),
    );
  }

  function cancelEdit() {
    if (!editState) return;
    setDraft(draftAfterEdit(editState));
    setEditState(null);
    setChatError("");
    window.requestAnimationFrame(resizeComposer);
  }

  /** Opens the confirmation row under the chat; only one request at a time. */
  function beginDeleteRequest(message: ChatMessage) {
    if (!activePeer) return;
    if (!canRequestDeletion({ message, userId, peerId: activePeer })) return;
    const targetId = message.replayId;
    if (!targetId) return;
    setActiveEditId(null);
    setDeleteError("");
    setDeleteConfirmId(targetId);
  }

  function cancelDeleteRequest() {
    setDeleteConfirmId(null);
    setDeleteError("");
  }

  async function confirmDeleteRequest() {
    if (!deleteConfirmId || !activePeer) return;
    const result = await controllerRef.current?.sendDeleteRequest(
      activePeer,
      deleteConfirmId,
    );
    if (!result?.ok) {
      setDeleteError(errorText(result?.error ?? "server_unavailable"));
      return;
    }
    setDeleteConfirmId(null);
    setDeleteError("");
  }

  /** The recipient answers the request: hide the message here or keep it. */
  async function answerDeleteRequest(targetId: string, accept: boolean) {
    if (!activePeer) return;
    const result = await controllerRef.current?.sendDeleteAnswer(
      activePeer,
      targetId,
      accept,
    );
    if (!result?.ok) {
      setDeleteError(errorText(result?.error ?? "server_unavailable"));
      return;
    }
    setDeleteError("");
  }

  /** Note under your own message: what the other person did with the request. */
  function deletionMarkText(message: ChatMessage): string {
    return message.deletion === "accepted"
      ? t.deleteAccepted
      : message.deletion === "declined"
        ? t.deleteDeclined
        : t.deleteRequested;
  }

  function retryMessage(message: ChatMessage) {
    if (!message.clientMsgId || !activePeer) return;
    controllerRef.current?.retryMessage(activePeer, message.clientMsgId);
  }

  function statusText(message: ChatMessage): string {
    if (message.direction !== "out" || isSavedChat) return "";
    return message.status === "read"
      ? t.read
      : message.status === "delivered"
        ? t.delivered
        : message.status === "sent"
          ? t.sent
          : message.status === "error"
            ? t.failed
            : t.sending;
  }

  async function confirmDeleteChat() {
    if (!activePeer) return;
    const deleted = await controllerRef.current?.deleteChat(activePeer);
    if (deleted) {
      setShowDeleteConfirmation(false);
      setChatMenuOpen(false);
      setEditingName(false);
      setDraft("");
      setChatError("");
    } else {
      setChatError(t.deleteChatFailed);
    }
  }
  if (screen === "loading") return <main className="session-loading" />;
  return (
    <main className="shell">
      <header className={screen === "home" ? "app-header" : undefined}>
        <a
          className="brand"
          onClick={() => screen === "welcome" && setScreen("welcome")}
        >
          {t.title}
        </a>
        {screen === "home" && (
          <span
            className={`connection-dot ${socketState}`}
            data-testid="connection-status"
            data-state={socketState}
            aria-label={
              socketState === "connected"
                ? t.connected
                : socketState === "connecting"
                  ? t.connecting
                  : t.offline
            }
            title={
              socketState === "connected"
                ? t.connected
                : socketState === "connecting"
                  ? t.connecting
                  : t.offline
            }
            tabIndex={0}
          />
        )}
        <div className="header-actions">
          {screen === "home" && (
            <div className="profile-wrap" ref={profileRef}>
              <button
                data-testid="profile"
                className="profile-button"
                aria-label={t.profile}
                title={t.profile}
                aria-expanded={profileOpen}
                onClick={() => {
                  if (profileOpen) {
                    setProfileSection(null);
                    setPinForm(null);
                  }
                  setProfileOpen(!profileOpen);
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
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <circle cx="12" cy="8" r="4" />
                  <path d="M5 21v-2a7 7 0 0 1 14 0v2" />
                </svg>
              </button>
              {profileOpen && (
                <div className="profile-panel">
                  <button
                    className="secondary profile-item"
                    aria-expanded={profileSection === "language"}
                    onClick={() => toggleProfileSection("language")}
                  >
                    {t.language}
                  </button>
                  {profileSection === "language" && (
                    <div className="profile-section">
                      <label className="profile-language">
                        {t.language}
                        <select
                          aria-label={t.language}
                          value={language}
                          onChange={(event) =>
                            changeLanguage(event.target.value as Language)
                          }
                        >
                          {supportedLanguages.map((entry) => (
                            <option key={entry.code} value={entry.code}>
                              {entry.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  )}
                  <button
                    className="secondary profile-item"
                    aria-expanded={profileSection === "pin"}
                    onClick={() => toggleProfileSection("pin")}
                  >
                    {t.pinTitle}
                  </button>
                  {profileSection === "pin" && (
                    <div className="profile-section pin-settings">
                      {!pinEnabled ? (
                        <>
                          <button
                            className="secondary profile-item"
                            aria-expanded={pinForm === "enable"}
                            disabled={Boolean(pinOperation)}
                            onClick={() => togglePinForm("enable")}
                          >
                            {t.pinEnable}
                          </button>
                          {pinForm === "enable" && (
                            <>
                              <input
                                aria-label={t.pinNew}
                                className="pin-input"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={pin}
                                onChange={(e) => setPin(e.target.value)}
                                placeholder={t.pinNew}
                              />
                              <input
                                aria-label={t.pinConfirm}
                                className="pin-input"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={pinConfirm}
                                onChange={(e) => setPinConfirm(e.target.value)}
                                placeholder={t.pinConfirm}
                              />
                              <small>{t.pinHint}</small>
                              <button
                                className={`secondary pin-action${pinButtonError ? " pin-action-error" : ""}`}
                                aria-live="polite"
                                disabled={pinActionDisabled("enable")}
                                onClick={() => void managePin("enable")}
                              >
                                {pinActionText(t.pinInstallSubmit, "enable")}
                              </button>
                            </>
                          )}
                        </>
                      ) : (
                        <>
                          <button
                            className="secondary profile-item"
                            aria-expanded={pinForm === "change"}
                            disabled={Boolean(pinOperation)}
                            onClick={() => togglePinForm("change")}
                          >
                            {t.pinChange}
                          </button>
                          {pinForm === "change" && (
                            <>
                              <input
                                aria-label={t.pinCurrent}
                                ref={pinInputRef}
                                className={`pin-input${pinInputIncorrect ? " pin-input-incorrect" : ""}`}
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={oldPin}
                                onChange={(e) => setOldPin(e.target.value)}
                                placeholder={t.pinCurrent}
                              />
                              <input
                                aria-label={t.pinNew}
                                className="pin-input"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={pin}
                                onChange={(e) => setPin(e.target.value)}
                                placeholder={t.pinNew}
                              />
                              <input
                                aria-label={t.pinConfirm}
                                className="pin-input"
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={pinConfirm}
                                onChange={(e) => setPinConfirm(e.target.value)}
                                placeholder={t.pinConfirm}
                              />
                              <small>{t.pinHint}</small>
                              <button
                                className={`secondary pin-action${pinButtonError ? " pin-action-error" : ""}`}
                                aria-live="polite"
                                disabled={pinActionDisabled("change")}
                                onClick={() => void managePin("change")}
                              >
                                {pinActionText(t.pinChangeSubmit, "change")}
                              </button>
                            </>
                          )}
                          <button
                            className="secondary profile-item"
                            aria-expanded={pinForm === "disable"}
                            disabled={Boolean(pinOperation)}
                            onClick={() => togglePinForm("disable")}
                          >
                            {t.pinDisable}
                          </button>
                          {pinForm === "disable" && (
                            <>
                              <input
                                aria-label={t.pinCurrent}
                                ref={pinInputRef}
                                className={`pin-input${pinInputIncorrect ? " pin-input-incorrect" : ""}`}
                                type="text"
                                inputMode="text"
                                autoComplete="off"
                                data-lpignore="true"
                                data-1p-ignore="true"
                                value={oldPin}
                                onChange={(e) => setOldPin(e.target.value)}
                                placeholder={t.pinCurrent}
                              />
                              <button
                                className={`secondary pin-action${pinButtonError ? " pin-action-error" : ""}`}
                                aria-live="polite"
                                disabled={pinActionDisabled("disable")}
                                onClick={() => void managePin("disable")}
                              >
                                {pinActionText(t.pinDisableSubmit, "disable")}
                              </button>
                            </>
                          )}
                        </>
                      )}
                    </div>
                  )}
                  <button
                    className="secondary profile-item"
                    aria-expanded={profileSection === "id"}
                    onClick={() => toggleProfileSection("id")}
                  >
                    {t.userId}
                  </button>
                  {profileSection === "id" && (
                    <div className="profile-id">
                      <code data-testid="user-id">{userId}</code>
                      <button
                        className="secondary copy-button"
                        onClick={() => {
                          void navigator.clipboard
                            .writeText(userId)
                            .then(() => {
                              setCopied(true);
                              setTimeout(() => setCopied(false), 1600);
                            });
                        }}
                      >
                        {copied ? t.copied : t.copy}
                      </button>
                    </div>
                  )}
                  <button
                    data-testid="logout"
                    className="danger profile-item profile-logout"
                    onClick={openLogoutCheck}
                  >
                    {t.logout}
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </header>
      <section
        className={`card${["welcome", "create", "verify", "login"].includes(screen) ? " auth-card" : ""}${screen === "welcome" ? " welcome-card" : ""}`}
      >
        {screen === "locked" && (
          <div
            className="pin-lock-screen"
            aria-label={t.pinUnlock}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                event.target instanceof HTMLInputElement
              ) {
                event.preventDefault();
                void submitPin();
              }
            }}
          >
            <h1>{t.pinUnlockTitle}</h1>
            <label>
              <input
                autoFocus
                ref={pinInputRef}
                aria-label={t.pinTitle}
                className={`pin-input${pinInputIncorrect ? " pin-input-incorrect" : ""}`}
                type="text"
                inputMode="text"
                autoComplete="off"
                data-lpignore="true"
                data-1p-ignore="true"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
              />
            </label>
            <button
              className={`primary pin-action${pinButtonError ? " pin-action-error" : ""}${pinButtonError === "incorrect" ? " pin-action-incorrect" : ""}`}
              aria-live="polite"
              disabled={Boolean(pinOperation) || pinCountdown > 0}
              onClick={() => void submitPin()}
            >
              {pinActionText(t.pinUnlock, "unlock")}
            </button>
            <button className="text-button" onClick={() => void forgotPin()}>
              {t.forgotPin}
            </button>
          </div>
        )}
        {showForgotPinConfirmation && (
          <div
            className="confirm-panel confirm-stack"
            role="alertdialog"
            aria-labelledby="forgot-pin-message"
          >
            <div id="forgot-pin-message" className="forgot-pin-message">
              {t.forgotConfirm.split("\n\n").map((paragraph) => (
                <p key={paragraph}>{paragraph}</p>
              ))}
            </div>
            <button className="danger" onClick={() => void finishForgotPin()}>
              {t.forgotFinish}
            </button>
            <button
              className="secondary"
              onClick={() => setShowForgotPinConfirmation(false)}
            >
              {t.cancel}
            </button>
          </div>
        )}
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
            <select
              className="welcome-language-select"
              aria-label={t.language}
              value={language}
              onChange={(event) =>
                changeLanguage(event.target.value as Language)
              }
            >
              {supportedLanguages.map((entry) => (
                <option key={entry.code} value={entry.code}>
                  {entry.name}
                </option>
              ))}
            </select>
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
                  <span className="seed-index" aria-hidden="true">
                    {i + 1}.
                  </span>
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
            <section className={`messenger ${activePeer ? "show-chat" : ""}`}>
              <aside className="chat-sidebar">
                <button
                  className="secondary new-chat-toggle"
                  onClick={() => {
                    setNewChatOpen(!newChatOpen);
                    setChatError("");
                  }}
                >
                  {newChatOpen ? t.cancel : `＋ ${t.newChat}`}
                </button>
                {newChatOpen && (
                  <form
                    onSubmit={(event) => void openChat(event)}
                    className="new-chat"
                    data-testid="new-chat-form"
                  >
                    <input
                      aria-label={t.peerId}
                      data-testid="peer-id-input"
                      value={peerInput}
                      onKeyDown={(event) => {
                        if (event.key === "Escape") setNewChatOpen(false);
                      }}
                      onChange={(event) => setPeerInput(event.target.value)}
                      placeholder={t.peerId}
                    />
                    <input
                      aria-label={t.contactName}
                      value={newContactName}
                      onChange={(event) =>
                        setNewContactName(event.target.value)
                      }
                      placeholder={t.contactName}
                    />
                    {chatError && <p className="error">{chatError}</p>}
                    <div className="new-chat-actions">
                      <button data-testid="new-chat" className="primary">
                        {t.createChat}
                      </button>
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => {
                          setNewChatOpen(false);
                          setPeerInput("");
                          setNewContactName("");
                        }}
                      >
                        {t.cancel}
                      </button>
                    </div>
                  </form>
                )}
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
                      }}
                    >
                      <span className="chat-item-copy">
                        <strong>
                          {chatTitle(chat.peerId)}
                          {chat.peerId !== userId && (
                            <PresenceDot
                              connectionState={socketState}
                              presence={chatState.presence[chat.peerId]}
                              onlineLabel={t.presenceOnline}
                            />
                          )}
                        </strong>
                        <span>
                          {chatPreviewAfterDeletion(chat, t.messageDeleted) ??
                            chatPreview(chat, t)}
                        </span>
                      </span>
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
                          ).toLocaleTimeString(getLanguageLocale(language), {
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
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
                        aria-label={t.back}
                        onClick={() => {
                          if (chatHistoryRef.current) window.history.back();
                          else controllerRef.current?.closeActiveChat();
                        }}
                      >
                        ← {t.back}
                      </button>
                      {isSavedChat ? (
                        <div
                          className="contact-name-trigger saved-title"
                          data-testid="saved-chat-title"
                        >
                          <strong>{t.savedMessages}</strong>
                        </div>
                      ) : !editingName ? (
                        <button
                          className="contact-name-trigger"
                          onClick={() => {
                            setContactNameDraft(
                              chatState.contacts[activePeer] ?? "",
                            );
                            setEditingName(true);
                          }}
                        >
                          <strong>
                            {contactLabel(activePeer, chatState.contacts)}
                          </strong>
                          <small>{activePeer.slice(-10)}</small>
                          <PresenceLabel
                            connectionState={socketState}
                            presence={chatState.presence[activePeer]}
                            language={language}
                            now={presenceClock}
                          />
                          <span aria-hidden="true">✎</span>
                        </button>
                      ) : (
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
                            else {
                              setChatError("");
                              setEditingName(false);
                            }
                          }}
                        >
                          <input
                            aria-label={t.contactName}
                            value={contactNameDraft}
                            onChange={(event) =>
                              setContactNameDraft(event.target.value)
                            }
                            onKeyDown={(event) => {
                              if (event.key === "Escape") {
                                setContactNameDraft(
                                  chatState.contacts[activePeer] ?? "",
                                );
                                setEditingName(false);
                              }
                            }}
                            placeholder={
                              chatState.contacts[activePeer] ||
                              activePeer.slice(-10)
                            }
                          />
                          {contactNameDraft.trim() !==
                            (chatState.contacts[activePeer] ?? "") && (
                            <button className="secondary">{t.saveName}</button>
                          )}
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => setEditingName(false)}
                          >
                            {t.cancel}
                          </button>
                        </form>
                      )}
                      <div className="conversation-menu">
                        <button
                          type="button"
                          className="secondary conversation-menu-toggle"
                          aria-label={t.chatActions}
                          aria-expanded={chatMenuOpen}
                          data-testid="chat-menu"
                          onClick={() => setChatMenuOpen(!chatMenuOpen)}
                        >
                          ⋯
                        </button>
                        {chatMenuOpen && (
                          <div className="conversation-menu-panel">
                            <button
                              type="button"
                              className="danger"
                              data-testid="delete-chat"
                              onClick={() => {
                                setChatMenuOpen(false);
                                setChatError("");
                                setShowDeleteConfirmation(true);
                              }}
                            >
                              {t.deleteChatMenu}
                            </button>
                          </div>
                        )}
                      </div>
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
                      {isSavedChat &&
                        !activeChat?.loadingHistory &&
                        activeMessages.length === 0 &&
                        activeChat?.hasMore === false && (
                          <p
                            className="muted saved-hint"
                            data-testid="saved-hint"
                          >
                            {t.savedHint}
                          </p>
                        )}
                      {activeMessages.map((message) => (
                        <div
                          className={`message-row ${message.direction}${
                            activeEditId === message.id ? " active" : ""
                          }`}
                          data-testid="message-row"
                          key={message.id}
                        >
                          <EditMessageButton
                            message={message}
                            userId={userId}
                            label={t.edit}
                            onEdit={beginEdit}
                          />
                          <DeleteRequestButton
                            message={message}
                            userId={userId}
                            peerId={activePeer}
                            label={t.deleteRequest}
                            editing={Boolean(editState)}
                            onRequest={beginDeleteRequest}
                          />
                          <article
                            data-testid="message"
                            data-status={message.status}
                            data-direction={message.direction}
                            className={`message ${message.direction}${
                              isEditingMessage(editState, message)
                                ? " message-editing"
                                : ""
                            }`}
                            onClick={() => selectMessageForEdit(message)}
                          >
                            <div className="message-text">
                              {isDeletedIncoming(message) ? (
                                <DeletedMessageText label={t.messageDeleted} />
                              ) : message.decryptFailed ? (
                                t.decryptFailed
                              ) : (
                                message.text
                              )}
                            </div>
                            <small data-testid="message-status">
                              {new Date(message.createdAt).toLocaleTimeString(
                                getLanguageLocale(language),
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                              {statusText(message) && ` ${statusText(message)}`}
                            </small>
                            {message.direction === "in" &&
                              message.deletion === "pending" && (
                                <DeleteRequestNotice
                                  text={t.deleteNotice}
                                  acceptLabel={t.deleteAccept}
                                  keepLabel={t.deleteKeep}
                                  onAccept={() => {
                                    if (message.replayId)
                                      void answerDeleteRequest(
                                        message.replayId,
                                        true,
                                      );
                                  }}
                                  onKeep={() => {
                                    if (message.replayId)
                                      void answerDeleteRequest(
                                        message.replayId,
                                        false,
                                      );
                                  }}
                                />
                              )}
                            {message.edited && !isDeletedIncoming(message) && (
                              <EditedMark label={t.edited} />
                            )}
                            {message.direction === "out" &&
                              message.deletion && (
                                <DeletionMark
                                  status={message.deletion}
                                  label={deletionMarkText(message)}
                                />
                              )}
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
                        </div>
                      ))}
                    </div>
                    {deleteError && (
                      <p
                        className="error composer-error"
                        data-testid="delete-error"
                        role="alert"
                      >
                        {deleteError}
                      </p>
                    )}
                    {editState && (
                      <EditBanner
                        label={t.editBanner}
                        cancelLabel={t.cancel}
                        onCancel={cancelEdit}
                      />
                    )}
                    {deleteConfirmId && !editState && (
                      <DeleteConfirmBar
                        text={t.deleteConfirm}
                        sendLabel={t.deleteConfirmSend}
                        cancelLabel={t.cancel}
                        onSend={() => void confirmDeleteRequest()}
                        onCancel={cancelDeleteRequest}
                      />
                    )}
                    <form
                      className="composer"
                      onSubmit={(event) => void sendMessage(event)}
                    >
                      <textarea
                        ref={composerRef}
                        value={draft}
                        data-testid="message-input"
                        maxLength={4000}
                        onChange={(event) => {
                          setDraft(event.target.value);
                          event.currentTarget.style.height = "auto";
                          event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 130)}px`;
                        }}
                        onKeyDown={(event) => {
                          if (event.key === "Escape" && editState) {
                            event.preventDefault();
                            cancelEdit();
                            return;
                          }
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
                        disabled={
                          editState
                            ? !canSubmitEdit(editState, draft)
                            : !draft.trim()
                        }
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
            {chatState.contactsError && !chatState.waking && (
              <p className="error">{t.contactsDecryptError}</p>
            )}
            {chatState.waking && (
              <p className="muted" role="status">
                {t.serverWaking}
              </p>
            )}
            {chatState.error === "outbox_clear_failed" && (
              <p className="error">{t.outboxClearFailed}</p>
            )}
            {showLogoutConfirmation && !showLogoutSkipWarning && (
              <div
                className="confirm-panel confirm-stack"
                role="alertdialog"
                aria-labelledby="logout-check-title"
                aria-describedby="logout-check-hint"
              >
                <h2 id="logout-check-title">{t.logoutCheckTitle}</h2>
                <p id="logout-check-hint">{t.logoutCheckHint}</p>
                <label>
                  {t.phrase}
                  <textarea
                    data-testid="logout-phrase"
                    rows={4}
                    value={logoutPhrase}
                    onChange={(e) => {
                      setLogoutPhrase(e.target.value);
                      setLogoutError(false);
                    }}
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                </label>
                {logoutError && (
                  <p className="error" data-testid="logout-error" role="alert">
                    {t.logoutCheckWrong}
                  </p>
                )}
                <button
                  data-testid="logout-verify"
                  className="primary"
                  onClick={verifyAndLogout}
                >
                  {t.logoutCheckSubmit}
                </button>
                <button
                  data-testid="logout-skip"
                  className="danger"
                  onClick={() => setShowLogoutSkipWarning(true)}
                >
                  {t.logoutSkip}
                </button>
                <button className="secondary" onClick={cancelLogout}>
                  {t.cancel}
                </button>
              </div>
            )}
            {showLogoutConfirmation && showLogoutSkipWarning && (
              <div
                className="confirm-panel confirm-stack"
                role="alertdialog"
                aria-labelledby="logout-skip-warning"
              >
                <p id="logout-skip-warning" className="warning">
                  {t.logoutSkipWarning}
                </p>
                <button
                  data-testid="confirm-logout"
                  className="danger"
                  onClick={() => void confirmLogout()}
                >
                  {t.logoutSkipConfirm}
                </button>
                <button className="secondary" onClick={backToLogoutCheck}>
                  {t.back}
                </button>
              </div>
            )}
            {showDeleteConfirmation && (
              <div
                className="confirm-panel confirm-stack"
                role="alertdialog"
                aria-labelledby="delete-chat-message"
                aria-describedby="delete-chat-description"
              >
                <h2 id="delete-chat-message">{t.deleteChatMenu}</h2>
                <p id="delete-chat-description">{t.confirmDeleteChat}</p>
                {chatError && <p className="error">{chatError}</p>}
                <button
                  data-testid="confirm-delete-chat"
                  className="danger"
                  onClick={() => void confirmDeleteChat()}
                >
                  {t.delete}
                </button>
                <button
                  className="secondary"
                  onClick={() => {
                    setShowDeleteConfirmation(false);
                    setChatError("");
                  }}
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

/**
 * “Saved messages” is always the first row, even before any note exists.
 */
function withSavedChat(chats: Chat[], userId: string): Chat[] {
  const saved = chats.find((chat) => chat.peerId === userId);
  const row: Chat = saved ?? {
    peerId: userId,
    messages: [],
    unreadCount: 0,
    hasMore: true,
  };
  /* Your own notes never count as unread. */
  return [
    { ...row, peerId: userId, unreadCount: 0 },
    ...chats.filter((chat) => chat.peerId !== userId),
  ];
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
