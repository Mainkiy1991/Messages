# Messages

**[Русский](#русский) | [English](#english)**

## Русский

Messages — открытый мессенджер, задуманный с авторизацией по сид-фразе и шифрованием на клиенте. Криптографическая обработка приватных данных должна оставаться на устройстве пользователя.

**Статус:** ранняя разработка.

### Что уже работает

- Создание аккаунта с фразой BIP-39 на 12 или 24 слова и вход по существующей фразе.
- Локальная сессия в IndexedDB, содержащая производные ключи; выход удаляет хранилище.
- Получение стабильного ID и переключение интерфейса RU/EN.
- Серверный health endpoint `GET /health`.

### Запуск локально

Требуются Node.js 22 и pnpm 11.

```sh
pnpm install
pnpm dev
```

Веб-приложение доступно на http://localhost:5173, сервер — на http://localhost:3000. Проверка сервера: `GET http://localhost:3000/health` возвращает `{"status":"ok"}`.

```sh
pnpm lint
pnpm build
pnpm test
```

### Структура

- `apps/web` — React, Vite и TypeScript.
- `apps/server` — Node.js сервер и `GET /health`.
- `packages/crypto` — BIP-39 и детерминированное получение Ed25519, X25519 и ключа истории.

### Предупреждение

Проект экспериментальный и ещё не прошёл аудит безопасности. Не используйте его для защиты реальных сообщений или хранения ценных секретов. Никогда не передавайте сид-фразы и приватные ключи другим людям или сервисам.

## English

Messages is an open-source messenger designed around seed-phrase sign-in and client-side encryption. Cryptographic processing of private data is intended to remain on the user's device.

**Status:** early development.

### What already works

- Create an account with a 12- or 24-word BIP-39 phrase, or sign in with an existing phrase.
- A local IndexedDB session containing derived keys; signing out deletes the database.
- Stable user ID derivation and RU/EN interface switching.
- Server health endpoint at `GET /health`.

### Run locally

Requires Node.js 22 and pnpm 11.

```sh
pnpm install
pnpm dev
```

The web app is available at http://localhost:5173 and the server at http://localhost:3000. `GET http://localhost:3000/health` returns `{"status":"ok"}`.

```sh
pnpm lint
pnpm build
pnpm test
```

### Repository structure

- `apps/web` — React, Vite, and TypeScript.
- `apps/server` — Node.js server and `GET /health`.
- `packages/crypto` — BIP-39 and deterministic Ed25519, X25519, and history-key derivation.

### Warning

This project is experimental and has not undergone a security audit. Do not use it to protect real messages or store valuable secrets. Never share seed phrases or private keys with other people or services.
