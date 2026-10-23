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
