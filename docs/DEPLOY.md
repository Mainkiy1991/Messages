# Развёртывание на Render

Эта инструкция подготавливает Render Web Service для сервера и Static Site для сайта. Деплой выполняется владельцем из панели Render; секреты не добавляйте в файлы репозитория и не отправляйте в чат.

## Перед началом

Создайте отдельную production-базу PostgreSQL в Neon. Скопируйте её строку подключения с SSL-параметром из Neon и храните её только в менеджере паролей или временно в окне PowerShell.

Перед первым запуском примените миграции 001–007 к production-базе с компьютера. Откройте PowerShell в папке репозитория и выполните:

```powershell
$env:DATABASE_URL = Read-Host "Вставьте строку подключения боевой базы"
$db = [uri]$env:DATABASE_URL
Write-Output "Хост: $($db.Host); база: $($db.AbsolutePath.TrimStart('/'))"
pnpm --filter @messages/server migrate
Remove-Item Env:DATABASE_URL
Clear-Host
```

Команда проверки выводит только хост и имя базы, без пароля. До запуска убедитесь, что они соответствуют production-базе. Если на новой или пустой базе команда сообщает «Все миграции уже применены», значит, она подключилась НЕ к той базе: остановитесь и перепроверьте строку подключения. Если миграции завершились ошибкой, не продолжайте настройку до исправления причины. Никогда не пересылайте строку подключения или пароли в чат. Если строка попала в чат или историю команд PowerShell, сразу замените пароль в Neon (Reset password) и обновите строку подключения.

## Создать сервисы

1. Создайте аккаунт Render и подключите GitHub, затем выберите репозиторий `Mainkiy1991/Messages`.
2. Создайте Blueprint из файла `render.yaml` и выберите ветку `main`. Render создаст `messages-server` и `messages-web`; оба сервиса настроены на запуск после успешных CI-проверок.
3. Откройте настройки `messages-server` и добавьте `DATABASE_URL` (строка production-базы Neon) и `ALLOWED_ORIGINS` (пока можно временно указать `https://example.com`). Вводите значения в панели Render; не сохраняйте их в репозитории и не отправляйте в чат.
4. Запустите первый deploy сервера. В панели сервера откройте его публичный адрес `https://...onrender.com` и проверьте `https://АДРЕС-СЕРВЕРА/health`. Ответ должен быть `{"status":"ok"}`. Это адрес без завершающего `/`.
5. Откройте настройки `messages-web` и задайте `VITE_API_URL` равным адресу сервера, например `https://<ваш-сервер>.onrender.com`. Изменение переменной Static Site требует новой сборки сайта. Дождитесь её завершения и скопируйте публичный адрес сайта.
6. Вернитесь к `messages-server` и замените временный `ALLOWED_ORIGINS` на точный адрес сайта, например `https://<ваш-сайт>.onrender.com` (без завершающего `/`). Сохраните и дождитесь перезапуска сервера.

Адрес сервера и сайта копируйте целиком из адресной строки браузера, включая `https://` и косую черту на конце, если она есть. Для `ALLOWED_ORIGINS` косая черта на конце допустима: сервер убирает её при чтении настройки. Для `VITE_API_URL` завершающая косая черта тоже допустима — `resolveApiUrl` убирает её при сборке сайта.

Если хотите использовать собственные домены, задайте соответствующие адреса в `VITE_API_URL` и `ALLOWED_ORIGINS`.

## Проверка

Откройте адрес сервера с путём `/health`: должно отобразиться `{"status":"ok"}`. Откройте адрес сайта, войдите с одной сид-фразой в двух разных браузерах/профилях, создайте два аккаунта и обменяйтесь сообщениями. Начальный вход или подключение может занять время, пока бесплатный сервер просыпается. После пробуждения бесплатный сервер может отвечать около минуты — это нормально.

## Сон бесплатного сервиса

Бесплатный Web Service Render засыпает после 15 минут без входящих запросов. Первый запрос после сна запускает сервер; пробуждение может занять около минуты. Пользователь может увидеть долгую первую загрузку, ожидание подключения или временный статус «не в сети». Повторите действие после запуска. Статический сайт остаётся доступен, но запросы к спящему серверу будут ждать пробуждения.

## Если что-то не работает

В Render откройте нужный сервис, раздел **Logs** и найдите ошибки последней сборки или запуска. Сначала проверяйте серверные логи, если `/health` не открывается; логи сборки сайта — если сайт не обновился. Убедитесь, что `DATABASE_URL` указывает на production-базу с SSL и миграции выполнены, `VITE_API_URL` содержит адрес сервера, а `ALLOWED_ORIGINS` — точный адрес сайта. После изменения `VITE_API_URL` пересоберите Static Site. Сервер отклоняет браузерные запросы с Origin, отсутствующим в `ALLOWED_ORIGINS`.

Если в консоли браузера (F12 → Console) появились ошибки CORS или запрос получил ответ 403 с текстом `origin_forbidden`, сравните адрес сайта в адресной строке с адресом, указанным в `ALLOWED_ORIGINS` в настройках сервера Render. Убедитесь, что это полный адрес сайта с `https://` и без пути.

## English quick guide

1. Create a separate production PostgreSQL database in Neon. In PowerShell, enter the URL with `$env:DATABASE_URL = Read-Host "Paste the production database connection string"`, verify only its host and database name with `$db = [uri]$env:DATABASE_URL; Write-Output "Host: $($db.Host); database: $($db.AbsolutePath.TrimStart('/'))"`, run `pnpm --filter @messages/server migrate`, then clear the variable with `Remove-Item Env:DATABASE_URL` and the window with `Clear-Host`. Never share connection strings or passwords in chat. If the string appears in chat or PowerShell history, reset the Neon password immediately. If a new or empty database reports that all migrations are already applied, stop and verify the connection string; it points to the wrong database.
2. Connect the GitHub repository to Render and create a Blueprint from `render.yaml` on `main`.
3. Enter `DATABASE_URL` and `ALLOWED_ORIGINS` in the server's Render settings. Copy the complete server and site addresses from the browser address bar, including `https://` and any trailing slash. A trailing slash is fine for `ALLOWED_ORIGINS`; the server removes it. Deploy the server first and verify its `/health` URL.
4. Set the web Static Site's `VITE_API_URL` to the server's public HTTPS URL and rebuild the site. `resolveApiUrl` removes a trailing slash during the build. Then set the server's `ALLOWED_ORIGINS` to the site's full public origin.
5. Open the site, create two accounts in separate browser profiles, and exchange messages. The free server sleeps after 15 minutes without requests; waking it and responding for about a minute is normal. Check each service's **Logs** in Render if setup fails. CORS errors in the browser's Console (F12) or a 403 `origin_forbidden` response mean you should compare the site's full address with the server's `ALLOWED_ORIGINS` setting.
