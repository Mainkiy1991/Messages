# Messages

**[Русский](#русский) | [English](#english)**

## Русский

Messages — открытый мессенджер с входом по сид-фразе и шифрованием на клиенте. Приватные данные не покидают устройство.

**Статус:** ранняя разработка; проект не проходил аудит безопасности.

### Запуск сервера

Требуются Node.js 22 и pnpm 11. Создайте бесплатную БД на [Neon](https://neon.tech/): зарегистрируйтесь, создайте проект, выберите регион и скопируйте строку подключения в разделе **Connect**. Скопируйте `apps/server/.env.example` в `apps/server/.env`, вставьте строку как `DATABASE_URL`.

```sh
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

`.env` содержит пароль: никогда не коммитьте его и не показывайте другим. `TRUST_PROXY=false` используется по умолчанию. На Render установите `TRUST_PROXY=true`, чтобы rate limit учитывал клиентский IP из заголовков доверенного прокси.

API на `http://localhost:3000`: `GET /health`; `POST /auth/challenge` выдаёт одноразовый challenge; `POST /auth/login` проверяет Ed25519-подписи и выдаёт Bearer-токен; `POST /auth/logout` удаляет сессию; `GET /me` возвращает ваши публичные ключи; `GET /users/:userId/keys` возвращает публичный ключ пользователя. Для защищённых запросов используйте `Authorization: Bearer <token>`.

Проверка полного цикла входа на запущенном сервере: `pnpm --filter @messages/server smoke`. По умолчанию проверяется `http://localhost:3000`; для другого адреса задайте `SMOKE_URL`.

### WebSocket-сообщения

Подключитесь к `GET /ws` по WebSocket. Токен нельзя передавать в URL: первым JSON-текстовым кадром отправьте `{"type":"auth","token":"<Bearer token>"}`. При успехе сервер отвечает `{"type":"auth_ok","userId":"<64 hex>"}`. Веб-клиенты должны передавать разрешённый `WEB_ORIGIN`; клиенты без `Origin` допускаются. До авторизации разрешён только кадр `auth`; таймаут авторизации — 5 секунд.

Отправка: `{"type":"send","clientMsgId":"<32 hex>","to":"<64 hex>","ciphertext":"<base64>","senderCopy":"<base64>"}`. Оба поля с base64 содержат от 1 до 65536 декодированных байт. `senderCopy` предназначен для будущей истории отправителя и не доставляется адресату. Подтверждение сохранения: `{"type":"sent","clientMsgId":"...","id":"<uuid>","createdAt":"<ISO>"}`. Адресат получает `{"type":"message","id":"<uuid>","from":"<userId>","ciphertext":"<base64>","createdAt":"<ISO>"}`. Для подтверждения получения отправьте `{"type":"ack","ids":["<uuid>"]}`; отправитель получает `{"type":"delivered","id":"<uuid>","clientMsgId":"...","at":"<ISO>"}`.

После `auth_ok` сервер передаёт недоставленные сообщения по порядку последовательности БД, группами до 200. Следующая группа приходит после подтверждения предыдущей. Сообщение может прийти повторно — сразу при доставке и позднее из ящика; клиенту нужно дедуплицировать сообщения по `id`. Клиент должен всегда отправлять `ack` на каждое полученное сообщение, даже если расшифровать его не удалось: иначе ящик этого соединения остановится на неподтверждённом сообщении. При повторной отправке используйте тот же `clientMsgId`; если получатель изменился, сервер вернёт `client_msg_id_conflict`. Сообщения сохраняются после доставки. Максимальный кадр — 256 KiB; максимум 5 соединений на пользователя, 120 кадров любого типа за 10 секунд на соединение и 30 рукопожатий в минуту с одного IP; ping отправляется каждые 30 секунд. Сессия проверяется при подключении: уже открытое соединение остаётся активным до logout или разрыва.

Коды кадра `error`: `invalid_frame` (JSON, тип, схема или размер поля), `recipient_not_found`, `client_msg_id_conflict` и `internal_error`. Ошибки авторизации закрывают соединение кодом 4401; превышение лимита кадров закрывает его с кодом 4429; несовпадающий `Origin` отклоняется при рукопожатии. Smoke создаёт двух пользователей, отправляет случайные байты офлайн-получателю, проверяет доставку из ящика, ack и статус `delivered`.

### Проверки

```sh
pnpm lint
pnpm build
pnpm test
```

Серверные интеграционные тесты требуют `TEST_DATABASE_URL`. CI автоматически запускает их на PostgreSQL 16; локально без переменной тесты сервера пропускаются с сообщением.

### Структура

- `apps/web` — React, Vite и TypeScript.
- `apps/server` — Fastify API, PostgreSQL, миграции, challenge-response и сессии.
- `packages/crypto` — BIP-39, Ed25519, X25519 и функции подписи.

## English

Messages is an open-source messenger with seed-phrase sign-in and client-side encryption. Private data stays on the user's device.

**Status:** early development; the project has not undergone a security audit.

### Run the server

Requires Node.js 22 and pnpm 11. Create a free database at [Neon](https://neon.tech/): sign up, create a project, choose a region, and copy the connection string from **Connect**. Copy `apps/server/.env.example` to `apps/server/.env` and set `DATABASE_URL` to that string.

```sh
pnpm install
pnpm --filter @messages/server migrate
pnpm dev
```

`.env` contains your database password. Never commit or share it. `TRUST_PROXY=false` is the default. Set `TRUST_PROXY=true` when deploying behind Render's proxy so rate limits use each client's forwarded IP.

API at `http://localhost:3000`: `GET /health`; `POST /auth/challenge` creates a one-use challenge; `POST /auth/login` verifies Ed25519 signatures and returns a Bearer token; `POST /auth/logout` removes the session; `GET /me` returns your public keys; `GET /users/:userId/keys` returns a user's public key. Send `Authorization: Bearer <token>` for protected requests.

Check the complete sign-in flow against a running server with `pnpm --filter @messages/server smoke`. It uses `http://localhost:3000` by default; set `SMOKE_URL` to check another server.

### WebSocket messaging

Connect to `GET /ws`. Never put the token in the URL: send `{"type":"auth","token":"<Bearer token>"}` as the first JSON text frame. On success the server replies with `{"type":"auth_ok","userId":"<64 hex>"}`. Browser clients must send the configured `WEB_ORIGIN`; clients without an `Origin` header are allowed. Only `auth` is accepted before authentication; the auth timeout is five seconds.

Send `{"type":"send","clientMsgId":"<32 hex>","to":"<64 hex>","ciphertext":"<base64>","senderCopy":"<base64>"}`. Each base64 value must decode to 1–65536 bytes. `senderCopy` is reserved for the sender's future history and is never sent to the recipient. The sender receives `sent` with the stable message UUID and creation time. The recipient receives `message` with `id`, `from`, `ciphertext`, and `createdAt`. A recipient acknowledges with `{"type":"ack","ids":["<uuid>"]}`; the sender then receives `delivered`.

After `auth_ok`, undelivered mailbox entries arrive in database sequence order, in batches of at most 200. The next batch is sent after the previous batch is acknowledged. A message can arrive more than once: immediately and later from the mailbox. Clients should deduplicate messages by `id` and always send `ack` for every received message, even when decryption fails; otherwise this connection's mailbox remains blocked at the unacknowledged message. Reuse the same `clientMsgId` when retrying a send; changing the recipient returns `client_msg_id_conflict`. Messages remain stored after delivery. Limits are 256 KiB per frame, five connections per user, 120 frames of any type per connection per 10 seconds, and 30 handshakes per IP per minute; ping runs every 30 seconds. The session is checked at connection time; an open connection remains active until logout or disconnect.

Frame error codes are `invalid_frame`, `recipient_not_found`, `client_msg_id_conflict`, and `internal_error`. Authentication failures close with code 4401; exceeding the frame limit closes with code 4429; a disallowed `Origin` is rejected during the handshake. The smoke test creates two users, sends random bytes while the recipient is offline, then checks mailbox delivery, ack, and the sender's `delivered` status.

### Checks

```sh
pnpm lint
pnpm build
pnpm test
```

Server integration tests require `TEST_DATABASE_URL`. CI runs them against PostgreSQL 16; locally, server tests are skipped with a message when the variable is not set.

### Repository structure

- `apps/web` — React, Vite, and TypeScript.
- `apps/server` — Fastify API, PostgreSQL, migrations, challenge-response, and sessions.
- `packages/crypto` — BIP-39, Ed25519, X25519, and signing functions.
