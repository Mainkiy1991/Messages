# Развёртывание на Render

Эта инструкция подготавливает Render Web Service для сервера и Static Site для сайта. Деплой выполняется владельцем из панели Render; секреты не добавляйте в файлы репозитория и не отправляйте в чат.

## Перед началом

Создайте отдельную production-базу PostgreSQL в Neon. Скопируйте её строку подключения с SSL-параметром из Neon и храните её только в менеджере паролей или временно в окне PowerShell.

Перед первым запуском примените миграции 001–007 к production-базе с компьютера. Откройте PowerShell в папке репозитория и выполните:

```powershell
$secureUrl = Read-Host "Введите строку подключения Neon" -AsSecureString
$credential = [System.Management.Automation.PSCredential]::new("Neon", $secureUrl)
$env:DATABASE_URL = $credential.GetNetworkCredential().Password
Remove-Variable secureUrl, credential
pnpm --filter @messages/server migrate
Remove-Item Env:DATABASE_URL
```

Не делайте снимки экрана с этой строкой и не пересылайте её. Ввод скрыт, команда не сохраняет строку в файле или историю PowerShell. Переменная окружения доступна только процессам из этого окна и удаляется последней командой. Если миграции завершились ошибкой, не продолжайте настройку до исправления причины.

## Создать сервисы

1. Создайте аккаунт Render и подключите GitHub, затем выберите репозиторий `Mainkiy1991/Messages`.
2. Создайте Blueprint из файла `render.yaml` и выберите ветку `main`. Render создаст `messages-server` и `messages-web`; оба сервиса настроены на запуск после успешных CI-проверок.
3. Откройте настройки `messages-server` и добавьте `DATABASE_URL` (строка production-базы Neon) и `ALLOWED_ORIGINS` (пока можно временно указать `https://example.com`). Вводите значения в панели Render; не сохраняйте их в репозитории и не отправляйте в чат.
4. Запустите первый deploy сервера. В панели сервера откройте его публичный адрес `https://...onrender.com` и проверьте `https://АДРЕС-СЕРВЕРА/health`. Ответ должен быть `{"status":"ok"}`. Это адрес без завершающего `/`.
5. Откройте настройки `messages-web` и задайте `VITE_API_URL` равным адресу сервера, например `https://messages-server.onrender.com`. Изменение переменной Static Site требует новой сборки сайта. Дождитесь её завершения и скопируйте публичный адрес сайта.
6. Вернитесь к `messages-server` и замените временный `ALLOWED_ORIGINS` на точный адрес сайта, например `https://messages-web.onrender.com` (без завершающего `/`). Сохраните и дождитесь перезапуска сервера.

Если хотите использовать собственные домены, задайте соответствующие адреса в `VITE_API_URL` и `ALLOWED_ORIGINS`.

## Проверка

Откройте адрес сервера с путём `/health`: должно отобразиться `{"status":"ok"}`. Откройте адрес сайта, войдите с одной сид-фразой в двух разных браузерах/профилях, создайте два аккаунта и обменяйтесь сообщениями. Начальный вход или подключение может занять время, пока бесплатный сервер просыпается.

## Сон бесплатного сервиса

Бесплатный Web Service Render засыпает после 15 минут без входящих запросов. Первый запрос после сна запускает сервер; пробуждение может занять около минуты. Пользователь может увидеть долгую первую загрузку, ожидание подключения или временный статус «не в сети». Повторите действие после запуска. Статический сайт остаётся доступен, но запросы к спящему серверу будут ждать пробуждения.

## Если что-то не работает

В Render откройте нужный сервис, раздел **Logs** и найдите ошибки последней сборки или запуска. Сначала проверяйте серверные логи, если `/health` не открывается; логи сборки сайта — если сайт не обновился. Убедитесь, что `DATABASE_URL` указывает на production-базу с SSL и миграции выполнены, `VITE_API_URL` содержит адрес сервера, а `ALLOWED_ORIGINS` — точный адрес сайта. После изменения `VITE_API_URL` пересоберите Static Site. Сервер отклоняет браузерные запросы с Origin, отсутствующим в `ALLOWED_ORIGINS`.

## English quick guide

1. Create a separate production PostgreSQL database in Neon. In PowerShell, use `Read-Host -AsSecureString` to enter the Neon URL without echoing it, temporarily set `$env:DATABASE_URL`, run `pnpm --filter @messages/server migrate`, then run `Remove-Item Env:DATABASE_URL`. Do not save or share the connection string.
2. Connect the GitHub repository to Render and create a Blueprint from `render.yaml` on `main`.
3. Enter `DATABASE_URL` and `ALLOWED_ORIGINS` in the server's Render settings. Deploy the server first and verify its `/health` URL.
4. Set the web Static Site's `VITE_API_URL` to the server's public HTTPS URL and rebuild the site. Then set the server's `ALLOWED_ORIGINS` to the site's exact public URL.
5. Open the site, create two accounts in separate browser profiles, and exchange messages. The free server sleeps after 15 minutes without requests; waking it can take about a minute. Check each service's **Logs** in Render if setup fails.
