<div align="center">

<img src="resources/icon.png" width="120" alt="WPDock" />

# WPDock

**Локальная разработка WordPress на Docker — прямо внутри VS Code.**

Создавайте локальные сайты в один клик, синхронизируйте файлы и базу с боевым сервером без FTP, работайте с Git и живым предпросмотром — не выходя из редактора.

![VS Code](https://img.shields.io/badge/VS%20Code-1.106%2B-007ACC?logo=visualstudiocode&logoColor=white)
![WordPress](https://img.shields.io/badge/WordPress-Docker-21759B?logo=wordpress&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-MySQL%208-2496ED?logo=docker&logoColor=white)
![License](https://img.shields.io/badge/license-MIT-green)

</div>

---

## Что это

WPDock — это встроенный в VS Code аналог LocalWP. Каждый сайт поднимается в изолированном Docker-окружении (MySQL 8 + WordPress/Apache + WP-CLI), а управление полностью живёт в боковой панели редактора. Отдельная панель «Текущий сайт» показывает настройки только того проекта, который открыт в рабочей области.

## Возможности

### 🐳 Локальная среда
- Создание сайта WordPress в один клик на Docker-окружении
- Выбор версии PHP, веб-сервера, локали и SSL при создании
- Красивые локальные адреса вида `site.local` без указания порта
- Старт/стоп/перезапуск, авто-восстановление зависших процессов
- Точный статус сайтов между несколькими окнами VS Code

### 🔄 Синхронизация с удалёнными сайтами (без FTP)
- Подключение боевого WordPress по Application Passwords
- Pull/Push файлов `wp-content` и базы данных через HTTP-агент
- Привязка нескольких удалённых сайтов к одному локальному проекту
- Управление каждым подключением: Pull, Push, открыть, отвязать
- История синхронизаций и сброс удалённого WP до заводских настроек
- **Отмена любой длительной операции** (Pull/Push/создание сайта) на лету

### ⚡ Live Preview
- Горячая перезагрузка через BrowserSync + chokidar

### 🔧 Git и деплой
- Инициализация репозитория и привязка GitHub из панели
- Генератор GitHub Actions для деплоя

### 💾 Бэкапы
- Локальные ZIP-бэкапы и выгрузка в облако (Yandex Disk / Google Drive)
- Экспорт и импорт сайта одним архивом

## Установка

### Из VSIX

```powershell
code --install-extension wpdock-0.1.0.vsix
```

### Для разработки

```bash
npm install          # ставит зависимости расширения и webview-ui
npm run compile      # сборка TypeScript + React webview
```

Затем `F5` в VS Code — откроется Extension Development Host.

### Сборка и установка одной командой

```powershell
npm run deploy:local
```

## Команды npm

| Команда | Назначение |
| --- | --- |
| `npm run compile` | Сборка расширения и webview |
| `npm run deploy:local` | Полный build → VSIX → установка в VS Code |
| `npm run pack-agent` | Упаковка PHP-агента в ZIP |
| `npm run watch` | Watch-режим TypeScript |
| `npm run watch:webview` | Dev-сервер Vite для webview |

## Как работает удалённая синхронизация

1. Подключение проверяет WP REST API с Application Password.
2. На сервер ставится лёгкий плагин-агент (`wpdock-agent`) — без FTP и SSH.
3. Агент регистрирует токен и упаковывает `wp-content` + дамп БД в ZIP.
4. **Pull** — архив скачивается и распаковывается в локальный сайт.
5. **Push** — локальный `wp-content` загружается, агент распаковывает его на сервере.

### Безопасность агента

- Токен = `SHA256(Application Password)`, хранится в transient WordPress (1 час).
- Временные файлы лежат в `wp-content/wpdock-temp/` под защитой `.htaccess`.
- Cron очищает временные файлы каждый час.

## Технологии

- **Расширение**: TypeScript + VS Code API
- **UI**: React 18 + Vite (WebView-панель)
- **Окружение**: docker-compose на сайт (MySQL 8 + WordPress/Apache + WP-CLI)
- **Удалённая синхронизация**: PHP-агент по HTTP (ZIP + mysqldump)
- **Live Preview**: BrowserSync + chokidar
- **Git**: simple-git + генератор GitHub Actions

## Требования

- Docker Desktop
- VS Code 1.106+

## Лицензия

[MIT](LICENSE) © C0dece
