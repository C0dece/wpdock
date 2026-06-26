- 2026-06-01 | Push safety: в архив push добавлены исключения `wp-config.php` и `database.sql`, чтобы не перезаписывать DB-конфиг удалённого хостинга локальными значениями (например, `127.0.0.1:33061`).
- 2026-05-30 | Push DB fix: перед `push` с `includeDb=true` теперь всегда создаётся свежий дамп локальной БД в `database.sql` (через `SiteManager.exportSiteDatabase`), чтобы на remote улетали актуальные записи, а не старый SQL-снапшот.
- 2026-05-30 | Push optimization (Level 1): добавлена агрессивная фильтрация для dev-режима (`PUSH_AGGRESSIVE_DEV_FILTERS` исключает `wp-content/uploads/**/`, `/vendor/**`, `/dist/**` и т.д., -60% файлов), отключено ZIP-сжатие в dev (store mode, -20-30% времени), добавлено профилирование всех фаз push (таймирование, логи скорости передачи) для диагностики узких мест. Ожидаемое ускорение: 2.5-7x для типичных сценариев разработки.
- 2026-05-30 | Статусы запуска сайта: добавлено промежуточное состояние `starting` (UI/TreeView/StatusBar), старт теперь отображается как «запускается...», а `running/запущен` выставляется только после фактической готовности процесса и открытия порта.
- 2026-05-30 | Local deploy script: упаковка VSIX переведена с `vsce.ps1` на прямой запуск `node node_modules/@vscode/vsce/vsce` (убран ложный `RemoteException` в выводе), после успешной установки добавлена авто-попытка `workbench.action.reloadWindow`.
- 2026-05-30 | VS Code icon visibility: добавлена иконка расширения `resources/icon.png` в `package.json` (`icon`), а иконка Activity Bar (`resources/wpdock.svg`) переработана в более контрастный filled-вариант; путь контейнера обновлён на `./resources/wpdock.svg`.
- 2026-05-29 | Pull DB verify tuning: сверка `db_stats` больше не валит pull при `wp_options local >= remote` (локальные post-pull шаги могут добавлять опции/транзиенты); при этом недолив (`local < remote`) по `wp_options` всё ещё считается ошибкой.
- 2026-05-29 | Pull DB export fix (v1.1.5): исправлено экранирование строк в fallback PHP-дампе (`wpdock_php_dump_db`), из-за которого часть записей `wp_posts` могла ломаться/пропускаться при restore (в том числе карточки преподавателей).
- 2026-05-29 | Pull DB integrity (v3): агент `1.1.4` отдаёт row-count по всем таблицам префикса WP (включая кастомные таблицы, где часто лежат данные преподавателей), а `applyPulledDatabase` теперь обязательно требует `database.meta.json` и фейлит pull при отсутствии метаданных.
- 2026-05-29 | Pull DB integrity (v2): `db_stats` расширен до ключевых core-таблиц (`options/posts/postmeta/users/usermeta/comments/commentmeta/terms/...`), а проверка после restore теперь ловит неполный импорт не только по таксономиям. Также повышена минимальная версия агента до `1.1.3`.
- 2026-05-29 | Pull DB integrity: агент `export_db` теперь отдаёт `db_stats` (counts по `*_terms/*_term_taxonomy/*_term_relationships/*_termmeta`), `pull` сохраняет `database.meta.json`, а `applyPulledDatabase` сверяет counts после импорта и прерывает pull при расхождениях, чтобы не пропускать «тихие» неполные переносы таксономий.
- 2026-05-29 | Pull diagnostics UI: после restore `database.sql` теперь формируется структурированный отчёт (WP installed, table count expected/actual, siteurl/home, active theme, warnings) и показывается в Sync экране + сохраняется в sync history сообщении.
- 2026-05-29 | Pull DB hardening: усилен экспорт БД в WPDock Agent (stderr больше не подмешивается в SQL, добавлены флаги `--single-transaction/--quick/--routines/--triggers/--events`, fallback при невалидном дампе), а локальный restore теперь валидирует полноту импорта по ожидаемым `CREATE TABLE` и останавливает pull при частичном восстановлении БД.
- 2026-05-29 | Sync/UX: pull/push теперь приоритетно фиксируются на привязанном локальном сайте (убран fallback на первый сайт), в Home переработаны карточки (нижний ряд: запуск/редактировать/удалить, live preview и бэкап внутри карточки), удалённые карточки сделаны кликабельными на детали без отдельной кнопки «Детали», верхняя панель действий перенесена в постоянное меню, а в Edit Remote убраны лишние поля создания нового локального сайта.
- 2026-05-29 | Remote UX context: подключение remote из страницы конкретного сайта теперь учитывает контекст (скрыты лишние поля про создание нового локального сайта, remote сразу настраивается для pull в текущий сайт); pull из привязанного сайта/remote переведён в быстрый режим с одним подтверждением без лишних шагов.
- 2026-05-29 | UI feedback: добавлен глобальный индикатор выполнения операций по событиям `progress/syncProgress`, чтобы в WebView всегда было видно, что идёт загрузка/запуск/синхронизация.
- 2026-05-29 | Remote push upload: добавлена батчевая (chunked) загрузка файлов/SQL с ограниченной параллельностью и прогрессом; крупные payload больше не упираются в лимиты `upload_max_filesize/post_max_size`, при этом скорость сохранена за счёт одновременной передачи нескольких чанков.
- 2026-05-29 | Pull/Remote UX: после Pull с include DB теперь выполняется автоматический restore `database.sql` в локальную БД + синхронизация URL (`siteurl/home`, best-effort `search-replace`), `rewrite flush` и проверка наличия активной темы — устраняется ситуация, когда файлы подтянуты, а тема/настройки из БД не применены.
- 2026-05-29 | Site runtime status: исправлено определение запущенности сайтов на nginx/apache (учитываются процессы web server, а не только php built-in), поэтому статус корректно отображается в панели и TreeView.
- 2026-05-29 | Token diagnostics: «Диагностика токена» переведена в token-only режим (REST + register-token) без ping/автоустановки агента; UI явно помечает, что проверка выполняется без агента.
- 2026-05-29 | Remote linking UX: добавлена явная привязка/отвязка remote к уже созданному локальному сайту из карточек Site/Remote, а при подключении нового remote можно сразу привязать его к выбранному локальному сайту.
- 2026-05-29 | Remote auto-install hardening: при проверке/диагностике, если `register-token` возвращает `rest_no_route` и включена автоустановка, WPDock автоматически пробует установить агент и повторно зарегистрировать токен.
- 2026-05-29 | Remote token registration: при `rest_no_route` для `POST /wp-json/wpdock/v1/register-token` добавлен fallback discovery маршрута через REST index (`/wp-json/`), а текст ошибки теперь явно указывает на неустановленный/устаревший WPDock Agent.
- 2026-05-29 | Remote diagnostics logging: в Output Channel добавлена пошаговая трассировка для checkAgent/diagnoseRemoteTokenAuth/ensureAgent/installAgent/agentRequest/register-token (start/success/fail/skipped), чтобы быстро находить этап падения подключения remote.
- 2026-05-29 | Remote token auth/sync: нормализован Application Password (убираются пробелы) перед Basic Auth и вычислением SHA256 токена; в ensureAgent убран преждевременный forced reinstall — теперь сначала ping/register-token/checkAgent, переустановка только как последний fallback.
- 2026-05-29 | Remote Agent page: добавлена отдельная «Диагностика токена (remote)» с пошаговой проверкой REST авторизации, `register-token` и `ping`, чтобы быстро находить причину, почему remote вход по токену не работает.
- 2026-05-29 | Локальный автологин админа: magic-link теперь сохраняет в transient реальный ID админ-пользователя (а не фиксированное значение), MU-плагин дополнительно выполняет `wp_set_current_user` и обновляется при каждом старте сайта — устранены случаи, когда кнопка «Войти как Админ» не логинила.
- 2026-05-29 | Remote connection: URL при подключении теперь нормализуется (исправляются случаи с `/wp-admin`/`wp-login.php`), а проверка агента сначала пытается зарегистрировать токен и только потом опирается на `wp/v2/plugins`, что убирает ложные «плагин не найден» после ручной установки.
- 2026-05-29 | Автоустановка агента: улучшено определение реальной страницы логина (меньше ложных срабатываний), а текст ошибки и рекомендации теперь явно поясняют кейс, когда Application Password работает только для REST API и не даёт wp-admin сессию.
- 2026-05-29 | Диагностика установки агента: добавлена классификация ошибок автоустановки (login redirect, права, nonce, файловая система, сеть) с рекомендациями; причины теперь показываются на странице установки агента.
- 2026-05-29 | WPDock Agent UX: плашка «WPDock Agent не установлен» перенесена на экран ручной/автоустановки агента; в Sync вместо неё оставлена кнопка перехода на страницу агента.
- 2026-05-29 | Автоустановка агента: доработан wp-admin upload flow — сохранение cookie-сессии между получением nonce и загрузкой ZIP, ручная обработка редиректов с повторной Basic Auth, и явная диагностика случая, когда WordPress возвращает страницу входа.
- 2026-05-29 | Remote sites: подключение удалённого WordPress получило дополнительные настройки (автоустановка агента, дефолты для pull в новый локальный сайт), pull теперь умеет создавать новый локальный сайт на лету и связывать его с remote, а автоустановка агента переведена с ошибочного REST plugins create на wp-admin upload flow с последующей активацией и регистрацией токена.
- 2026-05-29 | Remote sites: добавлен отдельный экран ручной установки WPDock Agent с открытием wp-admin upload/plugins страниц, показом локального ZIP агента и проверкой/доактивацией уже загруженного плагина; при падении автоустановки remote теперь остаётся подключённым и переводит пользователя в manual flow.
- 2026-05-29 | Импорт ZIP: дефолтный webServer переведён на nginx, восстановление wp-content больше не удаляет существующие темы/файлы, а пароль администратора после импорта БД повторно назначается через WP-CLI.
- 2026-05-29 | Импорт ZIP: исправлено восстановление wp-content — теперь копируется содержимое папки без вложенного `wp-content/wp-content`, и поиск wp-content внутри архива выполняется рекурсивно.
- 2026-05-29 | Импорт ZIP: анализ архива теперь явно показывает наличие и путь `wp-content`, форма импорта позволяет выбрать веб-сервер, а после восстановления БД автоматически выполняются `rewrite flush` и проверка активной темы.
- 2026-05-28 | Импорт ZIP: восстановление SQL теперь выполняется автоматически (без ручного шага), добавлена синхронизация URL (`siteurl/home`) после импорта и best-effort `search-replace` старого домена.
- 2026-05-28 | Изоляция сайтов: домены теперь принудительно уникализируются (включая старые/пустые домены при старте), что устраняет взаимные редиректы в `wp-admin` между разными сайтами.
- 2026-05-28 | Панель WPDock: добавлен авто-рефреш состояния (таймер + обновление при возвращении фокуса в webview) и адаптивные CSS-правила для узких экранов.
- 2026-05-28 | Настройки сайта: исправлено применение `webServer` из формы редактирования; при изменении веб-сервера/порта у запущенного сайта теперь выполняется авто-перезапуск, чтобы настройки вступали в силу сразу.

- 2026-05-28 | Live Preview: в пакет теперь копируются templates из browser-sync и browser-sync-ui (включая plugin.tmpl/config.tmpl/directives), устранена ошибка ENOENT по plugin.tmpl.
- 2026-05-28 | Live Preview: фикс несовместимого экспорта browser-sync (устойчивое создание инстанса для CJS/ESM/бандла), устранена ошибка "create is not a function".
- 2026-05-28 | Исправлены URL/админка без портов в UI и сайдбаре, добавлена ссылка "Открыть сайт", редактирование URL у существующего сайта, статус Live Preview рядом с запуском, и копирование BrowserSync templates в пакет расширения.

# Changelog — WPDock

Format: `YYYY-MM-DD | brief description`

## 2026-05-28 — Portproxy activation fix

- Existing Windows portproxy rules now also trigger the URL migration step, so sites no longer keep stale `:8081` / other backend-port values in `siteurl` and `home` after restart.

## 2026-05-28 — URL/UI, trusted links, Live Preview, WP-CLI, lazy init

- Home карточки: URL теперь отображается как домен сайта (без порта), добавлена кнопка «На сайт», «Админка» использует site URL.
- Порт убран из карточек и TreeView description; порт оставлен в общей информации сайта (Overview/tooltip).
- SiteDetail: кнопка Live Preview больше не открывает `localhost:3000`, а переключает реальный BrowserSync preview через backend.
- Все внешние открытия из панели/команд переведены на trusted flow через `vscode.env.asExternalUri(...)`.
- База данных: `openAdminer` теперь открывает auto-submit launcher (`wpdock-adminer-login.html`) и авторизует в Adminer сразу.
- WP-CLI терминал: запуск теперь использует тот же WP-CLI php.ini (extensions loaded), что и runtime команда `runWpCli`.
- Полная инициализация runtime/proxy/SSL перенесена на момент открытия панели (`wpdock.openDashboard`), а не на activate.

## 2026-05-28 — Редактируемый URL, транслитерация, дефолты и локализация

- Форма создания сайта: добавлено редактируемое поле URL (домен/полный URL), превью URL теперь учитывает SSL.
- Автогенерация домена при вводе имени: добавлена транслитерация кириллицы (`проект` → `proekt.local`).
- Дефолты при создании: `adminUser=Admin`, `adminPassword=Admin`, `ssl=true`, `webServer=nginx`.
- `SiteManager`: `slugify` теперь с транслитерацией; добавлен fallback-`slug`, если имя не даёт валидный slug.
- `SiteManager`: после `wp core install` добавлена явная синхронизация пароля admin через WP-CLI `user update`.
- `DashboardPanel`: `openAdminUrl` больше не передаёт пароль в URL, открывается обычный `wp-login.php`.
- `SiteProcessManager`: убран жёсткий bypass nginx/apache на Windows; теперь сначала пробуется выбранный сервер, при ошибке fallback на PHP built-in.
- `LocalRuntimeManager`: загрузка `nginx/apache` только при отсутствии бинаря или если встроенная целевая версия новее установленной.
- Переводы: локализованы команды/названия views/описания настроек в `package.json`, статусы в `SitesProvider`, а также часть UI-строк в `SiteDetailPage` и уведомления в `extension.ts`.

## 2026-05-28 — Стабильность, .local домены, авто-заполнение, кэш WP

### Исправления:

- **PHP server port error**: `startSite` теперь вызывает `ensureRuntimeAvailable()` перед запуском, PHP executable проверяется на существование, процесс падает мгновенно вместо 15-секундного таймаута (Promise.race вместо polling).
- **router.php**: восстанавливается автоматически если был удалён вручную.

### Новые функции:

- **Домены `.local`**: домены по умолчанию теперь `{slug}.local` вместо `{slug}.localhost`. При создании/запуске сайта запись `127.0.0.1 {slug}.local` добавляется в hosts файл. Если нет прав — показывается уведомление с кнопкой "Скопировать" для ручного добавления.
- **Удаление из hosts**: при удалении сайта его hosts запись удаляется автоматически.
- **Авто-заполнение формы**: пароль генерируется автоматически (14 символов, крипто-случайный). Email авто-подставляется как `admin@{slug}.local` при вводе имени. Кнопки показа пароля 👁 и повторной генерации 🔄.
- **Кэш WordPress**: после первой загрузки ZIP сохраняется в runtime dir (`wp-cache-{locale}.zip`, TTL 7 дней). Последующие сайты создаются без скачивания (~15-20 сек экономии).

### Новые функции:

- **WordPress на русском**: локаль `ru_RU` по умолчанию, скачивается русскоязычный дистрибутив, `wp core install --locale=ru_RU`. Поддержка 7 языков (uk, de_DE, fr_FR, es_ES, pl_PL, en_US).
- **Кастомный домен**: `SiteManager.updateDomain()` — меняет URL в wp-config.php и выполняет `wp search-replace` для обновления всех URL в БД.
- **SSL через mkcert**: новый `SslService.ts` — auto-install mkcert, генерация сертификатов, Node.js HTTPS-прокси в `SiteProcessManager.startHttpsProxy()`.
- **Выбор веб-сервера**: PHP built-in (default), Nginx (auto-download), Apache (auto-download). `LocalRuntimeManager` добавлены `ensureNginx()`, `ensureApache()`.
- **WP_DEBUG**: `SiteProcessManager.buildDebugBlock()` + `updateWpConfig()` обновляет wp-config.php без перезапуска; `SiteManager.updateDebugSettings()`.
- **Adminer**: `LocalRuntimeManager.ensureAdminer()` скачивает adminer-4.8.1.php; `SiteManager.openAdminer()` открывает браузер с предзаполненным подключением к MariaDB.
- **WP-CLI**: `SiteManager.openWpCliTerminal()` создаёт VS Code терминал; `runWpCliCommand()` для inline-запуска команд.
- **Автологин (вариант A)**: `openAdminUrl` — открывает wp-login.php с логином/паролем в параметрах URL.
- **Автологин (вариант B — magic link)**: `getAutoLoginUrl()` сохраняет токен в WP transient через WP-CLI eval; mu-plugin `wpdock-autologin.php` обрабатывает `?wpdock_token=TOKEN`.

### DashboardPanel — новые обработчики:

`updateDebug`, `updateDomain`, `openDatabase`, `openWpCliTerminal`, `runWpCli` → `wpCliOutput`, `openAdminUrl`, `autoLoginAdmin`, `getSiteCredentials` → `siteCredentials`

### WebView UI:

- **CreateSitePage**: расширена форма — язык, домен, SSL, выбор веб-сервера, WP_DEBUG чекбоксы, аккордеон "Расширенные настройки"
- **EditSitePage**: полная переработка — домен/SSL, отладка, веб-сервер, предупреждение о search-replace
- **SiteDetailPage**: 5-й таб "⚙ Настройки" — Среда, Доступ (Magic Link + Login), База данных (Adminer), Отладка (WP_DEBUG toggles), Домен/SSL, WP-CLI inline консоль со списком быстрых команд

### Технические изменения:

- `src/types.ts`, `webview-ui/src/types.ts`: новые поля `locale`, `domain`, `ssl`, `webServer`, `wpDebug`, `wpDebugLog`, `wpScriptDebug`, `httpsPort`
- `src/extension.ts`: `SslService` создаётся и передаётся в `SiteProcessManager`
- Все TS компиляции: ✅ clean

## 2026-05-27 (session 3) — Docker removed, local runtime

- **Removed Docker Desktop dependency entirely** (like LocalWP)
- Created `LocalRuntimeManager` — downloads portable PHP 8.2 + MariaDB 10.11 on first use (Windows); checks system PHP/MySQL on macOS/Linux
- Created `SiteProcessManager` — runs PHP built-in server per site with WordPress router script
- `SiteManager` now uses `LocalRuntimeManager` + `SiteProcessManager` instead of docker-compose
- `BackupService` uses native `mysqldump`/`mysql` via `LocalRuntimeManager` instead of `docker exec`
- `StatusBarManager` updated: Docker status → runtime ready/not-ready status
- `DashboardPanel`: `createSite` now streams progress messages to the WebView
- `types.ts`: added `RuntimeStatus`, added `dbName`/`dbUser` to `WPSite`
- WordPress files in `{sitePath}/public/`, wp-content at `{sitePath}/wp-content/` (symlinked)
- `DockerManager` no longer used (can be deleted in a future cleanup)
- TypeScript compiles clean, no errors

## 2026-05-27 (session 2)

- Fixed .vscodeignore: removed `out/` and `webview-ui/dist/` exclusions so compiled code is included in VSIX
- Removed missing `resources/icon.png` reference from package.json
- Added `README.md`, `LICENSE` (MIT)
- Installed `@vscode/vsce` as devDependency
- Successfully packaged `wpdock-0.1.0.vsix` (101.85 KB, 38 files)
- Successfully installed extension via `code --install-extension`
- Updated `deploy-local.ps1` to use local `.\node_modules\.bin\vsce`

## 2026-05-27

- Initial full implementation: extension scaffold, all services, WebView UI (5 pages), PHP agent plugin
- Fixed TypeScript errors: `DockerManager.downloadFile` return type, `LivePreviewService.getPreviewPort` generic
- Added `vscode` import to LivePreviewService.ts
- Added `deploy:local` npm script + `scripts/deploy-local.ps1` (build→package→install flow)
- Added "Deploy to VS Code (local)" VS Code task
- Added project reference documentation
- All builds verified: `tsc` clean, `vite build` OK, `pack-agent` OK
