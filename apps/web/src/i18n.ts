export type Language = "ru" | "en";

export const supportedLanguages = [
  { code: "ru", name: "Русский", locale: "ru-RU" },
  { code: "en", name: "English", locale: "en-US" },
] as const satisfies readonly {
  code: Language;
  name: string;
  locale: string;
}[];

export const languageStorageKey = "messages-lang";

export const strings = {
  ru: {
    title: "Messages",
    create: "Создать аккаунт",
    login: "Войти по сид-фразе",
    welcome: "Добро пожаловать",
    createTitle: "Создание аккаунта",
    words: "Количество слов",
    twelve: "12 слов",
    twentyFour: "24 слова",
    warning:
      "Запишите фразу на бумаге и храните в безопасном месте. Никому её не показывайте. При потере восстановить аккаунт невозможно.",
    saved: "Я сохранил(а) фразу",
    next: "Продолжить",
    verify: "Проверка фразы",
    enterWord: (n: number) => `Введите слово №${n}`,
    finish: "Завершить создание",
    loginTitle: "Вход по сид-фразе",
    phrase: "Сид-фраза",
    signIn: "Войти",
    invalid: "Неверная сид-фраза. Проверьте слова и попробуйте снова.",
    chats: "Чаты",
    profile: "Профиль",
    createChat: "Создать чат",
    connectionError: "Ошибка подключения",
    userId: "ID пользователя",
    copy: "Копировать",
    copied: "Скопировано",
    logout: "Выйти",
    confirmLogout:
      "Выйти? Ключи будут стёрты с этого устройства. Войти снова можно только по сид-фразе. Убедитесь, что она сохранена.",
    confirm: "Выйти",
    cancel: "Отмена",
    deleteChatMenu: "Удалить чат",
    chatActions: "Действия чата",
    confirmDeleteChat:
      "Переписка будет удалена только у вас, на всех ваших устройствах. У собеседника она останется. Неотправленные сообщения этого чата тоже будут удалены. Это нельзя отменить.",
    deleteChatFailed:
      "Не удалось удалить переписку. Проверьте соединение и попробуйте ещё раз.",
    outboxClearFailed:
      "Чат скрыт, но не удалось очистить очередь сообщений. Перезагрузите страницу и попробуйте снова.",
    delete: "Удалить",
    back: "Назад",
    language: "Язык",
    serverUnavailable: "Сервер недоступен, попробуйте позже",
    connected: "подключено",
    connecting: "подключение…",
    offline: "нет связи",
    peerId: "ID собеседника",
    newChat: "Новый чат",
    invalidId: "Введите ID из 64 строчных hex-символов.",
    selfChat: "Нельзя создать чат с самим собой.",
    userNotFound: "Пользователь не найден — он должен хотя бы раз войти.",
    badPeerKey: "Не удалось проверить ключ пользователя.",
    decryptFailed: "Не удалось расшифровать сообщение",
    sendFailed: "Не удалось отправить сообщение.",
    invalidText: "Сообщение должно содержать от 1 до 4000 символов.",
    sending: "отправляется",
    sent: "отправлено",
    delivered: "доставлено",
    read: "прочитано",
    failed: "ошибка",
    retry: "Повторить",
    send: "Отправить",
    messagePlaceholder: "Сообщение",
    noMessages: "Нет сообщений",
    you: "Вы",
    selectChat: "Выберите чат или создайте новый.",
    contactName: "Имя контакта (необязательно)",
    saveName: "Сохранить имя",
    contactSaveFailed: "Не удалось сохранить имя",
    contactsDecryptError:
      "Не удалось загрузить контакты. Для чатов показаны ID.",
    serverWaking: "Сервер просыпается, подождите до минуты…",
    loadMore: "Загрузить ещё",
    loading: "Загрузка…",
    presenceOnline: "в сети",
    pinTitle: "PIN",
    pinNew: "Новый PIN",
    pinConfirm: "Повторите PIN",
    pinCurrent: "Текущий PIN",
    pinHint:
      "Рекомендуем 8 и больше символов, лучше с буквами. Короткий PIN можно подобрать.",
    pinEnable: "Включить PIN",
    pinInstallSubmit: "Установить",
    pinChange: "Сменить PIN",
    pinChangeSubmit: "Сменить",
    pinDisable: "Отключить PIN",
    pinDisableSubmit: "Отключить",
    pinUnlock: "Разблокировать",
    pinInstalling: "Установка…",
    pinChanging: "Смена…",
    pinDisabling: "Отключение…",
    pinUnlocking: "Разблокировка…",
    pinOperationFailed: "Не удалось выполнить операцию",
    pinCheckFailed: "Не удалось проверить PIN. Попробуйте ещё раз",
    pinIncorrect: "Неверный PIN",
    pinTooShort: "PIN короче 6 символов",
    pinMismatch: "PIN-коды не совпадают",
    pinCountdown: (time: string) => `Подождите ${time}`,
    pinQueueConfirm: (count: number) =>
      `${count} неотправленных сообщений будут удалены. Продолжить?`,
    forgotPin: "Забыли PIN?",
    forgotFinish: "Завершить сессию",
    forgotConfirm:
      "Без PIN продолжить эту сессию нельзя. Чтобы снова открыть чаты, нужно войти заново по сид-фразе (12 или 24 слова). Убедитесь, что она у вас есть. Сообщения останутся на сервере и подтянутся после входа. Завершить текущую сессию?",
  },
  en: {
    title: "Messages",
    create: "Create account",
    login: "Sign in with seed phrase",
    welcome: "Welcome",
    createTitle: "Create account",
    words: "Number of words",
    twelve: "12 words",
    twentyFour: "24 words",
    warning:
      "Write the phrase on paper and keep it safe. Never show it to anyone. If it is lost, the account cannot be recovered.",
    saved: "I have saved the phrase",
    next: "Continue",
    verify: "Verify phrase",
    enterWord: (n: number) => `Enter word #${n}`,
    finish: "Finish account setup",
    loginTitle: "Sign in with seed phrase",
    phrase: "Seed phrase",
    signIn: "Sign in",
    invalid: "Invalid seed phrase. Check the words and try again.",
    chats: "Chats",
    profile: "Profile",
    createChat: "Create chat",
    connectionError: "Connection error",
    userId: "User ID",
    copy: "Copy",
    copied: "Copied",
    logout: "Sign out",
    confirmLogout:
      "Sign out? Keys will be erased from this device. You can sign in again only with your seed phrase. Make sure you have saved it.",
    confirm: "Sign out",
    cancel: "Cancel",
    deleteChatMenu: "Delete chat",
    chatActions: "Chat actions",
    confirmDeleteChat:
      "The conversation will be deleted only for you, on all your devices. It will remain with the other person. Unsent messages in this chat will also be deleted. This cannot be undone.",
    deleteChatFailed:
      "Could not delete the conversation. Check your connection and try again.",
    outboxClearFailed:
      "The chat was hidden, but its queued messages could not be cleared. Reload the page and try again.",
    delete: "Delete",
    back: "Back",
    language: "Language",
    serverUnavailable: "Server unavailable, try again later",
    connected: "connected",
    connecting: "connecting…",
    offline: "offline",
    peerId: "Contact ID",
    newChat: "New chat",
    invalidId: "Enter a 64-character lowercase hex ID.",
    selfChat: "You cannot start a chat with yourself.",
    userNotFound: "User not found. They need to sign in at least once.",
    badPeerKey: "Could not verify this user's key.",
    decryptFailed: "Could not decrypt message",
    sendFailed: "Message could not be sent.",
    invalidText: "Message must contain 1 to 4000 characters.",
    sending: "sending",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    failed: "failed",
    retry: "Retry",
    send: "Send",
    messagePlaceholder: "Message",
    noMessages: "No messages",
    you: "You",
    selectChat: "Select a chat or start a new one.",
    contactName: "Contact name (optional)",
    saveName: "Save name",
    contactSaveFailed: "Could not save contact name",
    contactsDecryptError: "Could not load contacts. Chats are shown with IDs.",
    serverWaking: "The server is waking up, please wait up to a minute…",
    loadMore: "Load more",
    loading: "Loading…",
    presenceOnline: "online",
    pinTitle: "PIN",
    pinNew: "New PIN",
    pinConfirm: "Confirm PIN",
    pinCurrent: "Current PIN",
    pinHint:
      "We recommend 8 or more characters, preferably with letters. A short PIN can be guessed.",
    pinEnable: "Enable PIN",
    pinInstallSubmit: "Set PIN",
    pinChange: "Change PIN",
    pinChangeSubmit: "Change",
    pinDisable: "Disable PIN",
    pinDisableSubmit: "Disable",
    pinUnlock: "Unlock",
    pinInstalling: "Setting…",
    pinChanging: "Changing…",
    pinDisabling: "Disabling…",
    pinUnlocking: "Unlocking…",
    pinOperationFailed: "The operation could not be completed",
    pinCheckFailed: "Could not verify PIN. Please try again",
    pinIncorrect: "Incorrect PIN",
    pinTooShort: "PIN is shorter than 6 characters",
    pinMismatch: "PINs do not match",
    pinCountdown: (time: string) => `Wait ${time}`,
    pinQueueConfirm: (count: number) =>
      `${count} unsent message${count === 1 ? "" : "s"} will be deleted. Continue?`,
    forgotPin: "Forgot PIN?",
    forgotFinish: "End session",
    forgotConfirm:
      "You cannot continue this session without the PIN. To open your chats again, sign in with your seed phrase (12 or 24 words). Make sure you have it. Your messages will remain on the server and will be synced after sign-in. End the current session?",
  },
} as const;

export type Strings = (typeof strings)[Language];

export function detectLanguage(browserLanguages: readonly string[]): Language {
  for (const browserLanguage of browserLanguages) {
    const code = browserLanguage.trim().toLowerCase().split(/[-_]/u)[0];
    if (code === "ru" || code === "uk" || code === "be") return "ru";
    if (code === "en") return "en";
  }
  return "en";
}

export function getInitialLanguage(
  browserLanguages: readonly string[],
  storage?: Pick<Storage, "getItem">,
): Language {
  try {
    const saved = (storage ?? globalThis.localStorage).getItem(
      languageStorageKey,
    );
    if (saved === "ru" || saved === "en") return saved;
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return detectLanguage(browserLanguages);
}

export function saveLanguagePreference(
  language: Language,
  storage?: Pick<Storage, "setItem">,
): void {
  try {
    (storage ?? globalThis.localStorage).setItem(languageStorageKey, language);
  } catch {
    // Keep the in-memory language selection when storage is unavailable.
  }
}

export function getLanguageLocale(language: Language): string {
  return supportedLanguages.find((entry) => entry.code === language)!.locale;
}

export function chooseCheckPositions(
  length: number,
  random = () => crypto.getRandomValues(new Uint32Array(1))[0]! / 0x1_0000_0000,
): number[] {
  if (length < 3) throw new RangeError("At least three words are required");
  const chosen = new Set<number>();
  while (chosen.size < 3) chosen.add(Math.floor(random() * length));
  return [...chosen].sort((a, b) => a - b);
}
