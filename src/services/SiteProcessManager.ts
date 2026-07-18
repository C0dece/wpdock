/**
 * SiteProcessManager — manages per-site PHP built-in server processes.
 * Also handles WordPress download, extraction, configuration and WP-CLI install.
 * No Docker required.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { Writable } from 'stream';
import { unzipSync } from 'fflate';
import { WPSite } from '../types';
import { LocalRuntimeManager, DB_PORT } from './LocalRuntimeManager';
import { ProxyRouterService } from './ProxyRouterService';
import { Logger } from '../utils/logger';

/**
 * Number of php-cgi workers per nginx site. php-cgi on Windows handles one
 * request per process, so a pool is required to avoid loopback (wp-cron) 502s.
 */
const PHP_CGI_WORKERS = 4;

/**
 * Crash-loop guard for php-cgi workers: if a single worker dies more than
 * CGI_MAX_RESTARTS times within CGI_RESTART_WINDOW_MS, automatic restart is
 * paused so a flapping worker can't spin the CPU or flood the log forever.
 */
const CGI_RESTART_WINDOW_MS = 60_000;
const CGI_MAX_RESTARTS = 5;

/** Returns locale-specific WP download URL. */
function wpDownloadUrl(locale?: string): string {
  const loc = locale ?? 'ru_RU';
  if (loc === 'en_US' || loc === 'en') {
    return 'https://wordpress.org/latest.zip';
  }
  // e.g. https://downloads.wordpress.org/release/ru_RU/wordpress-latest.zip
  return `https://downloads.wordpress.org/release/${loc}/wordpress-latest.zip`;
}

/**
 * PHP built-in server router for WordPress.
 * Emulates mod_rewrite: serves real files directly, routes everything else to index.php.
 */
const WP_ROUTER_PHP = `<?php
/**
 * WPDock PHP built-in server router for WordPress.
 * Drop in the site root (next to wp-config.php).
 */
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$docRoot = $_SERVER['DOCUMENT_ROOT'];
$file = rtrim($docRoot, '/\\\\') . '/' . ltrim($path, '/');

// Serve real files (CSS, JS, images, PHP files in subdirs) directly
// Also allow real directories (e.g. /wp-admin) so built-in server can serve
// their index.php instead of routing everything to front controller.
if ($path !== '/' && file_exists($file)) {
    return false;
}

// WordPress entry point
$_SERVER['SCRIPT_FILENAME'] = $docRoot . '/index.php';
require $docRoot . '/index.php';
`;

/** Auth/secret key names in wp-config-sample.php */
const WP_SECRET_KEYS = [
  'AUTH_KEY', 'SECURE_AUTH_KEY', 'LOGGED_IN_KEY', 'NONCE_KEY',
  'AUTH_SALT', 'SECURE_AUTH_SALT', 'LOGGED_IN_SALT', 'NONCE_SALT',
];

export interface SiteSetupOptions {
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
  dbName: string;
  dbUser: string;
  dbPass: string;
}

interface StaleRuntimeProcess {
  ProcessId?: number;
  Name?: string;
  CommandLine?: string;
}

export class SiteProcessManager {
  /** Map of siteId → running PHP process */
  private readonly processes = new Map<string, cp.ChildProcess>();
  /** Map of siteId → Nginx/Apache process */
  private readonly serverProcs = new Map<string, cp.ChildProcess>();
  /** Map of siteId → local SMTP capture server used by PHP mail() on Windows. */
  private readonly mailServers = new Map<string, net.Server>();
  private readonly mailPorts = new Map<string, number>();
  /** Map of siteId → open log streams that can block Windows directory deletion */
  private readonly logStreams = new Map<string, Set<Writable>>();
  /** Sites that are being stopped intentionally; exit handlers must not self-heal them. */
  private readonly stoppingSites = new Set<string>();
  /** Restart timestamps per php-cgi worker key, for crash-loop detection. */
  private readonly cgiRestarts = new Map<string, number[]>();

  /** Called when a site process exits unexpectedly after a successful start. */
  onSiteExited?: (siteId: string) => void;

  constructor(
    private readonly runtime: LocalRuntimeManager,
    private readonly proxyRouter?: ProxyRouterService
  ) { }

  // ── Site setup ────────────────────────────────────────────────────────────

  /**
   * Full first-time site setup:
   *  1. Create directory structure
   *  2. Download + extract WordPress into `{sitePath}/public/`
   *  3. Write wp-config.php
   *  4. Create database + user
   *  5. Run `wp core install` via WP-CLI
   */
  async setupNewSite(
    site: WPSite,
    opts: SiteSetupOptions,
    onProgress?: (msg: string) => void
  ): Promise<void> {
    const publicDir = this.publicDir(site);
    const logsDir = path.join(site.path, 'logs');

    fs.mkdirSync(site.path, { recursive: true });
    this.removePathIfExists(publicDir);
    fs.mkdirSync(publicDir, { recursive: true });
    fs.mkdirSync(logsDir, { recursive: true });

    // Router script — lives next to public/ (parent of WordPress root)
    const routerPath = path.join(site.path, 'router.php');
    fs.writeFileSync(routerPath, WP_ROUTER_PHP, 'utf-8');

    // ── Download WordPress ────────────────────────────────────────────────
    const locale = site.locale ?? 'ru_RU';
    onProgress?.(`Скачивание WordPress (${locale})...`);
    const wpZip = path.join(os.tmpdir(), `wpdock-wordpress-${crypto.randomUUID()}.zip`);
    try {
      await this.downloadWordPress(wpZip, locale, onProgress);

      onProgress?.('Распаковка WordPress...');
      this.extractWordPressZipToPublic(wpZip, publicDir);
    } finally {
      try { fs.unlinkSync(wpZip); } catch { /* ignore */ }
      // Cleanup leftovers created by older builds inside the site folder.
      try { fs.rmSync(path.join(site.path, '_wp_extract'), { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(site.path, 'wordpress'), { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(path.join(publicDir, 'wordpress'), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    // wp-content must be a normal directory in the WordPress document root.
    this.normalizeWordPressLayout(site);

    // ── wp-config.php ────────────────────────────────────────────────────
    onProgress?.('Configuring WordPress...');
    this.writeWpConfig(publicDir, site, opts);

    // ── Database setup ───────────────────────────────────────────────────
    onProgress?.('Creating database...');
    await this.runtime.createSiteDatabase(opts.dbName, opts.dbUser, opts.dbPass);

    // ── WP-CLI core install ──────────────────────────────────────────────
    onProgress?.('Установка WordPress (WP-CLI)...');
    const siteUrl = this.getSiteUrl(site);
    await this.runtime.runWpCli(
      [
        'core', 'install',
        `--path=${publicDir}`,
        `--url=${siteUrl}`,
        `--title=${site.name}`,
        `--admin_user=${opts.adminUser}`,
        `--admin_password=${opts.adminPassword}`,
        `--admin_email=${opts.adminEmail}`,
        `--locale=${site.locale ?? 'ru_RU'}`,
        '--skip-email',
      ],
      publicDir,
      site.phpVersion,
      { WP_CLI_ALLOW_ROOT: '1' }
    );

    // ── mu-plugins autologin helper ──────────────────────────────────────
    onProgress?.('Настройка MU-плагинов...');
    this.writeMuPlugins(site);

    onProgress?.('WordPress установлен.');
  }

  // ── Process lifecycle ─────────────────────────────────────────────────────

  /** Start PHP built-in server for this site (also starts the DB). */
  async startSite(site: WPSite): Promise<void> {
    Logger.log(`[site] \u0417\u0430\u043f\u0443\u0441\u043a \u00ab${site.name}\u00bb (\u0432\u0435\u0431-\u0441\u0435\u0440\u0432\u0435\u0440: ${site.webServer ?? 'php'}, SSL: ${site.ssl ?? false})`);
    await this.runtime.startDatabase();
    this.writeMuPlugins(site);
    await this.startLocalMailServer(site);
    // A VS Code reload/crash can leave nginx/php-cgi/php processes alive while
    // the new extension host has an empty in-memory process map. Kill processes
    // whose command line points at this site before binding ports again.
    await this.killStaleSiteProcesses(site);

    const preferredServer = site.webServer ?? 'php';

    if (preferredServer === 'nginx' || preferredServer === 'apache') {
      try {
        if (preferredServer === 'nginx') {
          await this.startNginx(site);
        } else {
          await this.startApache(site);
        }

        // Guard against a common php-cgi misconfiguration where the server starts,
        // but every request returns "No input file specified".
        if (await this.hasNoInputFileError(site.port, site.domain)) {
          throw new Error('Upstream PHP reports: No input file specified');
        }
      } catch (err) {
        Logger.error(`[site] ${preferredServer} failed for "${site.name}", falling back to PHP built-in`, err);
        await this.stopSite(site);
        await this.startPhpServer(site);
      }
    } else {
      await this.startPhpServer(site);
    }

    Logger.log(`[site] «${site.name}» запущен.`);
  }

  /** Stop the PHP built-in server (and web server) for this site. */
  async stopSite(site: WPSite): Promise<void> {
    this.stoppingSites.add(site.id);
    // Stop Nginx/Apache process
    const serverProc = this.serverProcs.get(site.id);
    const waits: Array<Promise<void>> = [];
    try {
      if (serverProc && this.isProcessActive(serverProc)) {
        waits.push(this.terminateProcess(serverProc, `server:${site.id}`));
      }
      this.serverProcs.delete(site.id);

      // Stop PHP process
      const proc = this.processes.get(site.id);
      if (proc && this.isProcessActive(proc)) {
        waits.push(this.terminateProcess(proc, `php:${site.id}`));
      }
      this.processes.delete(site.id);

      // Stop PHP-CGI worker pool used by nginx mode (if running).
      // Workers are keyed `${site.id}-cgi-${idx}`; also clear the legacy single key.
      for (const key of [...this.processes.keys()]) {
        if (key === `${site.id}-cgi` || key.startsWith(`${site.id}-cgi-`)) {
          const cgiProc = this.processes.get(key);
          if (cgiProc && this.isProcessActive(cgiProc)) {
            waits.push(this.terminateProcess(cgiProc, key));
          }
          this.processes.delete(key);
        }
      }

      await Promise.allSettled(waits);
      this.closeSiteLogStreams(site.id);
      this.stopLocalMailServer(site.id);
      await this.killStaleSiteProcesses(site);
    } finally {
      this.stoppingSites.delete(site.id);
    }
  }

  /** Returns true if the PHP server for this site is still running. */
  isSiteRunning(siteId: string): boolean {
    // In php mode we track the server process in `processes` by siteId.
    // In nginx/apache mode the primary process is tracked in `serverProcs`.
    const phpProc = this.processes.get(siteId);
    const webProc = this.serverProcs.get(siteId);
    return Boolean((phpProc && this.isProcessActive(phpProc)) || (webProc && this.isProcessActive(webProc)));
  }

  /** Stop all running PHP servers (called on extension deactivate). */
  stopAll(): void {
    for (const [siteId, proc] of this.serverProcs.entries()) {
      this.forceKillProcessTree(proc, `server:${siteId}`);
    }
    this.serverProcs.clear();

    for (const [siteId, proc] of this.processes.entries()) {
      this.forceKillProcessTree(proc, `php:${siteId}`);
    }
    this.processes.clear();
    for (const siteId of [...this.mailServers.keys()]) {
      this.stopLocalMailServer(siteId);
    }
    for (const siteId of this.logStreams.keys()) {
      this.closeSiteLogStreams(siteId);
    }
  }

  private forceKillProcessTree(proc: cp.ChildProcess, label: string): void {
    if (!this.isProcessActive(proc)) {return;}

    try {
      if (os.platform() === 'win32' && proc.pid) {
        cp.execFile(
          'taskkill',
          ['/PID', String(proc.pid), '/T', '/F'],
          { windowsHide: true },
          (err) => {
            if (err) {
              Logger.error(`[site] failed to force-kill process tree ${label}`, err);
            }
          }
        );
        return;
      }

      proc.kill('SIGKILL');
    } catch (err) {
      Logger.error(`[site] failed to force-kill process ${label}`, err);
    }
  }

  // ── URL helpers ───────────────────────────────────────────────────────────

  /** Returns the effective site URL (http/https, domain or localhost). */
  getSiteUrl(site: WPSite): string {
    // If proxy router is running and the site has a domain, use the portless proxy URL
    if (this.proxyRouter?.isRunning() && site.domain) {
      return this.proxyRouter.getPublicUrl(site);
    }
    // Fallback: direct localhost with port (no HTTPS without portproxy)
    const host = site.domain ?? 'localhost';
    return `http://${host}:${site.port}`;
  }

  // ── mu-plugins ────────────────────────────────────────────────────────────

  /** Writes wpdock-autologin.php to wp-content/mu-plugins for magic-link support. */
  writeMuPlugins(site: WPSite): void {
    const muDir = path.join(this.getContentDir(site), 'mu-plugins');
    fs.mkdirSync(muDir, { recursive: true });
    const pluginPath = path.join(muDir, 'wpdock-autologin.php');
    const pluginCode = `<?php
/**
 * WPDock Auto-Login MU-Plugin
 * Handles ?wpdock_token=TOKEN magic-link login for local development.
 * Auto-generated — do not edit manually.
 */
if ( ! defined( 'ABSPATH' ) ) exit;

add_action( 'init', function () {
    if ( empty( $_GET['wpdock_token'] ) ) return;
    $token   = sanitize_text_field( $_GET['wpdock_token'] );
    $user_id = get_transient( 'wpdock_autologin_' . $token );
    if ( ! $user_id ) return;
  $user_id = (int) $user_id;
  if ( $user_id <= 0 ) return;
    delete_transient( 'wpdock_autologin_' . $token );
  wp_set_current_user( $user_id );
    wp_set_auth_cookie( $user_id, true );
  do_action( 'wp_login', wp_get_current_user()->user_login, wp_get_current_user() );
    wp_redirect( admin_url() );
    exit;
} );
`;
    fs.writeFileSync(pluginPath, pluginCode, 'utf-8');
  }

  /**
   * Normalizes site files after create/reset/reinstall:
   * - removes old temporary extract folders from the site;
   * - guarantees `public/wp-content` is a real directory, not a junction;
   * - migrates legacy top-level `wp-content` into `public/wp-content`.
   */
  normalizeWordPressLayout(site: WPSite): void {
    const publicDir = this.publicDir(site);
    const publicContentDir = path.join(publicDir, 'wp-content');
    const legacyContentDir = path.join(site.path, 'wp-content');

    try { fs.rmSync(path.join(site.path, '_wp_extract'), { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(site.path, 'wordpress'), { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(path.join(publicDir, 'wordpress'), { recursive: true, force: true }); } catch { /* ignore */ }

    this.ensurePublicWpContentDirectory(site);

    if (fs.existsSync(legacyContentDir)) {
      try {
        fs.cpSync(legacyContentDir, publicContentDir, { recursive: true, force: true, dereference: true });
        fs.rmSync(legacyContentDir, { recursive: true, force: true });
      } catch (err) {
        Logger.error(`[site] failed to migrate legacy wp-content for "${site.name}"`, err);
      }
    }
  }

  // ── Local mail capture ────────────────────────────────────────────────────

  private async startLocalMailServer(site: WPSite): Promise<void> {
    if (this.mailServers.has(site.id) && this.mailPorts.has(site.id)) {
      return;
    }

    const port = await this.pickFreePort(site.port + 250);
    const server = net.createServer((socket) => this.handleMailSocket(site, socket));

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.off('listening', onListening);
        reject(err);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });

    this.mailServers.set(site.id, server);
    this.mailPorts.set(site.id, port);
    fs.mkdirSync(this.getLocalMailDir(site), { recursive: true });
    Logger.log(`[mail] Локальный SMTP capture для «${site.name}» запущен на 127.0.0.1:${port}`);
  }

  private stopLocalMailServer(siteId: string): void {
    const server = this.mailServers.get(siteId);
    if (server) {
      try { server.close(); } catch { /* ignore */ }
    }
    this.mailServers.delete(siteId);
    this.mailPorts.delete(siteId);
  }

  private handleMailSocket(site: WPSite, socket: net.Socket): void {
    let buffer = '';
    let dataMode = false;
    let mailFrom = '';
    const rcptTo: string[] = [];
    const dataLines: string[] = [];

    const write = (line: string) => socket.write(`${line}\r\n`);
    write('220 WPDock local mail capture ready');

    const saveMessage = () => {
      const rawMessage = dataLines.join('\r\n');
      this.saveCapturedMail(site, mailFrom, rcptTo, rawMessage);
      dataLines.length = 0;
    };

    const handleLine = (rawLine: string) => {
      const line = rawLine.replace(/\r$/, '');
      if (dataMode) {
        if (line === '.') {
          dataMode = false;
          saveMessage();
          write('250 2.0.0 Message captured by WPDock');
          return;
        }
        dataLines.push(line.startsWith('..') ? line.slice(1) : line);
        return;
      }

      const command = line.split(/\s+/, 1)[0]?.toUpperCase() ?? '';
      if (command === 'EHLO') {
        socket.write('250-WPDock\r\n250-8BITMIME\r\n250 OK\r\n');
      } else if (command === 'HELO') {
        write('250 WPDock');
      } else if (command === 'MAIL') {
        mailFrom = line.replace(/^MAIL\s+FROM:\s*/i, '').trim();
        write('250 2.1.0 OK');
      } else if (command === 'RCPT') {
        rcptTo.push(line.replace(/^RCPT\s+TO:\s*/i, '').trim());
        write('250 2.1.5 OK');
      } else if (command === 'DATA') {
        dataMode = true;
        write('354 End data with <CR><LF>.<CR><LF>');
      } else if (command === 'RSET') {
        mailFrom = '';
        rcptTo.length = 0;
        dataLines.length = 0;
        dataMode = false;
        write('250 OK');
      } else if (command === 'NOOP') {
        write('250 OK');
      } else if (command === 'QUIT') {
        write('221 Bye');
        socket.end();
      } else {
        write('250 OK');
      }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index = buffer.indexOf('\n');
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
        index = buffer.indexOf('\n');
      }
    });
  }

  private saveCapturedMail(site: WPSite, mailFrom: string, rcptTo: string[], rawMessage: string): void {
    const mailDir = this.getLocalMailDir(site);
    fs.mkdirSync(mailDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(mailDir, `${stamp}-${crypto.randomBytes(3).toString('hex')}.eml`);
    const envelope = [
      `X-WPDock-Site: ${site.name}`,
      `X-WPDock-Transport: local-smtp-capture`,
      `X-WPDock-Mail-From: ${mailFrom}`,
      `X-WPDock-Rcpt-To: ${rcptTo.join(', ')}`,
      '',
    ].join('\r\n');
    fs.writeFileSync(filePath, `${envelope}${rawMessage}`, 'utf-8');
    Logger.log(`[mail] Письмо сайта «${site.name}» сохранено: ${filePath}`);
  }

  private writeSendmailShim(site: WPSite): string {
    const binDir = path.join(site.path, 'bin');
    fs.mkdirSync(binDir, { recursive: true });
    const scriptPath = path.join(binDir, 'wpdock-sendmail');
    const mailDir = this.getLocalMailDir(site).replace(/'/g, `'\\''`);
    const code = `#!/bin/sh
MAIL_DIR='${mailDir}'
mkdir -p "$MAIL_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$MAIL_DIR/$STAMP-$$.eml"
{
  echo "X-WPDock-Transport: sendmail-shim"
  echo "X-WPDock-Args: $*"
  echo
  cat
} > "$OUT"
exit 0
`;
    fs.writeFileSync(scriptPath, code, { encoding: 'utf-8', mode: 0o755 });
    try { fs.chmodSync(scriptPath, 0o755); } catch { /* ignore */ }
    return scriptPath;
  }

  private defaultMailFrom(site: WPSite): string {
    const host = (site.domain || `${site.name}.local`)
      .toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/\/.*$/, '')
      .replace(/[^a-z0-9.-]/g, '-')
      .replace(/^-+|-+$/g, '') || 'wpdock.local';
    return `wordpress@${host}`;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  // ── Nginx ─────────────────────────────────────────────────────────────────

  private async startNginx(site: WPSite): Promise<void> {
    site.port = await this.pickFreePort(site.port);
    Logger.log(`[nginx] Запуск для «${site.name}» на порту ${site.port}`);

    const nginxExe = await this.runtime.ensureNginx();
    const nginxDir = path.dirname(nginxExe); // e.g. …/runtime/nginx
    const confPath = await this.writeNginxConfig(site, nginxDir);
    Logger.log(`[nginx] Конфиг записан: ${confPath}`);

    const logsDir = path.join(site.path, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'nginx.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.trackLogStream(site.id, logStream);

    // Use -p to set nginx prefix so it can locate its own shared files (temp, client_body, etc.)
    const proc = cp.spawn(nginxExe, ['-p', nginxDir, '-c', confPath, '-g', 'daemon off;'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    // Fast-fail: if nginx exits before the port opens we report immediately
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => {
        this.releaseLogStream(site.id, logStream);
        const hint = stderrBuf.trim().slice(0, 400) || `Проверьте лог: ${logFile}`;
        Logger.error(`[nginx] Процесс завершился (код ${code}). ${hint}`);
        reject(new Error(`Nginx завершился (код ${code}). ${hint}`));
      };
      proc.once('exit', onExit);
      this.waitForPort(site.port, 30, 'Nginx').then(() => {
        proc.removeListener('exit', onExit);
        resolve();
      }, reject);
    });

    proc.on('exit', () => { this.serverProcs.delete(site.id); this.releaseLogStream(site.id, logStream); });
    this.serverProcs.set(site.id, proc);
    Logger.log(`[nginx] Запущен, PID ${proc.pid}`);
  }

  /**
   * Writes an nginx.conf for the site.
   * Uses absolute paths for mime.types / fastcgi_params so nginx doesn't look
   * in the site directory (which would always fail).
   */
  private async writeNginxConfig(site: WPSite, nginxDir: string): Promise<string> {
    // PHP-CGI on Windows (`-b`) is single-threaded: one worker serves one request
    // at a time. WordPress fires loopback requests (wp-cron, admin-ajax, REST) while
    // rendering a page, so a single worker deadlocks → nginx returns 502. Start a
    // small pool of workers and let nginx load-balance across them via an upstream.
    const basePort = site.port + 100;
    const cgiPorts = await this.startPhpCgiPool(site, basePort, PHP_CGI_WORKERS);
    const upstreamName = `php_${site.id.replace(/[^a-zA-Z0-9_]/g, '_')}`;

    const pubDir = this.publicDir(site).replace(/\\/g, '/');
    const logDir = path.join(site.path, 'logs').replace(/\\/g, '/');
    // Absolute paths to nginx's own conf files (under {nginxDir}/conf/)
    const confDir = path.join(nginxDir, 'conf').replace(/\\/g, '/');
    const mimeTypes = `${confDir}/mime.types`;
    const fcgiParams = `${confDir}/fastcgi_params`;
    const upstreamServers = cgiPorts
      .map((p) => `    server 127.0.0.1:${p};`)
      .join('\n');

    const conf = `
worker_processes 1;
error_log  ${logDir}/nginx-error.log  warn;
events { worker_connections 1024; }
http {
  include       "${mimeTypes}";
  default_type  application/octet-stream;
  upstream ${upstreamName} {
${upstreamServers}
  }
  server {
    listen      ${site.port};
    server_name ${site.domain ?? 'localhost'};
    root        "${pubDir}";
    index       index.php index.html;
    access_log  "${logDir}/nginx-access.log";

    location / {
      try_files $uri $uri/ /index.php$is_args$args;
    }
    location ~ \\.php$ {
      try_files      $uri =404;
      include        "${fcgiParams}";
      fastcgi_param  SCRIPT_FILENAME  $realpath_root$fastcgi_script_name;
      fastcgi_param  DOCUMENT_ROOT    $realpath_root;
      fastcgi_param  PATH_INFO        $fastcgi_path_info;
      fastcgi_pass   ${upstreamName};
      fastcgi_index  index.php;
      fastcgi_connect_timeout 10s;
      fastcgi_send_timeout    300s;
      fastcgi_read_timeout    300s;
      fastcgi_next_upstream   error timeout invalid_header http_503;
    }
    location ~* \\.(jpg|jpeg|png|gif|ico|css|js|svg|woff|woff2|ttf)$ {
      expires 30d;
      add_header Cache-Control "public";
    }
  }
}
`;
    const confPath = path.join(site.path, 'nginx.conf');
    fs.writeFileSync(confPath, conf, 'utf-8');
    return confPath;
  }

  /**
   * Starts a pool of PHP-CGI workers for Nginx FastCGI and returns their ports.
   * Each worker is a separate php-cgi.exe bound to its own port; nginx balances
   * across them. This prevents the single-worker 502 deadlock when WordPress
   * issues loopback requests (wp-cron / admin-ajax) while rendering a page.
   */
  private async startPhpCgiPool(site: WPSite, basePort: number, count: number): Promise<number[]> {
    // Fresh start → reset crash-loop counters for this site's workers.
    for (let i = 0; i < count; i++) {
      this.cgiRestarts.delete(`${site.id}-cgi-${i}`);
    }
    const ports: number[] = [];
    for (let i = 0; i < count; i++) {
      const port = await this.pickFreePort(basePort + i);
      await this.startPhpCgi(site, port, i);
      ports.push(port);
    }
    return ports;
  }

  /** Starts a single PHP-CGI worker (index `idx`) for Nginx FastCGI. */
  private async startPhpCgi(site: WPSite, port: number, idx: number): Promise<void> {
    const phpDir = path.dirname(this.runtime.phpExe(site.phpVersion));
    const cgiExe = path.join(phpDir, os.platform() === 'win32' ? 'php-cgi.exe' : 'php-cgi');
    if (!fs.existsSync(cgiExe)) {
      throw new Error(`PHP-CGI не найден: ${cgiExe}. Nginx требует php-cgi.`);
    }
    Logger.log(`[php-cgi] Запуск воркера #${idx} на порту ${port}: ${cgiExe}`);
    const iniPath = this.getSitePhpIni(site);
    const logsDir = path.join(site.path, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, `php-cgi-${idx}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.trackLogStream(site.id, logStream);
    const proc = cp.spawn(cgiExe, ['-c', iniPath, '-b', `127.0.0.1:${port}`], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);
    let stderrBuf = '';
    proc.stderr?.on('data', (d: Buffer) => { stderrBuf += d.toString(); });
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => {
        this.releaseLogStream(site.id, logStream);
        const hint = stderrBuf.trim().slice(0, 300) || 'Нет подробностей';
        Logger.error(`[php-cgi] Воркер #${idx} завершился (код ${code}). ${hint}`);
        reject(new Error(`PHP-CGI завершился (код ${code}). ${hint}`));
      };
      proc.once('exit', onExit);
      this.waitForPort(port, 20, 'PHP-CGI').then(() => {
        proc.removeListener('exit', onExit);
        resolve();
      }, reject);
    });
    this.processes.set(`${site.id}-cgi-${idx}`, proc);
    proc.on('exit', (code) => {
      this.processes.delete(`${site.id}-cgi-${idx}`);
      this.releaseLogStream(site.id, logStream);
      if (this.stoppingSites.has(site.id)) {
        Logger.log(`[php-cgi] Воркер #${idx} сайта «${site.name}» остановлен`);
        return;
      }

      // Crash-loop guard: if this worker keeps dying, stop hammering restarts.
      const restartKey = `${site.id}-cgi-${idx}`;
      const now = Date.now();
      const history = (this.cgiRestarts.get(restartKey) ?? []).filter((t) => now - t < CGI_RESTART_WINDOW_MS);
      history.push(now);
      this.cgiRestarts.set(restartKey, history);

      if (history.length > CGI_MAX_RESTARTS) {
        Logger.error(
          `[php-cgi] Воркер #${idx} сайта «${site.name}» падает слишком часто ` +
          `(${history.length} раз за минуту) — автоперезапуск приостановлен. ` +
          `Вероятная причина: тяжёлый фоновый процесс (wp-cron / WooCommerce Action Scheduler). ` +
          `Перезапустите сайт вручную.`
        );
        return;
      }

      // Exponential backoff so a flapping worker doesn't spin the CPU.
      const backoff = Math.min(750 * 2 ** (history.length - 1), 10_000);
      Logger.error(`[php-cgi] Воркер #${idx} сайта «${site.name}» завершился (код ${code}) — перезапуск через ${backoff} мс`);
      setTimeout(() => {
        const webProc = this.serverProcs.get(site.id);
        if (this.stoppingSites.has(site.id) || !webProc || !this.isProcessActive(webProc)) {
          return;
        }
        void this.startPhpCgi(site, port, idx).catch((err) => {
          Logger.error(`[php-cgi] Не удалось перезапустить воркер #${idx} сайта «${site.name}»`, err);
          this.onSiteExited?.(site.id);
        });
      }, backoff);
    });
    Logger.log(`[php-cgi] Воркер #${idx} запущен, PID ${proc.pid}`);
  }

  // ── Apache ────────────────────────────────────────────────────────────────

  private async startApache(site: WPSite): Promise<void> {
    site.port = await this.pickFreePort(site.port);
    Logger.log(`[apache] Запуск для «${site.name}» на порту ${site.port}`);

    const apacheExe = await this.runtime.ensureApache();
    const confPath = this.writeApacheConfig(site);

    const logsDir = path.join(site.path, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const logFile = path.join(logsDir, 'apache.log');
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.trackLogStream(site.id, logStream);

    const proc = cp.spawn(apacheExe, ['-f', confPath, '-DFOREGROUND'], {
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    // Fast-fail: if apache exits before the port opens we report immediately
    await new Promise<void>((resolve, reject) => {
      const onExit = (code: number | null) => {
        this.releaseLogStream(site.id, logStream);
        const hint = stderrBuf.trim().slice(0, 400) || `Проверьте лог: ${logFile}`;
        Logger.error(`[apache] Процесс завершился (код ${code}). ${hint}`);
        reject(new Error(`Apache завершился (код ${code}). ${hint}`));
      };
      proc.once('exit', onExit);
      this.waitForPort(site.port, 30, 'Apache').then(() => {
        proc.removeListener('exit', onExit);
        resolve();
      }, reject);
    });

    proc.on('exit', () => { this.serverProcs.delete(site.id); this.releaseLogStream(site.id, logStream); });
    this.serverProcs.set(site.id, proc);
    Logger.log(`[apache] Запущен, PID ${proc.pid}`);
  }

  private writeApacheConfig(site: WPSite): string {
    const apacheDir = path.dirname(this.runtime.apachePath);
    const pubDir = this.publicDir(site).replace(/\\/g, '/');
    const logDir = path.join(site.path, 'logs').replace(/\\/g, '/');
    const phpExe = this.runtime.phpExe(site.phpVersion).replace(/\\/g, '/');
    const iniPath = this.getSitePhpIni(site).replace(/\\/g, '/');
    const conf = `
ServerRoot "${apacheDir.replace(/\\/g, '/')}"
Listen ${site.port}
ServerName ${site.domain ?? 'localhost'}

LoadModule rewrite_module modules/mod_rewrite.so
LoadModule cgi_module     modules/mod_cgi.so
LoadModule mime_module    modules/mod_mime.so
LoadModule dir_module     modules/mod_dir.so
LoadModule log_config_module modules/mod_log_config.so
LoadModule authz_core_module modules/mod_authz_core.so

DocumentRoot "${pubDir}"
ErrorLog  "${logDir}/apache-error.log"
CustomLog "${logDir}/apache-access.log" combined

<Directory "${pubDir}">
  AllowOverride All
  Require all granted
  Options +ExecCGI -Indexes

  DirectoryIndex index.php index.html
</Directory>

Action  application/x-httpd-php "${phpExe}"
AddType application/x-httpd-php .php

<FilesMatch "\\.php$">
  SetHandler application/x-httpd-php
</FilesMatch>

SetEnv PHPRC "${iniPath}"
`;
    const confPath = path.join(site.path, 'httpd.conf');
    fs.writeFileSync(confPath, conf, 'utf-8');
    return confPath;
  }

  private async startPhpServer(site: WPSite): Promise<void> {
    if (this.isSiteRunning(site.id)) {return;}

    // Auto-select a free port at startup — if the saved port is taken, pick a new one.
    site.port = await this.pickFreePort(site.port);
    Logger.log(`[php] \u0417\u0430\u043f\u0443\u0441\u043a \u00ab${site.name}\u00bb \u043d\u0430 \u043f\u043e\u0440\u0442\u0443 ${site.port}`);

    const publicDir = this.publicDir(site);
    const routerPath = path.join(site.path, 'router.php');
    const iniPath = this.getSitePhpIni(site);
    const logFile = path.join(site.path, 'logs', 'php-server.log');
    const phpExe = this.runtime.phpExe(site.phpVersion);

    // Fail fast if PHP executable doesn’t exist
    if (phpExe !== 'php' && !fs.existsSync(phpExe)) {
      throw new Error(
        `PHP ${site.phpVersion} не найден (путь: ${phpExe}). ` +
        `Нажмите кнопку "Установить runtime" на главной странице или создайте новый сайт.`
      );
    }

    // Always refresh router.php so fixes are applied to already created sites.
    fs.mkdirSync(path.dirname(routerPath), { recursive: true });
    fs.writeFileSync(routerPath, WP_ROUTER_PHP, 'utf-8');

    // PHP 8.1+ supports multiple worker processes
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PHP_CLI_SERVER_WORKERS: '4',
    };

    const args = [
      '-c', iniPath,
      '-S', `0.0.0.0:${site.port}`,
      '-t', publicDir,
      routerPath,
    ];

    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    this.trackLogStream(site.id, logStream);

    const proc = cp.spawn(phpExe, args, {
      cwd: publicDir,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });

    proc.stdout?.pipe(logStream);
    proc.stderr?.pipe(logStream);

    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => { stderrBuf += chunk.toString(); });

    this.processes.set(site.id, proc);

    // Race: port opens vs process exits early
    await new Promise<void>((resolve, reject) => {
      proc.once('exit', (code) => {
        this.processes.delete(site.id);
        this.releaseLogStream(site.id, logStream);
        const hint = stderrBuf.trim()
          ? `Ошибка PHP: ${stderrBuf.trim().slice(0, 200)}`
          : `Убедитесь, что PHP установлен: ${phpExe}`;
        reject(new Error(`PHP сервер завершился (код ${code}). ${hint}`));
      });
      this.waitForPort(site.port).then(resolve, reject);
    });

    // Process still running — register exit handler for cleanup
    proc.on('exit', (code) => {
      this.processes.delete(site.id);
      this.releaseLogStream(site.id, logStream);
      if (code !== null && code !== 0) {
        Logger.error(`[php] \u0421\u0435\u0440\u0432\u0435\u0440 \u00ab${site.name}\u00bb \u0437\u0430\u0432\u0435\u0440\u0448\u0438\u043b\u0441\u044f \u0441 \u043a\u043e\u0434\u043e\u043c ${code}`);
      }
      this.onSiteExited?.(site.id);
    });
    Logger.log(`[php] Сервер «${site.name}» запущен, PID ${proc.pid}`);
  }

  private async hasNoInputFileError(port: number, domain?: string): Promise<boolean> {
    const host = domain ?? 'localhost';
    const paths = ['/', '/index.php', '/wp-admin/', '/wp-login.php'];
    for (const p of paths) {
      if (await this.probeNoInputFile(port, p, host)) {
        return true;
      }
    }
    return false;
  }

  private probeNoInputFile(port: number, requestPath: string, host: string): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        {
          hostname: '127.0.0.1',
          port,
          path: requestPath,
          timeout: 5000,
          headers: { Host: host },
        },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            const lower = body.toLowerCase();
            resolve(
              lower.includes('no input file specified') ||
              lower.includes('входной файл не указан')
            );
          });
        }
      );

      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });
      req.on('error', () => resolve(false));
    });
  }

  /** Write wp-config.php from the sample file. */
  private writeWpConfig(publicDir: string, site: WPSite, opts: SiteSetupOptions): void {
    const samplePath = path.join(publicDir, 'wp-config-sample.php');
    if (!fs.existsSync(samplePath)) {
      throw new Error('wp-config-sample.php not found — WordPress may not have been extracted correctly.');
    }

    let config = fs.readFileSync(samplePath, 'utf-8');

    // DB connection
    config = config
      .replace("database_name_here", opts.dbName)
      .replace("username_here", opts.dbUser)
      .replace("password_here", opts.dbPass)
      .replace("'DB_HOST', 'localhost'", `'DB_HOST', '127.0.0.1:${DB_PORT}'`);

    // Secret keys — replace all at once
    for (const key of WP_SECRET_KEYS) {
      config = config.replace(
        new RegExp(`define\\(\\s*'${key}',\\s*'put your unique phrase here'\\s*\\);`),
        `define( '${key}', '${this.randomKey()}' );`
      );
    }

    // Strip any pre-existing WP_DEBUG-related defines from the sample
    // (wp-config-sample.php in WordPress 6.x already has: define( 'WP_DEBUG', false );)
    config = config.replace(
      /^[ \t]*define\s*\(\s*'WP_DEBUG(?:_LOG|_DISPLAY)?'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      ''
    );
    config = config.replace(
      /^[ \t]*define\s*\(\s*'SCRIPT_DEBUG'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      ''
    );

    // Ensure buildDebugBlock resolves WP_CONTENT_DIR to public/wp-content, not
    // to a legacy top-level wp-content from older WPDock builds.
    this.normalizeWordPressLayout(site);

    // Debug constants block
    const debugBlock = this.buildDebugBlock(site);

    // All URL + debug constants are inside debugBlock (buildDebugBlock)
    config = config.replace(
      "/* That's all, stop editing! Happy publishing. */",
      debugBlock + `/* That's all, stop editing! Happy publishing. */`
    );

    fs.writeFileSync(path.join(publicDir, 'wp-config.php'), config, 'utf-8');
  }

  /** Builds the full WPDock-managed block for wp-config.php (URL + debug constants). */
  private buildDebugBlock(site: WPSite): string {
    const debug = site.wpDebug ?? false;
    const debugLog = site.wpDebugLog ?? false;
    const scriptDbg = site.wpScriptDebug ?? false;
    const logFile = path.join(site.path, 'logs', 'wp-debug.log').replace(/\\/g, '/');
    const siteUrl = this.getSiteUrl(site);
    const contentDir = this.getContentDir(site).replace(/\\/g, '/');
    const contentUrl = `${siteUrl}/wp-content`;
    return [
      `// WPDock managed block — do not edit manually`,
      // Tell WordPress it's running over HTTPS when the WPDock proxy adds this header.
      // Required because PHP built-in server receives plain HTTP from the TLS proxy.
      `if ( ! empty( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && $_SERVER['HTTP_X_FORWARDED_PROTO'] === 'https' ) {`,
      `    $_SERVER['HTTPS'] = 'on';`,
      `    $_SERVER['SERVER_PORT'] = 443;`,
      `}`,
      `define( 'WP_HOME',        '${siteUrl}' );`,
      `define( 'WP_SITEURL',     '${siteUrl}' );`,
      `define( 'FORCE_SSL_ADMIN', ${site.ssl ? 'true' : 'false'} );`,
      `define( 'WP_CONTENT_DIR', '${contentDir}' );`,
      `define( 'WP_CONTENT_URL', '${contentUrl}' );`,
      `define( 'WP_DEBUG',         ${debug ? 'true' : 'false'} );`,
      `define( 'WP_DEBUG_LOG',     ${debugLog ? `'${logFile}'` : 'false'} );`,
      `define( 'WP_DEBUG_DISPLAY', ${debug && !debugLog ? 'true' : 'false'} );`,
      // Disable WordPress' built-in loopback cron. Locally it floods the small
      // php-cgi worker pool with concurrent loopback requests (WooCommerce
      // Action Scheduler fires `as_async_request_queue_runner` every minute),
      // which deadlocks the single-request php-cgi workers and crashes them.
      // Run cron manually when needed: `wp cron event run --due-now`.
      `define( 'DISABLE_WP_CRON', true );`,
      `define( 'SCRIPT_DEBUG',     ${scriptDbg ? 'true' : 'false'} );`,
      ``,
    ].join('\n') + '\n';
  }

  /**
   * Updates only the WPDock debug block inside an existing wp-config.php.
   * Safe to call on a running or stopped site.
   */
  updateWpConfig(site: WPSite): void {
    const configPath = path.join(this.publicDir(site), 'wp-config.php');
    if (!fs.existsSync(configPath)) {return;}

    let config = fs.readFileSync(configPath, 'utf-8');
    const newBlock = this.buildDebugBlock(site);

    // Strip any standalone defines that are now managed inside the WPDock block
    const standaloneDefines = [
      /^[ \t]*\/\/ WPDock managed block[^\n]*\n?/gm,
      /^[ \t]*if\s*\(\s*!\s*empty\s*\(\s*\$_SERVER\['HTTP_X_FORWARDED_PROTO'\]\s*\)\s*&&\s*\$_SERVER\['HTTP_X_FORWARDED_PROTO'\]\s*===\s*'https'\s*\)\s*\{\r?\n[ \t]*\$_SERVER\['HTTPS'\]\s*=\s*'on';\r?\n[ \t]*\$_SERVER\['SERVER_PORT'\]\s*=\s*443;\r?\n[ \t]*\}\r?\n?/gm,
      /^[ \t]*define\s*\(\s*'WP_DEBUG(?:_LOG|_DISPLAY)?'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'SCRIPT_DEBUG'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'WP_HOME'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'WP_SITEURL'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'FORCE_SSL_ADMIN'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'WP_CONTENT_DIR'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'WP_CONTENT_URL'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
      /^[ \t]*define\s*\(\s*'DISABLE_WP_CRON'\s*,\s*[^)]+\)\s*;\s*\n?/gm,
    ];
    for (const re of standaloneDefines) {
      config = config.replace(re, '');
    }

    // Replace existing WPDock block (support old and new marker, with or without the PHP if-block)
    const blockRe = /\/\/ WPDock (?:debug settings|managed block)[^\n]*\n[\s\S]*?define\s*\(\s*'SCRIPT_DEBUG'[^)]+\);\n/g;
    if (blockRe.test(config)) {
      config = config.replace(blockRe, newBlock);
    } else {
      // Inject before the "stop editing" marker if block is missing
      config = config.replace(
        "/* That's all, stop editing! Happy publishing. */",
        newBlock + `/* That's all, stop editing! Happy publishing. */`
      );
    }

    fs.writeFileSync(configPath, config, 'utf-8');
  }

  /** Updates the WordPress DB table prefix in wp-config.php. */
  setWpConfigTablePrefix(site: WPSite, prefix: string): void {
    const normalized = String(prefix || '').trim();
    if (!/^[a-zA-Z0-9_]+$/.test(normalized)) {
      throw new Error(`Invalid WordPress table prefix: ${prefix}`);
    }

    const configPath = path.join(this.publicDir(site), 'wp-config.php');
    if (!fs.existsSync(configPath)) {return;}

    let config = fs.readFileSync(configPath, 'utf-8');
    const assignment = `$table_prefix = '${normalized}';`;
    const tablePrefixRe = /^[ \t]*\$table_prefix\s*=\s*(['"])[^'"]*\1\s*;/m;

    if (tablePrefixRe.test(config)) {
      config = config.replace(tablePrefixRe, assignment);
    } else {
      const wpSettingsRe = /(\r?\n[ \t]*require_once\s+ABSPATH\s*\.\s*['"]wp-settings\.php['"]\s*;)/;
      if (wpSettingsRe.test(config)) {
        config = config.replace(wpSettingsRe, `\n${assignment}$1`);
      } else {
        config += `\n${assignment}\n`;
      }
    }

    fs.writeFileSync(configPath, config, 'utf-8');
    Logger.log(`[SiteProcessManager] wp-config table_prefix updated site=${site.name} prefix=${normalized}`);
  }

  /** Returns the path to the per-site php.ini (always regenerated on start). */
  private getSitePhpIni(site: WPSite): string {
    const iniPath = path.join(site.path, 'php.ini');

    const phpDir = path.dirname(this.runtime.phpExe(site.phpVersion));
    const extDir = path.join(phpDir, 'ext').replace(/\\/g, '/');
    const logFile = path.join(site.path, 'logs', 'php-error.log').replace(/\\/g, '/');
    const mailDir = this.getLocalMailDir(site).replace(/\\/g, '/');
    const mailPort = this.mailPorts.get(site.id);
    const sendmailFrom = this.defaultMailFrom(site);
    const sendmailShimPath = os.platform() !== 'win32'
      ? this.writeSendmailShim(site).replace(/\\/g, '/')
      : undefined;

    // Build a minimal, reliable php.ini from scratch every time.
    // Avoids issues with stale cached files or template mismatches.
    const lines = [
      `; WPDock — auto-generated for site: ${site.name}`,
      `; Re-generated on each start — do not edit manually`,
      ``,
      `[PHP]`,
      `extension_dir = "${extDir}"`,
      ``,
      `; WordPress required extensions`,
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
      ``,
      `; PHP settings`,
      `display_errors = On`,
      `error_reporting = E_ALL & ~E_DEPRECATED & ~E_STRICT`,
      `error_log = "${logFile}"`,
      `upload_max_filesize = 64M`,
      `post_max_size = 64M`,
      `memory_limit = 256M`,
      `max_execution_time = 120`,
      `date.timezone = UTC`,
      `cgi.fix_pathinfo = 1`,
      `cgi.force_redirect = 0`,
      ``,
      `; Local mail capture`,
      `; wp_mail() / PHP mail() messages are captured to: ${mailDir}`,
      `mail.add_x_header = On`,
      `sendmail_from = ${sendmailFrom}`,
      ...(os.platform() === 'win32' && mailPort ? [
        `SMTP = 127.0.0.1`,
        `smtp_port = ${mailPort}`,
      ] : []),
      ...(sendmailShimPath ? [
        `sendmail_path = "${sendmailShimPath}" -t -i`,
      ] : []),
      ``,
      `; Session`,
      `session.save_handler = files`,
      `session.save_path = "${path.join(site.path, 'tmp').replace(/\\/g, '/')}"`,
    ];

    // Ensure tmp dir exists (for PHP session storage)
    const tmpDir = path.join(site.path, 'tmp');
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    fs.mkdirSync(this.getLocalMailDir(site), { recursive: true });

    fs.writeFileSync(iniPath, lines.join('\n'), 'utf-8');
    return iniPath;
  }

  /** `{sitePath}/public` — the WordPress document root. */
  publicDir(site: WPSite): string {
    return path.join(site.path, 'public');
  }

  private getContentDir(site: WPSite): string {
    return path.join(this.publicDir(site), 'wp-content');
  }

  /** Directory where local wp_mail()/mail() messages are captured as .eml files. */
  getLocalMailDir(site: WPSite): string {
    return path.join(site.path, 'mail');
  }

  // ── WordPress download ────────────────────────────────────────────────────

  /**
   * Downloads WordPress or uses a local cache (7 days TTL).
   * Cached zip is stored in the runtime dir as `wp-cache-{locale}.zip`.
   */
  private async downloadWordPress(dest: string, locale?: string, onProgress?: (msg: string) => void): Promise<void> {
    const loc = locale ?? 'ru_RU';
    const cacheZip = this.runtime.wpCacheZip(loc);

    if (fs.existsSync(cacheZip)) {
      const stat = fs.statSync(cacheZip);
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 7 * 24 * 60 * 60 * 1000) {
        onProgress?.(`Используется кэш WordPress (${loc})...`);
        fs.copyFileSync(cacheZip, dest);
        return;
      }
    }

    onProgress?.(`Скачивание WordPress (${loc})...`);
    try {
      await this.runtime.downloadFile(wpDownloadUrl(loc), dest, onProgress);
    } catch (err) {
      // Download failed — fall back to a stale cache if we have one rather than
      // failing site creation outright.
      if (fs.existsSync(cacheZip)) {
        onProgress?.(`Не удалось скачать WordPress, используется устаревший кэш (${loc})...`);
        fs.copyFileSync(cacheZip, dest);
        return;
      }
      throw err;
    }

    // Save to cache for next time
    try { fs.copyFileSync(dest, cacheZip); } catch { /* ignore — caching is best-effort */ }
  }

  // ── Port helpers ──────────────────────────────────────────────────────────

  /** Finds the first free TCP port starting from `preferred`. */
  private pickFreePort(preferred: number): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(preferred, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        server.close(() => resolve(addr.port));
      });
      server.on('error', () => resolve(this.pickFreePort(preferred + 1)));
    });
  }

  private async waitForPort(port: number, maxAttempts = 30, context = 'Server'): Promise<void> {
    for (let i = 0; i < maxAttempts; i++) {
      if (await this.isPortOpen(port)) {return;}
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`${context} не запустился на порту ${port}. Проверьте панель Output → WPDock.`);
  }

  private isPortOpen(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = new net.Socket();
      socket.setTimeout(400);
      socket.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
      socket.on('error', () => resolve(false));
      socket.on('timeout', () => { socket.destroy(); resolve(false); });
    });
  }

  private moveExtractedEntry(sourcePath: string, destPath: string): void {
    if (fs.existsSync(destPath)) {
      fs.rmSync(destPath, { recursive: true, force: true });
    }

    try {
      fs.renameSync(sourcePath, destPath);
      return;
    } catch (err: any) {
      if (!['EPERM', 'EBUSY', 'EXDEV', 'ENOTEMPTY'].includes(String(err?.code ?? ''))) {
        throw err;
      }
    }

    fs.cpSync(sourcePath, destPath, { recursive: true });
    fs.rmSync(sourcePath, { recursive: true, force: true });
  }

  private extractWordPressZipToPublic(zipPath: string, publicDir: string): void {
    const data = fs.readFileSync(zipPath);
    const entries = unzipSync(new Uint8Array(data));
    const names = Object.keys(entries);

    const normalize = (name: string) => name.replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = names.map(normalize);
    const hasAt = (prefix: string, child: string) =>
      normalized.some((name) => name === `${prefix}${child}` || name.startsWith(`${prefix}${child}/`));

    const prefix = (() => {
      if (hasAt('', 'wp-admin') && hasAt('', 'wp-includes') && hasAt('', 'wp-content')) {
        return '';
      }

      const firstDirs = Array.from(new Set(
        normalized
          .map((name) => name.split('/')[0])
          .filter(Boolean)
      ));

      for (const dir of firstDirs) {
        const p = `${dir}/`;
        if (hasAt(p, 'wp-admin') && hasAt(p, 'wp-includes') && hasAt(p, 'wp-content')) {
          return p;
        }
      }

      return null;
    })();

    if (prefix === null) {
      throw new Error('Архив WordPress распакован, но корень WordPress не найден.');
    }

    const root = path.resolve(publicDir);
    fs.mkdirSync(root, { recursive: true });

    for (const [rawName, content] of Object.entries(entries)) {
      const name = normalize(rawName);
      if (prefix && !name.startsWith(prefix)) {continue;}

      const rel = prefix ? name.slice(prefix.length) : name;
      if (!rel || rel.endsWith('/')) {continue;}

      const outPath = path.resolve(root, rel);
      if (outPath !== root && !outPath.startsWith(root + path.sep)) {
        throw new Error(`Небезопасный путь в архиве WordPress: ${rawName}`);
      }

      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      fs.writeFileSync(outPath, content);
    }

    if (!fs.existsSync(path.join(root, 'wp-content'))) {
      fs.mkdirSync(path.join(root, 'wp-content'), { recursive: true });
    }
  }

  private findExtractedWordPressRoot(dir: string, depth = 0): string | null {
    if (depth > 3) {return null;}

    if (
      fs.existsSync(path.join(dir, 'wp-admin')) &&
      fs.existsSync(path.join(dir, 'wp-includes')) &&
      fs.existsSync(path.join(dir, 'wp-content'))
    ) {
      return dir;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return null;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {continue;}
      const found = this.findExtractedWordPressRoot(path.join(dir, entry.name), depth + 1);
      if (found) {return found;}
    }

    return null;
  }

  private ensurePublicWpContentDirectory(site: WPSite): void {
    const publicContentDir = path.join(this.publicDir(site), 'wp-content');

    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(publicContentDir);
    } catch {
      fs.mkdirSync(publicContentDir, { recursive: true });
      return;
    }

    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return;
    }

    // If an old symlink/junction exists, replace it with a real folder while
    // preserving its current contents.
    const tmp = path.join(this.publicDir(site), `_wp-content-real-${crypto.randomUUID()}`);
    fs.mkdirSync(tmp, { recursive: true });
    try {
      const real = fs.realpathSync(publicContentDir);
      if (fs.existsSync(real)) {
        fs.cpSync(real, tmp, { recursive: true, force: true, dereference: true });
      }
    } catch { /* ignore */ }

    fs.rmSync(publicContentDir, { recursive: true, force: true });
    fs.renameSync(tmp, publicContentDir);
  }

  private removePathIfExists(targetPath: string): void {
    const readStat = (): fs.Stats | undefined => {
      try { return fs.lstatSync(targetPath); } catch { return undefined; }
    };

    const assertRemoved = (): void => {
      if (readStat()) {
        throw new Error(`Не удалось удалить старый путь: ${targetPath}`);
      }
    };

    const stat = readStat();
    if (!stat) {
      return;
    }

    if (stat.isSymbolicLink()) {
      try { fs.unlinkSync(targetPath); } catch { fs.rmdirSync(targetPath); }
      assertRemoved();
      return;
    }

    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      assertRemoved();
      return;
    } catch {
      // Fall through to a manual remover. fs.rmSync can leave broken Windows
      // junctions behind when the target no longer exists.
    }

    const current = readStat();
    if (!current) {return;}

    if (current.isDirectory() && !current.isSymbolicLink()) {
      for (const entry of fs.readdirSync(targetPath)) {
        this.removePathIfExists(path.join(targetPath, entry));
      }
      try { fs.chmodSync(targetPath, 0o777); } catch { /* ignore */ }
      fs.rmdirSync(targetPath);
    } else {
      try { fs.chmodSync(targetPath, 0o666); } catch { /* ignore */ }
      try { fs.unlinkSync(targetPath); } catch { fs.rmdirSync(targetPath); }
    }

    assertRemoved();
  }

  private terminateProcess(proc: cp.ChildProcess, label: string): Promise<void> {
    return new Promise((resolve) => {
      if (!this.isProcessActive(proc)) {
        resolve();
        return;
      }

      let settled = false;
      const finish = () => {
        if (settled) {return;}
        settled = true;
        clearTimeout(forceTimer);
        resolve();
      };

      const forceTimer = setTimeout(() => {
        if (!this.isProcessActive(proc)) {
          finish();
          return;
        }
        try {
          if (os.platform() === 'win32' && proc.pid) {
            cp.execFile('taskkill', ['/PID', String(proc.pid), '/T', '/F'], () => finish());
            return;
          }
          proc.kill('SIGKILL');
        } catch (err) {
          Logger.error(`[site] failed to force kill process ${label}`, err);
        }
        setTimeout(finish, 300);
      }, 1500);

      proc.once('exit', finish);
      proc.once('error', finish);

      try {
        proc.kill('SIGTERM');
      } catch (err) {
        Logger.error(`[site] failed to terminate process ${label}`, err);
        finish();
        return;
      }
    });
  }

  private isProcessActive(proc: cp.ChildProcess): boolean {
    return proc.exitCode === null && proc.signalCode === null;
  }

  private async killStaleSiteProcesses(site: WPSite): Promise<void> {
    if (os.platform() !== 'win32') {return;}

    const sitePath = path.resolve(site.path).toLowerCase();
    if (!sitePath) {return;}

    const ps = [
      `$target = [string]$env:WPDockSitePath`,
      `if ([string]::IsNullOrWhiteSpace($target)) { exit 0 }`,
      `$target = $target.ToLowerInvariant()`,
      `$names = @('nginx.exe', 'php-cgi.exe', 'php.exe', 'httpd.exe')`,
      `$procs = Get-CimInstance Win32_Process | Where-Object {`,
      `  $names -contains $_.Name -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains($target)`,
      `} | Select-Object ProcessId, Name, CommandLine`,
      `$procs | ConvertTo-Json -Compress`,
    ].join('\r\n');

    const stdout = await new Promise<string>((resolve) => {
      cp.execFile(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps],
        {
          windowsHide: true,
          env: { ...process.env, WPDockSitePath: sitePath },
        },
        (err, out) => {
          if (err) {
            Logger.error(`[site] failed to query stale processes for "${site.name}"`, err);
            resolve('');
            return;
          }
          resolve(out);
        }
      );
    });

    const raw = stdout.trim();
    if (!raw) {return;}

    let parsed: StaleRuntimeProcess | StaleRuntimeProcess[];
    try {
      parsed = JSON.parse(raw) as StaleRuntimeProcess | StaleRuntimeProcess[];
    } catch (err) {
      Logger.error(`[site] failed to parse stale process query for "${site.name}": ${raw.slice(0, 500)}`, err);
      return;
    }

    const staleProcesses = (Array.isArray(parsed) ? parsed : [parsed])
      .filter((procInfo) => typeof procInfo.ProcessId === 'number' && procInfo.ProcessId > 0);

    for (const procInfo of staleProcesses) {
      const pid = procInfo.ProcessId;
      if (!pid) {continue;}

      await new Promise<void>((resolve) => {
        cp.execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
          if (err) {
            Logger.error(`[site] failed to kill stale ${procInfo.Name ?? 'process'} PID ${pid} for "${site.name}"`, err);
          } else {
            Logger.log(`[site] killed stale ${procInfo.Name ?? 'process'} PID ${pid} for "${site.name}"`);
          }
          resolve();
        });
      });
      await this.waitForWindowsPidExit(pid);
    }

    // Windows can keep directory handles busy briefly after process exit.
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  private async waitForWindowsPidExit(pid: number): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt++) {
      const stillRunning = await new Promise<boolean>((resolve) => {
        cp.execFile(
          'powershell.exe',
          ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `if (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { '1' }`],
          { windowsHide: true },
          (_err, stdout) => resolve(stdout.trim() === '1')
        );
      });
      if (!stillRunning) {return;}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }

  private trackLogStream(siteId: string, stream: Writable): void {
    let siteStreams = this.logStreams.get(siteId);
    if (!siteStreams) {
      siteStreams = new Set<Writable>();
      this.logStreams.set(siteId, siteStreams);
    }
    siteStreams.add(stream);
  }

  private releaseLogStream(siteId: string, stream: Writable): void {
    try {
      stream.end();
    } catch { /* ignore */ }
    try {
      stream.destroy();
    } catch { /* ignore */ }

    const siteStreams = this.logStreams.get(siteId);
    if (!siteStreams) {return;}
    siteStreams.delete(stream);
    if (siteStreams.size === 0) {
      this.logStreams.delete(siteId);
    }
  }

  private closeSiteLogStreams(siteId: string): void {
    const siteStreams = this.logStreams.get(siteId);
    if (!siteStreams) {return;}
    for (const stream of siteStreams) {
      try {
        stream.end();
      } catch { /* ignore */ }
      try {
        stream.destroy();
      } catch { /* ignore */ }
    }
    this.logStreams.delete(siteId);
  }

  // ── Crypto helpers ────────────────────────────────────────────────────────

  private randomKey(length = 64): string {
    const charset =
      'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%^&*()-_=+[]{}|;:,.<>?';
    // Use crypto-grade random bytes for secret keys
    const bytes = crypto.randomBytes(length);
    return Array.from(bytes)
      .map((b) => charset[b % charset.length])
      .join('');
  }
}
