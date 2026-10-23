export type Language = "ru" | "en";

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
    chats: "Чаты появятся на следующих этапах",
    userId: "ID пользователя",
    copy: "Копировать",
    copied: "Скопировано",
    logout: "Выйти",
    confirmLogout:
      "Убедитесь, что сохранили сид-фразу. Выйти и удалить ключи с этого устройства?",
    cancel: "Отмена",
    back: "Назад",
    language: "Язык",
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
    chats: "Chats will appear in a later stage",
    userId: "User ID",
    copy: "Copy",
    copied: "Copied",
    logout: "Sign out",
    confirmLogout:
      "Make sure you have saved your seed phrase. Sign out and delete keys from this device?",
    cancel: "Cancel",
    back: "Back",
    language: "Language",
  },
} as const;

export type Strings = (typeof strings)[Language];

export function detectLanguage(browserLanguage: string | undefined): Language {
  return browserLanguage?.toLowerCase().startsWith("en") ? "en" : "ru";
}

export function getInitialLanguage(
  storage: Pick<Storage, "getItem">,
  browserLanguage: string | undefined,
): Language {
  const saved = storage.getItem("messages-language");
  return saved === "ru" || saved === "en"
    ? saved
    : detectLanguage(browserLanguage);
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
