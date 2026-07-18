- 2026-07-15 | Remote Push split-upload: если `507 Failed to write chunk data` повторяется даже после resume и снижения параллелизма до 1, клиент больше не застревает на одной ZIP-части. После persistent single-file write failure WPDock повторяет загрузку этой части через agent fallback `write_mode=chunks` (пер-чанк файлы + финальная сборка), обходя проблемные offset/sparse writes на shared-хостинге; если и это не помогает, дополнительно уменьшает `chunkSize`. WPDock Agent `1.3.18` принимает `write_mode=chunks`, возвращает `storage=chunk_files` и добавляет последнюю PHP filesystem-ошибку к `Failed to write chunk data`, чтобы отличать transient write-сбой от реальной квоты/прав.
- 2026-07-13 | Remote Push split-upload: `507 Failed to write chunk data` больше не считается безусловно фатальной ошибкой диска, если агент уже принял запрос, но shared-хостинг сорвался на записи chunk в single-file upload. Клиент теперь ретраит такой chunk/session через resumable `resume_key` и включает уже существующее адаптивное снижение параллелизма (например 8→4→2→1), поэтому повторная попытка продолжает с уже принятых chunks вместо падения всей ZIP-части. Настоящие storage/quota ошибки (`Cannot store uploaded chunk`, `Insufficient server disk space`, `quota exceeded`, `No space left on device`) по-прежнему падают быстро.
- 2026-07-10 | Дисковый бюджет Push ≈ размер сайта + 1 часть (а не ×2): сам split-push и так экономный (каждая ZIP-часть удаляется агентом сразу после распаковки, `upload_finalize` делает rename без копии), но остатки прерванных попыток — `upload-*.zip`, `chunks-*` сессии, completed-uploads с TTL 24 ч — копились и удваивали требуемое место, а на staging-сайтах без трафика wp-cron не срабатывает и cleanup-cron не работал вовсе. Теперь: (1) cron-очистка вынесена в `wpdock_temp_sweep()` и запускается оппортунистически из `ping` (троттлинг 15 мин) — истёкший мусор удаляется при любом обращении WPDock, без зависимости от wp-cron; (2) клиент перед split-push вызывает `cleanup_uploads`, если resume не нашёл ни одной перенесённой части (переиспользовать нечего — место освобождается до начала загрузки; при валидном resume остатки не трогаются); (3) после успешного split-push клиент best-effort подчищает upload-остатки сразу, не дожидаясь TTL.
- 2026-07-10 | WPDock Agent `1.3.17` — диагностика переполненного диска на хостинге: по логу push падал через 18 минут упаковки с загадочными `Download failed: 404` (resume verify) и `Cannot create chunk directory` (upload_init) — оба симптома одной причины: `wp-content/wpdock-temp` перестал записываться (переполненный диск/квота аккаунта, которую `disk_free_space` не видит — она показывает раздел). Теперь: (1) `ping` агента выполняет реальную пробу записи в wpdock-temp и отдаёт `temp_writable`/`temp_write_error`/`temp_free_bytes`, а клиент в `ensureAgent` падает сразу с понятной ошибкой («очистите wp-content/wpdock-temp, проверьте квоту») до упаковки; (2) `wpdock_store_temp_file` больше не возвращает «мёртвый» токен при неудачной записи `tok-*.json` (раньше это всплывало как 404 на download), а отвечает 500 с реальной ошибкой ФС; (3) запись манифеста проверяет каждый `fwrite` — усечённый манифест на полном диске больше не проходит как валидный; (4) в ошибки `Cannot create chunk directory`/`Cannot create destination file` добавлен текст последней ошибки PHP (`error_get_last`), чтобы в логе сразу была видна причина (quota exceeded / permission denied).
- 2026-07-09 | Remote Push: устранён ложный успех при устаревшем resume-состоянии. Раньше `.wpdock/transfer-state-<remote>.json` с флагом «завершено» пропускал загрузку всех файлов по совпадению плана, даже если сервер после этого очистили/переустановили (в логе «RESUME files already applied» — и 16 GB uploads никуда не улетали). Теперь: (1) resume-состояние перед пропуском сверяется с живым `file_manifest` сервера — в split-режиме перезаливаются только части, чьи файлы реально отсутствуют; (2) после Push выполняется контрольная сверка manifest — при недостающих файлах Push падает с ошибкой «Push не подтверждён: отсутствует N файлов (из них в uploads: M)» вместо ложного успеха; (3) incremental Push («Только изменённые») загружает файл, если его нет на сервере, даже когда baseline считает его неизменным; (4) в Sync-странице добавлена кнопка «Сбросить состояние sync (начать заново)» — удаляет локальные resume-отметки и manifest последнего sync, следующий Push/Pull переносит всё с нуля (файлы на сервере и локально не трогаются).
- 2026-07-09 | WPDock Agent `1.3.16` — потоковый импорт БД: `import_db` больше не загружает весь дамп в память (`file_get_contents` + `preg_replace` по всей строке валили push БД 100+ MB с `Allowed memory size of 268435456 bytes exhausted` на shared-хостинге). Дамп теперь читается построчно: первый проход собирает CREATE TABLE/prefix/preview, импорт выполняется statement-by-statement через выделенное mysqli-соединение (fallback на `$wpdb`), c поддержкой `DELIMITER ;;` блоков триггеров/процедур из mysqldump и переносом префикса per-statement. Peak память PHP при импорте 114 MB дампа — ~2 MB (проверено самотестом на локальной MariaDB); заодно снят риск упереться в `max_allowed_packet`, так как `mysqli_multi_query` одним гигантским пакетом больше не используется.
- 2026-07-08 | WPDock Agent `1.3.15` — целостность split-push: `upload_finalize` теперь сверяет sha256 собранного файла с хэшем из `resume_key` клиента (раньше проверялся только размер, и битый 64 MB chunk «проходил» и всплывал позже как CRC-ошибка `ZIP direct extract failed` при распаковке); при mismatch сессия сбрасывается и клиент прозрачно перезаливает часть. При частичном фейле `extract_files` агент больше не удаляет загруженный архив/токен — ретрай распаковки (и resume целого Push по `resume_key`) работает без повторной загрузки сотен мегабайт. В ошибку и `error_log` добавлен `zip_status` (`getStatusString()`), чтобы отличать CRC-порчу от прав на файлы. Клиент теперь реально ретраит эти два класса ошибок (раньше 500 от `extract_files` не считался retryable и вторая попытка не выполнялась).
- 2026-07-02 | Local runtime stability: исправлен ложный cleanup живых сайтов между окнами VS Code. `SiteManager` больше не убивает reachable nginx/php-cgi как “unowned stale lock” из фоновой синхронизации, а подключается к уже запущенному серверу и обновляет runtime lock; lock теперь не стирается чужим окном при transient probe miss, а владелец освежает heartbeat до health-check. Также запуск nginx больше не выполняет глобальный `Stop-Process nginx`, чтобы старт одного сайта не останавливал другие.
- 2026-07-01 | Remote Push/Pull resume после обрыва: WPDock теперь сохраняет локальное состояние незавершённого sync в `.wpdock/transfer-state-<remote>.json`. Full Pull через агент продолжает существующий pack job по `job_id`/seq и не перепаковывает уже извлечённые части; split/full Push пропускает уже применённые ZIP-части/архивы, не запускает авто-cleanup upload-сессий при сбое, а FTP Pull/Push докачивает/дозагружает текущий файл через временные partial-файлы. Incremental Push/Pull при повторе пропускает файлы, которые уже совпадают на целевой стороне.
- 2026-07-01 | Remote Pull media fallback: если быстрая загрузка `wp-content/uploads` напрямую через curl не может добрать несколько файлов (например, `wp-file-manager-pro/fm_backup/index.html` из защищённой `.htaccess` папки) и агент уже 1.3.13+, WPDock больше не тратит по 3×90 секунд на один и тот же stall. Остатки скачиваются через безопасный `download_path` агента; Pull завершается без ложного `не удалось 1`.
- 2026-07-01 | Remote Push hardening для больших split-upload: клиент теперь во время одного Push автоматически снижает параллелизм chunk upload при transient TLS/socket/idle сбоях (`WRONG_VERSION_NUMBER`, `The user aborted a request`, таймауты). Уже загруженные чанки сохраняются через resumable `resume_key`, а следующие ZIP-части продолжаются с меньшим давлением на shared-хостинг вместо повторения 64 MB × 8 потоков после каждого сбоя.
- 2026-07-01 | WPDock Agent `1.3.14`: `extract_files` больше не распаковывает ZIP-часть сначала во временную папку `wp-content/wpdock-temp`, а извлекает безопасные entry прямо в `ABSPATH` с пропуском защищённого `wpdock-agent`. Это снижает peak disk usage на больших split-push (ошибка `ZIP extractTo() failed — check disk space and permissions` на части ~500 MB). При падении split-push клиент теперь best-effort запускает `cleanup_uploads`, чтобы убрать остатки upload-сессий/ZIP.
- 2026-06-30 | Добавлен FTP/FTPS file transport для remote sync: remote можно подключить с FTP-доступом и передавать файлы без WPDock Agent. БД в FTP-режиме синхронизируется через одноразовый PHP DB bridge: WPDock загружает случайный PHP-файл в корень WordPress, делает export/import и удаляет bridge/SQL через HTTP+FTP cleanup. Добавлен режим «Только изменённые» для Push/Pull: WPDock хранит manifest локального/remote состояния и переносит новые/изменённые файлы, а также удаления после последнего успешного sync. Режим работает и через FTP, и через WPDock Agent 1.3.13 (`file_manifest`, `download_path`, `delete_paths`).
- 2026-06-30 | Remote Push hardening для split-upload: `upload_init`/`upload_finalize`/`upload_abort` получили отдельный 5-минутный таймаут вместо общего 60s, а таймауты AbortError (`The user aborted a request`) и TLS-сбои `WRONG_VERSION_NUMBER` теперь считаются transient upload errors. Большой Push после временного падения control-запроса переинициализирует/resume-ит upload-сессию по `resume_key`, а не обрывается между ZIP-частями.
- 2026-06-29 | Remote Push для очень больших сайтов: если локальные файлы оцениваются больше ~1.5 GB, WPDock больше не собирает один гигантский ZIP (в логе падал на 13.8 GB и `Failed to write chunk data` после ~2.5 GB), а режет push на независимые ZIP-части примерно по 512 MB, загружает и распаковывает каждую часть сразу. Перед split-push best-effort очищаются старые незавершённые upload-сессии агента, чтобы не держать на хостинге остатки предыдущего гигантского архива.
- 2026-06-28 | Remote Push hardening: WPDock Agent `1.3.12` теперь пишет chunk upload сразу в один собираемый файл по offsets и умеет resume по `resume_key`/SHA256 архива: при повторном Push уже принятые chunks и завершённый upload token сохраняются на сервере до 24 часов и пропускаются клиентом. Большой push требует ~1× размер архива, а не ~2×. Добавлены preflight-проверка свободного места (507), `upload_abort` только для несовместимых сессий (например, 413 и смена chunk size), быстрый fail без ретраев при storage/quota ошибках, автообновление агента после register-token/checkAgent paths и настройка параллелизма чанков в UI и кнопка «Очистить остатки Push» (удаляет незавершённые chunks/ZIP/SQL, если пользователь передумал продолжать загрузку).
- 2026-06-26 | Live Preview переписан с нуля: вместо browser-sync (работал только на первой проксируемой странице из-за абсолютных URL WordPress) теперь используется same-origin live reload через общий `ProxyRouterService`. mu-plugin (`wpdock-livereload.php`) внедряет клиентский скрипт во все страницы WP, скрипт и SSE-поток `/__wpdock-livereload__/` идут по тому же origin что и сайт (нет mixed-content/CORS, переживает навигацию). chokidar следит за `wp-content`: `.css` → горячая подмена стилей без перезагрузки, `.js/.php/.html/.twig` → полная перезагрузка. Удалены зависимость `browser-sync`, копирование шаблонов в `build-extension.js`, каталог `templates/` и мёртвая настройка `wpdock.livePreviewPort`.
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
