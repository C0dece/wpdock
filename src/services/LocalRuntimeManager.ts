/**
 * LocalRuntimeManager — manages portable PHP + MariaDB runtime.
 * Downloads binaries on first use (Windows) or checks system PHP/MySQL (macOS/Linux).
 * No Docker required.
 */
import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as https from 'https';
import * as http from 'http';
import { unzip } from '../utils/zipUtils';
import { RuntimeStatus } from '../types';
import { Logger } from '../utils/logger';

// ── Portable binary download URLs (Windows NTS x64) ──────────────────────────

const PHP_WIN_URLS: Record<string, string> = {
  '8.3': 'https://downloads.php.net/~windows/releases/php-8.3.31-nts-Win32-vs16-x64.zip',
  '8.2': 'https://downloads.php.net/~windows/releases/php-8.2.31-nts-Win32-vs16-x64.zip',
  '8.1': 'https://downloads.php.net/~windows/releases/php-8.1.34-nts-Win32-vs16-x64.zip',
  '8.0': 'https://downloads.php.net/~windows/releases/php-8.0.30-nts-Win32-vs16-x64.zip',
};

// MariaDB 10.11 LTS portable for Windows
const MARIADB_WIN_URL =
  'https://archive.mariadb.org/mariadb-10.11.10/winx64-packages/mariadb-10.11.10-winx64.zip';

const WPCLI_URL =
  'https://github.com/wp-cli/wp-cli/releases/download/v2.10.0/wp-cli-2.10.0.phar';

const NGINX_WIN_VERSION = '1.26.2';
const NGINX_WIN_URL = `https://nginx.org/download/nginx-${NGINX_WIN_VERSION}.zip`;
const APACHE_WIN_VERSION = '2.4.63';
const APACHE_WIN_URL = 'https://www.apachelounge.com/download/VS17/binaries/httpd-2.4.63-250207-win64-VS17.zip';

export const DB_PORT = 33061; // avoid conflict with existing MySQL 3306
export const DB_ROOT_PASS = 'WPDock_Root_Local!';

// ── macOS PHP paths (Homebrew) ────────────────────────────────────────────────

const MACOS_PHP_PATHS: Record<string, string[]> = {
  '8.3': [
    '/opt/homebrew/opt/php@8.3/bin/php',
    '/usr/local/opt/php@8.3/bin/php',
  ],
  '8.2': [
    '/opt/homebrew/opt/php@8.2/bin/php',
    '/usr/local/opt/php@8.2/bin/php',
  ],
  '8.1': [
    '/opt/homebrew/opt/php@8.1/bin/php',
    '/usr/local/opt/php@8.1/bin/php',
  ],
  '8.0': [
    '/opt/homebrew/opt/php@8.0/bin/php',
    '/usr/local/opt/php@8.0/bin/php',
  ],
};

// ── Linux PHP paths ───────────────────────────────────────────────────────────

const LINUX_PHP_PATHS: Record<string, string[]> = {
  '8.3': ['/usr/bin/php8.3', '/usr/bin/php83'],
  '8.2': ['/usr/bin/php8.2', '/usr/bin/php82'],
  '8.1': ['/usr/bin/php8.1', '/usr/bin/php81'],
  '8.0': ['/usr/bin/php8.0', '/usr/bin/php80'],
};

export class LocalRuntimeManager {
  private runtimeDir: string;
  private dbProcess: cp.ChildProcess | null = null;

  constructor(private context: vscode.ExtensionContext) {
    this.runtimeDir = path.join(context.globalStorageUri.fsPath, 'runtime');
  }

  // ── Paths ─────────────────────────────────────────────────────────────────
  /** Path to cached WordPress ZIP (per locale). Used to skip repeated downloads. */
  wpCacheZip(locale: string): string {
    return path.join(this.runtimeDir, `wp-cache-${locale}.zip`);
  }
  private phpVersionDir(version: string): string {
    return path.join(this.runtimeDir, `php-${version}`);
  }

  /** Returns the PHP executable path for the given version. */
  phpExe(version = '8.2'): string {
    const platform = os.platform();

    if (platform === 'win32') {
      return path.join(this.phpVersionDir(version), 'php.exe');
    }

    // macOS — try Homebrew paths first, then fall back to system php
    if (platform === 'darwin') {
      const candidates = MACOS_PHP_PATHS[version] ?? [];
      for (const p of candidates) {
        if (fs.existsSync(p)) {return p;}
      }
    }

    // Linux — try versioned binaries first
    if (platform === 'linux') {
      const candidates = LINUX_PHP_PATHS[version] ?? [];
      for (const p of candidates) {
        if (fs.existsSync(p)) {return p;}
      }
    }

    // Fall back to system php
    return 'php';
  }

  private get mariadbDir(): string {
    return path.join(this.runtimeDir, 'mariadb');
  }

  get mariadbDataDir(): string {
    return path.join(this.runtimeDir, 'mariadb-data');
  }

  private get mysqldPath(): string {
    if (os.platform() === 'win32') {
      // Try both old and new naming
      const candidates = [
        path.join(this.mariadbDir, 'bin', 'mariadbd.exe'),
        path.join(this.mariadbDir, 'bin', 'mysqld.exe'),
      ];
      return candidates.find(fs.existsSync) ?? candidates[1];
    }
    return 'mysqld';
  }

  get mysqldumpPath(): string {
    if (os.platform() === 'win32') {
      const candidates = [
        path.join(this.mariadbDir, 'bin', 'mariadb-dump.exe'),
        path.join(this.mariadbDir, 'bin', 'mysqldump.exe'),
      ];
      return candidates.find(fs.existsSync) ?? candidates[1];
    }
    return 'mysqldump';
  }

  private get mysqlClientPath(): string {
    if (os.platform() === 'win32') {
      const candidates = [
        path.join(this.mariadbDir, 'bin', 'mariadb.exe'),
        path.join(this.mariadbDir, 'bin', 'mysql.exe'),
      ];
      return candidates.find(fs.existsSync) ?? candidates[1];
    }
    return 'mysql';
  }

  private get mysqladminPath(): string {
    if (os.platform() === 'win32') {
      const candidates = [
        path.join(this.mariadbDir, 'bin', 'mariadb-admin.exe'),
        path.join(this.mariadbDir, 'bin', 'mysqladmin.exe'),
      ];
      return candidates.find(fs.existsSync) ?? candidates[1];
    }
    return 'mysqladmin';
  }

  private get dbPidFile(): string {
    return path.join(this.mariadbDataDir, 'wpdock-mariadbd.pid');
  }

  get wpcliPath(): string {
    return path.join(this.runtimeDir, 'wp-cli.phar');
  }

  /** Exposed DB port for Adminer connection strings. */
  get dbPort(): number {
    return DB_PORT;
  }

  /**
   * Ensures adminer.php is downloaded to runtimeDir.
   * Returns the full path to adminer.php.
   */
  async ensureAdminer(): Promise<string> {
    const adminerPath = path.join(this.runtimeDir, 'adminer.php');
    if (fs.existsSync(adminerPath)) {return adminerPath;}

    const ADMINER_URL = 'https://github.com/vrana/adminer/releases/download/v4.8.1/adminer-4.8.1.php';
    fs.mkdirSync(this.runtimeDir, { recursive: true });
    await this.downloadFile(ADMINER_URL, adminerPath);
    return adminerPath;
  }

  // ── Status ────────────────────────────────────────────────────────────────

  async getStatus(): Promise<RuntimeStatus> {
    const phpInstalled = this.isPhpReady('8.2');
    const mariadbInstalled = this.isMariadbReady();
    const dbRunning = await this.isPortOpen(DB_PORT);

    return {
      available: phpInstalled && mariadbInstalled,
      dbRunning,
      phpInstalled,
      mariadbInstalled,
    };
  }

  // ── Nginx ─────────────────────────────────────────────────────────────────

  private get nginxDir(): string { return path.join(this.runtimeDir, 'nginx'); }

  get apachePath(): string {
    if (os.platform() === 'win32') {
      return path.join(this.runtimeDir, 'apache', 'bin', 'httpd.exe');
    }
    // macOS/Linux — system apache
    return fs.existsSync('/usr/sbin/httpd') ? '/usr/sbin/httpd' : 'apache2';
  }

  /**
   * Returns path to nginx executable.
   * On Windows: downloads portable nginx if needed.
   * On macOS/Linux: uses system nginx.
   */
  async ensureNginx(): Promise<string> {
    if (os.platform() === 'win32') {
      const nginxExe = path.join(this.nginxDir, 'nginx.exe');
      if (fs.existsSync(nginxExe)) {
        const installed = this.detectNginxVersion(nginxExe);
        if (!installed || this.compareVersions(installed, NGINX_WIN_VERSION) >= 0) {
          return nginxExe;
        }
        // Installed version is older than bundled target.
        fs.rmSync(this.nginxDir, { recursive: true, force: true });
      }

      const zipPath   = path.join(this.runtimeDir, 'nginx.zip');
      await this.downloadFile(NGINX_WIN_URL, zipPath);
      const tmpDir = path.join(this.runtimeDir, '_nginx_extract');
      fs.mkdirSync(tmpDir, { recursive: true });
      await unzip(zipPath, tmpDir);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

      // nginx extracts to nginx-X.XX.X/
      const entries = fs.readdirSync(tmpDir);
      const nginxSubDir = entries.find((e) => e.startsWith('nginx-'));
      if (nginxSubDir) {
        fs.renameSync(path.join(tmpDir, nginxSubDir), this.nginxDir);
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return nginxExe;
    }

    // macOS/Linux — check system
    const sysNginx = ['/usr/sbin/nginx', '/usr/local/sbin/nginx', '/opt/homebrew/bin/nginx']
      .find(fs.existsSync);
    if (sysNginx) {return sysNginx;}

    throw new Error('nginx не найден. Установите: brew install nginx (macOS) или apt install nginx (Linux).');
  }

  /**
   * Returns path to Apache httpd executable.
   * On Windows: downloads Apache Lounge portable if needed.
   * On macOS/Linux: uses system apache2/httpd.
   */
  async ensureApache(): Promise<string> {
    if (os.platform() === 'win32') {
      const apacheExe = this.apachePath;
      if (fs.existsSync(apacheExe)) {
        const installed = this.detectApacheVersion(apacheExe);
        if (!installed || this.compareVersions(installed, APACHE_WIN_VERSION) >= 0) {
          return apacheExe;
        }
        fs.rmSync(path.join(this.runtimeDir, 'apache'), { recursive: true, force: true });
      }

      const zipPath    = path.join(this.runtimeDir, 'apache.zip');
      await this.downloadFile(APACHE_WIN_URL, zipPath);
      const tmpDir = path.join(this.runtimeDir, '_apache_extract');
      fs.mkdirSync(tmpDir, { recursive: true });
      await unzip(zipPath, tmpDir);
      try { fs.unlinkSync(zipPath); } catch { /* ignore */ }

      // Apache Lounge extracts to Apache24/
      const apacheSub = path.join(tmpDir, 'Apache24');
      const apacheDir = path.join(this.runtimeDir, 'apache');
      if (fs.existsSync(apacheSub)) {
        fs.renameSync(apacheSub, apacheDir);
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      return apacheExe;
    }

    // macOS/Linux — check system
    const sysApache = ['/usr/sbin/apache2', '/usr/sbin/httpd', '/opt/homebrew/bin/httpd']
      .find(fs.existsSync);
    if (sysApache) {return sysApache;}

    throw new Error('Apache не найден. Установите: brew install httpd (macOS) или apt install apache2 (Linux).');
  }

  // ── First-time setup ──────────────────────────────────────────────────────

  /**
   * Ensures PHP, MariaDB and WP-CLI are available.
   * Downloads portable binaries on Windows; checks system tools on macOS/Linux.
   */
  async ensureRuntimeAvailable(onProgress?: (msg: string) => void): Promise<void> {
    fs.mkdirSync(this.runtimeDir, { recursive: true });

    const platform = os.platform();
    onProgress?.('Checking WPDock runtime...');

    if (platform === 'win32') {
      await this.ensureWindowsRuntime(onProgress);
    } else {
      await this.ensureUnixRuntime(onProgress);
    }

    // WP-CLI phar
    if (!fs.existsSync(this.wpcliPath)) {
      onProgress?.('Downloading WP-CLI...');
      await this.downloadFile(WPCLI_URL, this.wpcliPath, onProgress);
      onProgress?.('WP-CLI ready.');
    }

    // Initialize DB data directory (Windows only — Unix uses the system service)
    if (platform === 'win32' && !this.isDbInitialized()) {
      onProgress?.('Initializing database (first-time setup)...');
      await this.initializeDatabase(onProgress);
    }

    onProgress?.('Runtime ready.');
  }

  private async ensureWindowsRuntime(onProgress?: (msg: string) => void): Promise<void> {
    // PHP 8.2
    if (!this.isPhpReady('8.2')) {
      const phpDir = this.phpVersionDir('8.2');
      fs.mkdirSync(phpDir, { recursive: true });

      const url = PHP_WIN_URLS['8.2'];
      onProgress?.('Downloading PHP 8.2 (~30 MB)...');
      const tmpZip = path.join(this.runtimeDir, 'php-8.2.zip');
      await this.downloadFile(url, tmpZip, onProgress);

      onProgress?.('Extracting PHP 8.2...');
      await unzip(tmpZip, phpDir);
      try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }

      this.writePHPIni(phpDir);
      onProgress?.('PHP 8.2 ready.');
    }

    // MariaDB
    if (!this.isMariadbReady()) {
      onProgress?.('Downloading MariaDB (~160 MB)...');
      const tmpZip = path.join(this.runtimeDir, 'mariadb.zip');
      await this.downloadFile(MARIADB_WIN_URL, tmpZip, onProgress);

      onProgress?.('Extracting MariaDB...');
      const tmpDir = path.join(this.runtimeDir, '_mariadb_extract');
      fs.mkdirSync(tmpDir, { recursive: true });
      await unzip(tmpZip, tmpDir);
      try { fs.unlinkSync(tmpZip); } catch { /* ignore */ }

      // MariaDB zip extracts to a versioned subdirectory — move it
      const entries = fs.readdirSync(tmpDir);
      const subdir = entries.find((e) => /^mariadb/i.test(e));
      if (subdir) {
        if (fs.existsSync(this.mariadbDir)) {
          fs.rmSync(this.mariadbDir, { recursive: true, force: true });
        }
        fs.renameSync(path.join(tmpDir, subdir), this.mariadbDir);
      } else {
        // Already flat inside tmpDir
        fs.renameSync(tmpDir, this.mariadbDir);
        return;
      }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
      onProgress?.('MariaDB ready.');
    }
  }

  private async ensureUnixRuntime(onProgress?: (msg: string) => void): Promise<void> {
    // Check PHP
    try {
      cp.execSync(`${this.phpExe('8.2')} --version`, { stdio: 'ignore' });
    } catch {
      const msg =
        'PHP 8.2 not found.\n' +
        '  macOS:  brew install php@8.2\n' +
        '  Ubuntu: sudo apt install php8.2 php8.2-mysql php8.2-mbstring php8.2-xml php8.2-curl php8.2-gd php8.2-zip';
      throw new Error(msg);
    }

    // Check MySQL/MariaDB
    const dbReady = ['mysql', 'mariadb'].some((cmd) => {
      try {
        cp.execSync(`${cmd} --version`, { stdio: 'ignore' });
        return true;
      } catch {
        return false;
      }
    });

    if (!dbReady) {
      throw new Error(
        'MySQL/MariaDB not found.\n' +
        '  macOS:  brew install mariadb && brew services start mariadb\n' +
        '  Ubuntu: sudo apt install mariadb-server && sudo systemctl start mariadb'
      );
    }

    onProgress?.('System PHP and MySQL detected.');
  }

  // ── Database lifecycle ────────────────────────────────────────────────────

  private async initializeDatabase(onProgress?: (msg: string) => void): Promise<void> {
    fs.mkdirSync(this.mariadbDataDir, { recursive: true });

    // Try mysql_install_db.exe (MariaDB 10.x), fall back to mysqld --initialize-insecure
    const installDbExe = path.join(this.mariadbDir, 'bin', 'mysql_install_db.exe');

    if (fs.existsSync(installDbExe)) {
      // MariaDB 10.x — supports --password directly
      await this.runProcess(installDbExe, [
        `--datadir=${this.mariadbDataDir}`,
        `--password=${DB_ROOT_PASS}`,
      ]);
    } else {
      // MariaDB 11.x / MySQL 8.x — initialize without password, then set it
      await this.runProcess(this.mysqldPath, [
        '--initialize-insecure',
        `--datadir=${this.mariadbDataDir}`,
      ]);

      onProgress?.('Starting database to set root password...');
      await this.startDatabase();
      await this.setRootPassword();
      await this.stopDatabase();
    }

    onProgress?.('Database initialized.');
  }

  private async setRootPassword(): Promise<void> {
    const sql =
      `ALTER USER 'root'@'localhost' IDENTIFIED BY '${DB_ROOT_PASS}';\n` +
      `FLUSH PRIVILEGES;\n`;

    const result = cp.spawnSync(
      this.mysqlClientPath,
      [
        '-h', '127.0.0.1',
        '-P', String(DB_PORT),
        '-u', 'root',
        '--connect-expired-password',
      ],
      { input: sql, maxBuffer: 1024 * 1024 * 2, timeout: 15000 }
    );

    if (result.error) {throw result.error;}
  }

  async startDatabase(): Promise<void> {
    if (await this.isPortOpen(DB_PORT)) {return;} // already running

    if (os.platform() !== 'win32') {
      // On Unix the user manages the DB service; we just verify it's up
      throw new Error(
        `MariaDB is not running on port ${DB_PORT}.\n` +
        'Please start it:\n' +
        '  macOS:  brew services start mariadb\n' +
        '  Ubuntu: sudo systemctl start mariadb'
      );
    }

    if (!fs.existsSync(this.mysqldPath)) {
      throw new Error('MariaDB binary not found. Please run first-time setup.');
    }

    fs.mkdirSync(this.mariadbDataDir, { recursive: true });

    // An instance may already be running but not yet listening — e.g. an orphan
    // from a previous VS Code window still doing InnoDB crash recovery. Spawning
    // a second mysqld would fail with "ibdata1 must be writable" (the datadir is
    // exclusively locked) and leave the original to finish on its own. Detect it
    // via the PID file and wait briefly for the port instead of starting a rival.
    //
    // But the PID file cannot be trusted blindly: on Windows a recorded PID is
    // routinely reused by an unrelated process, and a tracked mariadbd may be
    // mid-shutdown (port already closed, never to reopen). In both cases a 90s
    // wait is a guaranteed dead end. So we only wait when the PID is *actually*
    // a live mariadbd/mysqld, we bound that wait, and if the port still doesn't
    // come up we reclaim the datadir (kill the stale process) and start fresh.
    const existingPid = this.readDbPid();
    if (existingPid !== null && this.isProcessAlive(existingPid) && this.isDbProcess(existingPid)) {
      // Crash recovery here normally completes in 1-2s; 30s is generous headroom.
      if (await this.waitForPortQuiet(DB_PORT, 30)) {return;}
      Logger.log(`[LocalRuntimeManager] tracked mariadbd pid=${existingPid} never opened port ${DB_PORT} — reclaiming datadir`);
    }

    // Reclaim the datadir: hard-kill any tracked/orphan mysqld so the fresh
    // instance below doesn't abort with "ibdata1 must be writable".
    await this.stopDatabase();

    const errorLog = path.join(this.mariadbDataDir, 'mariadb-error.log');

    const child = cp.spawn(
      this.mysqldPath,
      [
        `--port=${DB_PORT}`,
        `--datadir=${this.mariadbDataDir}`,
        '--bind-address=127.0.0.1',
        '--skip-networking=OFF',
        `--log-error=${errorLog}`,
      ],
      { detached: false, stdio: 'ignore' }
    );
    this.dbProcess = child;

    // Persist PID so a later window (or stopDatabase) can find this process even
    // though `this.dbProcess` only lives in the current instance's memory.
    if (child.pid !== undefined) {
      try { fs.writeFileSync(this.dbPidFile, String(child.pid)); } catch { /* best effort */ }
    }

    const exitState: { exited: boolean; code: number | null } = { exited: false, code: null };
    child.on('exit', (code) => {
      if (this.dbProcess === child) {this.dbProcess = null;}
      try { fs.rmSync(this.dbPidFile, { force: true }); } catch { /* ignore */ }
      // Record an exit that happens before the port comes up.
      exitState.exited = true;
      exitState.code = code;
    });

    // Crash recovery can take a while; allow up to 90s before giving up.
    for (let i = 0; i < 90; i++) {
      if (await this.isPortOpen(DB_PORT)) {return;}
      if (exitState.exited) {
        const tail = this.readDbErrorTail();
        throw new Error(
          `MariaDB exited during startup (code ${exitState.code}).\n` +
          (tail ? `Last log lines:\n${tail}` : `See ${errorLog}`)
        );
      }
      await new Promise((r) => setTimeout(r, 1000));
    }

    const tail = this.readDbErrorTail();
    throw new Error(
      `Service on port ${DB_PORT} did not start after 90 seconds.` +
      (tail ? `\nLast log lines:\n${tail}` : '')
    );
  }

  async stopDatabase(): Promise<void> {
    // Prefer a graceful shutdown so InnoDB flushes cleanly — a hard kill leaves
    // the datadir dirty and forces a slow crash recovery on the next start.
    if (os.platform() === 'win32' && (await this.isPortOpen(DB_PORT))) {
      try {
        await this.runProcess(this.mysqladminPath, [
          '-h', '127.0.0.1',
          '-P', String(DB_PORT),
          '-u', 'root',
          `-p${DB_ROOT_PASS}`,
          'shutdown',
        ]);
        // Wait for the port to actually close (graceful flush can take a moment).
        for (let i = 0; i < 20; i++) {
          if (!(await this.isPortOpen(DB_PORT))) {break;}
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch {
        // Graceful path failed (e.g. wrong password / admin binary missing) —
        // fall through to the hard kill below.
      }
    }

    // Hard-kill whatever is still tracked or recorded in the PID file.
    if (this.dbProcess && !this.dbProcess.killed) {
      this.dbProcess.kill('SIGKILL');
    }
    const pid = this.readDbPid();
    if (pid !== null && this.isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
    this.dbProcess = null;
    try { fs.rmSync(this.dbPidFile, { force: true }); } catch { /* ignore */ }
  }

  private readDbPid(): number | null {
    try {
      const raw = fs.readFileSync(this.dbPidFile, 'utf8').trim();
      const pid = parseInt(raw, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      // Signal 0 performs existence/permission checks without killing.
      process.kill(pid, 0);
      return true;
    } catch (err: any) {
      // EPERM means the process exists but we can't signal it — still alive.
      return err?.code === 'EPERM';
    }
  }

  private readDbErrorTail(maxLines = 15): string {
    try {
      const log = path.join(this.mariadbDataDir, 'mariadb-error.log');
      const lines = fs.readFileSync(log, 'utf8').split(/\r?\n/).filter(Boolean);
      return lines.slice(-maxLines).join('\n');
    } catch {
      return '';
    }
  }

  // ── Database operations ───────────────────────────────────────────────────

  async createSiteDatabase(dbName: string, dbUser: string, dbPass: string): Promise<void> {
    // Sanitize identifiers — allow only alphanumeric and underscores
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeUser = dbUser.replace(/[^a-zA-Z0-9_]/g, '_');

    const sql = [
      `CREATE DATABASE IF NOT EXISTS \`${safeName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
      `CREATE USER IF NOT EXISTS '${safeUser}'@'127.0.0.1' IDENTIFIED BY '${dbPass.replace(/'/g, "\\'")}';`,
      `GRANT ALL PRIVILEGES ON \`${safeName}\`.* TO '${safeUser}'@'127.0.0.1';`,
      `FLUSH PRIVILEGES;`,
    ].join('\n');

    await this.runMysql(sql);
  }

  async dropSiteDatabase(dbName: string, dbUser: string): Promise<void> {
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    const safeUser = dbUser.replace(/[^a-zA-Z0-9_]/g, '_');

    const sql = [
      `DROP DATABASE IF EXISTS \`${safeName}\`;`,
      `DROP USER IF EXISTS '${safeUser}'@'127.0.0.1';`,
      `FLUSH PRIVILEGES;`,
    ].join('\n');

    await this.runMysql(sql);
  }

  /**
   * Dumps specific tables (data only, no CREATE) into a SQL string.
   * Used to snapshot wp_users / wp_usermeta / wp_options before a DB restore
   * so credentials can be re-applied afterwards.
   * Returns empty string if the DB or tables do not exist.
   */
  dumpTablesSql(dbName: string, tables: string[]): string {
    if (tables.length === 0) {return '';}
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    const result = cp.spawnSync(
      this.mysqldumpPath,
      [
        '-h', '127.0.0.1',
        '-P', String(DB_PORT),
        '-u', 'root',
        `--password=${DB_ROOT_PASS}`,
        '--no-create-info',     // INSERT only — no CREATE TABLE
        '--complete-insert',    // include column names so order doesn't matter
        '--replace',            // use REPLACE INTO instead of INSERT — idempotent on re-run
        '--skip-triggers',
        '--skip-add-locks',
        '--skip-comments',
        safeName,
        ...tables,
      ],
      { maxBuffer: 1024 * 1024 * 50, timeout: 30000 }
    );
    if (result.error || result.status !== 0) {
      const stderr = String(result.stderr ?? '').substring(0, 300);
      Logger.log(`[LocalRuntimeManager] dumpTablesSql SKIP db=${safeName} tables=${tables.join(',')} err=${stderr}`);
      return '';
    }
    return String(result.stdout ?? '');
  }

  async dumpDatabase(dbName: string, outputPath: string): Promise<void> {
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    Logger.log(`[LocalRuntimeManager] dumpDatabase START db=${safeName} outputPath=${outputPath}`);
    await this.runProcess(this.mysqldumpPath, [
      '-h', '127.0.0.1',
      '-P', String(DB_PORT),
      '-u', 'root',
      `--password=${DB_ROOT_PASS}`,
      '--single-transaction',
      '--routines',
      '--triggers',
      safeName,
      `--result-file=${outputPath}`,
    ]);
    const dumpSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
    Logger.log(`[LocalRuntimeManager] dumpDatabase DONE db=${safeName} outputSize=${dumpSize} bytes`);
  }

  async restoreDatabase(dbName: string, sqlPath: string): Promise<void> {
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    // Read the dump as raw bytes and treat it as latin1 (1:1 byte<->char), NOT utf-8.
    // mysqldump emits BINARY/BLOB columns (e.g. wp_pmxi_hash) as raw bytes that are not
    // valid utf-8; decoding as utf-8 replaces them with U+FFFD and corrupts every _binary
    // literal, which aborts the primary import (spawnSync EOF) and forces --force to skip
    // those rows. latin1 round-trips bytes losslessly while the ASCII-only normalization
    // regexes below still match.
    const sqlText = fs.readFileSync(sqlPath).toString('latin1');
    const expectedTables = this.extractExpectedTableNames(sqlText);

    Logger.log(`[LocalRuntimeManager] restoreDatabase START db=${safeName} sqlPath=${sqlPath} sqlSize=${sqlText.length} expectedTables=${expectedTables.length} tableList=${expectedTables.join(',')}`);

    // Always restore into a clean database to avoid partial imports when tables already exist.
    await this.resetDatabase(safeName);
    Logger.log(`[LocalRuntimeManager] restoreDatabase database reset complete db=${safeName}`);

    // Normalize host-specific directives and MySQL-8-only collations up front so the
    // primary (non-forced) import does not abort on the first incompatible statement.
    // Re-encode via latin1 back to the exact original bytes so binary data survives stdin.
    const normalized = Buffer.from(this.normalizeSqlForLocalRestore(sqlText), 'latin1');

    const primary = this.execMysqlImport(safeName, normalized, false);
    Logger.log(`[LocalRuntimeManager] restoreDatabase primary import result ok=${primary.ok} stderr=${primary.stderr || 'none'}`);
    if (primary.ok) {
      this.ensureExpectedTablesRestored(safeName, expectedTables);
      Logger.log(`[LocalRuntimeManager] restoreDatabase primary import OK db=${safeName}`);
      return;
    }

    Logger.log(`[LocalRuntimeManager] restoreDatabase primary import failed db=${safeName} stderr=${primary.stderr || 'n/a'}`);

    // Fallback: re-run the same normalized SQL but continue past non-critical SQL errors.
    Logger.log(`[LocalRuntimeManager] restoreDatabase running fallback import with --force db=${safeName}`);
    const fallback = this.execMysqlImport(safeName, normalized, true);
    Logger.log(`[LocalRuntimeManager] restoreDatabase fallback import result ok=${fallback.ok} stderr=${fallback.stderr || 'none'}`);
    if (fallback.ok) {
      this.ensureExpectedTablesRestored(safeName, expectedTables);
      Logger.log(`[LocalRuntimeManager] restoreDatabase fallback import OK db=${safeName}`);
      return;
    }

    Logger.error(`[LocalRuntimeManager] restoreDatabase fallback import failed db=${safeName} stderr=${fallback.stderr || 'n/a'}`);

    const details = [
      primary.stderr ? `primary: ${primary.stderr}` : '',
      fallback.stderr ? `fallback: ${fallback.stderr}` : '',
    ].filter(Boolean).join(' | ');
    throw new Error(`DB restore failed: ${details || 'unknown error'}`);
  }

  private extractExpectedTableNames(sql: string): string[] {
    const names = new Set<string>();
    const createTableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?`?([a-zA-Z0-9_]+)`?/gi;
    let match: RegExpExecArray | null = null;
    while ((match = createTableRegex.exec(sql)) !== null) {
      const tableName = String(match[1] || '').trim();
      if (tableName) {names.add(tableName);}
    }
    return Array.from(names);
  }

  private ensureExpectedTablesRestored(dbName: string, expectedTables: string[]): void {
    if (expectedTables.length === 0) {
      return;
    }

    const result = cp.spawnSync(
      this.mysqlClientPath,
      [
        '-h', '127.0.0.1',
        '-P', String(DB_PORT),
        '-u', 'root',
        `--password=${DB_ROOT_PASS}`,
        '-N',
        '-e',
        `SHOW TABLES FROM \`${dbName}\`;`,
      ],
      { maxBuffer: 1024 * 1024 * 10, timeout: 30000 }
    );

    if (result.error) {
      throw new Error(`DB restore verification failed: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const stderr = String(result.stderr ?? '').trim();
      throw new Error(`DB restore verification failed: ${stderr || 'cannot list tables'}`);
    }

    const actualTables = new Set(
      String(result.stdout ?? '')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    );

    const missing = expectedTables.filter((tableName) => !actualTables.has(tableName));
    if (missing.length > 0) {
      const preview = missing.slice(0, 8).join(', ');
      throw new Error(
        `DB restore appears partial: missing ${missing.length} table(s) after import (${preview}${missing.length > 8 ? ', ...' : ''})`
      );
    }
  }

  private async resetDatabase(dbName: string): Promise<void> {
    await this.runMysql([
      `DROP DATABASE IF EXISTS \`${dbName}\`;`,
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
    ].join('\n'));
  }

  private execMysqlImport(
    dbName: string,
    sqlContent: Buffer,
    force: boolean
  ): { ok: boolean; stderr: string } {
    const args = [
      '-h', '127.0.0.1',
      '-P', String(DB_PORT),
      '-u', 'root',
      `--password=${DB_ROOT_PASS}`,
    ];
    if (force) {args.push('--force');}
    args.push(dbName);

    Logger.log(`[LocalRuntimeManager] execMysqlImport START db=${dbName} force=${force} sqlLen=${sqlContent.length}`);
    const result = cp.spawnSync(
      this.mysqlClientPath,
      args,
      { input: sqlContent, maxBuffer: 1024 * 1024 * 500, timeout: 300000 }
    );

    if (result.error) {
      Logger.error(`[LocalRuntimeManager] execMysqlImport SPAWN ERROR db=${dbName}: ${result.error.message}`);
      return { ok: false, stderr: result.error.message };
    }

    const stderr = String(result.stderr ?? '').trim();
    const stdout = String(result.stdout ?? '').trim();
    Logger.log(`[LocalRuntimeManager] execMysqlImport done db=${dbName} status=${result.status} stdout=${stdout ? stdout.substring(0, 200) : 'empty'} stderr=${stderr ? stderr.substring(0, 500) : 'empty'}`);
    return { ok: result.status === 0, stderr };
  }

  private normalizeSqlForLocalRestore(sql: string): string {
    let next = sql;

    // Removes GTID/replication directives that often fail on local MariaDB/MySQL without SUPER.
    next = next.replace(/SET\s+@@GLOBAL\.GTID_PURGED\s*=\s*[^;]+;\s*/gi, '');
    next = next.replace(/SET\s+@@SESSION\.SQL_LOG_BIN\s*=\s*[^;]+;\s*/gi, '');

    // MariaDB may fail on MySQL dump comments with versioned GTID directives.
    next = next.replace(/\/\*![0-9]{5}\s+SET\s+@@GLOBAL\.GTID_PURGED[^*]*\*\//gi, '');

    // DEFINER clauses frequently break when imported under a different user.
    next = next.replace(/\s+DEFINER=`[^`]+`@`[^`]+`/gi, '');

    // MariaDB does not support MySQL 8's *_0900_* collations (e.g. utf8mb4_0900_ai_ci,
    // utf8mb4_ru_0900_ai_ci). Without this, every CREATE TABLE using them fails with
    // "Unknown collation" and the table — plus all its INSERT/ALTER statements — is
    // skipped, leaving a partial/broken import. Map them to a MariaDB-compatible collation.
    next = next.replace(/utf8mb4_(?:[a-z0-9]+_)?0900_[a-z0-9_]+/gi, 'utf8mb4_unicode_ci');

    return next;
  }

  /**
   * Run arbitrary SQL against a specific database.
   * Unlike the private `runMysql` (no database context), this selects the
   * target DB first — useful for running credential-restore INSERT/REPLACE statements.
   */
  async runMysqlSql(dbName: string, sql: string): Promise<void> {
    const safeName = dbName.replace(/[^a-zA-Z0-9_]/g, '_');
    const result = cp.spawnSync(
      this.mysqlClientPath,
      [
        '-h', '127.0.0.1',
        '-P', String(DB_PORT),
        '-u', 'root',
        `--password=${DB_ROOT_PASS}`,
        safeName,
      ],
      { input: sql, maxBuffer: 1024 * 1024 * 50, timeout: 60000 }
    );
    if (result.error) {throw result.error;}
    if (result.status !== 0) {
      const stderr = (result.stderr?.toString() ?? '').split('\n')
        .filter((l) => !l.includes('[Warning]')).join('\n').trim();
      if (stderr) {throw new Error(`MySQL error: ${stderr}`);}
    }
  }

  private async runMysql(sql: string): Promise<void> {
    const result = cp.spawnSync(
      this.mysqlClientPath,
      [
        '-h', '127.0.0.1',
        '-P', String(DB_PORT),
        '-u', 'root',
        `--password=${DB_ROOT_PASS}`,
      ],
      { input: sql, maxBuffer: 1024 * 1024 * 10, timeout: 30000 }
    );

    if (result.error) {throw result.error;}
    if (result.status !== 0) {
      const stderr = result.stderr?.toString() ?? '';
      // Ignore "using password on command line is insecure" warning
      const errLines = stderr.split('\n').filter((l) => !l.includes('[Warning]'));
      if (errLines.some((l) => l.trim())) {
        throw new Error(`MySQL error: ${errLines.join('\n')}`);
      }
    }
  }

  // ── WP-CLI ────────────────────────────────────────────────────────────────

  /**
   * WP-CLI sub-commands that genuinely need plugins/themes loaded, so we must
   * never auto-inject --skip-plugins/--skip-themes for them. Everything else is
   * a maintenance/bootstrap command that only touches core (options/users/db)
   * and is skipped by default — see {@link applyDefaultSkipFlags}.
   */
  private static readonly WP_CLI_KEEP_EXTENSIONS = new Set([
    'plugin', 'theme', 'cron', 'i18n', 'language', 'package',
  ]);

  /**
   * Appends --skip-plugins/--skip-themes to maintenance WP-CLI commands.
   *
   * Loading the site's active plugins during WP-CLI bootstrap triggers a
   * blocking loopback HTTP request (wp-cron / Action Scheduler) to the site's
   * URL. While WPDock runs these commands the site's web server is often not
   * serving yet (start / pull / restore / diagnose), so the request hangs until
   * timeout and the whole operation stalls or aborts. Maintenance commands only
   * read/write core tables, so skipping extensions is both safe and required.
   *
   * Exceptions: commands in {@link WP_CLI_KEEP_EXTENSIONS} and the fresh-install
   * bootstrap (`core install`) must run with extensions loaded.
   */
  private applyDefaultSkipFlags(args: string[]): string[] {
    // The sub-command is the first token that is not a global flag (callers may
    // prefix --path=… / --allow-root before it).
    const sub = args.find((a) => !a.startsWith('-'));
    if (!sub) {return args;}
    if (LocalRuntimeManager.WP_CLI_KEEP_EXTENSIONS.has(sub)) {return args;}
    if (sub === 'core' && (args.includes('install') || args.includes('multisite-install'))) {
      return args;
    }
    const out = [...args];
    if (!out.includes('--skip-plugins')) {out.push('--skip-plugins');}
    if (!out.includes('--skip-themes')) {out.push('--skip-themes');}
    return out;
  }

  /**
   * @param opts.rawExtensions when true, runs args exactly as given without
   *   auto-injecting --skip-plugins/--skip-themes. Used by the manual WP-CLI
   *   console, where the site is already running (no loopback hang) and the
   *   user may intentionally invoke plugin/theme/cron/eval commands.
   */
  async runWpCli(
    args: string[],
    cwd: string,
    phpVersion = '8.2',
    env?: Record<string, string>,
    opts?: { rawExtensions?: boolean }
  ): Promise<string> {
    const phpExe = this.phpExe(phpVersion);
    const wpcliIni = this.getWpCliPhpIniPath(phpVersion);
    const finalArgs = opts?.rawExtensions ? args : this.applyDefaultSkipFlags(args);

    return this.runProcess(
      phpExe,
      ['-c', wpcliIni, this.wpcliPath, '--no-color', ...finalArgs],
      { cwd, env: { ...process.env, ...env } }
    );
  }

  /** Returns a generated php.ini path for WP-CLI with required extensions enabled. */
  getWpCliPhpIniPath(phpVersion = '8.2'): string {
    const phpExe = this.phpExe(phpVersion);
    const phpDir = path.dirname(phpExe);
    const extDir = path.join(phpDir, 'ext').replace(/\\/g, '/');

    const wpcliIni = path.join(this.runtimeDir, `wpcli-php${phpVersion}.ini`);
    const lines = [
      `[PHP]`,
      `extension_dir = "${extDir}"`,
      `extension=mysqli`,
      `extension=pdo_mysql`,
      `extension=openssl`,
      `extension=mbstring`,
      `extension=curl`,
      `extension=gd`,
      `extension=zip`,
      `extension=intl`,
      `extension=fileinfo`,
      `extension=exif`,
      `memory_limit = 256M`,
      `max_execution_time = 300`,
      `date.timezone = UTC`,
    ];
    fs.writeFileSync(wpcliIni, lines.join('\n'), 'utf-8');
    return wpcliIni;
  }

  // ── Check helpers ─────────────────────────────────────────────────────────

  isPhpReady(version = '8.2'): boolean {
    const exe = this.phpExe(version);
    if (os.platform() === 'win32') {
      return fs.existsSync(exe);
    }
    try {
      cp.execSync(`"${exe}" --version`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private isMariadbReady(): boolean {
    if (os.platform() === 'win32') {
      return fs.existsSync(this.mysqldPath);
    }
    try {
      cp.execSync('mysqld --version', { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }

  private isDbInitialized(): boolean {
    // MariaDB creates a 'mysql' system database directory when initialized
    return fs.existsSync(path.join(this.mariadbDataDir, 'mysql'));
  }

  // ── PHP ini ───────────────────────────────────────────────────────────────

  private writePHPIni(phpDir: string): void {
    const iniDest = path.join(phpDir, 'php.ini');
    if (fs.existsSync(iniDest)) {return;}

    const iniTemplate = path.join(phpDir, 'php.ini-development');
    let content = fs.existsSync(iniTemplate)
      ? fs.readFileSync(iniTemplate, 'utf-8')
      : '';

    // Enable extensions required by WordPress
    const extensions = [
      'curl', 'fileinfo', 'gd', 'mbstring', 'mysqli',
      'openssl', 'pdo_mysql', 'xml', 'zip', 'intl', 'exif',
    ];
    for (const ext of extensions) {
      content = content.replace(new RegExp(`;extension=${ext}\\b`), `extension=${ext}`);
    }

    // Set extension directory
    content = content.replace(
      '; extension_dir = "ext"',
      `extension_dir = "${path.join(phpDir, 'ext').replace(/\\/g, '/')}"`
    );

    fs.writeFileSync(iniDest, content, 'utf-8');
  }

  private detectNginxVersion(nginxExe: string): string | undefined {
    try {
      const result = cp.spawnSync(nginxExe, ['-v'], { encoding: 'utf-8' });
      const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const match = raw.match(/nginx\/(\d+\.\d+\.\d+)/i);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private detectApacheVersion(apacheExe: string): string | undefined {
    try {
      const result = cp.spawnSync(apacheExe, ['-v'], { encoding: 'utf-8' });
      const raw = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      const match = raw.match(/Apache\/(\d+\.\d+\.\d+)/i);
      return match?.[1];
    } catch {
      return undefined;
    }
  }

  private compareVersions(a: string, b: string): number {
    const toParts = (v: string) => v.split('.').map((n) => parseInt(n, 10));
    const left = toParts(a);
    const right = toParts(b);
    const maxLen = Math.max(left.length, right.length);
    for (let i = 0; i < maxLen; i++) {
      const av = left[i] ?? 0;
      const bv = right[i] ?? 0;
      if (av > bv) {return 1;}
      if (av < bv) {return -1;}
    }
    return 0;
  }

  // ── File download ─────────────────────────────────────────────────────────

  /**
   * Downloads a file with automatic retries. Slow mirrors (e.g. downloads.wordpress.org
   * from RU) routinely stall, so a single timeout must not fail the whole operation.
   */
  async downloadFile(
    url: string,
    dest: string,
    onProgress?: (msg: string) => void,
    maxAttempts = 3
  ): Promise<void> {
    // Prefer the system `curl` (bundled with Windows 10/11). It survives slow /
    // VPN-throttled mirrors far better than Node's http: connect timeout, a
    // low-speed abort (so a trickling-but-alive socket can't hang forever) and
    // resume support. Node download stays as a fallback if curl is missing.
    if (LocalRuntimeManager.curlPath()) {
      try {
        await this.curlDownload(url, dest, onProgress, maxAttempts);
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.(`curl не справился (${msg}), переключаюсь на встроенный загрузчик...`);
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
      }
    }

    let lastErr: Error | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.downloadOnce(url, dest, onProgress);
        return;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        try { fs.unlinkSync(dest); } catch { /* ignore */ }
        if (attempt < maxAttempts) {
          const delayMs = 2000 * attempt;
          onProgress?.(`Сбой загрузки (${lastErr.message}). Повтор ${attempt + 1}/${maxAttempts} через ${delayMs / 1000} с...`);
          await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    }
    throw lastErr ?? new Error(`Не удалось скачать ${url}`);
  }

  /** Cached path to a usable system `curl` executable, or '' if none. */
  private static _curlPath: string | null = null;
  private static curlPath(): string {
    if (this._curlPath !== null) { return this._curlPath; }
    const candidates = os.platform() === 'win32'
      ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'curl.exe'), 'curl.exe', 'curl']
      : ['/usr/bin/curl', 'curl'];
    for (const c of candidates) {
      try {
        cp.execFileSync(c, ['--version'], { stdio: 'ignore', timeout: 5000 });
        this._curlPath = c;
        return c;
      } catch { /* try next */ }
    }
    this._curlPath = '';
    return '';
  }

  /**
   * Downloads via system curl with resume (`-C -`), retries and a low-speed
   * abort (`--speed-limit`/`--speed-time`) so a stalled-but-alive socket — common
   * on VPN / throttled mirrors — fails fast instead of hanging forever.
   */
  private curlDownload(
    url: string,
    dest: string,
    onProgress?: (msg: string) => void,
    maxAttempts = 3
  ): Promise<void> {
    const curl = LocalRuntimeManager.curlPath();
    return new Promise((resolve, reject) => {
      onProgress?.('Downloading...');
      const args = [
        '-L',                       // follow redirects
        '-C', '-',                  // resume a partial file
        '--connect-timeout', '30',
        '--retry', String(maxAttempts),
        '--retry-delay', '3',
        '--retry-connrefused',
        '--speed-limit', '1024',    // < 1 KB/s ...
        '--speed-time', '60',       // ... for 60s ⇒ abort (then --retry kicks in)
        '--fail',                   // non-2xx ⇒ non-zero exit
        '--silent', '--show-error',
        '-o', dest,
        url,
      ];
      const proc = cp.execFile(curl, args, { timeout: 30 * 60 * 1000 }, (err, _stdout, stderr) => {
        if (err) {
          // Exit 33: range/resume not supported by server — retry from scratch.
          if (/\b33\b/.test(String(err.message))) {
            try { fs.unlinkSync(dest); } catch { /* ignore */ }
          }
          reject(new Error((stderr || err.message).trim()));
          return;
        }
        resolve();
      });
      proc.on('error', (e) => reject(e));
    });
  }

  private downloadOnce(url: string, dest: string, onProgress?: (msg: string) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(dest);
      let downloaded = 0;
      let total = 0;
      let lastPct = -1;
      let settled = false;
      const fail = (err: Error) => {
        if (settled) {return;}
        settled = true;
        file.destroy();
        reject(err);
      };

      const doRequest = (u: string, redirectCount = 0): void => {
        if (redirectCount > 10) {
          fail(new Error('Too many redirects'));
          return;
        }
        const protocol = u.startsWith('https://') ? https : http;
        // 120s socket-inactivity timeout — large mirrors can pause mid-transfer.
        const req = protocol.get(u, { timeout: 120000 }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 307) {
            const location = res.headers.location;
            if (!location) { fail(new Error('Redirect without Location header')); return; }
            res.resume();
            doRequest(location, redirectCount + 1);
            return;
          }
          if (res.statusCode !== 200) {
            fail(new Error(`HTTP ${res.statusCode} downloading ${u}`));
            return;
          }
          total = parseInt(res.headers['content-length'] ?? '0', 10);

          res.on('data', (chunk: Buffer) => {
            downloaded += chunk.length;
            if (total > 0 && onProgress) {
              const pct = Math.floor((downloaded / total) * 100);
              if (pct !== lastPct && pct % 10 === 0) {
                lastPct = pct;
                onProgress(`Downloading... ${pct}%`);
              }
            }
          });
          res.on('error', (err) => fail(err));

          res.pipe(file);
          file.on('finish', () => {
            if (settled) {return;}
            settled = true;
            file.close(() => resolve());
          });
        });

        req.on('error', (err) => fail(err));
        req.on('timeout', () => { req.destroy(); fail(new Error(`Request timed out: ${u}`)); });
      };

      file.on('error', (err) => fail(err));
      doRequest(url);
    });
  }

  // ── Process helpers ───────────────────────────────────────────────────────

  private runProcess(
    cmd: string,
    args: string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(
        cmd, args,
        { timeout: 180000, maxBuffer: 1024 * 1024 * 50, cwd: options.cwd, env: options.env },
        (err, stdout, stderr) => {
          if (err) {reject(new Error(stderr || err.message));}
          else {resolve(stdout);}
        }
      );
    });
  }

  private async waitForPort(port: number, maxAttempts = 40): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.isPortOpen(port)) {return;}
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error(`Service on port ${port} did not start after ${maxAttempts} seconds.`);
  }

  /** Like waitForPort but resolves to false on timeout instead of throwing. */
  private async waitForPortQuiet(port: number, maxAttempts: number): Promise<boolean> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.isPortOpen(port)) {return true;}
      await new Promise((r) => setTimeout(r, 1000));
    }
    return false;
  }

  /**
   * Whether the given PID is actually a MariaDB/MySQL server process.
   * Guards against trusting a stale PID file whose PID was reused by an
   * unrelated process (common on Windows). Best-effort on non-Windows.
   */
  private isDbProcess(pid: number): boolean {
    if (os.platform() !== 'win32') {return true;}
    try {
      const out = cp.execSync(`tasklist /FI "PID eq ${pid}" /NH /FO CSV`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return /mariadbd?\.exe|mysqld\.exe/i.test(out);
    } catch {
      return false;
    }
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(500);
      socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
  }

  // ── Disposal ─────────────────────────────────────────────────────────────

  async dispose(): Promise<void> {
    await this.stopDatabase();
  }
}
