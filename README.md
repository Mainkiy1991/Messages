# Messages

**[Русский](#русский) | [English](#english) | [Українська](#українська)**

**User guide:** [RU](docs/USER-GUIDE.ru.md) | [EN](docs/USER-GUIDE.en.md) | [UK](docs/USER-GUIDE.uk.md)

## Русский

Messages — открытый мессенджер с входом по сид-фразе и шифрованием на клиенте. Приватные данные не покидают устройство.

Интерфейс доступен на русском, английском и украинском языках.

Пример формата строки подключения PostgreSQL: `DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full`.

**Статус:** ранняя разработка; проект не проходил аудит безопасности.

### Запуск сервера

Требуются Node.js 22 и pnpm 11. Создайте бесплатную БД на [Neon](https://neon.tech/): зарегистрируйтесь, создайте проект, выберите регион и скопируйте строку подключения в разделе **Connect**. Скопируйте `apps/server/.env.example` в `apps/server/.env`, вставьте строку как `DATABASE_URL`.

Windows PowerShell:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
notepad apps/server/.env
```

Linux/macOS:

```sh
cp apps/server/.env.example apps/server/.env
$EDITOR apps/server/.env
```

Команды сервера, миграции и smoke загружают `apps/server/.env` относительно расположения исходного файла; переменные, уже заданные в окружении, имеют приоритет. Например, после копирования файла команда migrate сама найдёт `DATABASE_URL`.

Для веб-клиента скопируйте `apps/web/.env.example` в `apps/web/.env` (по умолчанию API уже настроен на `http://localhost:3000`). Чтобы запустить API и веб-клиент вместе, выполните из корня:

```powershell
Copy-Item apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

Linux/macOS:

```sh
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

### Обновление базы данных

После получения новой версии кода примените миграции к базе из `apps/server/.env`:

```powershell
pnpm --filter @messages/server migrate
```

Если миграции не применить, сервер может вернуть 500 на запросах к новым таблицам.

После обновления примените миграцию отметок о прочтении: `pnpm --filter @messages/server migrate`. Когда чат открыт на видимой вкладке, клиент отмечает входящие сообщения прочитанными; отправитель увидит статус «прочитано».

Откройте `http://localhost:5173`. Для проверки обмена создайте/войдите в аккаунт в обычном окне браузера, скопируйте свой ID, затем откройте второй браузерный профиль или приватное окно и войдите/создайте там второй аккаунт. В первом окне создайте чат по ID второго и отправьте сообщение; ответьте из второго окна. Vite использует порт 5173 без автоматического переключения порта, так как сервер сверяет Origin с `WEB_ORIGIN`.

Клиент загружает список чатов и постраничную историю после входа; имена хранятся в зашифрованной контакт-книге. Неотправленные зашифрованные кадры сохраняются в IndexedDB до подтверждения сервера и отправляются повторно после восстановления соединения или входа. Расшифрованная история и текст очереди существуют только в памяти страницы.
`.env` содержит пароль: никогда не коммитьте его и не показывайте другим. `HOST=127.0.0.1` и `TRUST_PROXY=false` используются по умолчанию. На Render установите `HOST=0.0.0.0`, чтобы сервер принимал внешние подключения, и `TRUST_PROXY=true`, чтобы rate limit учитывал клиентский IP из заголовков доверенного прокси.

API на `http://localhost:3000`: `GET /health`; `POST /auth/challenge` выдаёт одноразовый challenge; `POST /auth/login` проверяет Ed25519-подписи и выдаёт Bearer-токен; `POST /auth/logout` удаляет сессию; `GET /me` возвращает ваши публичные ключи; `GET /users/:userId/keys` возвращает публичный ключ пользователя. Для защищённых запросов используйте `Authorization: Bearer <token>`.

Проверка полного цикла входа на запущенном сервере: `pnpm --filter @messages/server smoke`. По умолчанию проверяется `http://localhost:3000`; для другого адреса задайте `SMOKE_URL`.

### WebSocket-сообщения

Подключитесь к `GET /ws` по WebSocket. Токен нельзя передавать в URL: первым JSON-текстовым кадром отправьте `{"type":"auth","token":"<Bearer token>"}`. При успехе сервер отвечает `{"type":"auth_ok","userId":"<64 hex>"}`. Веб-клиенты должны передавать разрешённый `WEB_ORIGIN`; клиенты без `Origin` допускаются. До авторизации разрешён только кадр `auth`; таймаут авторизации — 5 секунд.

Отправка: `{"type":"send","clientMsgId":"<32 hex>","to":"<64 hex>","ciphertext":"<base64>","senderCopy":"<base64>"}`. Оба поля с base64 содержат от 1 до 65536 декодированных байт. `senderCopy` предназначен для будущей истории отправителя и не доставляется адресату. Подтверждение сохранения: `{"type":"sent","clientMsgId":"...","id":"<uuid>","createdAt":"<ISO>"}`. Адресат получает `{"type":"message","id":"<uuid>","from":"<userId>","ciphertext":"<base64>","createdAt":"<ISO>"}`. Для подтверждения получения отправьте `{"type":"ack","ids":["<uuid>"]}`; отправитель получает `{"type":"delivered","id":"<uuid>","clientMsgId":"...","at":"<ISO>"}`.

Когда чат открыт на видимой вкладке, клиент отправляет только ID собеседника и максимальный прочитанный номер сообщения. Отправитель увидит статус «прочитано».

После `auth_ok` сервер передаёт недоставленные сообщения по порядку последовательности БД, группами до 200. Следующая группа приходит после подтверждения предыдущей. Сообщение может прийти повторно — сразу при доставке и позднее из ящика; клиенту нужно дедуплицировать сообщения по `id`. Клиент должен всегда отправлять `ack` на каждое полученное сообщение, даже если расшифровать его не удалось: иначе ящик этого соединения остановится на неподтверждённом сообщении. При повторной отправке используйте тот же `clientMsgId`; если получатель изменился, сервер вернёт `client_msg_id_conflict`. Сообщения сохраняются после доставки. Максимальный кадр — 256 KiB; максимум 5 соединений на пользователя, 120 кадров любого типа за 10 секунд на соединение и 30 рукопожатий в минуту с одного IP; ping отправляется каждые 30 секунд. Сессия проверяется при подключении: уже открытое соединение остаётся активным до logout или разрыва.

### Формат шифрования

### История и контакты (HTTP)

Все новые маршруты требуют `Authorization: Bearer <token>`. `GET /conversations` возвращает до 500 собеседников `{ "conversations": [{ "peerId": "<hex>", "lastSeq": "<seq>", "lastCreatedAt": "<ISO timestamp>" }] }`, от новых сообщений к старым. `GET /history/:peerId?before=<seq>&limit=<1..100>` возвращает `{ "messages": [{ "id", "seq", "direction": "in|out", "clientMsgId", "payload", "createdAt", "deliveredAt" }], "hasMore": false }`; `before` исключается, `limit` по умолчанию 50, порядок внутри страницы — от старых к новым. Для входящих `payload` — ciphertext адресата, для исходящих — sender copy текущего пользователя. Неизвестный собеседник дает пустую страницу.

`GET /contacts` возвращает `{ "version": "0", "blob": null }` до первой записи или текущую версию и зашифрованный base64 `blob`. `PUT /contacts` принимает `{ "baseVersion": "<version>", "blob": "<base64>" }` и возвращает `{ "version": "<next>" }`. Размер декодированного blob — 1..262144 байта. Несовпадение версии дает `409 { "error": "version_conflict", "version": "<current>", "blob": "<current-or-null>" }`; неверный ввод — 400, отсутствие/неверная сессия — 401, лимит PUT — 429. Сервер хранит только ciphertext.

Контакт-лист шифруется на клиенте ключом HKDF-SHA256 от history key с info `messages/v1/contacts`; XChaCha20-Poly1305 использует случайный 24-байтовый nonce и ту же строку как AAD. Plaintext — UTF-8 JSON `{ "v": 1, "contacts": { "<64 lowercase hex userId>": "<name>" } }`. Контакты ограничены 1000 записями; имена после trim должны быть длиной 1..64 Unicode code points.

`@messages/crypto` шифрует JSON `{v:1,text,sentAt}` как UTF-8 с XChaCha20-Poly1305. Ключ для сообщения получается через HKDF-SHA256 из общего X25519 секрета; AAD связывает шифртекст с `senderId` и `recipientId`. Base64-декодированный конверт: `0x01 || nonce(24) || ciphertext || tag(16)`. Копия отправителя для истории использует отдельный HKDF info и AAD с `clientMsgId` и `peerId`.

Шифрование защищает содержимое и привязывает его к указанным отправителю и получателю. Сервер видит метаданные «кто кому и когда», длину сообщения, а forward secrecy в MVP нет: компрометация долговременного ключа шифрования может открыть сохранённые сообщения.

Коды кадра `error`: `invalid_frame` (JSON, тип, схема или размер поля), `recipient_not_found`, `client_msg_id_conflict` и `internal_error`. Ошибки авторизации закрывают соединение кодом 4401; превышение лимита кадров закрывает его с кодом 4429; несовпадающий `Origin` отклоняется при рукопожатии. Smoke создаёт двух пользователей, отправляет случайные байты офлайн-получателю, проверяет доставку из ящика, ack и статус `delivered`.

### Проверки

```sh
pnpm lint
pnpm build
pnpm test
```

Серверные интеграционные тесты требуют `TEST_DATABASE_URL`. CI автоматически запускает их на PostgreSQL 16; локально без переменной тесты сервера пропускаются с сообщением.

### Браузерные e2e-проверки

Для локального запуска нужна отдельная пустая PostgreSQL база, например отдельная база `messages_e2e` в локальном PostgreSQL. Не задавайте здесь рабочую базу с реальными данными: проверки создают аккаунты и оставляют тестовые записи.

```powershell
$env:E2E_DATABASE_URL = "postgresql://messages:messages@localhost:5432/messages_e2e"
pnpm install
pnpm exec playwright install chromium
pnpm test:e2e
```

Тесты сами соберут приложения, применят миграции, поднимут настоящий сервер и сайт на портах 3000 и 5173. Отчёт HTML находится в `apps/web/playwright-report`; открыть его можно командой `pnpm exec playwright show-report apps/web/playwright-report`. При падении тестов Playwright сохраняет трассировки и скриншоты в `apps/web/test-results`.

### Структура

- `apps/web` — React, Vite и TypeScript.
- `apps/server` — Fastify API, PostgreSQL, миграции, challenge-response и сессии.
- `packages/crypto` — BIP-39, Ed25519, X25519, функции подписи и шифрование сообщений.

## English

Messages is an open-source messenger with seed-phrase sign-in and client-side encryption. Private data stays on the user's device.

The interface is available in Russian, English, and Ukrainian.

Example PostgreSQL connection string: `DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full`.

**Status:** early development; the project has not undergone a security audit.

### Run the server

Requires Node.js 22 and pnpm 11. Create a free database at [Neon](https://neon.tech/): sign up, create a project, choose a region, and copy the connection string from **Connect**. Copy `apps/server/.env.example` to `apps/server/.env` and set `DATABASE_URL` to that string.

Windows PowerShell:

```powershell
Copy-Item apps/server/.env.example apps/server/.env
notepad apps/server/.env
```

Linux/macOS:

```sh
cp apps/server/.env.example apps/server/.env
$EDITOR apps/server/.env
```

The server, migration, and smoke entrypoints load `apps/server/.env` relative to their source file. Variables already present in the environment take precedence, so migrate finds `DATABASE_URL` after the file is copied.

Copy `apps/web/.env.example` to `apps/web/.env` for the web client (the default API URL is `http://localhost:3000`). To run the API and web client together, from the repository root:

```powershell
Copy-Item apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

Linux/macOS:

```sh
cp apps/web/.env.example apps/web/.env
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

### Database updates

After getting a new version of the code, apply migrations to the database in `apps/server/.env`:

```powershell
pnpm --filter @messages/server migrate
```

If you do not apply migrations, the server may return 500 for requests that use new tables.

Open `http://localhost:5173`. To verify messaging, create or sign in to one account in a normal browser window, copy its ID, then use a second browser profile or private window for another account. Create a chat by entering the second ID, send a message, and reply from the second window. Vite keeps port 5173 fixed because the server checks the `WEB_ORIGIN` value.

The client loads the conversation list and paginated message history after sign-in; contact names are stored in an encrypted contact book. Encrypted frames waiting to send are kept in IndexedDB until server confirmation and retried after reconnect or sign-in. Decrypted history and queued message text stay in page memory only.
`.env` contains your database password. Never commit or share it. `HOST=127.0.0.1` and `TRUST_PROXY=false` are the defaults. On Render, set `HOST=0.0.0.0` so the server accepts external connections, and set `TRUST_PROXY=true` so rate limits use each client's forwarded IP.

API at `http://localhost:3000`: `GET /health`; `POST /auth/challenge` creates a one-use challenge; `POST /auth/login` verifies Ed25519 signatures and returns a Bearer token; `POST /auth/logout` removes the session; `GET /me` returns your public keys; `GET /users/:userId/keys` returns a user's public key. Send `Authorization: Bearer <token>` for protected requests.

Check the complete sign-in flow against a running server with `pnpm --filter @messages/server smoke`. It uses `http://localhost:3000` by default; set `SMOKE_URL` to check another server.

### WebSocket messaging

Connect to `GET /ws`. Never put the token in the URL: send `{"type":"auth","token":"<Bearer token>"}` as the first JSON text frame. On success the server replies with `{"type":"auth_ok","userId":"<64 hex>"}`. Browser clients must send the configured `WEB_ORIGIN`; clients without an `Origin` header are allowed. Only `auth` is accepted before authentication; the auth timeout is five seconds.

Send `{"type":"send","clientMsgId":"<32 hex>","to":"<64 hex>","ciphertext":"<base64>","senderCopy":"<base64>"}`. Each base64 value must decode to 1–65536 bytes. `senderCopy` is reserved for the sender's future history and is never sent to the recipient. The sender receives `sent` with the stable message UUID and creation time. The recipient receives `message` with `id`, `from`, `ciphertext`, and `createdAt`. A recipient acknowledges with `{"type":"ack","ids":["<uuid>"]}`; the sender then receives `delivered`.

When a chat is open in a visible tab, the client sends only the peer ID and highest read message sequence. The sender sees a “Read” status. Apply database migrations after updating with `pnpm --filter @messages/server migrate`.

After `auth_ok`, undelivered mailbox entries arrive in database sequence order, in batches of at most 200. The next batch is sent after the previous batch is acknowledged. A message can arrive more than once: immediately and later from the mailbox. Clients should deduplicate messages by `id` and always send `ack` for every received message, even when decryption fails; otherwise this connection's mailbox remains blocked at the unacknowledged message. Reuse the same `clientMsgId` when retrying a send; changing the recipient returns `client_msg_id_conflict`. Messages remain stored after delivery. Limits are 256 KiB per frame, five connections per user, 120 frames of any type per connection per 10 seconds, and 30 handshakes per IP per minute; ping runs every 30 seconds. The session is checked at connection time; an open connection remains active until logout or disconnect.

### Message encryption format

### History and contacts (HTTP)

All new routes require `Authorization: Bearer <token>`. `GET /conversations` returns up to 500 peers as `{ "conversations": [{ "peerId": "<hex>", "lastSeq": "<seq>", "lastCreatedAt": "<ISO timestamp>" }] }`, newest first. `GET /history/:peerId?before=<seq>&limit=<1..100>` returns `{ "messages": [{ "id", "seq", "direction": "in|out", "clientMsgId", "payload", "createdAt", "deliveredAt" }], "hasMore": false }`; `before` is exclusive, default limit is 50, and each page is ordered oldest first. Incoming payloads contain the recipient ciphertext; outgoing payloads contain only the current user's sender copy. Unknown peers return an empty page.

`GET /contacts` returns `{ "version": "0", "blob": null }` before the first write, or the current version and encrypted base64 `blob`. `PUT /contacts` accepts `{ "baseVersion": "<version>", "blob": "<base64>" }` and returns `{ "version": "<next>" }`. Decoded blobs must be 1..262144 bytes. A stale version returns `409 { "error": "version_conflict", "version": "<current>", "blob": "<current-or-null>" }`; invalid input returns 400, missing/invalid sessions return 401, and PUT rate limits return 429. The server stores ciphertext only.

Clients encrypt contact books with HKDF-SHA256 derived from the history key using info `messages/v1/contacts`; XChaCha20-Poly1305 uses a random 24-byte nonce and the same string as AAD. Plaintext is UTF-8 JSON `{ "v": 1, "contacts": { "<64 lowercase hex userId>": "<name>" } }`. Contact books allow at most 1000 entries; trimmed names must contain 1..64 Unicode code points.

`@messages/crypto` encrypts JSON `{v:1,text,sentAt}` as UTF-8 with XChaCha20-Poly1305. The message key comes from HKDF-SHA256 over the shared X25519 secret; AAD binds the ciphertext to `senderId` and `recipientId`. The base64-decoded envelope is `0x01 || nonce(24) || ciphertext || tag(16)`. The sender's history copy uses a separate HKDF info string and AAD containing `clientMsgId` and `peerId`.

Encryption protects message contents and binds them to the stated sender and recipient. The server can see who messaged whom and when, as well as message length. The MVP has no forward secrecy: compromise of a long-term encryption key may expose stored messages.

Frame error codes are `invalid_frame`, `recipient_not_found`, `client_msg_id_conflict`, and `internal_error`. Authentication failures close with code 4401; exceeding the frame limit closes with code 4429; a disallowed `Origin` is rejected during the handshake. The smoke test creates two users, sends random bytes while the recipient is offline, then checks mailbox delivery, ack, and the sender's `delivered` status.

### Checks

```sh
pnpm lint
pnpm build
pnpm test
```

Server integration tests require `TEST_DATABASE_URL`. CI runs them against PostgreSQL 16; locally, server tests are skipped with a message when the variable is not set.

### Browser e2e checks

Use a separate, empty PostgreSQL database for local e2e runs (for example, a dedicated local `messages_e2e` database). Never point `E2E_DATABASE_URL` at a production or other database with real data: the tests create accounts and leave test records behind.

```sh
export E2E_DATABASE_URL=postgresql://messages:messages@localhost:5432/messages_e2e
pnpm install
pnpm exec playwright install chromium
pnpm test:e2e
```

The command builds the apps, applies migrations, and starts the real server and site on ports 3000 and 5173. The HTML report is in `apps/web/playwright-report`; open it with `pnpm exec playwright show-report apps/web/playwright-report`. Failure traces and screenshots are saved in `apps/web/test-results`.

### Repository structure

- `apps/web` — React, Vite, and TypeScript.
- `apps/server` — Fastify API, PostgreSQL, migrations, challenge-response, and sessions.
- `packages/crypto` — BIP-39, Ed25519, X25519, signing functions, and message encryption.

## Українська

Messages — відкритий месенджер з входом за сід-фразою та шифруванням на клієнті. Приватні дані не виходять за межі пристрою.

Інтерфейс доступний російською, англійською та українською мовами.

Приклад формату рядка підключення PostgreSQL: `DATABASE_URL=postgresql://USER:PASSWORD@HOST/DATABASE?sslmode=verify-full`.

**Статус:** рання розробка; проєкт не проходив аудит безпеки.

**Посібник користувача:** [Українська](docs/USER-GUIDE.uk.md).

Інструкції із запуску сервера, вебклієнта та перевірок — у розділах [Русский](#русский) і [English](#english).
