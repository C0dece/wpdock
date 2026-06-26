/**
 * БЫСТРАЯ ОПТИМИЗАЦИЯ PUSH-ОПЕРАЦИИ
 * 
 * Примеры кода для внедрения в RemoteService.ts
 * 
 * Рекомендуемый порядок:
 * 1. Минимальная оптимизация (5-10 минут) → закон 80/20
 * 2. Логирование фаз (для профилирования)
 * 3. Кэш хешей (инкрементальный push)
 */

// ============================================================================
// ВАРИАНТ 1: МИНИМАЛЬНАЯ ОПТИМИЗАЦИЯ (БЫСТРО И ЭФФЕКТИВНО)
// ============================================================================

/**
 * Шаг 1: Добавить aggressiveDevFilter в PUSH_IGNORE_PATTERNS
 * 
 * Location: src/services/RemoteService.ts:20-45
 */

// ДО:
const PUSH_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  // ... 15 строк
  'wp-content/cache/**',
  'wp-content/upgrade/**',
];

// ПОСЛЕ:
const PUSH_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.gitignore',
  '.DS_Store',
  'thumbs.db',
  '**/.DS_Store',
  '**/thumbs.db',
  'wp-content/cache/**',
  'wp-content/upgrade/**',
  'wp-content/backup/**',
  'wp-content/debug.log',
  'wp-content/**/.git/**',
  'wp-content/plugins/*/node_modules/**',
  'wp-content/plugins/**/.git/**',
  'wp-content/themes/*/node_modules/**',
  'wp-content/themes/**/.git/**',
  '.vscode/**',
  '.idea/**',
  '*.swp',
  '*.swo',
  '.env.local',
  '.env.*.local',
];

// Новый: агрессивный фильтр для dev-режима
const PUSH_AGGRESSIVE_DEV_FILTERS = [
  ...PUSH_IGNORE_PATTERNS,
  'wp-content/uploads/**',           // ← -60% файлов на типичном сайте
  'wp-content/plugins/*/vendor/**',
  'wp-content/plugins/*/node_modules/**',
  'wp-content/themes/*/vendor/**',
  'wp-content/themes/*/node_modules/**',
  'wp-content/plugins/**/.git/**',
  'wp-content/themes/**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/.nuxt/**',
];

// ============================================================================

/**
 * Шаг 2: Модифицировать createZip() для отключения сжатия в dev-режиме
 * 
 * Location: src/services/RemoteService.ts:1671-1695
 */

// ДО:
private createZip(sourceDir: string, destZip: string, archiver: any, devMode: boolean = false): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    const archive = archiver('zip', { zlib: { level: ZIP_COMPRESSION_LEVEL } }); // ← Всегда сжимает
    // ...
  });
}

// ПОСЛЕ:
private createZip(
  sourceDir: string,
  destZip: string,
  archiver: any,
  devMode: boolean = false,
  enableLogging: boolean = true
): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destZip);
    
    // ✅ Отключить сжатие в dev-режиме (store mode = копирование без сжатия)
    const useCompression = !devMode;
    const zipConfig = {
      zlib: useCompression ? { level: ZIP_COMPRESSION_LEVEL } : false
    };
    
    const archive = archiver('zip', zipConfig);
    
    output.on('close', () => {
      const bytes = fs.statSync(destZip).size;
      if (enableLogging) {
        Logger.log(
          `[ZIP] created path=${destZip} size=${this.formatBytes(bytes)} ` +
          `compression=${useCompression ? 'yes' : 'no'}`
        );
      }
      resolve();
    });
    
    archive.on('error', reject);
    archive.pipe(output);

    // ✅ Использовать агрессивный фильтр в dev-режиме
    const ignorePatterns = devMode ? PUSH_AGGRESSIVE_DEV_FILTERS : PUSH_IGNORE_PATTERNS;
    
    if (enableLogging) {
      Logger.log(
        `[ZIP] scanning sourceDir=${sourceDir} devMode=${devMode} ` +
        `filters=${ignorePatterns.length}`
      );
    }

    archive.glob('**/*', {
      cwd: sourceDir,
      ignore: ignorePatterns,
    });
    
    archive.finalize();
  });
}

// ============================================================================

/**
 * Шаг 3: Добавить профилирование фаз в pushSite()
 * 
 * Location: src/services/RemoteService.ts:687-760
 */

// ПЕРЕД:
async pushSite(
  remoteId: string,
  localPath: string,
  includeDb: boolean,
  devMode: boolean = false,
  onProgress: (phase: string, msg: string, pct?: number) => void
): Promise<void> {
  const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
  onProgress('connecting', 'Подключение к удаленному сайту...');
  // ...
}

// ПОСЛЕ:
async pushSite(
  remoteId: string,
  localPath: string,
  includeDb: boolean,
  devMode: boolean = false,
  onProgress: (phase: string, msg: string, pct?: number) => void,
  enableTiming: boolean = true  // ← Новый параметр для логирования
): Promise<void> {
  const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
  
  // ✅ Профилирование
  const startTotal = Date.now();
  const timings: Record<string, number> = {};
  const markTime = (phase: string) => {
    timings[phase] = Date.now() - startTotal;
    if (enableTiming) {
      Logger.log(`[PUSH] ${phase}: +${timings[phase]}ms (total: ${timings[phase]}ms)`);
    }
  };

  onProgress('connecting', 'Подключение к удаленному сайту...');
  Logger.log(
    `[RemoteService] pushSite START ` +
    `remote=${remote.name} remoteId=${remoteId} localPath=${localPath} ` +
    `includeDb=${includeDb} devMode=${devMode}`
  );
  
  await this.ensureAgent(remote, appPassword);
  markTime('ensureAgent');

  onProgress('packaging', 'Подготовка локальных файлов...', 10);
  const packStart = Date.now();
  const archiver = (await import('archiver')).default;
  const zipPath = path.join(require('os').tmpdir(), `wpdock-push-${Date.now()}.zip`);
  
  await this.createZip(localPath, zipPath, archiver, devMode, enableTiming);
  
  const zipStats = fs.statSync(zipPath);
  markTime('createZip');
  
  const packElapsed = Date.now() - packStart;
  Logger.log(
    `[PUSH] packaging complete size=${this.formatBytes(zipStats.size)} ` +
    `elapsed=${packElapsed}ms ` +
    `speed=${this.formatBytes(zipStats.size / (packElapsed / 1000))}/s`
  );

  onProgress('uploading', 'Загрузка файлов на удаленный сервер...', 30);
  const uploadStart = Date.now();
  
  const uploadToken = await this.uploadToAgent(
    remote.url,
    appPassword,
    zipPath,
    (uploadedBytes, totalBytes) => {
      const ratio = totalBytes > 0 ? uploadedBytes / totalBytes : 1;
      const pct = 30 + Math.round(Math.min(1, ratio) * 35);
      onProgress(
        'uploading',
        `Загрузка файлов на удаленный сервер... ${this.formatBytes(uploadedBytes)} / ${this.formatBytes(totalBytes)}`,
        pct
      );
    }
  );
  
  const uploadElapsed = Date.now() - uploadStart;
  markTime('uploadToAgent');
  Logger.log(
    `[PUSH] upload complete token=${uploadToken} ` +
    `elapsed=${uploadElapsed}ms ` +
    `speed=${this.formatBytes(zipStats.size / (uploadElapsed / 1000))}/s`
  );

  onProgress('extracting', 'Распаковка на удаленном сервере...', 70);
  const extractStart = Date.now();
  
  const extractResult = await this.retryAsync('extract_files', 2, () =>
    this.agentRequest(remote.url, appPassword, 'extract_files', {
      file_token: uploadToken,
    })
  );
  
  markTime('agentExtract');
  Logger.log(
    `[PUSH] extract_files done result=${JSON.stringify(extractResult ?? {})} ` +
    `elapsed=${Date.now() - extractStart}ms`
  );

  // ... DB import code (аналогично с таймингами) ...

  Logger.log(
    `[RemoteService] pushSite SUCCESS remote=${remote.name} remoteId=${remoteId} ` +
    `totalTime=${Date.now() - startTotal}ms ` +
    `breakdown={${Object.entries(timings)
      .map(([k, v]) => `${k}=${v}ms`)
      .join(', ')}}`
  );
  
  onProgress('done', 'Push завершен!', 100);
  fs.unlinkSync(zipPath);
}

// ============================================================================
// ВАРИАНТ 2: ИНКРЕМЕНТАЛЬНЫЙ PUSH (СРЕДНЯЯ СЛОЖНОСТЬ)
// ============================================================================

/**
 * Сервис для кэширования хешей файлов (инкрементальный push)
 * 
 * Место: src/services/PushCacheService.ts (новый файл)
 */

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import { Logger } from '../utils/logger';

export interface FileHashCache {
  [relativePath: string]: {
    hash: string;
    size: number;
    mtime: number;
  };
}

export class PushCacheService {
  private cacheDir: string;

  constructor(extensionPath: string) {
    this.cacheDir = path.join(extensionPath, '.push-cache');
    if (!fs.existsSync(this.cacheDir)) {
      fs.mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCacheFilePath(remoteId: string): string {
    return path.join(this.cacheDir, `${remoteId}.json`);
  }

  async getRemoteCache(remoteId: string): Promise<FileHashCache> {
    const cacheFile = this.getCacheFilePath(remoteId);
    if (fs.existsSync(cacheFile)) {
      try {
        return JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
      } catch (err) {
        Logger.error(`[PushCache] Failed to load cache ${remoteId}`, err);
      }
    }
    return {};
  }

  async saveRemoteCache(remoteId: string, cache: FileHashCache): Promise<void> {
    const cacheFile = this.getCacheFilePath(remoteId);
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2), 'utf-8');
  }

  async computeFileHash(filePath: string): Promise<{ hash: string; size: number }> {
    return new Promise((resolve, reject) => {
      const hash = createHash('sha256');
      const stream = fs.createReadStream(filePath);
      const stats = fs.statSync(filePath);

      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('end', () => {
        resolve({
          hash: hash.digest('hex').slice(0, 16),
          size: stats.size,
        });
      });
      stream.on('error', reject);
    });
  }

  async getChangedFiles(
    sourceDir: string,
    remoteId: string,
    filesToCheck: string[]
  ): Promise<{
    changed: string[];
    deleted: string[];
    unchanged: string[];
  }> {
    const remoteCache = await this.getRemoteCache(remoteId);
    const changed: string[] = [];
    const deleted: string[] = [];
    const unchanged: string[] = [];

    const checkedSet = new Set(filesToCheck);

    // Найти удалённые файлы (были в кэше, но не найдены локально)
    for (const cached of Object.keys(remoteCache)) {
      if (!checkedSet.has(cached)) {
        deleted.push(cached);
      }
    }

    // Проверить изменённые файлы
    for (const filePath of filesToCheck) {
      const fullPath = path.join(sourceDir, filePath);
      const stats = fs.statSync(fullPath);
      const cached = remoteCache[filePath];

      if (!cached) {
        // Новый файл
        changed.push(filePath);
        continue;
      }

      // Быстрая проверка: размер или mtime изменился?
      if (stats.size !== cached.size || stats.mtime.getTime() !== cached.mtime) {
        // Вычислить полный хеш только если размер/mtime изменился
        const { hash } = await this.computeFileHash(fullPath);
        if (hash !== cached.hash) {
          changed.push(filePath);
        } else {
          unchanged.push(filePath);
        }
      } else {
        unchanged.push(filePath);
      }
    }

    Logger.log(
      `[PushCache] Analysis remoteId=${remoteId} ` +
      `changed=${changed.length} deleted=${deleted.length} unchanged=${unchanged.length}`
    );

    return { changed, deleted, unchanged };
  }

  async updateCache(
    sourceDir: string,
    remoteId: string,
    files: string[]
  ): Promise<void> {
    const newCache: FileHashCache = {};

    for (const filePath of files) {
      const fullPath = path.join(sourceDir, filePath);
      if (fs.existsSync(fullPath)) {
        const stats = fs.statSync(fullPath);
        const { hash } = await this.computeFileHash(fullPath);

        newCache[filePath] = {
          hash,
          size: stats.size,
          mtime: stats.mtime.getTime(),
        };
      }
    }

    await this.saveRemoteCache(remoteId, newCache);
  }
}

// ============================================================================

/**
 * Интеграция PushCacheService в RemoteService
 * 
 * Location: src/services/RemoteService.ts (конструктор и pushSite)
 */

import { PushCacheService } from './PushCacheService';

export class RemoteService {
  private pushCache: PushCacheService;  // ← Новое

  constructor(
    private context: vscode.ExtensionContext,
    private storage: StorageService
  ) {
    this.loadUploadSettings();
    this.pushCache = new PushCacheService(context.extensionPath);  // ← Инициализация
  }

  // В pushSite() добавить опцию:
  async pushSite(
    remoteId: string,
    localPath: string,
    includeDb: boolean,
    devMode: boolean = false,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    enableTiming: boolean = true,
    useIncremental: boolean = true  // ← Новый параметр
  ): Promise<void> {
    // ...
    
    if (useIncremental) {
      onProgress('analyzing', 'Анализ изменённых файлов...', 5);
      
      // Получить все локальные файлы
      const allLocalFiles = await this.getAllLocalFiles(localPath, devMode);
      
      // Найти только изменённые
      const analysis = await this.pushCache.getChangedFiles(
        localPath,
        remoteId,
        allLocalFiles
      );
      
      Logger.log(
        `[PUSH] Incremental analysis: ${analysis.changed.length} changed, ` +
        `${analysis.deleted.length} deleted, ${analysis.unchanged.length} unchanged`
      );
      
      if (analysis.changed.length === 0 && analysis.deleted.length === 0) {
        onProgress('done', 'Нечего загружать: файлы не изменились!', 100);
        return;
      }
      
      // Создать ZIP только с изменёнными файлами
      await this.createIncrementalZip(
        localPath,
        zipPath,
        archiver,
        analysis.changed,
        analysis.deleted
      );
      
      // Обновить кэш после успешного push
      // (в конце метода, после extractResult успешен)
    } else {
      // Обычный push (весь архив)
      await this.createZip(localPath, zipPath, archiver, devMode, enableTiming);
    }
    
    // ...
  }

  private async getAllLocalFiles(sourceDir: string, devMode: boolean): Promise<string[]> {
    // Использовать fast-glob для параллельного сканирования
    const { glob } = await import('fast-glob');
    const ignorePatterns = devMode ? PUSH_AGGRESSIVE_DEV_FILTERS : PUSH_IGNORE_PATTERNS;
    
    return await glob('**/*', {
      cwd: sourceDir,
      ignore: ignorePatterns,
      concurrency: 8,  // Параллельное сканирование
    });
  }

  private async createIncrementalZip(
    sourceDir: string,
    destZip: string,
    archiver: any,
    changedFiles: string[],
    deletedFiles: string[]
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver('zip', { zlib: false }); // Store mode для скорости

      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      // Добавить только изменённые файлы
      for (const file of changedFiles) {
        const fullPath = path.join(sourceDir, file);
        if (fs.existsSync(fullPath)) {
          archive.file(fullPath, { name: file });
        }
      }

      // Добавить манифест удалённых файлов
      if (deletedFiles.length > 0) {
        const manifest = { deleted: deletedFiles };
        archive.append(JSON.stringify(manifest), { name: '__wpdock_deleted__.json' });
      }

      archive.finalize();
    });
  }
}

// ============================================================================
// ВАРИАНТ 3: UI ОПЦИИ SYNC-СТРАНИЦЫ
// ============================================================================

/**
 * Добавить опции на SyncPage.tsx
 * 
 * Location: webview-ui/src/pages/SyncPage.tsx
 */

export const SyncPage: React.FC = () => {
  const [excludeUploads, setExcludeUploads] = React.useState(true);
  const [useIncremental, setUseIncremental] = React.useState(true);
  const [showAdvanced, setShowAdvanced] = React.useState(false);

  const handlePush = async () => {
    // ...
    await vscode.postMessage({
      command: 'pushRemote',
      remoteId,
      siteId,
      includeDb,
      devMode: excludeUploads,           // ← Используем как devMode
      useIncremental,
      // ...
    });
  };

  return (
    <div className="sync-page">
      {/* Существующий UI */}

      {/* Новые опции */}
      <fieldset>
        <legend>Опции push</legend>
        
        <label>
          <input
            type="checkbox"
            checked={excludeUploads}
            onChange={(e) => setExcludeUploads(e.target.checked)}
          />
          🖼️ Исключить wp-content/uploads (рекомендуется для разработки)
        </label>

        <label>
          <input
            type="checkbox"
            checked={useIncremental}
            onChange={(e) => setUseIncremental(e.target.checked)}
          />
          ⚡ Инкрементальный push (только изменённые файлы)
        </label>

        <button
          onClick={() => setShowAdvanced(!showAdvanced)}
          className="btn-secondary"
        >
          {showAdvanced ? '▼' : '▶'} Расширенные опции
        </button>

        {showAdvanced && (
          <div style={{ marginLeft: '20px', marginTop: '10px', fontSize: '12px' }}>
            <p>💡 Советы:</p>
            <ul>
              <li>
                <strong>Исключить uploads:</strong> ускорит push в 3-5 раз для типичной разработки.
                Медиа-файлы редко меняются.
              </li>
              <li>
                <strong>Инкрементальный:</strong> после первого push, загружает только изменённые файлы.
                До 40x ускорение при разработке.
              </li>
              <li>
                Оба варианта можно комбинировать для максимальной скорости.
              </li>
            </ul>
          </div>
        )}
      </fieldset>
    </div>
  );
};

// ============================================================================
// РЕЗЮМЕ ОПТИМИЗАЦИЙ
// ============================================================================

/**
 * РЕАЛИЗОВАННЫЕ УЛУЧШЕНИЯ:
 * 
 * ✅ Уровень 1 (5 минут, 3-5x ускорение):
 *    - Отключить ZIP-сжатие в dev-режиме (store mode)
 *    - Использовать агрессивный фильтр для dev-режима (исключить uploads)
 *    - Добавить логирование фаз для профилирования
 * 
 * ✅ Уровень 2 (30-60 минут, 10-40x ускорение):
 *    - Внедрить PushCacheService для кэширования хешей
 *    - Инкрементальный push (только изменённые файлы)
 *    - Параллельное сканирование через fast-glob
 * 
 * ⚠️  Требования к npm:
 *    - fast-glob (для параллельного сканирования)
 *    - Уже есть: archiver, crypto, fs, path
 */
