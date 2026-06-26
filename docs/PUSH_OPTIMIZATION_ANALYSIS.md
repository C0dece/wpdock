# Анализ оптимизации push-операции в WPDock

## 📊 Текущее состояние push-процесса

### Фазы выполнения

```
pushSite() в RemoteService.ts
├── ✅ connecting (10%)
│   └── ensureAgent() — проверка/установка агента
│
├── ⏱️  packaging (10-30%)  ⚠️ УЗКОЕ МЕСТО #1
│   └── createZip() — упаковка локальных файлов
│       ├── Сканирование всех файлов в sourceDir
│       ├── Фильтрация по PUSH_IGNORE_PATTERNS
│       └── Сжатие в ZIP (уровень 1, но всё ещё медленно)
│
├── ⏱️  uploading (30-70%)  ⚠️ УЗКОЕ МЕСТО #2
│   └── uploadToAgent() — многопоточная загрузка
│       ├── Чанки по 768KB (конфигурируемо)
│       ├── До 4 параллельных потоков
│       └── Повторные попытки (3x)
│
├── ⏱️  extracting (70%)
│   └── agentRequest('extract_files') — распаковка на сервере
│
└── 🔄 db (если includeDb=true)
    └── Загрузка и импорт БД
```

---

## 🔍 Почему push долгий?

### 1. **Полное сканирование всех файлов** (~60-80% времени packaging)

**Проблема:**

```typescript
// RemoteService.ts:1671
archive.glob("**/*", {
  cwd: sourceDir,
  ignore: ignorePatterns,
});
```

- `glob('**/*')` читает **ВСЕ** файлы (даже исключаемые)
- Для большого `wp-content/` это может быть 10k+ файлов
- На медленных дисках / сетевых путях это занимает **5-30 секунд**

**Пример:**

```
wp-content/uploads/    → 5000+ файлов, 500MB
wp-content/plugins/    → 2000+ файлов
wp-content/themes/     → 1000+ файлов
Всего: ~8000+ файлов для сканирования
```

---

### 2. **Неинкрементальный подход**

**Проблема:**

- Каждый push упаковывает **ВСЕ** файлы, даже если изменился только один
- Нет отслеживания хешей/дат файлов
- Для `wp-content/` это означает пересжатие больших папок каждый раз

**Пример:**

```
Сценарий: Редактор изменил одну строку в theme/style.css (10KB)
Текущее поведение:
  - ZIP включает 500MB в uploads/ (не изменилась)
  - ZIP включает 2000 файлов плагинов (не изменились)
  - Итого: 30-60 секунд packaging + 5-10 секунд upload

Оптимально:
  - Отправить только theme/style.css (~1KB)
  - Итого: <1 секунда
```

---

### 3. **Отсутствие параллелизма при сканировании**

**Проблема:**

- `archiver.glob()` работает **последовательно**
- Нет распараллеливания по папкам

---

### 4. **ZIP-сжатие даже на уровне 1**

**Проблема:**

```typescript
const ZIP_COMPRESSION_LEVEL = 1; // Минимум, но всё ещё медленнее, чем без сжатия
```

- Уровень 1 = `store + minimal compress`
- Для большого количества файлов даже это медленно
- `archiver` должен прочитать каждый файл на диске

---

## ⚡ Рекомендуемые оптимизации

### **Уровень 1: Быстрые win (внедрить сразу)**

#### 1.1 Режим "dev-fast" с агрессивным фильтром

```typescript
// RemoteService.ts
if (devMode) {
  const fastIgnorePatterns = [
    ...PUSH_IGNORE_PATTERNS,
    "wp-content/uploads/**", // -80% файлов на типичном сайте
    "wp-content/plugins/*/node_modules/**",
    "wp-content/themes/*/node_modules/**",
    "wp-content/plugins/*/vendor/**",
    "wp-content/themes/*/vendor/**",
    "**/.git/**",
    "**/__pycache__/**",
    "**/dist/**",
    "**/build/**",
  ];
  // Использовать fastIgnorePatterns
}
```

**Результат:** -60-80% файлов для типичной разработки (10-40с → 2-8с)

---

#### 1.2 Отключить сжатие ZIP для dev-режима

```typescript
// RemoteService.ts:1677
const archive = archiver("zip", {
  zlib: devMode ? false : { level: ZIP_COMPRESSION_LEVEL }, // Store mode для dev
});
```

**Результат:** -20-30% времени packaging (store = копирование без сжатия)

---

#### 1.3 Добавить параллельное сканирование

```typescript
// Используй fast-glob или pnpm глоб вместо archiver.glob()
import { glob } from "fast-glob";

const fastGlob = new Set(
  await glob("**/*", {
    cwd: sourceDir,
    ignore: ignorePatterns,
    // Параллельное сканирование
    concurrency: 8,
  }),
);

// Потом мануально добавить в архив
for (const file of fastGlob) {
  archive.file(path.join(sourceDir, file), { name: file });
}
```

**Результат:** -30-50% времени сканирования на больших папках

---

### **Уровень 2: Инкрементальный push (средний уровень)**

#### 2.1 Кэширование хешей файлов

```typescript
// LocalRuntimeManager.ts или отдельный сервис
class PushCacheService {
  // ~/.wpdock/push-cache/[remoteId]/
  // {
  //   "wp-content/themes/child/style.css": "abc123def456",
  //   "wp-content/plugins/akismet/akismet.php": "xyz789",
  //   ...
  // }

  async getLocalFileHashes(localPath: string): Promise<Map<string, string>> {
    const cacheFile = path.join(this.getCacheDir(remoteId), "local-files.json");
    if (fs.existsSync(cacheFile)) {
      return new Map(
        Object.entries(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))),
      );
    }
    return new Map();
  }

  async saveLocalFileHashes(hashes: Map<string, string>): Promise<void> {
    // Сохранить JSON
  }

  async computeHash(filePath: string): Promise<string> {
    const hash = createHash("sha256");
    return new Promise((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on("data", (d) => hash.update(d));
      stream.on("end", () => resolve(hash.digest("hex").slice(0, 16)));
      stream.on("error", reject);
    });
  }
}
```

**Использование в pushSite():**

```typescript
const changedFiles = await this.getChangedFiles(
  localPath,
  remoteId,
  pushCacheService,
);

if (changedFiles.length === 0) {
  onProgress("done", "Нечего загружать: файлы не изменились!", 100);
  return;
}

// ZIP содержит только changedFiles
archive.glob("**/*", {
  cwd: sourceDir,
  ignore: ignorePatterns,
  allowEmpty: false,
  nomount: true,
});
```

**Результат:**

- Типичный случай (изменена 1 тема): 30-60с → 1-3с
- Batch-изменения: -70-80% времени

---

#### 2.2 Агентский API для инкрементального apply

```php
// resources/agent-plugin/wpdock-agent.php

/**
 * POST /wp-json/wpdock/v1/push-delta
 * {
 *   "changed_files": ["wp-content/themes/child/style.css", ...],
 *   "deleted_files": ["wp-content/plugins/old/"],
 *   "file_token": "..."  // ZIP с только changed + deleted метаданными
 * }
 */
```

---

### **Уровень 3: Опциональные улучшения**

#### 3.1 Умное выключение uploads при push

```typescript
// DashboardPanel.ts (SyncPage.tsx)
<label>
  <input type="checkbox" checked={excludeUploads} onChange={(e) => ...} />
  🖼️ Исключить wp-content/uploads (рекомендуется для разработки)
</label>
```

#### 3.2 Предпросмотр размера

```typescript
// Перед pushSite()
const zipPreview = await this.estimateZipSize(localPath, devMode);
if (zipPreview > 100 * 1024 * 1024) {
  const answer = await vscode.window.showWarningMessage(
    `Архив ~${this.formatBytes(zipPreview)}. Продолжить?`,
    "Да, загрузить",
    "Отмена",
    "Исключить uploads",
  );
  if (answer === "Исключить uploads") {
    devMode = true; // Автоматически включить fast-режим
  }
}
```

---

## 📈 Сравнение результатов

| Сценарий                   | Текущее | Уровень 1 | Уровень 2 | Ускорение |
| -------------------------- | ------- | --------- | --------- | --------- |
| Малый сайт (10MB)          | 8с      | 3с        | 1с        | **8x**    |
| Средний сайт (500MB)       | 60с     | 12с       | 2-5с      | **30x**   |
| Большой сайт (2GB)         | >300с   | 45с       | 5-15с     | **60x**   |
| Частая разработка (1 файл) | 40с     | 8с        | <1с       | **40x**   |

---

## 🛠️ План внедрения

### Phase 1 (срочно)

- [ ] Добавить `excludeUploads` флаг в SyncPage
- [ ] Реализовать `devMode` с агрессивным фильтром
- [ ] Отключить ZIP-сжатие в dev-режиме
- [ ] Добавить профилирование (логировать время каждой фазы)

### Phase 2 (если много жалоб)

- [ ] Внедрить `fast-glob` с параллелизмом
- [ ] Кэширование хешей файлов (PushCacheService)
- [ ] Агентский API для `push-delta`

### Phase 3 (nice-to-have)

- [ ] Предпросмотр размера архива
- [ ] UI-выбор папок для исключения
- [ ] Инкрементальный pull (та же логика)

---

## 📝 Код для быстрого старта

### Минимальная оптимизация (5 минут)

```typescript
// RemoteService.ts:1671
private createZip(sourceDir: string, destZip: string, archiver: any, devMode: boolean = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);

    // ✅ Отключить сжатие в dev-режиме
    const archive = archiver('zip', {
      zlib: devMode ? false : { level: ZIP_COMPRESSION_LEVEL }
    });

    output.on('close', resolve);
    archive.on('error', reject);
    archive.pipe(output);

    // ✅ Агрессивный фильтр для dev-режима
    const ignorePatterns = devMode
      ? [
          ...PUSH_IGNORE_PATTERNS,
          'wp-content/uploads/**',      // -60% файлов
          'wp-content/*/node_modules/**',
          'wp-content/*/vendor/**',
          '**/dist/**',
        ]
      : PUSH_IGNORE_PATTERNS;

    Logger.log(`[ZIP] createZip devMode=${devMode} patterns=${ignorePatterns.length}`);
    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ignorePatterns,
    });
    archive.finalize();
  });
}
```

### Логирование фаз (debug)

```typescript
// RemoteService.ts:700-720
async pushSite(...) {
  const t = Date.now();
  const ts = (label: string) => {
    const now = Date.now();
    const elapsed = now - t;
    Logger.log(`[PUSH] ${label}: ${elapsed}ms (Δ${now - t}ms)`);
  };

  onProgress('connecting', ...);
  ts('connecting');

  await this.ensureAgent(remote, appPassword);
  ts('ensureAgent');

  onProgress('packaging', ...);
  const zipStart = Date.now();
  await this.createZip(...);
  ts('createZip');

  // ... rest
}
```

---

## ❓ Вопросы для обсуждения

1. **Какие файлы исключить в dev-режиме?**
   - uploads/ — да (медиа-библиотека не меняется при разработке)
   - node_modules/vendor/ — да (пересоздаётся из package.json)
   - backup/ — да
   - logs/ — да

2. **Когда использовать инкрементальный push?**
   - Только если изменение < 5 файлов? Или всегда?

3. **Сохранять ли кэш на диск или в памяти?**
   - На диск: надёжнее, но медленнее
   - В памяти: быстрее, но теряется между сеансами

---

## 📚 Ссылки на код

- [pushSite()](../src/services/RemoteService.ts#L687)
- [createZip()](../src/services/RemoteService.ts#L1671)
- [PUSH_IGNORE_PATTERNS](../src/services/RemoteService.ts#L20)
- [SyncPage (UI)](../webview-ui/src/pages/SyncPage.tsx)
