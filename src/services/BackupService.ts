import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';
import { v4 as uuidv4 } from 'uuid';
import archiver from 'archiver';
import { unzip } from '../utils/zipUtils';
import { WPSite, BackupEntry, BackupConfig, SiteCreateOptions } from '../types';
import { StorageService } from './StorageService';
import { LocalRuntimeManager } from './LocalRuntimeManager';
import { SiteManager } from './SiteManager';
import { Logger } from '../utils/logger';

export interface ZipAnalysis {
  zipPath: string;
  detectedName: string;
  phpVersion: string;
  hasDb: boolean;
  dbFileName: string;
  tablePrefix: string;
  hasWpContent: boolean;
  wpContentPath: string;
  /** Non-empty if the archive looks like it came from a known backup plugin */
  backupPlugin: string;
}

export class BackupService {
  /** Cached temp dir from the last analyzeZip call — reused by importFromZip */
  private _analyzeCache: { zipPath: string; tempDir: string } | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    private storage: StorageService,
    private runtime: LocalRuntimeManager,
    private siteManager: SiteManager
  ) {}

  /**
   * Extract the ZIP to a temp dir, detect site name / PHP / DB presence.
   * The temp dir is cached and reused automatically on the next importFromZip call.
   */
  async analyzeZip(zipPath: string, onProgress?: (msg: string) => void): Promise<ZipAnalysis> {
    // Clean up any previous cache
    if (this._analyzeCache) {
      try { fs.rmSync(this._analyzeCache.tempDir, { recursive: true, force: true }); } catch {}
      this._analyzeCache = null;
    }

    onProgress?.('Анализ архива...');
    const tempDir = path.join(this.storage.getBackupsDirectory(), '_analyze_' + uuidv4());
    fs.mkdirSync(tempDir, { recursive: true });

    await unzip(zipPath, tempDir);

    // Detect backup plugin — wpdock-meta.json теперь лежит вложенно
    // ({проект}/wpdock-meta.json), поэтому ищем рекурсивно.
    const wpdockMetaPath = this.findFileDeep(tempDir, 'wpdock-meta.json', 3);
    let backupPlugin = '';
    if (wpdockMetaPath) {backupPlugin = 'wpdock';}
    else if (this.findFileByPattern(tempDir, /^backup_.*\.php$/i)) {backupPlugin = 'duplicator';}
    else if (this.findFileByPattern(tempDir, /\.wpress$/i)) {backupPlugin = 'ai1wm';}
    else if (this.findFileByPattern(tempDir, /^updraft/i)) {backupPlugin = 'updraftplus';}

    // Site name
    let detectedName = path.basename(zipPath, '.zip').replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();
    let phpVersion = '8.2';
    let tablePrefix = 'wp_';
    let wpContentPath = '';

    // WPDock meta
    const metaPath = wpdockMetaPath;
    if (metaPath && fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        if (meta.siteName) {detectedName = meta.siteName;}
        if (meta.phpVersion) {phpVersion = meta.phpVersion;}
      } catch {}
    }

    // wp-config.php — detect table prefix
    const wpConfigPath = this.findFileDeep(tempDir, 'wp-config.php', 3);
    if (wpConfigPath) {
      try {
        const cfg = fs.readFileSync(wpConfigPath, 'utf8');
        const prefixMatch = cfg.match(/\$table_prefix\s*=\s*['"]([^'"]+)['"]/);
        if (prefixMatch) {tablePrefix = prefixMatch[1];}
        const phpMatch = cfg.match(/PHP\s*([578]\.\d)/i);
        if (phpMatch) {phpVersion = phpMatch[1];}
      } catch {}
    }

    const wpContentSrc = this.findWpContent(tempDir);
    if (wpContentSrc) {
      wpContentPath = path.relative(tempDir, wpContentSrc) || 'wp-content';
      onProgress?.(`wp-content найден: ${wpContentPath}`);
    } else {
      onProgress?.('wp-content в архиве не найден.');
    }

    // Find DB dump
    const dbSqlPath = this.findDbSqlRecursive(tempDir);
    let dbFileName = '';
    if (dbSqlPath) {
      dbFileName = path.relative(tempDir, dbSqlPath);
      onProgress?.(`База данных найдена: ${dbFileName}`);
    } else {
      onProgress?.('База данных в архиве не найдена.');
    }

    // Detect table prefix from SQL if not found in wp-config
    if (dbSqlPath && tablePrefix === 'wp_') {
      const detected = this.detectTablePrefixFromSql(dbSqlPath);
      if (detected) {tablePrefix = detected;}
    }

    this._analyzeCache = { zipPath, tempDir };
    onProgress?.('Анализ завершён.');

    return {
      zipPath,
      detectedName,
      phpVersion,
      hasDb: !!dbSqlPath,
      dbFileName,
      tablePrefix,
      hasWpContent: !!wpContentSrc,
      wpContentPath,
      backupPlugin,
    };
  }

  /** Discard the cached temp dir (call on user cancel). */
  clearAnalyzeCache(): void {
    if (this._analyzeCache) {
      try { fs.rmSync(this._analyzeCache.tempDir, { recursive: true, force: true }); } catch {}
      this._analyzeCache = null;
    }
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Create a local backup (ZIP with wp-content + optional DB dump).
   */
  async backupSite(
    siteId: string,
    includeDb = true,
    onProgress?: (msg: string) => void
  ): Promise<BackupEntry> {
    const site = this.siteManager.getSite(siteId);
    if (!site) {throw new Error(`Site ${siteId} not found`);}

    // Папка бэкапов по имени проекта (а не по UUID) — так понятнее на диске.
    const backupsDir = path.join(this.storage.getBackupsDirectory(), this.slugify(site.name) || site.id);
    if (!fs.existsSync(backupsDir)) {
      fs.mkdirSync(backupsDir, { recursive: true });
    }

    const ts = new Date().toISOString().replace(/[:.]/g, '-');
    const backupId = uuidv4();
    const zipName = `${this.slugify(site.name)}-${ts}.zip`;
    const zipPath = path.join(backupsDir, zipName);

    onProgress?.('Preparing backup...');

    // Дамп БД и упаковка wp-content идут параллельно: mysqldump работает, пока
    // archiver уже стримит файлы. db.sql добавляется в архив, когда дамп готов.
    let dbSqlPath: string | null = null;
    const dbDumpPromise: Promise<string | null> = includeDb
      ? (async () => {
          onProgress?.('Dumping database...');
          try {
            const p = await this.dumpDatabase(site);
            onProgress?.('Database dump done.');
            return p;
          } catch (e: any) {
            onProgress?.(`Warning: DB dump failed (${e.message}). Backup will not include DB.`);
            includeDb = false;
            return null;
          }
        })()
      : Promise.resolve(null);

    onProgress?.('Packaging files...');
    dbSqlPath = await this.createZip(site, zipPath, dbDumpPromise);

    // Cleanup temp db dump
    if (dbSqlPath && fs.existsSync(dbSqlPath)) {
      fs.unlinkSync(dbSqlPath);
    }

    const stat = fs.statSync(zipPath);
    const entry: BackupEntry = {
      id: backupId,
      siteId: site.id,
      siteName: site.name,
      createdAt: new Date().toISOString(),
      size: stat.size,
      localPath: zipPath,
      includesDb: includeDb,
      source: 'local',
      backupKind: 'site-backup',
      cloudUploads: [],
    };

    this.storage.saveBackup(entry);
    this.pruneOldBackups(site.id);

    onProgress?.('Backup complete!');
    return entry;
  }

  /**
   * Export site to a user-chosen location (opens save dialog).
   */
  async exportSite(
    siteId: string,
    targetPath?: string,
    onProgress?: (msg: string) => void
  ): Promise<string> {
    const entry = await this.backupSite(siteId, true, onProgress);

    if (!targetPath) {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(
          path.join(
            process.env.USERPROFILE || process.env.HOME || '',
            'Desktop',
            path.basename(entry.localPath)
          )
        ),
        filters: { 'ZIP Archive': ['zip'] },
        saveLabel: 'Export Site',
      });
      if (!uri) {throw new Error('Export cancelled');}
      targetPath = uri.fsPath;
    }

    fs.copyFileSync(entry.localPath, targetPath);
    onProgress?.(`Exported to: ${targetPath}`);
    return targetPath;
  }

  /**
   * Import a site from a ZIP file (WPDock export or standard WP backup).
   * Returns the newly created WPSite.
   */
  async importFromZip(
    zipPath: string,
    options: SiteCreateOptions,
    onProgress?: (msg: string) => void
  ): Promise<WPSite> {
    // Reuse pre-extracted temp dir from analyzeZip if available for the same ZIP
    let tempDir: string;
    let ownTempDir = false;

    if (this._analyzeCache && this._analyzeCache.zipPath === zipPath) {
      tempDir = this._analyzeCache.tempDir;
      this._analyzeCache = null; // ownership transferred
    } else {
      onProgress?.('Извлечение архива...');
      tempDir = path.join(this.storage.getBackupsDirectory(), '_import_' + uuidv4());
      fs.mkdirSync(tempDir, { recursive: true });
      await unzip(zipPath, tempDir);
      ownTempDir = true;
    }

    try {
      onProgress?.('Создание сайта...');
      const site = await this.siteManager.createSite(options, (msg) => onProgress?.(msg));

      // Detect structure
      const wpContentSrc = this.findWpContent(tempDir);
      const dbSqlSrc = this.findDbSqlRecursive(tempDir);

      if (wpContentSrc) {
        onProgress?.('Восстановление файлов wp-content...');
        const dest = this.ensurePublicWpContentDirectory(site);
        this.copyDirectoryContents(wpContentSrc, dest);
        this.patchWpConfigContentDir(site);
        onProgress?.(`wp-content восстановлен из: ${path.relative(tempDir, wpContentSrc) || 'wp-content'}`);
      } else {
        onProgress?.('Предупреждение: wp-content не найден в архиве.');
      }

      if (dbSqlSrc) {
        onProgress?.('Восстановление базы данных...');
        try {
          // Detect table prefix in dump and patch wp-config.php accordingly
          const detectedPrefix = this.detectTablePrefixFromSql(dbSqlSrc);
          if (detectedPrefix) {
            onProgress?.(`Обнаружен table_prefix: ${detectedPrefix}`);
            this.patchWpConfigTablePrefix(site, detectedPrefix, onProgress);
          }

          await this.restoreDatabase(site, dbSqlSrc);
          onProgress?.('База данных восстановлена. Обновление URL...');
          await this.syncImportedSiteUrl(site, onProgress);
          await this.ensureImportedAdminPassword(site, options, onProgress);
          await this.runImportedSiteSanityChecks(site, onProgress);
          onProgress?.('URL обновлены.');
        } catch (e: any) {
          const targetSql = path.join(site.path, 'import.sql');
          fs.copyFileSync(dbSqlSrc, targetSql);
          onProgress?.(`Предупреждение: ошибка восстановления БД (${e.message}). SQL сохранён: ${targetSql}`);
        }
      } else {
        onProgress?.('База данных в архиве не найдена — сайт запущен с чистой установкой.');
      }

      return site;
    } finally {
      if (fs.existsSync(tempDir) && (ownTempDir || !this._analyzeCache)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  /**
   * Restore files from an existing local backup to a site.
   */
  async restoreBackup(
    backupId: string,
    siteId: string,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const backup = this.storage.getBackups().find((b) => b.id === backupId);
    if (!backup) {throw new Error('Backup not found');}
    if (!fs.existsSync(backup.localPath)) {throw new Error('Backup file is missing on disk');}

    const site = this.siteManager.getSite(siteId);
    if (!site) {throw new Error('Site not found');}

    onProgress?.('Extracting backup...');
    const tempDir = path.join(this.storage.getBackupsDirectory(), '_restore_' + uuidv4());

    try {
      fs.mkdirSync(tempDir, { recursive: true });
      await unzip(backup.localPath, tempDir);

      const wpContentSrc = this.findWpContent(tempDir);
      if (wpContentSrc) {
        onProgress?.('Restoring wp-content...');
        const dest = this.ensurePublicWpContentDirectory(site);
        this.copyDirectoryContents(wpContentSrc, dest);
        this.patchWpConfigContentDir(site);
      }

      const dbSqlSrc = this.findDbSqlRecursive(tempDir);
      if (dbSqlSrc && backup.includesDb) {
        onProgress?.('Restoring database...');
        try {
          await this.restoreDatabase(site, dbSqlSrc);
          onProgress?.('Database restored.');
        } catch (e: any) {
          onProgress?.(`Warning: DB restore failed: ${e.message}`);
          const targetSql = path.join(site.path, 'restored.sql');
          fs.copyFileSync(dbSqlSrc, targetSql);
          onProgress?.(`DB dump saved to ${targetSql} for manual restore.`);
        }
      }

      onProgress?.('Restore complete!');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  }

  getBackups(siteId?: string): BackupEntry[] {
    const backups = this.storage.getBackups(siteId);
    const missing = backups.filter((backup) => !backup.localPath || !fs.existsSync(backup.localPath));
    if (missing.length > 0) {
      for (const backup of missing) {
        this.storage.deleteBackup(backup.id);
      }
    }
    return this.storage.getBackups(siteId);
  }

  deleteBackup(backupId: string): void {
    const backup = this.storage.getBackups().find((b) => b.id === backupId);
    if (backup && fs.existsSync(backup.localPath)) {
      fs.unlinkSync(backup.localPath);
    }
    this.storage.deleteBackup(backupId);
  }

  getBackup(backupId: string): BackupEntry | undefined {
    return this.storage.getBackups().find((b) => b.id === backupId);
  }

  /** Удаляет ссылку на облачную копию из записи бэкапа (после удаления в облаке). */
  removeCloudUpload(backupId: string, provider: string, remotePath: string): BackupEntry | undefined {
    const backup = this.storage.getBackups().find((b) => b.id === backupId);
    if (!backup) {return undefined;}
    backup.cloudUploads = (backup.cloudUploads ?? []).filter(
      (u) => !(u.provider === provider && u.remotePath === remotePath)
    );
    this.storage.saveBackup(backup);
    return backup;
  }

  getBackupConfig(): BackupConfig {
    return this.storage.getBackupConfig();
  }

  saveBackupConfig(config: BackupConfig): void {
    this.storage.saveBackupConfig(config);
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private async dumpDatabase(site: WPSite): Promise<string> {
    if (!site.dbName) {throw new Error(`Site ${site.name} has no dbName — cannot dump database.`);}

    // Для дампа нужен только общий сервер MariaDB (порт 33061), а не запущенный
    // PHP-сайт. Поднимаем сервер БД, если он ещё не запущен, иначе mariadb-dump
    // падает с "2002 Can't connect to server on 127.0.0.1".
    await this.runtime.startDatabase();

    const dumpPath = path.join(this.storage.getBackupsDirectory(), `_db_${uuidv4()}.sql`);
    await this.runtime.dumpDatabase(site.dbName, dumpPath);
    return dumpPath;
  }

  private async restoreDatabase(site: WPSite, sqlPath: string): Promise<void> {
    if (!site.dbName) {throw new Error(`Site ${site.name} has no dbName — cannot restore database.`);}
    await this.runtime.startDatabase();
    await this.runtime.restoreDatabase(site.dbName, sqlPath);
  }

  /**
   * Ensure `public/wp-content` is a real directory.
   * Older versions created it as a junction to `{site}/wp-content`; restore/import
   * must materialize it so the WordPress root contains a normal wp-content folder.
   */
  private ensurePublicWpContentDirectory(site: WPSite): string {
    const publicDir = this.siteManager.getPublicDir(site);
    const rootContentDir = path.join(site.path, 'wp-content');
    const publicContentDir = path.join(publicDir, 'wp-content');

    fs.mkdirSync(publicDir, { recursive: true });

    if (fs.existsSync(publicContentDir)) {
      try {
        const stat = fs.lstatSync(publicContentDir);
        if (stat.isSymbolicLink()) {
          const tmp = path.join(publicDir, `_wp-content-real-${uuidv4()}`);
          fs.mkdirSync(tmp, { recursive: true });
          const real = fs.realpathSync(publicContentDir);
          if (fs.existsSync(real)) {
            this.copyDirectoryContents(real, tmp);
          }
          fs.rmSync(publicContentDir, { recursive: true, force: true });
          fs.renameSync(tmp, publicContentDir);
        } else if (!stat.isDirectory()) {
          fs.rmSync(publicContentDir, { recursive: true, force: true });
          fs.mkdirSync(publicContentDir, { recursive: true });
        }
      } catch {
        fs.rmSync(publicContentDir, { recursive: true, force: true });
        fs.mkdirSync(publicContentDir, { recursive: true });
      }
    } else {
      fs.mkdirSync(publicContentDir, { recursive: true });
      if (fs.existsSync(rootContentDir)) {
        this.copyDirectoryContents(rootContentDir, publicContentDir);
      }
    }

    if (fs.existsSync(rootContentDir)) {
      try { fs.rmSync(rootContentDir, { recursive: true, force: true }); } catch { /* ignore legacy cleanup */ }
    }

    return publicContentDir;
  }

  private patchWpConfigContentDir(site: WPSite): void {
    const publicDir = this.siteManager.getPublicDir(site);
    const wpConfigPath = path.join(publicDir, 'wp-config.php');
    if (!fs.existsSync(wpConfigPath)) {return;}

    const contentDir = path.join(publicDir, 'wp-content').replace(/\\/g, '/').replace(/'/g, "\\'");
    const contentUrl = `${this.siteManager.getSiteUrl(site)}/wp-content`.replace(/'/g, "\\'");

    try {
      let cfg = fs.readFileSync(wpConfigPath, 'utf8');
      cfg = cfg.replace(
        /^[ \t]*define\s*\(\s*'WP_CONTENT_DIR'\s*,\s*[^)]+\)\s*;\s*$/m,
        `define( 'WP_CONTENT_DIR', '${contentDir}' );`
      );
      cfg = cfg.replace(
        /^[ \t]*define\s*\(\s*'WP_CONTENT_URL'\s*,\s*[^)]+\)\s*;\s*$/m,
        `define( 'WP_CONTENT_URL', '${contentUrl}' );`
      );
      fs.writeFileSync(wpConfigPath, cfg, 'utf8');
    } catch {
      // Non-critical: WordPress can still use default public/wp-content.
    }
  }

  private async syncImportedSiteUrl(site: WPSite, onProgress?: (msg: string) => void): Promise<void> {
    const publicDir = this.siteManager.getPublicDir(site);
    const newUrl = this.siteManager.getSiteUrl(site);
    const env = { WP_CLI_ALLOW_ROOT: '1' };

    try {
      const oldHome = (await this.runtime.runWpCli(
        ['option', 'get', 'home', `--path=${publicDir}`, '--allow-root'],
        publicDir,
        site.phpVersion,
        env
      )).trim();

      if (oldHome && oldHome !== newUrl) {
        onProgress?.('Updating URLs in database...');
        await this.runtime.runWpCli(
          ['search-replace', oldHome, newUrl, '--skip-columns=guid', `--path=${publicDir}`, '--allow-root'],
          publicDir,
          site.phpVersion,
          env
        );
      }
    } catch {
      // Ignore lookup/search-replace failures and still force home/siteurl.
    }

    await this.runtime.runWpCli(
      ['option', 'update', 'siteurl', newUrl, `--path=${publicDir}`, '--allow-root'],
      publicDir,
      site.phpVersion,
      env
    );
    await this.runtime.runWpCli(
      ['option', 'update', 'home', newUrl, `--path=${publicDir}`, '--allow-root'],
      publicDir,
      site.phpVersion,
      env
    );
  }

  private async ensureImportedAdminPassword(
    site: WPSite,
    options: SiteCreateOptions,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const publicDir = this.siteManager.getPublicDir(site);
    const env = { WP_CLI_ALLOW_ROOT: '1' };
    const candidateUsers = new Set<string>();
    const requestedUser = options.adminUser.trim();

    if (requestedUser) {
      try {
        await this.runtime.runWpCli(
          ['user', 'get', requestedUser, '--field=ID', `--path=${publicDir}`, '--allow-root'],
          publicDir,
          site.phpVersion,
          env
        );
        candidateUsers.add(requestedUser);
      } catch {
        // Fallback to any administrator in the restored database.
      }
    }

    try {
      const adminList = await this.runtime.runWpCli(
        ['user', 'list', '--role=administrator', '--field=user_login', `--path=${publicDir}`, '--allow-root'],
        publicDir,
        site.phpVersion,
        env
      );
      for (const user of adminList.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
        candidateUsers.add(user);
      }
    } catch {
      // If listing fails, still try the requested user above.
    }

    for (const user of candidateUsers) {
      try {
        await this.runtime.runWpCli(
          [
            'user',
            'update',
            user,
            `--user_pass=${options.adminPassword}`,
            `--user_email=${options.adminEmail}`,
            `--path=${publicDir}`,
            '--allow-root',
          ],
          publicDir,
          site.phpVersion,
          env
        );
        onProgress?.(`Пароль администратора обновлён: ${user}`);
        return;
      } catch {
        // Try the next administrator account.
      }
    }

    onProgress?.('Предупреждение: не удалось обновить пароль администратора после импорта.');
  }

  private async runImportedSiteSanityChecks(site: WPSite, onProgress?: (msg: string) => void): Promise<void> {
    const publicDir = this.siteManager.getPublicDir(site);
    const env = { WP_CLI_ALLOW_ROOT: '1' };

    try {
      await this.runtime.runWpCli(
        ['rewrite', 'flush', '--hard', `--path=${publicDir}`, '--allow-root'],
        publicDir,
        site.phpVersion,
        env
      );
      onProgress?.('Постоянные ссылки обновлены автоматически.');
    } catch {
      onProgress?.('Предупреждение: не удалось автоматически обновить постоянные ссылки.');
    }

    try {
      const stylesheet = (await this.runtime.runWpCli(
        ['option', 'get', 'stylesheet', `--path=${publicDir}`, '--allow-root'],
        publicDir,
        site.phpVersion,
        env
      )).trim();
      const template = (await this.runtime.runWpCli(
        ['option', 'get', 'template', `--path=${publicDir}`, '--allow-root'],
        publicDir,
        site.phpVersion,
        env
      )).trim();

      const missingThemes = [stylesheet, template]
        .filter(Boolean)
        .filter((themeSlug, index, arr) => arr.indexOf(themeSlug) === index)
        .filter((themeSlug) => !fs.existsSync(path.join(this.siteManager.getSiteContentDir(site), 'themes', themeSlug)));

      if (missingThemes.length > 0) {
        onProgress?.(`Предупреждение: отсутствуют активные темы: ${missingThemes.join(', ')}`);
      } else if (stylesheet || template) {
        onProgress?.('Активная тема найдена в wp-content.');
      }
    } catch {
      onProgress?.('Предупреждение: не удалось проверить активную тему после импорта.');
    }
  }

  /**
   * Упаковывает wp-content в ZIP. `dbDump` может быть готовым путём или промисом
   * (mysqldump, идущий параллельно) — db.sql добавляется в архив, как только дамп
   * готов, перед finalize. Возвращает фактический путь к дампу (или null).
   */
  private createZip(
    site: WPSite,
    zipPath: string,
    dbDump: string | null | Promise<string | null>
  ): Promise<string | null> {
    // Нативный bsdtar (tar.exe, входит в Windows 10+) пакует десятки тысяч
    // файлов за секунды; archiver на чистом JS делает то же минуты. При любой
    // проблеме (нет tar / ошибка) откатываемся на archiver-реализацию.
    if (process.platform === 'win32') {
      return this.createZipNative(site, zipPath, dbDump).catch((err) => {
        Logger.log(`[BackupService] native zip failed (${err?.message ?? err}); fallback → archiver`);
        try { fs.rmSync(zipPath, { force: true }); } catch {}
        return this.createZipArchiver(site, zipPath, dbDump);
      });
    }
    return this.createZipArchiver(site, zipPath, dbDump);
  }

  /**
   * Быстрая упаковка через нативный bsdtar. wp-content НЕ копируется — на него
   * ставится directory junction внутри staging-папки, повторяющей структуру
   * архива ({project}/public/wp-content + db.sql + meta). bsdtar за один проход
   * пакует это в zip без компрессии (store) — как «Сжать в ZIP» в проводнике.
   */
  private async createZipNative(
    site: WPSite,
    zipPath: string,
    dbDump: string | null | Promise<string | null>
  ): Promise<string | null> {
    const projectFolder = this.slugify(site.name) || 'site';
    const wpContent = this.siteManager.getSiteContentDir(site);
    const hasWpContent = fs.existsSync(wpContent);

    // Дамп БД идёт параллельно — дожидаемся его (tar пакует за один проход).
    const dbSqlPath = (await Promise.resolve(dbDump)) || null;

    // staging повторяет структуру архива; реальные файлы wp-content туда НЕ
    // копируются — ставим junction (мгновенно, без занятия места).
    const stagingDir = path.join(path.dirname(zipPath), '_stage_' + uuidv4());
    const projDir = path.join(stagingDir, projectFolder);
    const publicDir = path.join(projDir, 'public');
    fs.mkdirSync(publicDir, { recursive: true });

    const junctionLink = path.join(publicDir, 'wp-content');
    if (hasWpContent) {
      fs.symlinkSync(wpContent, junctionLink, 'junction');
    }
    if (dbSqlPath && fs.existsSync(dbSqlPath)) {
      fs.copyFileSync(dbSqlPath, path.join(projDir, 'db.sql'));
    }

    const meta = {
      wpdock: true,
      version: '1.0',
      siteId: site.id,
      siteName: site.name,
      phpVersion: site.phpVersion,
      port: site.port,
      createdAt: new Date().toISOString(),
      includesDb: !!dbSqlPath,
    };
    fs.writeFileSync(path.join(projDir, 'wpdock-meta.json'), JSON.stringify(meta, null, 2));

    const tarBin = (() => {
      const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
      return fs.existsSync(sys) ? sys : 'tar';
    })();

    const args = [
      '--format=zip',
      '--options=zip:compression=store', // store — без deflate, максимально быстро
      '--dereference', // pack real wp-content files, not the staging junction itself
      // Регенерируемые/мусорные папки и файлы (как в archiver-версии)
      '--exclude', '*/cache/*', '--exclude', '*/cache',
      '--exclude', '*/node_modules/*', '--exclude', '*/node_modules',
      '--exclude', '*/.git/*', '--exclude', '*/.git',
      '--exclude', '*/wpdock-temp/*', '--exclude', '*/wpdock-temp',
      '--exclude', '*.log', '--exclude', '*.DS_Store', '--exclude', 'Thumbs.db',
      '-c', '-f', zipPath,
      '-C', stagingDir, projectFolder,
    ];

    Logger.log(`[BackupService] createZip(native) START site=${site.name}`);
    const startedAt = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const proc = spawn(tarBin, args, { windowsHide: true });
        let stderr = '';
        proc.stderr.on('data', (d) => { stderr += d.toString(); });
        proc.on('error', reject); // tar не найден / не запустился
        proc.on('close', (code) => {
          const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
          // code 1 у bsdtar = предупреждения (например файл исчез mid-zip).
          // Если архив создан и непустой — считаем успехом.
          if (code === 0 || (code === 1 && size > 0)) {
            if (code === 1) {Logger.log(`[BackupService] createZip(native) warnings: ${stderr.slice(0, 300)}`);}
            resolve();
          } else {
            reject(new Error(`tar exit ${code}: ${stderr.slice(0, 500)}`));
          }
        });
      });
    } finally {
      // Сначала снимаем junction (rmdir удаляет ТОЛЬКО ссылку, не трогая
      // реальный wp-content), затем убираем staging целиком.
      try { if (hasWpContent) {fs.rmdirSync(junctionLink);} } catch {}
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
    }

    const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
    Logger.log(`[BackupService] createZip(native) DONE size=${size} bytes in ${Date.now() - startedAt}ms`);
    if (size === 0) {throw new Error('native zip produced empty file');}
    return dbSqlPath;
  }

  private createZipArchiver(
    site: WPSite,
    zipPath: string,
    dbDump: string | null | Promise<string | null>
  ): Promise<string | null> {
    return new Promise((resolve, reject) => {
      Logger.log(`[BackupService] createZip START site=${site.name} zip=${zipPath}`);
      const output = fs.createWriteStream(zipPath);
      // store: true — архив без компрессии (как «Отправить → Сжатая ZIP-папка» в
      // проводнике, режим store). Для бэкапа из тысяч файлов это самый быстрый путь:
      // CPU не тратится на deflate вообще, упирается только в скорость диска.
      const archive = archiver('zip', { store: true });

      // Структура архива повторяет локальный сайт: папка проекта, внутри неё public/
      // с сайтом WP, а рядом — дамп БД.
      const projectFolder = this.slugify(site.name) || 'site';

      let settled = false;
      let resolvedDbPath: string | null = null;
      const finish = (err?: Error) => {
        if (settled) {return;}
        settled = true;
        if (err) {
          Logger.log(`[BackupService] createZip ERROR: ${err.message}`);
          try { archive.abort(); } catch {}
          try { output.destroy(); } catch {}
          reject(err);
        } else {
          const size = fs.existsSync(zipPath) ? fs.statSync(zipPath).size : 0;
          Logger.log(`[BackupService] createZip DONE size=${size} bytes`);
          resolve(resolvedDbPath);
        }
      };

      // Resolve only when the file stream is fully flushed to disk.
      output.on('close', () => finish());
      output.on('error', (err) => finish(err));

      // 'warning' is emitted for non-fatal issues (e.g. a file vanished mid-zip).
      // Without a handler these can stall finalize(); log and continue instead.
      archive.on('warning', (err: any) => {
        Logger.log(`[BackupService] createZip WARNING: ${err?.message ?? err}`);
      });
      archive.on('error', (err) => finish(err));

      // Periodic progress so a large wp-content doesn't look like a hang.
      let lastLog = Date.now();
      archive.on('progress', (data) => {
        if (Date.now() - lastLog > 2000) {
          lastLog = Date.now();
          Logger.log(
            `[BackupService] createZip progress: ${data.entries.processed} files, ` +
            `${Math.round(data.fs.processedBytes / 1048576)} MB`
          );
        }
      });

      archive.pipe(output);

      // wp-content (stored at site root, outside public/)
      const wpContent = this.siteManager.getSiteContentDir(site);
      if (fs.existsSync(wpContent)) {
        // Регенерируемые/мусорные папки — раздувают архив и время, пропускаем.
        const SKIP_DIRS = new Set(['cache', 'node_modules', '.git', 'wpdock-temp']);
        const isSkippedFile = (name: string) =>
          name === '.DS_Store' || name === 'Thumbs.db' || name.endsWith('.log');

        const walk = (dir: string, rel: string) => {
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dir, { withFileTypes: true });
          } catch {
            return;
          }
          for (const entry of entries) {
            const abs = path.join(dir, entry.name);
            const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
              if (SKIP_DIRS.has(entry.name)) {continue;}
              walk(abs, entryRel);
            } else if (entry.isFile()) {
              if (isSkippedFile(entry.name)) {continue;}
              archive.file(abs, {
                name: `${projectFolder}/public/wp-content/${entryRel}`,
              });
            }
          }
        };
        walk(wpContent, '');
      }

      // Дожидаемся параллельного mysqldump, добавляем db.sql + meta и финализируем.
      Promise.resolve(dbDump)
        .then((dbSqlPath) => {
          if (settled) {return;}
          resolvedDbPath = dbSqlPath ?? null;

          if (dbSqlPath && fs.existsSync(dbSqlPath)) {
            archive.file(dbSqlPath, { name: `${projectFolder}/db.sql` });
          }

          const meta = {
            wpdock: true,
            version: '1.0',
            siteId: site.id,
            siteName: site.name,
            phpVersion: site.phpVersion,
            port: site.port,
            createdAt: new Date().toISOString(),
            includesDb: !!dbSqlPath,
          };
          archive.append(JSON.stringify(meta, null, 2), { name: `${projectFolder}/wpdock-meta.json` });

          return archive.finalize();
        })
        .catch((err) => finish(err));
    });
  }

  private findWpContent(dir: string): string | null {
    const search = (currentDir: string, depth: number): string | null => {
      if (depth > 5) {return null;}

      const direct = path.join(currentDir, 'wp-content');
      try {
        if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) {
          return direct;
        }
      } catch {
        // ignore and continue searching
      }

      let entries: string[];
      try {
        entries = fs.readdirSync(currentDir);
      } catch {
        return null;
      }

      for (const entry of entries) {
        const candidate = path.join(currentDir, entry);
        try {
          if (!fs.statSync(candidate).isDirectory()) {continue;}
        } catch {
          continue;
        }

        const found = search(candidate, depth + 1);
        if (found) {return found;}
      }

      return null;
    };

    return search(dir, 0);
  }

  private copyDirectoryContents(srcDir: string, destDir: string): void {
    fs.mkdirSync(destDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, entry);
      const dest = path.join(destDir, entry);
      fs.cpSync(src, dest, { recursive: true, force: true, dereference: true });
    }
  }

  /** Recursively search for a SQL dump file up to maxDepth levels. */
  private findDbSqlRecursive(dir: string, maxDepth = 4): string | null {
    const candidates = ['db.sql', 'database.sql', 'dump.sql', 'backup.sql', 'wordpress.sql', 'wp.sql'];

    const search = (currentDir: string, depth: number): string | null => {
      if (depth > maxDepth) {return null;}
      let entries: string[];
      try { entries = fs.readdirSync(currentDir); } catch { return null; }

      // Check exact-name candidates first
      for (const name of candidates) {
        const p = path.join(currentDir, name);
        if (fs.existsSync(p)) {return p;}
      }

      // Then any .sql file at this level (skip files > 500 MB to avoid false positives)
      for (const entry of entries) {
        const p = path.join(currentDir, entry);
        if (entry.endsWith('.sql') && fs.statSync(p).isFile()) {return p;}
      }

      // Recurse into subdirectories
      for (const entry of entries) {
        const p = path.join(currentDir, entry);
        if (fs.statSync(p).isDirectory()) {
          const found = search(p, depth + 1);
          if (found) {return found;}
        }
      }

      return null;
    };

    return search(dir, 0);
  }

  /** Find any file matching a regex pattern anywhere in dir (non-recursive first level). */
  private findFileByPattern(dir: string, pattern: RegExp): string | null {
    try {
      for (const entry of fs.readdirSync(dir)) {
        if (pattern.test(entry)) {return path.join(dir, entry);}
      }
    } catch {}
    return null;
  }

  /** Find a file by exact name up to maxDepth levels deep. */
  private findFileDeep(dir: string, filename: string, maxDepth = 3): string | null {
    if (maxDepth <= 0) {return null;}
    try {
      for (const entry of fs.readdirSync(dir)) {
        const p = path.join(dir, entry);
        if (entry === filename) {return p;}
        if (fs.statSync(p).isDirectory()) {
          const found = this.findFileDeep(p, filename, maxDepth - 1);
          if (found) {return found;}
        }
      }
    } catch {}
    return null;
  }

  /**
   * Read the first ~200 lines of an SQL dump and detect the table prefix
   * from the first CREATE TABLE statement.
   */
  private detectTablePrefixFromSql(sqlPath: string): string | null {
    try {
      const buf = Buffer.alloc(8192);
      const fd = fs.openSync(sqlPath, 'r');
      fs.readSync(fd, buf, 0, 8192, 0);
      fs.closeSync(fd);
      const head = buf.toString('utf8');
      // Match: CREATE TABLE `prefix_tablename`
      const m = head.match(/CREATE\s+TABLE\s+[`"]?([a-z0-9_]+?)(?:options|posts|users|usermeta|links|terms|termmeta|term_taxonomy|term_relationships|postmeta|comments|commentmeta)[`"]?/i);
      if (m) {
        const fullName = m[1]; // e.g. 'wp_' or 'mysite_'
        return fullName;
      }
    } catch {}
    return null;
  }

  /**
   * Patch the $table_prefix in the site's wp-config.php to match the restored DB dump.
   */
  private patchWpConfigTablePrefix(
    site: WPSite,
    newPrefix: string,
    onProgress?: (msg: string) => void
  ): void {
    const publicDir = this.siteManager.getPublicDir(site);
    const wpConfigPath = path.join(publicDir, 'wp-config.php');
    if (!fs.existsSync(wpConfigPath)) {return;}

    try {
      const cfg = fs.readFileSync(wpConfigPath, 'utf8');
      const updated = cfg.replace(
        /(\$table_prefix\s*=\s*)['"][^'"]*['"]/,
        `$1'${newPrefix.replace(/'/g, "\\'")}'`
      );
      if (updated !== cfg) {
        fs.writeFileSync(wpConfigPath, updated, 'utf8');
        onProgress?.(`wp-config.php: table_prefix → '${newPrefix}'`);
      }
    } catch (e: any) {
      onProgress?.(`Предупреждение: не удалось обновить table_prefix в wp-config.php: ${e.message}`);
    }
  }

  private pruneOldBackups(siteId: string): void {
    const config = this.storage.getBackupConfig();
    const backups = this.storage.getBackups(siteId);
    const excess = backups.slice(config.keepCount);
    for (const b of excess) {
      try {
        if (fs.existsSync(b.localPath)) {fs.unlinkSync(b.localPath);}
        this.storage.deleteBackup(b.id);
      } catch {
        // ignore cleanup errors
      }
    }
  }

  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }
}
