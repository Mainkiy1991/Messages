export type Language = "ru" | "en" | "uk";

export const supportedLanguages = [
  { code: "ru", name: "Русский", locale: "ru-RU" },
  { code: "en", name: "English", locale: "en-US" },
  { code: "uk", name: "Українська", locale: "uk-UA" },
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
    loggingIn: "Входим…",
    registrationWaking: "Сервер просыпается, это может занять до минуты…",
    registrationNetworkError:
      "Не удалось связаться с сервером. Проверьте интернет и попробуйте ещё раз. Данные не сохранены.",
    registrationError: "Не удалось войти. Попробуйте ещё раз.",
    deviceRevokedNotice:
      "Этот вход завершён на другом устройстве. Войдите снова по сид-фразе.",
    chats: "Чаты",
    profile: "Профиль",
    createChat: "Создать чат",
    connectionError: "Ошибка подключения",
    userId: "ID пользователя",
    copy: "Копировать",
    copied: "Скопировано",
    copyPeerId: "Скопировать ID",
    idCopied: "ID скопирован",
    idCopyFailed:
      "Не удалось скопировать автоматически. Выделите и скопируйте ID вручную:",
    contactsTitle: "Контакты",
    contactsPickTitle: "Выбрать контакт",
    contactsPickEmpty: "Контактов пока нет. Создайте чат по ID.",
    newChatFromContacts: "Из контактов",
    newChatById: "По ID",
    contactsAddToContacts: "Добавить в контакты",
    contactsNotInContacts: "Нет в ваших контактах",
    contactsOpenCard: "Карточка контакта",
    contactsAdd: "Добавить контакт",
    contactsAdding: "Добавляем…",
    contactsId: "ID контакта",
    contactsName: "Имя",
    contactsNoteLabel: "Описание (необязательно)",
    contactsNoteHint: "Кто это и зачем добавлен",
    contactsCopyId: "Копировать ID",
    contactsCount: (n: number) => `${n} из 200`,
    contactsNoNote: "Описания нет",
    contactsMyNote: "Моё описание",
    contactsWrite: "Написать",
    contactsEditName: "Изменить имя",
    contactsEditNote: "Изменить описание",
    contactsSave: "Сохранить",
    contactsRemove: "Убрать из контактов",
    contactsRemovePrompt:
      "Убрать контакт из списка? Чат и сообщения останутся, но имя в чате пропадёт: останется только конец ID.",
    contactsRemoveConfirm: "Убрать",
    contactsEmpty: "Контактов пока нет. Добавьте контакт по ID.",
    contactsLoading: "Загружаем контакты…",
    contactsLoadFailed:
      "Не удалось загрузить контакты. Проверьте соединение и откройте экран ещё раз.",
    contactsErrorInvalidId:
      "Неверный ID: нужно 64 символа (цифры 0–9 и буквы a–f).",
    contactsErrorOwnId:
      "Это ваш собственный ID. «Избранное» добавлять в контакты не нужно.",
    contactsErrorNotLoaded:
      "Контакты ещё не загрузились. Подождите или обновите страницу.",
    contactsErrorNameRequired: "Введите имя.",
    contactsErrorNameTooLong: "Имя длиннее 64 символов.",
    contactsErrorNameInvalid: "В имени есть недопустимые символы.",
    contactsErrorNoteTooLong: "Описание длиннее 200 символов.",
    contactsErrorNoteInvalid: "В описании есть недопустимые символы.",
    contactsErrorNotContact: "Этого контакта больше нет в списке.",
    contactsErrorAlreadyContact: "Этот контакт уже есть в списке.",
    contactsErrorLimit: "Достигнут предел: 1000 контактов.",
    contactsErrorBookLarge:
      "Список контактов заполнен, добавить больше нельзя. Уберите ненужные контакты.",
    contactsErrorUserNotFound: "Пользователь с таким ID не найден.",
    contactsErrorBadPeerKey:
      "Не удалось проверить ключи этого пользователя. Проверьте ID.",
    contactsErrorServer: "Сервер недоступен. Проверьте соединение и повторите.",
    contactsErrorSave: "Не удалось сохранить. Повторите попытку.",
    logout: "Выйти",
    logoutCheckTitle: "Перед выходом проверим сид-фразу",
    logoutCheckHint:
      "Введите всю сид-фразу этого аккаунта. После выхода войти можно только с ней, восстановить её нельзя.",
    logoutCheckSubmit: "Проверить и выйти",
    logoutCheckWrong:
      "Эта фраза не подходит к вашему аккаунту. Проверьте слова и порядок.",
    logoutSkip: "Выйти без проверки",
    logoutSkipWarning:
      "Если вы не помните сид-фразу, после выхода вы не сможете войти в этот аккаунт. Потеря фразы означает потерю аккаунта и переписки: восстановить доступ невозможно. Убедитесь, что фраза записана в надёжном месте.",
    logoutSkipConfirm: "Всё равно выйти",
    confirm: "Выйти",
    cancel: "Отмена",
    clearChatMenu: "Очистить чат",
    deleteChatMenu: "Удалить чат",
    chatActions: "Действия чата",
    clear: "Очистить",
    clearChatConfirmation:
      "Переписка очистится только у вас, на всех ваших устройствах, а пустой чат останется в списке. Сообщения останутся на сервере и у собеседника. Неотправленные сообщения этого чата тоже будут удалены.",
    savedClearChatConfirmation:
      "Заметки очистятся только у вас, на всех ваших устройствах, а «Избранное» останется в списке. Сообщения останутся на сервере. Неотправленные заметки тоже будут удалены.",
    eraseChatConfirmation:
      "Чат будет убран из вашего списка на всех устройствах, а на сервере будут стёрты все ваши сообщения. Сообщения собеседника не затрагиваются; у него останется строка «Собеседник удалил сообщения». Гарантий нет: собеседник мог прочитать, скопировать или сфотографировать сообщения раньше; хостинг может ограниченное время хранить резервные копии; изменённый клиент мог сохранить текст. Метаданные переписки останутся. Неотправленные сообщения этого чата тоже будут удалены.",
    savedEraseChatConfirmation:
      "Заметки очистятся на всех ваших устройствах, а все ваши сообщения будут стёрты на сервере. «Избранное» останется в списке. Гарантий нет: текст могли прочитать, скопировать или сфотографировать раньше; хостинг может ограниченное время хранить резервные копии; изменённый клиент мог сохранить текст. Метаданные останутся. Неотправленные заметки тоже будут удалены.",
    clearChatFailed:
      "Не удалось очистить чат. Проверьте соединение и попробуйте ещё раз.",
    savedClearChatFailed:
      "Не удалось очистить заметки. Проверьте соединение и попробуйте ещё раз.",
    eraseChatFailed:
      "Не удалось удалить чат. Проверьте соединение и попробуйте ещё раз.",
    savedEraseChatFailed:
      "Не удалось удалить заметки. Проверьте соединение и попробуйте ещё раз.",
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
    savedMessages: "Избранное",
    savedHint:
      "Заметки для себя. Они хранятся зашифрованными и доступны на всех ваших устройствах.",
    userNotFound: "Пользователь не найден — он должен хотя бы раз войти.",
    badPeerKey: "Не удалось проверить ключ пользователя.",
    decryptFailed: "Не удалось расшифровать сообщение",
    sendFailed: "Не удалось отправить сообщение.",
    invalidText: "Сообщение должно содержать от 1 до 4000 символов.",
    edit: "Изменить",
    editBanner: "Правка сообщения",
    edited: "изменено",
    editLimit: "Это сообщение уже изменено максимальное число раз",
    editNotEditable: "Это сообщение нельзя изменить",
    editPending: "Дождитесь отправки сообщения",
    editMessageDeleted: "Сообщение уже удалено",
    editUnknownMessage:
      "Сообщение не найдено. Обновите страницу и попробуйте снова.",
    deleteMessage: "Удалить сообщение",
    deleteConfirm:
      "Удалить это сообщение? Его текст будет стёрт на сервере и у собеседника. Гарантий нет: собеседник мог уже прочитать или сохранить сообщение.",
    savedDeleteConfirm:
      "Удалить эту заметку? Её текст будет стёрт на сервере. Гарантий нет: текст могли прочитать, скопировать или сфотографировать раньше; хостинг может ограниченное время хранить резервные копии; изменённый клиент мог сохранить текст.",
    deletePending: "Подождите: удаление уже идёт",
    deleteNotDeletable: "Это сообщение нельзя удалить",
    deletedOwnMessage: "Вы удалили сообщение",
    deletedOwnMessages: "Вы удалили сообщения",
    deletedPeerMessage: "Собеседник удалил сообщение",
    deletedPeerMessages: "Собеседник удалил сообщения",
    savedDeletedMessage: "Вы удалили сообщение",
    savedDeletedMessages: "Вы удалили сообщения",
    messageDeleted: "Сообщение удалено",
    sending: "отправляется",
    sent: "отправлено",
    delivered: "доставлено",
    read: "прочитано",
    failed: "ошибка",
    retry: "Повторить",
    send: "Отправить",
    messagePlaceholder: "Сообщение",
    noMessages: "Нет сообщений",
    clearedChat: "Чат очищен",
    clearedChatNotice: "Вы очистили чат",
    you: "Вы",
    selectChat: "Выберите чат или создайте новый.",
    contactName: "Имя (необязательно)",
    newChatNameHint: "Если указать имя, контакт сохранится в ваших контактах.",
    contactSaveFailed: "Не удалось сохранить имя",
    contactsDecryptError:
      "Не удалось загрузить контакты. Для чатов показаны ID.",
    serverWaking: "Сервер просыпается, подождите до минуты…",
    loadMore: "Загрузить ещё",
    loading: "Загрузка…",
    presenceOnline: "в сети",
    pinTitle: "PIN",
    devicesTitle: "Устройства",
    devicesHint:
      "Устройства, на которых выполнен вход в ваш аккаунт. Завершённое устройство больше не сможет входить: чтобы войти снова, нужна сид-фраза.",
    devicesLoading: "Загружаем список…",
    devicesCurrent: "Это устройство",
    devicesUnknown: "неизвестно",
    devicesUnknownLabel: "Неизвестное устройство",
    devicesLastSeen: "Последняя активность:",
    devicesCreated: "Добавлено:",
    devicesRevoke: "Завершить",
    devicesRevokeConfirmTitle: "Завершить вход на этом устройстве?",
    devicesRevokeOthers: "Завершить все остальные",
    devicesRevokeOthersConfirmTitle:
      "Завершить вход на всех остальных устройствах?",
    devicesNotice: "Вход на устройстве завершён.",
    devicesOthersNotice: "Вход на остальных устройствах завершён.",
    devicesLoadError:
      "Не удалось загрузить список устройств. Проверьте связь и попробуйте ещё раз.",
    devicesRevokeError: "Не удалось завершить вход. Попробуйте ещё раз.",
    devicesRateLimited: "Слишком много попыток, подождите минуту.",
    devicesRetry: "Повторить",
    pinNew: "Новый PIN",
    pinConfirm: "Повторите PIN",
    pinCurrent: "Текущий PIN",
    pinHint:
      "Рекомендуем 8 и больше символов, лучше с буквами. Короткий PIN можно подобрать. PIN защищает ключи только на этом устройстве: на других устройствах задайте свой. Он не защищает от того, кто знает сид-фразу. Не используйте PIN от банка и других сервисов.",
    pinEnable: "Включить PIN",
    pinInstallSubmit: "Установить",
    pinChange: "Сменить PIN",
    pinChangeSubmit: "Сменить",
    pinDisable: "Отключить PIN",
    pinDisableSubmit: "Отключить",
    pinUnlock: "Разблокировать",
    pinUnlockTitle: "Для разблокировки введите PIN",
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
      "Без PIN продолжить текущую сессию невозможно. Чтобы снова получить доступ к чатам, необходимо войти в аккаунт с помощью сид-фразы (12 или 24 слова).\n\nУбедитесь, что у вас есть доступ к сид-фразе, прежде чем продолжить. Все сообщения останутся на сервере и будут восстановлены после повторного входа.\n\nЗавершить текущую сессию?",
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
    loggingIn: "Signing in…",
    registrationWaking:
      "The server is waking up; this may take up to a minute…",
    registrationNetworkError:
      "Could not reach the server. Check your internet connection and try again. No data was saved.",
    registrationError: "Could not sign in. Please try again.",
    deviceRevokedNotice:
      "This sign-in ended on another device. Sign in again with your seed phrase.",
    chats: "Chats",
    profile: "Profile",
    createChat: "Create chat",
    connectionError: "Connection error",
    userId: "User ID",
    copy: "Copy",
    copied: "Copied",
    copyPeerId: "Copy ID",
    idCopied: "ID copied",
    idCopyFailed:
      "Could not copy automatically. Select and copy the ID manually:",
    contactsTitle: "Contacts",
    contactsPickTitle: "Choose a contact",
    contactsPickEmpty: "No contacts yet. Start a chat by ID.",
    newChatFromContacts: "From contacts",
    newChatById: "By ID",
    contactsAddToContacts: "Add to contacts",
    contactsNotInContacts: "Not in your contacts",
    contactsOpenCard: "Contact card",
    contactsAdd: "Add contact",
    contactsAdding: "Adding…",
    contactsId: "Contact ID",
    contactsName: "Name",
    contactsNoteLabel: "Description (optional)",
    contactsNoteHint: "Who they are and why you added them",
    contactsCopyId: "Copy ID",
    contactsCount: (n: number) => `${n} of 200`,
    contactsNoNote: "No description",
    contactsMyNote: "My description",
    contactsWrite: "Message",
    contactsEditName: "Edit name",
    contactsEditNote: "Edit description",
    contactsSave: "Save",
    contactsRemove: "Remove from contacts",
    contactsRemovePrompt:
      "Remove this contact? The chat and messages stay, but the name disappears from the chat: only the end of the ID remains.",
    contactsRemoveConfirm: "Remove",
    contactsEmpty: "No contacts yet. Add a contact by ID.",
    contactsLoading: "Loading contacts…",
    contactsLoadFailed:
      "Could not load contacts. Check your connection and reopen this screen.",
    contactsErrorInvalidId:
      "Invalid ID: it must be 64 characters (digits 0–9 and letters a–f).",
    contactsErrorOwnId:
      "This is your own ID. You don't need to add Favorites to contacts.",
    contactsErrorNotLoaded:
      "Contacts have not loaded yet. Wait or refresh the page.",
    contactsErrorNameRequired: "Enter a name.",
    contactsErrorNameTooLong: "Name is longer than 64 characters.",
    contactsErrorNameInvalid: "Name contains invalid characters.",
    contactsErrorNoteTooLong: "Description is longer than 200 characters.",
    contactsErrorNoteInvalid: "Description contains invalid characters.",
    contactsErrorNotContact: "This contact is no longer in the list.",
    contactsErrorAlreadyContact: "This contact is already in the list.",
    contactsErrorLimit: "Contact limit reached: 1,000 contacts.",
    contactsErrorBookLarge:
      "The contact list is full. Remove contacts you no longer need.",
    contactsErrorUserNotFound: "No user was found with this ID.",
    contactsErrorBadPeerKey: "Could not verify this user's keys. Check the ID.",
    contactsErrorServer:
      "Server unavailable. Check your connection and try again.",
    contactsErrorSave: "Could not save. Please try again.",
    logout: "Sign out",
    logoutCheckTitle: "Check your seed phrase before signing out",
    logoutCheckHint:
      "Enter the full seed phrase of this account. After signing out, it is the only way back in, and it cannot be recovered.",
    logoutCheckSubmit: "Verify and sign out",
    logoutCheckWrong:
      "This phrase does not match your account. Check the words and their order.",
    logoutSkip: "Sign out without checking",
    logoutSkipWarning:
      "If you do not remember your seed phrase, you will not be able to sign in to this account again. Losing the phrase means losing the account and its history: there is no recovery. Make sure the phrase is stored somewhere safe.",
    logoutSkipConfirm: "Sign out anyway",
    confirm: "Sign out",
    cancel: "Cancel",
    clearChatMenu: "Clear chat",
    deleteChatMenu: "Delete chat",
    chatActions: "Chat actions",
    clear: "Clear",
    clearChatConfirmation:
      "The conversation will be cleared only for you, on all your devices, and the empty chat will remain in your chat list. Messages will remain on the server and with the other person. Unsent messages in this chat will also be deleted.",
    savedClearChatConfirmation:
      "Your notes will be cleared only for you, on all your devices, and Saved messages will remain in your chat list. Messages will remain on the server. Unsent notes will also be deleted.",
    eraseChatConfirmation:
      "The chat will be removed from your chat list on all your devices, and all your messages in it will be erased from the server. The other person's messages are not affected; they will see “The other person deleted these messages” in their place. Nothing is guaranteed: they may have read, copied, or photographed messages earlier; the host may keep backups for a limited time; a modified client may have saved the text. Conversation metadata remains. Unsent messages in this chat will also be deleted.",
    savedEraseChatConfirmation:
      "Your notes will be cleared on all your devices, and all your messages in this chat will be erased from the server. Saved messages will remain in your chat list. Nothing is guaranteed: the text may have been read, copied, or photographed earlier; the host may keep backups for a limited time; a modified client may have saved the text. Metadata remains. Unsent notes will also be deleted.",
    clearChatFailed:
      "Could not clear the chat. Check your connection and try again.",
    savedClearChatFailed:
      "Could not clear your notes. Check your connection and try again.",
    eraseChatFailed:
      "Could not delete the chat. Check your connection and try again.",
    savedEraseChatFailed:
      "Could not delete your notes. Check your connection and try again.",
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
    savedMessages: "Saved messages",
    savedHint:
      "Notes to yourself. They are stored encrypted and available on all your devices.",
    userNotFound: "User not found. They need to sign in at least once.",
    badPeerKey: "Could not verify this user's key.",
    decryptFailed: "Could not decrypt message",
    sendFailed: "Message could not be sent.",
    invalidText: "Message must contain 1 to 4000 characters.",
    edit: "Edit",
    editBanner: "Editing message",
    edited: "edited",
    editLimit:
      "This message has already been edited the maximum number of times",
    editNotEditable: "This message cannot be edited",
    editPending: "Wait until the message is sent",
    editMessageDeleted: "The message was already deleted",
    editUnknownMessage:
      "The message was not found. Reload the page and try again.",
    deleteMessage: "Delete message",
    deleteConfirm:
      "Delete this message? Its text will be erased on the server and for the other person. Nothing is guaranteed: they may have already read or saved the message.",
    savedDeleteConfirm:
      "Delete this note? Its text will be erased on the server. Nothing is guaranteed: the text may have been read, copied, or photographed earlier; the host may keep backups for a limited time; a modified client may have saved it.",
    deletePending: "Wait: the deletion is already in progress",
    deleteNotDeletable: "This message cannot be deleted",
    deletedOwnMessage: "You deleted this message",
    deletedOwnMessages: "You deleted these messages",
    deletedPeerMessage: "The other person deleted this message",
    deletedPeerMessages: "The other person deleted these messages",
    savedDeletedMessage: "You deleted this message",
    savedDeletedMessages: "You deleted these messages",
    messageDeleted: "Message deleted",
    sending: "sending",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    failed: "failed",
    retry: "Retry",
    send: "Send",
    messagePlaceholder: "Message",
    noMessages: "No messages",
    clearedChat: "Chat cleared",
    clearedChatNotice: "You cleared this chat",
    you: "You",
    selectChat: "Select a chat or start a new one.",
    contactName: "Name (optional)",
    newChatNameHint:
      "If you add a name, the contact is saved to your contacts.",
    contactSaveFailed: "Could not save contact name",
    contactsDecryptError: "Could not load contacts. Chats are shown with IDs.",
    serverWaking: "The server is waking up, please wait up to a minute…",
    loadMore: "Load more",
    loading: "Loading…",
    presenceOnline: "online",
    pinTitle: "PIN",
    devicesTitle: "Devices",
    devicesHint:
      "Devices where you are signed in to your account. A signed-out device will no longer be able to sign in; to sign in again, use the seed phrase.",
    devicesLoading: "Loading the device list…",
    devicesCurrent: "This device",
    devicesUnknown: "unknown",
    devicesUnknownLabel: "Unknown device",
    devicesLastSeen: "Last activity:",
    devicesCreated: "Added:",
    devicesRevoke: "Sign out",
    devicesRevokeConfirmTitle: "Sign out on this device?",
    devicesRevokeOthers: "Sign out all other devices",
    devicesRevokeOthersConfirmTitle: "Sign out on all other devices?",
    devicesNotice: "Sign-in on the device has ended.",
    devicesOthersNotice: "Sign-ins on other devices have ended.",
    devicesLoadError:
      "Could not load the device list. Check your connection and try again.",
    devicesRevokeError: "Could not end the sign-in. Please try again.",
    devicesRateLimited: "Too many attempts. Please wait a minute.",
    devicesRetry: "Retry",
    pinNew: "New PIN",
    pinConfirm: "Confirm PIN",
    pinCurrent: "Current PIN",
    pinHint:
      "We recommend 8 or more characters, preferably with letters. A short PIN can be guessed. The PIN protects the keys on this device only: set a separate one on your other devices. It does not protect against anyone who knows your seed phrase. Do not reuse a PIN from your bank or other services.",
    pinEnable: "Enable PIN",
    pinInstallSubmit: "Set PIN",
    pinChange: "Change PIN",
    pinChangeSubmit: "Change",
    pinDisable: "Disable PIN",
    pinDisableSubmit: "Disable",
    pinUnlock: "Unlock",
    pinUnlockTitle: "Enter your PIN to unlock",
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
      "You cannot continue this session without your PIN. To access your chats again, sign in to your account with your seed phrase (12 or 24 words).\n\nMake sure you have access to your seed phrase before continuing. All messages will remain on the server and will be restored after you sign in again.\n\nEnd the current session?",
  },
  uk: {
    title: "Messages",
    create: "Створити обліковий запис",
    login: "Увійти за сід-фразою",
    welcome: "Ласкаво просимо",
    createTitle: "Створення облікового запису",
    words: "Кількість слів",
    twelve: "12 слів",
    twentyFour: "24 слова",
    warning:
      "Запишіть фразу на папері та зберігайте її в надійному місці. Нікому її не показуйте. Якщо фразу буде втрачено, відновити обліковий запис неможливо.",
    saved: "Я зберіг(ла) фразу",
    next: "Продовжити",
    verify: "Перевірка фрази",
    enterWord: (n: number) => `Введіть слово №${n}`,
    finish: "Завершити створення",
    loginTitle: "Вхід за сід-фразою",
    phrase: "Сід-фраза",
    signIn: "Увійти",
    invalid: "Невірна сід-фраза. Перевірте слова й спробуйте ще раз.",
    loggingIn: "Входимо…",
    registrationWaking: "Сервер запускається, це може зайняти до хвилини…",
    registrationNetworkError:
      "Не вдалося зв’язатися з сервером. Перевірте інтернет і спробуйте ще раз. Дані не збережено.",
    registrationError: "Не вдалося увійти. Спробуйте ще раз.",
    deviceRevokedNotice:
      "Цей вхід завершено на іншому пристрої. Увійдіть знову за сід-фразою.",
    chats: "Чати",
    profile: "Профіль",
    createChat: "Створити чат",
    connectionError: "Помилка з’єднання",
    userId: "ID користувача",
    copy: "Копіювати",
    copied: "Скопійовано",
    copyPeerId: "Скопіювати ID",
    idCopied: "ID скопійовано",
    idCopyFailed:
      "Не вдалося скопіювати автоматично. Виділіть і скопіюйте ID вручну:",
    contactsTitle: "Контакти",
    contactsPickTitle: "Обрати контакт",
    contactsPickEmpty: "Контактів поки немає. Створіть чат за ID.",
    newChatFromContacts: "З контактів",
    newChatById: "За ID",
    contactsAddToContacts: "Додати до контактів",
    contactsNotInContacts: "Немає у ваших контактах",
    contactsOpenCard: "Картка контакту",
    contactsAdd: "Додати контакт",
    contactsAdding: "Додаємо…",
    contactsId: "ID контакту",
    contactsName: "Ім’я",
    contactsNoteLabel: "Опис (необов’язково)",
    contactsNoteHint: "Хто це і навіщо доданий",
    contactsCopyId: "Копіювати ID",
    contactsCount: (n: number) => `${n} з 200`,
    contactsNoNote: "Опису немає",
    contactsMyNote: "Мій опис",
    contactsWrite: "Написати",
    contactsEditName: "Змінити ім’я",
    contactsEditNote: "Змінити опис",
    contactsSave: "Зберегти",
    contactsRemove: "Прибрати з контактів",
    contactsRemovePrompt:
      "Прибрати контакт зі списку? Чат і повідомлення залишаться, але ім’я в чаті зникне: залишиться лише кінець ID.",
    contactsRemoveConfirm: "Прибрати",
    contactsEmpty: "Контактів поки немає. Додайте контакт за ID.",
    contactsLoading: "Завантажуємо контакти…",
    contactsLoadFailed:
      "Не вдалося завантажити контакти. Перевірте з’єднання та відкрийте екран ще раз.",
    contactsErrorInvalidId:
      "Невірний ID: потрібно 64 символи (цифри 0–9 і літери a–f).",
    contactsErrorOwnId:
      "Це ваш власний ID. «Обране» не потрібно додавати до контактів.",
    contactsErrorNotLoaded:
      "Контакти ще не завантажилися. Зачекайте або оновіть сторінку.",
    contactsErrorNameRequired: "Введіть ім’я.",
    contactsErrorNameTooLong: "Ім’я довше за 64 символи.",
    contactsErrorNameInvalid: "Ім’я містить недопустимі символи.",
    contactsErrorNoteTooLong: "Опис довший за 200 символів.",
    contactsErrorNoteInvalid: "Опис містить недопустимі символи.",
    contactsErrorNotContact: "Цього контакту більше немає у списку.",
    contactsErrorAlreadyContact: "Цей контакт уже є у списку.",
    contactsErrorLimit: "Досягнуто межу: 1000 контактів.",
    contactsErrorBookLarge:
      "Список контактів заповнений. Приберіть непотрібні контакти.",
    contactsErrorUserNotFound: "Користувача з таким ID не знайдено.",
    contactsErrorBadPeerKey:
      "Не вдалося перевірити ключі цього користувача. Перевірте ID.",
    contactsErrorServer:
      "Сервер недоступний. Перевірте з’єднання та повторіть.",
    contactsErrorSave: "Не вдалося зберегти. Спробуйте ще раз.",
    logout: "Вийти",
    logoutCheckTitle: "Перед виходом перевіримо сід-фразу",
    logoutCheckHint:
      "Введіть усю сід-фразу цього акаунта. Після виходу увійти можна лише з нею, відновити її неможливо.",
    logoutCheckSubmit: "Перевірити й вийти",
    logoutCheckWrong:
      "Ця фраза не підходить до вашого акаунта. Перевірте слова та їх порядок.",
    logoutSkip: "Вийти без перевірки",
    logoutSkipWarning:
      "Якщо ви не пам’ятаєте сід-фразу, після виходу ви не зможете увійти в цей акаунт. Втрата фрази означає втрату акаунта та листування: відновити доступ неможливо. Переконайтеся, що фразу записано в надійному місці.",
    logoutSkipConfirm: "Усе одно вийти",
    confirm: "Вийти",
    cancel: "Скасувати",
    clearChatMenu: "Очистити чат",
    deleteChatMenu: "Видалити чат",
    chatActions: "Дії чату",
    clear: "Очистити",
    clearChatConfirmation:
      "Переписку буде очищено лише у вас, на всіх ваших пристроях, а порожній чат залишиться у списку. Повідомлення залишаться на сервері та у співрозмовника. Ненадіслані повідомлення цього чату також буде видалено.",
    savedClearChatConfirmation:
      "Нотатки буде очищено лише у вас, на всіх ваших пристроях, а «Збережене» залишиться у списку. Повідомлення залишаться на сервері. Ненадіслані нотатки також буде видалено.",
    eraseChatConfirmation:
      "Чат буде прибрано з вашого списку на всіх пристроях, а всі ваші повідомлення в ньому буде стерто із сервера. Повідомлення співрозмовника не зачіпаються; на їхньому місці він побачить «Співрозмовник видалив повідомлення». Гарантій немає: співрозмовник міг прочитати, скопіювати або сфотографувати повідомлення раніше; хостинг може обмежений час зберігати резервні копії; змінений клієнт міг зберегти текст. Метадані листування залишаться. Ненадіслані повідомлення цього чату також буде видалено.",
    savedEraseChatConfirmation:
      "Нотатки буде очищено на всіх ваших пристроях, а всі ваші повідомлення в цьому чаті буде стерто із сервера. «Збережене» залишиться у списку. Гарантій немає: текст могли прочитати, скопіювати або сфотографувати раніше; хостинг може обмежений час зберігати резервні копії; змінений клієнт міг зберегти текст. Метадані залишаться. Ненадіслані нотатки також буде видалено.",
    clearChatFailed:
      "Не вдалося очистити чат. Перевірте з’єднання та спробуйте ще раз.",
    savedClearChatFailed:
      "Не вдалося очистити нотатки. Перевірте з’єднання та спробуйте ще раз.",
    eraseChatFailed:
      "Не вдалося видалити чат. Перевірте з’єднання та спробуйте ще раз.",
    savedEraseChatFailed:
      "Не вдалося видалити нотатки. Перевірте з’єднання та спробуйте ще раз.",
    outboxClearFailed:
      "Чат приховано, але не вдалося очистити чергу повідомлень. Перезавантажте сторінку та спробуйте ще раз.",
    delete: "Видалити",
    back: "Назад",
    language: "Мова",
    serverUnavailable: "Сервер недоступний. Спробуйте пізніше.",
    connected: "підключено",
    connecting: "підключення…",
    offline: "немає зв’язку",
    peerId: "ID співрозмовника",
    newChat: "Новий чат",
    invalidId: "Введіть ID із 64 малих шістнадцяткових символів.",
    savedMessages: "Збережене",
    savedHint:
      "Нотатки для себе. Вони зберігаються зашифрованими й доступні на всіх ваших пристроях.",
    userNotFound:
      "Користувача не знайдено. Він має хоча б раз увійти в обліковий запис.",
    badPeerKey: "Не вдалося перевірити ключ користувача.",
    decryptFailed: "Не вдалося розшифрувати повідомлення",
    sendFailed: "Не вдалося надіслати повідомлення.",
    invalidText: "Повідомлення має містити від 1 до 4000 символів.",
    edit: "Змінити",
    editBanner: "Редагування повідомлення",
    edited: "змінено",
    editLimit: "Це повідомлення вже змінено максимальну кількість разів",
    editNotEditable: "Це повідомлення не можна змінити",
    editPending: "Зачекайте на надсилання повідомлення",
    editMessageDeleted: "Повідомлення вже видалено",
    editUnknownMessage:
      "Повідомлення не знайдено. Оновіть сторінку та спробуйте ще раз.",
    deleteMessage: "Видалити повідомлення",
    deleteConfirm:
      "Видалити це повідомлення? Його текст буде стерто на сервері та у співрозмовника. Гарантій немає: співрозмовник міг уже прочитати або зберегти повідомлення.",
    savedDeleteConfirm:
      "Видалити цю нотатку? Її текст буде стерто на сервері. Гарантій немає: текст могли прочитати, скопіювати або сфотографувати раніше; хостинг може обмежений час зберігати резервні копії; змінений клієнт міг зберегти текст.",
    deletePending: "Зачекайте: видалення вже виконується",
    deleteNotDeletable: "Це повідомлення не можна видалити",
    deletedOwnMessage: "Ви видалили повідомлення",
    deletedOwnMessages: "Ви видалили кілька повідомлень",
    deletedPeerMessage: "Співрозмовник видалив повідомлення",
    deletedPeerMessages: "Співрозмовник видалив кілька повідомлень",
    savedDeletedMessage: "Ви видалили повідомлення",
    savedDeletedMessages: "Ви видалили кілька повідомлень",
    messageDeleted: "Повідомлення видалено",
    sending: "надсилається",
    sent: "надіслано",
    delivered: "доставлено",
    read: "прочитано",
    failed: "помилка",
    retry: "Повторити",
    send: "Надіслати",
    messagePlaceholder: "Повідомлення",
    noMessages: "Повідомлень немає",
    clearedChat: "Чат очищено",
    clearedChatNotice: "Ви очистили чат",
    you: "Ви",
    selectChat: "Виберіть чат або створіть новий.",
    contactName: "Ім’я (необов’язково)",
    newChatNameHint:
      "Якщо вказати ім’я, контакт збережеться у ваших контактах.",
    contactSaveFailed: "Не вдалося зберегти ім’я контакту",
    contactsDecryptError:
      "Не вдалося завантажити контакти. У чатах показано ID.",
    serverWaking: "Сервер запускається, зачекайте до хвилини…",
    loadMore: "Завантажити ще",
    loading: "Завантаження…",
    presenceOnline: "у мережі",
    pinTitle: "PIN",
    devicesTitle: "Пристрої",
    devicesHint:
      "Пристрої, на яких виконано вхід до вашого облікового запису. Завершений пристрій більше не зможе увійти: щоб увійти знову, потрібна seed-фраза.",
    devicesLoading: "Завантажуємо список…",
    devicesCurrent: "Цей пристрій",
    devicesUnknown: "невідомо",
    devicesUnknownLabel: "Невідомий пристрій",
    devicesLastSeen: "Остання активність:",
    devicesCreated: "Додано:",
    devicesRevoke: "Завершити",
    devicesRevokeConfirmTitle: "Завершити вхід на цьому пристрої?",
    devicesRevokeOthers: "Завершити всі інші",
    devicesRevokeOthersConfirmTitle: "Завершити вхід на всіх інших пристроях?",
    devicesNotice: "Вхід на пристрої завершено.",
    devicesOthersNotice: "Вхід на інших пристроях завершено.",
    devicesLoadError:
      "Не вдалося завантажити список пристроїв. Перевірте зв’язок і спробуйте ще раз.",
    devicesRevokeError: "Не вдалося завершити вхід. Спробуйте ще раз.",
    devicesRateLimited: "Забагато спроб, зачекайте хвилину.",
    devicesRetry: "Повторити",
    pinNew: "Новий PIN",
    pinConfirm: "Повторіть PIN",
    pinCurrent: "Поточний PIN",
    pinHint:
      "Рекомендуємо щонайменше 8 символів, бажано з літерами. Короткий PIN можна підібрати. PIN захищає ключі лише на цьому пристрої: на інших пристроях задайте свій. Він не захищає від того, хто знає сід-фразу. Не використовуйте PIN від банку та інших сервісів.",
    pinEnable: "Увімкнути PIN",
    pinInstallSubmit: "Встановити",
    pinChange: "Змінити PIN",
    pinChangeSubmit: "Змінити",
    pinDisable: "Вимкнути PIN",
    pinDisableSubmit: "Вимкнути",
    pinUnlock: "Розблокувати",
    pinUnlockTitle: "Введіть PIN, щоб розблокувати",
    pinInstalling: "Налаштування…",
    pinChanging: "Зміна…",
    pinDisabling: "Вимкнення…",
    pinUnlocking: "Розблокування…",
    pinOperationFailed: "Не вдалося виконати дію",
    pinCheckFailed: "Не вдалося перевірити PIN. Спробуйте ще раз",
    pinIncorrect: "Невірний PIN",
    pinTooShort: "PIN має містити щонайменше 6 символів",
    pinMismatch: "PIN не збігаються",
    pinCountdown: (time: string) => `Зачекайте ${time}`,
    pinQueueConfirm: (count: number) =>
      `${count} ${ukrainianPlural(count, "ненадіслане повідомлення", "ненадіслані повідомлення", "ненадісланих повідомлень")} буде видалено. Продовжити?`,
    forgotPin: "Забули PIN?",
    forgotFinish: "Завершити сеанс",
    forgotConfirm:
      "Без PIN продовжити цей сеанс неможливо. Щоб знову отримати доступ до чатів, увійдіть в обліковий запис за допомогою сід-фрази (12 або 24 слова).\n\nПерш ніж продовжити, переконайтеся, що маєте доступ до сід-фрази. Усі повідомлення залишаться на сервері й відновляться після повторного входу.\n\nЗавершити поточний сеанс?",
  },
} as const;

export type Strings = (typeof strings)[Language];

export function detectLanguage(browserLanguages: readonly string[]): Language {
  for (const browserLanguage of browserLanguages) {
    const code = browserLanguage.trim().toLowerCase().split(/[-_]/u)[0];
    if (code === "uk") return "uk";
    if (code === "ru" || code === "be") return "ru";
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
    if (saved === "ru" || saved === "en" || saved === "uk") return saved;
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

export function ukrainianPlural(
  count: number,
  one: string,
  few: string,
  many: string,
): string {
  const category = new Intl.PluralRules("uk-UA").select(count);
  return category === "one" ? one : category === "few" ? few : many;
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
