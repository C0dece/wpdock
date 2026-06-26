import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as net from 'net';
import * as http from 'http';
import * as https from 'https';
import * as os from 'os';
import * as crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { WPSite, SiteCreateOptions } from '../types';
import { StorageService, SiteRuntimeLock } from './StorageService';
import { LocalRuntimeManager } from './LocalRuntimeManager';
import { SiteProcessManager } from './SiteProcessManager';
import { ProxyRouterService } from './ProxyRouterService';
import { SslService } from './SslService';
import { Logger } from '../utils/logger';
import { runElevatedPs } from '../utils/elevate';

// ── Hosts file manager ────────────────────────────────────────────────────────
const HOSTS_WIN = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
const HOSTS_UNIX = '/etc/hosts';
const SITE_PROBE_FAILURES_BEFORE_RECOVERY = 3;
const SITE_AUTO_RECOVERY_COOLDOWN_MS = 30_000;
const STARTING_STATUS_STALE_MS = 5 * 60_000;
/**
 * A runtime ownership lock is considered "live" only if its heartbeat is fresher
 * than this. The owner refreshes it every sync tick (~3s); a generous window
 * tolerates a few missed ticks but still expires quickly after a window closes.
 */
const RUNTIME_LOCK_FRESH_MS = 15_000;

class SiteStartCancelledError extends Error {
  constructor(siteId: string) {
    super(`Запуск сайта ${siteId} отменён.`);
    this.name = 'SiteStartCancelledError';
  }
}

export function isSiteStartCancelledError(err: unknown): boolean {
  return err instanceof Error && err.name === 'SiteStartCancelledError';
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function psSingle(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Adds a hosts entry for `domain → ip`.
 * Tries a direct write first; if the file is protected (Windows), uses an
 * elevated PowerShell process (one UAC prompt, no user interaction beyond that).
 */
async function addHostsEntry(domain: string, ip = '127.0.0.1'): Promise<void> {
  await addHostsEntries([{ domain, ip }]);
}

async function addHostsEntries(entries: Array<{ domain: string; ip: string }>): Promise<void> {
  const uniqueEntries = Array.from(
    new Map(entries.filter((entry) => entry.domain).map((entry) => [entry.domain, entry])).values()
  );
  if (uniqueEntries.length === 0) {return;}

  const hostsPath = os.platform() === 'win32' ? HOSTS_WIN : HOSTS_UNIX;
  const failedEntries: Array<{ domain: string; ip: string }> = [];
  let currentContent = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf-8') : '';

  const hostsLineExists = (domain: string, ip: string): boolean => {
    const marker = `# WPDock:${domain}`;
    const newLine = `${ip} ${domain} ${marker}`;
    return currentContent.includes(newLine);
  };

  const applyDirect = (domain: string, ip: string): boolean => {
    const marker = `# WPDock:${domain}`;
    const newLine = `${ip} ${domain} ${marker}`;
    try {
      const pattern = new RegExp(`^.*${escapeRegex(marker)}.*(?:\\r?\\n)?`, 'gm');
      const cleaned = currentContent.replace(pattern, '');
      const updated = `${cleaned}${cleaned.length > 0 && !cleaned.endsWith('\n') ? os.EOL : ''}${newLine}${os.EOL}`;
      if (updated === currentContent) {return true;}
      fs.writeFileSync(hostsPath, updated, 'utf-8');
      currentContent = updated;
      return true;
    } catch {
      return false;
    }
  };

  for (const entry of uniqueEntries) {
    if (hostsLineExists(entry.domain, entry.ip)) {
      Logger.log(`[Hosts] already present: ${entry.ip} ${entry.domain}`);
      continue;
    }
    if (applyDirect(entry.domain, entry.ip)) {
      Logger.log(`[Hosts] added: ${entry.ip} ${entry.domain} # WPDock:${entry.domain}`);
    } else {
      failedEntries.push(entry);
    }
  }

  if (failedEntries.length === 0) {return;}

  if (os.platform() !== 'win32') {
    Logger.error(`[Hosts] cannot write ${hostsPath} — no permission`);
    return;
  }

  // Windows: write a temp .ps1 file and run it elevated (no escaping issues)
  Logger.log(`[Hosts] escalating to add ${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'}`);
  const psEntries = failedEntries
    .map((entry) => `@{ domain = '${psSingle(entry.domain)}'; ip = '${psSingle(entry.ip)}' }`)
    .join(', ');
  const hostsPs = [
    `$h = '${hostsPath}'`,
    `$entries = @(${psEntries})`,
    `$content = ''`,
    `$nl = [Environment]::NewLine`,
    `if (Test-Path $h) { $content = [System.IO.File]::ReadAllText($h) }`,
    `foreach ($entry in $entries) {`,
    `  $marker = '# WPDock:' + $entry.domain`,
    `  $line = $entry.ip + ' ' + $entry.domain + ' ' + $marker`,
    `  $pattern = '(?m)^.*' + [Regex]::Escape($marker) + '.*(?:\r?\n)?'`,
    `  $content = [Regex]::Replace($content, $pattern, '')`,
    `  if ($content.Length -gt 0 -and -not $content.EndsWith($nl)) { $content += $nl }`,
    `  $content += $line + $nl`,
    `}`,
    `[System.IO.File]::WriteAllText($h, $content, [System.Text.UTF8Encoding]::new($false))`,
  ].join('\r\n');

  const ok = await runElevatedPs(hostsPs);
  if (ok) {
    Logger.log(`[Hosts] elevated write OK: ${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'}`);
  } else {
    Logger.error(`[Hosts] elevated write FAILED for ${failedEntries.length} entr${failedEntries.length === 1 ? 'y' : 'ies'}`);
  }
}

async function removeHostsEntry(domain: string): Promise<void> {
  const hostsPath = os.platform() === 'win32' ? HOSTS_WIN : HOSTS_UNIX;
  const marker = `# WPDock:${domain}`;

  const removeDirect = (): boolean => {
    try {
      const content = fs.existsSync(hostsPath) ? fs.readFileSync(hostsPath, 'utf-8') : '';
      if (!content.includes(marker)) {return true;}
      const pattern = new RegExp(`^.*${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*(?:\\r?\\n)?`, 'gm');
      const newContent = content.replace(pattern, '');
      fs.writeFileSync(hostsPath, newContent, 'utf-8');
      return true;
    } catch {
      return false;
    }
  };

  if (removeDirect()) {
    Logger.log(`[Hosts] removed entry for ${domain}`);
    return;
  }

  if (os.platform() !== 'win32') {return;}

  const hostsPs = [
    `$h = '${hostsPath}'`,
    `$marker = '${marker}'`,
    `$content = ''`,
    `if (Test-Path $h) { $content = [System.IO.File]::ReadAllText($h) }`,
    `$pattern = '(?m)^.*' + [Regex]::Escape($marker) + '.*(?:\r?\n)?'`,
    `$content = [Regex]::Replace($content, $pattern, '')`,
    `[System.IO.File]::WriteAllText($h, $content, [System.Text.UTF8Encoding]::new($false))`,
  ].join('\r\n');
  await runElevatedPs(hostsPs);
}

interface PullDatabaseDiagnostic {
  wpInstalled: boolean;
  expectedTableCount: number;
  actualTableCount?: number;
  tablePrefix?: string;
  remoteStatsChecked?: boolean;
  taxonomyCountMismatches?: string[];
  siteurl?: string;
  home?: string;
  stylesheet?: string;
  template?: string;
  missingThemes: string[];
  warnings: string[];
  notes: string[];
  summary: string;
}

interface RemoteDbStats {
  prefix?: string;
  tables?: Record<string, number>;
}

export class SiteManager {
  private sites: Map<string, WPSite> = new Map();
  private readonly startInFlight: Map<string, Promise<void>> = new Map();
  private readonly startVersions: Map<string, number> = new Map();
  private readonly onDidChangeSitesEmitter = new vscode.EventEmitter<void>();
  private readonly onDidChangeSiteStatusEmitter = new vscode.EventEmitter<WPSite>();
  private syncStatusesPromise: Promise<void> | null = null;
  private readonly syncProbeFailures: Map<string, number> = new Map();
  private readonly intentionalStops: Set<string> = new Set();
  private readonly autoRecoverInFlight: Set<string> = new Set();
  private readonly lastAutoRecoverAt: Map<string, number> = new Map();
  /** PID of this extension host — identifies which window owns a running site. */
  private readonly instancePid = process.pid;
  private setupLocalAccessHook?: (onProgress?: (msg: string) => void) => Promise<void>;
  readonly onDidChangeSites = this.onDidChangeSitesEmitter.event;
  readonly onDidChangeSiteStatus = this.onDidChangeSiteStatusEmitter.event;

  private transliterate(input: string): string {
    const map: Record<string, string> = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
      к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
      х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    };
    return input
      .split('')
      .map((ch) => {
        const lower = ch.toLowerCase();
        return Object.prototype.hasOwnProperty.call(map, lower) ? map[lower] : ch;
      })
      .join('');
  }

  private normalizeDomain(domain: string | undefined): string | undefined {
    if (!domain) {return undefined;}
    const raw = domain.trim();
    if (!raw) {return undefined;}

    // Accept both host-only and full URL input from UI.
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const url = new URL(withScheme);
      const host = url.hostname.toLowerCase().replace(/\.$/, '');
      return host || undefined;
    } catch {
      return raw.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/:\d+$/, '').replace(/\.$/, '') || undefined;
    }
  }

  constructor(
    private context: vscode.ExtensionContext,
    private storage: StorageService,
    private runtime: LocalRuntimeManager,
    private processes: SiteProcessManager,
    private proxyRouter?: ProxyRouterService,
    private ssl?: SslService
  ) {
    this.loadSites();
    this.context.subscriptions.push(
      this.storage.onDidChangeSites((event) => {
        if (event.origin === 'external') {
          this.reloadSitesFromStorage();
          return;
        }
        this.onDidChangeSitesEmitter.fire();
      }),
      this.onDidChangeSitesEmitter,
      this.onDidChangeSiteStatusEmitter
    );
    this.processes.onSiteExited = (siteId: string) => {
      const site = this.sites.get(siteId);
      if (site && site.status === 'running') {
        if (this.intentionalStops.has(siteId)) {
          Logger.log(`[SiteManager] site "${site.name}" stopped intentionally`);
          return;
        }
        Logger.log(`[SiteManager] site "${site.name}" stopped unexpectedly — scheduling auto-recovery`);
        this.scheduleAutoRecovery(siteId, 'web server process exited');
      }
    };
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────

  private loadSites(): void {
    const stored = this.storage.getSites();
    this.sites.clear();
    for (const site of stored) {
      this.sites.set(site.id, site);
    }
  }

  private reloadSitesFromStorage(): void {
    const previous = new Map(this.sites);
    this.loadSites();
    Logger.log('[SiteManager] sites reloaded from shared storage');
    this.onDidChangeSitesEmitter.fire();

    for (const site of this.sites.values()) {
      const prev = previous.get(site.id);
      if (prev && prev.status !== site.status) {
        this.onDidChangeSiteStatusEmitter.fire(site);
      }
    }
  }

  getAllSites(): WPSite[] {
    return Array.from(this.sites.values());
  }

  getSite(id: string | undefined): WPSite | undefined {
    if (!id) {return undefined;}
    return this.sites.get(id);
  }

  openSiteLogs(siteId: string): void {
    const site = this.requireSite(siteId);
    const logsDir = path.join(site.path, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    Logger.log(`[SiteManager] opening logs for "${site.name}": ${logsDir}`);
    Logger.show();
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(logsDir));
    void vscode.window.showInformationMessage(`Логи сайта "${site.name}": ${logsDir}`);
  }

  openLocalMailFolder(siteId: string): void {
    const site = this.requireSite(siteId);
    const mailDir = this.processes.getLocalMailDir(site);
    fs.mkdirSync(mailDir, { recursive: true });
    Logger.log(`[SiteManager] opening local mail folder for "${site.name}": ${mailDir}`);
    void vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(mailDir));
    void vscode.window.showInformationMessage(`Письма сайта "${site.name}" сохраняются здесь: ${mailDir}`);
  }

  setLocalAccessSetupHook(
    setupHook: (onProgress?: (msg: string) => void) => Promise<void>
  ): void {
    this.setupLocalAccessHook = setupHook;
  }

  /**
   * Returns the WordPress web-root for a site.
   * WP files live in `site.path/public/` (created by SiteProcessManager).
   * Legacy `site.path/wp-content` is migrated to `public/wp-content` first.
   */
  getSiteWpRoot(site: WPSite): string {
    this.normalizeSiteLayout(site);
    return path.join(site.path, 'public');
  }

  /**
   * Returns the effective wp-content directory for a site.
   * Preferred layout is `{site.path}/public/wp-content` as a normal directory.
   * Older sites may still have content in `{site.path}/wp-content`.
   */
  getSiteContentDir(site: WPSite): string {
    this.normalizeSiteLayout(site);
    return path.join(site.path, 'public', 'wp-content');
  }

  /** Normalizes local filesystem layout to `{site.path}/public/wp-content`. */
  normalizeSiteLayout(siteOrId: WPSite | string | undefined): void {
    const site = typeof siteOrId === 'string' ? this.getSite(siteOrId) : siteOrId;
    if (!site) {return;}
    try {
      this.processes.normalizeWordPressLayout(site);
    } catch (err) {
      Logger.error(`[SiteManager] normalizeSiteLayout failed for "${site.name}"`, err);
    }
  }

  /**
   * Creates a new WordPress site:
   *  1. Ensures the local runtime (PHP + MariaDB) is available.
   *  2. Downloads WordPress, configures wp-config.php, creates DB, runs WP-CLI install.
   *  3. Saves the site record.
   */
  async createSite(
    options: SiteCreateOptions,
    onProgress?: (msg: string) => void
  ): Promise<WPSite> {
    Logger.log(`[SiteManager] createSite: "${options.name}"`);
    // Ensure runtime is available before doing anything else
    await this.runtime.ensureRuntimeAvailable(onProgress);

    const id = uuidv4();
    const port = await this.findFreePort(8080);
    const sitesDir = this.storage.getSitesDirectory();
    const baseSlug = this.slugify(options.name) || `site-${id.slice(0, 8)}`;
    let slug = baseSlug;
    let sitePath = options.path ?? path.join(sitesDir, slug);
    if (!options.path) {
      let counter = 2;
      while (fs.existsSync(sitePath) || this.isSitePathTaken(sitePath)) {
        slug = `${baseSlug}-${counter++}`;
        sitePath = path.join(sitesDir, slug);
      }
    }
    // Auto-assign {slug}.local so sites look like real domains.
    const domain = this.makeUniqueDomain(this.normalizeDomain(options.domain) || `${slug}.local`);

    // DB credentials
    const dbName = `wpdb_${slug.replace(/-/g, '_')}_${id.slice(0, 8)}`;
    const dbUser = `wpu_${id.replace(/-/g, '').slice(0, 16)}`;
    const dbPass = `wp_${uuidv4().replace(/-/g, '')}`;

    if (!fs.existsSync(sitePath)) {
      fs.mkdirSync(sitePath, { recursive: true });
    }

    const site: WPSite = {
      id,
      name: options.name,
      path: sitePath,
      port,
      phpVersion: options.phpVersion,
      status: 'stopped',
      statusUpdatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      adminUser: options.adminUser,
      adminEmail: options.adminEmail,
      dbName,
      dbUser,
      locale: options.locale ?? 'ru_RU',
      domain: domain,
      ssl: options.ssl ?? false,
      webServer: options.webServer ?? 'nginx',
      wpDebug: options.wpDebug ?? false,
      wpDebugLog: options.wpDebugLog ?? false,
      wpScriptDebug: options.wpScriptDebug ?? false,
    };

    this.sites.set(id, site);
    this.storage.saveSite(site);

    // Store passwords securely
    await this.storage.saveSecret(`site-${id}-admin-pass`, options.adminPassword);
    await this.storage.saveSecret(`site-${id}-db-pass`, dbPass);

    // Ensure DB is running before setup
    await this.runtime.startDatabase();

    // Full WordPress setup (download, configure, install)
    await this.processes.setupNewSite(
      site,
      {
        adminUser: options.adminUser,
        adminPassword: options.adminPassword,
        adminEmail: options.adminEmail,
        dbName,
        dbUser,
        dbPass,
      },
      onProgress
    );
    this.normalizeSiteLayout(site);
    this.processes.updateWpConfig(site);

    // Ensure the created admin password always matches user input.
    try {
      await this.runtime.runWpCli(
        [
          'user',
          'update',
          options.adminUser,
          `--user_pass=${options.adminPassword}`,
          `--path=${this.processes.publicDir(site)}`,
          '--allow-root',
        ],
        this.processes.publicDir(site),
        site.phpVersion,
        { WP_CLI_ALLOW_ROOT: '1' }
      );
    } catch (err) {
      Logger.error(`[SiteManager] failed to enforce admin password after install for "${site.name}"`, err);
    }

    // Add hosts file entry so {slug}.local resolves to the correct IP
    onProgress?.(`Добавление ${domain} в hosts...`);
    const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
    await addHostsEntry(domain, hostsIp);

    Logger.log(`[SiteManager] createSite done: "${site.name}" id=${site.id} domain=${domain} port=${site.port}`);
    return site;
  }

  async startSite(siteId: string, onProgress?: (msg: string) => void): Promise<void> {
    const inFlight = this.startInFlight.get(siteId);
    if (inFlight) {
      Logger.log(`[SiteManager] startSite deduplicated for siteId=${siteId}`);
      await inFlight;
      return;
    }

    const startVersion = this.getStartVersion(siteId);
    const task = this.doStartSite(siteId, onProgress, startVersion).finally(() => {
      if (this.startInFlight.get(siteId) === task) {
        this.startInFlight.delete(siteId);
      }
    });
    this.startInFlight.set(siteId, task);
    await task;
  }

  private async doStartSite(siteId: string, onProgress: ((msg: string) => void) | undefined, startVersion: number): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] startSite: "${site.name}" (${siteId})`);
    const startHeartbeat = setInterval(() => {
      if (!this.isStartCancelled(siteId, startVersion)) {
        this.writeRuntimeLock(siteId);
      }
    }, Math.max(1_000, Math.floor(RUNTIME_LOCK_FRESH_MS / 2)));
    try {
      this.throwIfStartCancelled(siteId, startVersion);
      if (!this.processes.isSiteRunning(siteId) && (site.status === 'running' || site.status === 'starting')) {
        const reachability = await this.checkSiteReachability(site, 2_500);
        this.throwIfStartCancelled(siteId, startVersion);
        if (reachability.ready) {
          if (this.isRuntimeLockLive(this.storage.getRuntimeLock(siteId))) {
            await this.exposeExternalRunningSite(site, onProgress, true);
            this.throwIfStartCancelled(siteId, startVersion);
            if (site.status !== 'running') {
              this.updateStatus(siteId, 'running');
            }
            Logger.log(`[SiteManager] startSite skipped: "${site.name}" already running in another VS Code window`);
            return;
          }

          Logger.log(`[SiteManager] startSite found reachable but unowned server for "${site.name}" — killing before fresh start`);
          onProgress?.('Обнаружены зависшие процессы сайта, очищаю...');
          await this.cleanupOrphanedSite(site);
          this.throwIfStartCancelled(siteId, startVersion);
        }

        const startOwnerLive = this.isRuntimeLockLive(this.storage.getRuntimeLock(siteId));
        if (site.status === 'starting' && startOwnerLive && !this.isStartingStatusStale(site)) {
          Logger.log(`[SiteManager] startSite skipped: "${site.name}" is already starting in another VS Code window`);
          return;
        }
        if (site.status === 'starting' && !startOwnerLive) {
          Logger.log(`[SiteManager] unowned starting status for "${site.name}" — starting in this VS Code window`);
        } else if (site.status === 'starting') {
          Logger.log(`[SiteManager] stale starting status for "${site.name}" — starting in this VS Code window`);
        }
      }

      if (this.processes.isSiteRunning(siteId)) {
        const reachability = await this.checkSiteReachability(site, 2_500);
        if (site.status === 'running' && reachability.ready) {
          Logger.log(`[SiteManager] startSite skipped: "${site.name}" already running and reachable`);
          return;
        }

        Logger.log(
          `[SiteManager] startSite detected stale running process for "${site.name}" reachable=${reachability.ready} error=${reachability.error ?? '-'}`
        );
        onProgress?.('Обнаружен зависший запуск, выполняется восстановление...');
        await this.processes.stopSite(site);
        this.proxyRouter?.unregister(site);
        if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
      }

      this.writeRuntimeLock(siteId);
      this.updateStatus(siteId, 'starting');
      onProgress?.('Сайт запускается...');

      const ensuredDomain = this.ensureOperationalDomain(site);
      if (site.domain !== ensuredDomain) {
        site.domain = ensuredDomain;
        this.sites.set(siteId, site);
        this.storage.saveSite(site);
      }

      // Ensure PHP + MariaDB are available (downloads on first run)
      await this.runtime.ensureRuntimeAvailable(onProgress);
      this.throwIfStartCancelled(siteId, startVersion);
      this.normalizeSiteLayout(site);
      await this.ensureSiteAccessReady(site, onProgress);
      this.throwIfStartCancelled(siteId, startVersion);
      onProgress?.('Запуск веб-сервера (PHP)...');
      await this.processes.startSite(site);
      this.throwIfStartCancelled(siteId, startVersion);
      // Register with proxy after start (site.port may have been updated by auto-port selection)
      this.proxyRouter?.register(site);
      // Update wp-config.php so WP_HOME/WP_SITEURL match the current URL (http vs https)
      this.processes.updateWpConfig(site);
      onProgress?.('Применение настроек WordPress...');

      // Keep DB options aligned with current public URL to avoid wp-admin redirect loops.
      // wp-config.php constants (WP_HOME/WP_SITEURL) already enforce the URL for page loads;
      // this just keeps the DB consistent. Skip if WP core tables are missing.
      try {
        const pubDir = this.processes.publicDir(site);
        const currentUrl = this.processes.getSiteUrl(site);
        // --skip-plugins/--skip-themes: these maintenance commands only touch core
        // tables (options/users). Loading the site's plugins here is what made this
        // block hang for ~46s (a plugin does a slow remote call on bootstrap), so we
        // skip them — it does not affect the result and keeps startup fast.
        const skipFlags = ['--skip-plugins', '--skip-themes'];
        const isInstalled = await this.runtime.runWpCli(
          ['core', 'is-installed', `--path=${pubDir}`, '--allow-root', ...skipFlags],
          pubDir,
          site.phpVersion,
          { WP_CLI_ALLOW_ROOT: '1' }
        ).then(() => true).catch(() => false);
        if (!isInstalled) {
          Logger.log(`[SiteManager] skipping siteurl DB update for "${site.name}" — WP not installed yet`);
        } else {
          await this.runtime.runWpCli(
            ['option', 'update', 'siteurl', currentUrl, `--path=${pubDir}`, '--allow-root', ...skipFlags],
            pubDir,
            site.phpVersion,
            { WP_CLI_ALLOW_ROOT: '1' }
          );
          await this.runtime.runWpCli(
            ['option', 'update', 'home', currentUrl, `--path=${pubDir}`, '--allow-root', ...skipFlags],
            pubDir,
            site.phpVersion,
            { WP_CLI_ALLOW_ROOT: '1' }
          );

          // Ensure WP admin password matches the value provided on site creation.
          if (site.adminUser) {
            const savedAdminPass = await this.getAdminPassword(siteId);
            if (savedAdminPass) {
              await this.runtime.runWpCli(
                [
                  'user',
                  'update',
                  site.adminUser,
                  `--user_pass=${savedAdminPass}`,
                  `--path=${pubDir}`,
                  '--allow-root',
                  ...skipFlags,
                ],
                pubDir,
                site.phpVersion,
                { WP_CLI_ALLOW_ROOT: '1' }
              );
            }
          }
        }
      } catch (err) {
        Logger.error(`[SiteManager] option update siteurl/home failed for "${site.name}"`, err);
      }

      // Ensure hosts entry exists (idempotent)
      if (site.domain) {
        const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
        await addHostsEntry(site.domain, hostsIp);
      }
      // Generate per-domain TLS cert and register with HTTPS proxy (SNI).
      // Must happen after proxyRouter.register so getPublicUrl() returns https://
      if (site.domain && this.proxyRouter) {
        if (site.ssl && this.ssl) {
          try {
            onProgress?.('Подготовка SSL-сертификата...');
            const cert = await this.ssl.generateSiteCert(site.domain);
            await this.proxyRouter.registerSni(site.domain, cert.certPath, cert.keyPath);
          } catch (err) {
            Logger.error(`[SiteManager] SSL cert failed for ${site.domain}`, err);
            throw new Error(`Не удалось подготовить SSL для сайта ${site.domain}.`);
          }
        } else {
          this.proxyRouter.unregisterSni(site.domain);
        }
      }
      onProgress?.('Проверка готовности сайта...');
      await this.waitForSiteReady(site, onProgress, () => this.isStartCancelled(siteId, startVersion));
      this.throwIfStartCancelled(siteId, startVersion);
      this.writeRuntimeLock(siteId);
      this.updateStatus(siteId, 'running');
      onProgress?.('Сайт запущен и готов.');
      Logger.log(`[SiteManager] startSite OK: "${site.name}" port=${site.port} domain=${site.domain ?? 'none'}`);
    } catch (err) {
      if (isSiteStartCancelledError(err)) {
        Logger.log(`[SiteManager] startSite CANCELLED: "${site.name}"`);
        throw err;
      }
      this.updateStatus(siteId, 'error');
      Logger.error(`[SiteManager] startSite FAILED: "${site.name}"`, err);
      throw err;
    } finally {
      clearInterval(startHeartbeat);
    }
  }

  async stopSite(siteId: string): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] stopSite: "${site.name}" (${siteId})`);
    this.cancelStart(siteId);
    this.intentionalStops.add(siteId);
    this.syncProbeFailures.delete(siteId);
    try {
      await this.processes.stopSite(site);
      this.proxyRouter?.unregister(site);
      if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
      this.clearRuntimeLock(siteId);
      this.updateStatus(siteId, 'stopped');
    } finally {
      this.intentionalStops.delete(siteId);
    }
  }

  async forceStopSite(siteId: string): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] forceStopSite: "${site.name}" (${siteId})`);
    this.cancelStart(siteId);
    this.intentionalStops.add(siteId);
    this.syncProbeFailures.delete(siteId);
    try {
      await this.processes.stopSite(site);
      this.proxyRouter?.unregister(site);
      if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
      this.clearRuntimeLock(siteId);
      this.updateStatus(siteId, 'stopped');
    } finally {
      this.intentionalStops.delete(siteId);
    }
  }

  async forceRestartSite(siteId: string, onProgress?: (msg: string) => void): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] forceRestartSite: "${site.name}" (${siteId})`);
    onProgress?.('Остановка зависших процессов сайта...');
    await this.forceStopSite(siteId);
    onProgress?.('Повторный запуск сайта...');
    await this.startSite(siteId, onProgress);
  }

  async deleteSite(siteId: string, deleteFiles: boolean): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] deleteSite: "${site.name}" deleteFiles=${deleteFiles}`);

    // Stop the PHP server first
    try {
      await this.processes.stopSite(site);
    } catch (err) {
      Logger.error(`[SiteManager] stopSite during delete failed`, err);
    }

    // Drop database if runtime is available
    if (site.dbName && site.dbUser) {
      try {
        await this.runtime.startDatabase();
        await this.runtime.dropSiteDatabase(site.dbName, site.dbUser);
      } catch (err) {
        Logger.error(`[SiteManager] dropSiteDatabase failed for "${site.dbName}"`, err);
      }
    }

    if (deleteFiles && fs.existsSync(site.path)) {
      await this.removeSiteDirectory(site.path);
    }

    // Remove hosts entry and unregister SNI cert
    if (site.domain) {
      await removeHostsEntry(site.domain);
      this.proxyRouter?.unregisterSni(site.domain);
    }

    this.clearRuntimeLock(siteId);
    this.sites.delete(siteId);
    this.storage.removeSite(siteId);
    await this.storage.deleteSecret(`site-${siteId}-admin-pass`);
    await this.storage.deleteSecret(`site-${siteId}-db-pass`);
  }

  async resetSite(siteId: string, preserveGit = false, onProgress?: (msg: string) => void): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] resetSite: "${site.name}" (${siteId}) preserveGit=${preserveGit}`);

    const adminPassword = await this.getAdminPassword(siteId);
    const dbPassword = await this.getDbPassword(siteId);
    if (!site.adminUser || !site.adminEmail || !site.dbName || !site.dbUser || !adminPassword || !dbPassword) {
      throw new Error('Недостаточно данных для полного сброса сайта. Проверьте учётные данные сайта.');
    }

    const wasRunning = site.status === 'running' || this.processes.isSiteRunning(siteId);
    const hadGit = Boolean(site.git?.repoInitialized);
    const preservedGitDir = preserveGit && hadGit
      ? await this.preserveGitDirectory(site.path)
      : undefined;

    try {
      onProgress?.('Остановка сайта...');
      await this.processes.stopSite(site);
    } catch (err) {
      Logger.error(`[SiteManager] stopSite during reset failed`, err);
    }

    this.proxyRouter?.unregister(site);
    if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
    this.updateStatus(siteId, 'stopped');

    onProgress?.('Подготовка runtime...');
    await this.runtime.ensureRuntimeAvailable(onProgress);
    await this.runtime.startDatabase();

    onProgress?.('Удаление файлов сайта...');
    if (fs.existsSync(site.path)) {
      await this.removeSiteDirectory(site.path);
    }
    fs.mkdirSync(site.path, { recursive: true });
    if (preservedGitDir) {
      onProgress?.('Восстановление Git-репозитория...');
      fs.cpSync(preservedGitDir, path.join(site.path, '.git'), { recursive: true });
      try { fs.rmSync(path.dirname(preservedGitDir), { recursive: true, force: true }); } catch { /* ignore */ }
    }

    onProgress?.('Сброс базы данных...');
    await this.runtime.dropSiteDatabase(site.dbName, site.dbUser).catch((err) => {
      Logger.error(`[SiteManager] dropSiteDatabase during reset failed for "${site.dbName}"`, err);
    });

    site.git = preserveGit && hadGit
      ? site.git
      : { repoInitialized: false };
    this.storage.saveSite(site);

    onProgress?.('Развёртывание чистого WordPress...');
    await this.processes.setupNewSite(
      site,
      {
        adminUser: site.adminUser,
        adminPassword,
        adminEmail: site.adminEmail,
        dbName: site.dbName,
        dbUser: site.dbUser,
        dbPass: dbPassword,
      },
      onProgress
    );
    this.processes.normalizeWordPressLayout(site);
    this.processes.updateWpConfig(site);

    try {
      await this.runtime.runWpCli(
        [
          'user',
          'update',
          site.adminUser,
          `--user_pass=${adminPassword}`,
          `--path=${this.processes.publicDir(site)}`,
          '--allow-root',
        ],
        this.processes.publicDir(site),
        site.phpVersion,
        { WP_CLI_ALLOW_ROOT: '1' }
      );
    } catch (err) {
      Logger.error(`[SiteManager] failed to enforce admin password after reset for "${site.name}"`, err);
    }

    if (site.domain) {
      const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
      await addHostsEntry(site.domain, hostsIp);
    }

    if (wasRunning) {
      onProgress?.('Перезапуск сайта...');
      await this.startSite(siteId, onProgress);
    } else {
      this.storage.saveSite(site);
    }
  }

  async resetSiteDatabase(siteId: string, onProgress?: (msg: string) => void): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] resetSiteDatabase: "${site.name}" (${siteId})`);
    await this.reinstallSiteCore(site, {
      removeSiteFiles: false,
      preserveGit: true,
      preserveWpContent: true,
      onProgress,
      progressTitle: 'Сброс базы данных...',
      resetMode: 'db-only',
    });
  }

  async reinstallSiteKeepContent(siteId: string, preserveGit = true, onProgress?: (msg: string) => void): Promise<void> {
    const site = this.requireSite(siteId);
    Logger.log(`[SiteManager] reinstallSiteKeepContent: "${site.name}" (${siteId}) preserveGit=${preserveGit}`);
    await this.reinstallSiteCore(site, {
      removeSiteFiles: true,
      preserveGit,
      preserveWpContent: true,
      onProgress,
      progressTitle: 'Переустановка WordPress...',
      resetMode: 'keep-content',
    });
  }

  private async preserveGitDirectory(sitePath: string): Promise<string | undefined> {
    const gitDir = path.join(sitePath, '.git');
    if (!fs.existsSync(gitDir)) {return undefined;}

    const tempRoot = path.join(os.tmpdir(), `wpdock-reset-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const tempGitDir = path.join(tempRoot, '.git');
    fs.mkdirSync(tempRoot, { recursive: true });
    fs.cpSync(gitDir, tempGitDir, { recursive: true });
    return tempGitDir;
  }

  private async reinstallSiteCore(
    site: WPSite,
    opts: {
      removeSiteFiles: boolean;
      preserveGit: boolean;
      preserveWpContent: boolean;
      onProgress?: (msg: string) => void;
      progressTitle: string;
      resetMode: 'full' | 'db-only' | 'keep-content';
    }
  ): Promise<void> {
    const adminPassword = await this.getAdminPassword(site.id);
    const dbPassword = await this.getDbPassword(site.id);
    if (!site.adminUser || !site.adminEmail || !site.dbName || !site.dbUser || !adminPassword || !dbPassword) {
      throw new Error('Недостаточно данных для переустановки сайта. Проверьте учётные данные сайта.');
    }

    const wasRunning = site.status === 'running' || this.processes.isSiteRunning(site.id);
    const hadGit = Boolean(site.git?.repoInitialized);
    const preservedGitDir = opts.preserveGit && hadGit
      ? await this.preserveGitDirectory(site.path)
      : undefined;

    try {
      opts.onProgress?.('Остановка сайта...');
      await this.processes.stopSite(site);
    } catch (err) {
      Logger.error(`[SiteManager] stopSite during ${opts.resetMode} failed`, err);
    }

    this.proxyRouter?.unregister(site);
    if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
    this.updateStatus(site.id, 'stopped');

    opts.onProgress?.('Подготовка runtime...');
    await this.runtime.ensureRuntimeAvailable(opts.onProgress);
    await this.runtime.startDatabase();

    if (opts.removeSiteFiles) {
      opts.onProgress?.(opts.progressTitle);
      await this.clearSiteForReinstall(site, opts.preserveWpContent);
      if (preservedGitDir) {
        opts.onProgress?.('Восстановление Git-репозитория...');
        fs.cpSync(preservedGitDir, path.join(site.path, '.git'), { recursive: true });
      }
    }

    try {
      opts.onProgress?.('Сброс базы данных...');
      await this.runtime.dropSiteDatabase(site.dbName, site.dbUser);
    } catch (err) {
      Logger.error(`[SiteManager] dropSiteDatabase during ${opts.resetMode} failed for "${site.dbName}"`, err);
    }

    site.git = opts.preserveGit && hadGit ? site.git : { repoInitialized: false };
    this.storage.saveSite(site);

    opts.onProgress?.('Развёртывание WordPress...');
    if (opts.removeSiteFiles) {
      await this.processes.setupNewSite(
        site,
        {
          adminUser: site.adminUser,
          adminPassword,
          adminEmail: site.adminEmail,
          dbName: site.dbName,
          dbUser: site.dbUser,
          dbPass: dbPassword,
        },
        opts.onProgress
      );
      this.processes.normalizeWordPressLayout(site);
      this.processes.updateWpConfig(site);
    } else {
      this.normalizeSiteLayout(site);
      await this.runtime.createSiteDatabase(site.dbName, site.dbUser, dbPassword);
      await this.runtime.runWpCli(
        [
          'core', 'install',
          `--path=${this.processes.publicDir(site)}`,
          `--url=${this.getSiteUrl(site)}`,
          `--title=${site.name}`,
          `--admin_user=${site.adminUser}`,
          `--admin_password=${adminPassword}`,
          `--admin_email=${site.adminEmail}`,
          `--locale=${site.locale ?? 'ru_RU'}`,
          '--skip-email',
        ],
        this.processes.publicDir(site),
        site.phpVersion,
        { WP_CLI_ALLOW_ROOT: '1' }
      );
      this.processes.writeMuPlugins(site);
      this.processes.updateWpConfig(site);
    }

    try {
      await this.runtime.runWpCli(
        [
          'user',
          'update',
          site.adminUser,
          `--user_pass=${adminPassword}`,
          `--path=${this.processes.publicDir(site)}`,
          '--allow-root',
        ],
        this.processes.publicDir(site),
        site.phpVersion,
        { WP_CLI_ALLOW_ROOT: '1' }
      );
    } catch (err) {
      Logger.error(`[SiteManager] failed to enforce admin password after ${opts.resetMode} for "${site.name}"`, err);
    } finally {
      if (preservedGitDir) {
        try { fs.rmSync(path.dirname(preservedGitDir), { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }

    if (site.domain) {
      const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
      await addHostsEntry(site.domain, hostsIp);
    }

    if (wasRunning) {
      opts.onProgress?.('Перезапуск сайта...');
      await this.startSite(site.id, opts.onProgress);
    } else {
      this.storage.saveSite(site);
    }
  }

  private async clearSiteForReinstall(site: WPSite, preserveWpContent: boolean): Promise<void> {
    if (!fs.existsSync(site.path)) {
      fs.mkdirSync(site.path, { recursive: true });
      return;
    }

    const publicDir = this.processes.publicDir(site);
    if (fs.existsSync(publicDir)) {
      await this.removeSiteDirectory(publicDir);
    }

    const topLevelEntries = fs.readdirSync(site.path);
    for (const entry of topLevelEntries) {
      if (entry === 'wp-content' && preserveWpContent) {continue;}
      if (entry === '.git') {continue;}
      const target = path.join(site.path, entry);
      try {
        this.removePathRobust(target);
      } catch (err) {
        Logger.error(`[SiteManager] failed to clear "${target}" during reinstall`, err);
        throw err;
      }
    }
  }

  private async removeSiteDirectory(sitePath: string): Promise<void> {
    let lastError: unknown;
    const maxAttempts = os.platform() === 'win32' ? 10 : 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        this.removePathRobust(sitePath);
        return;
      } catch (err: any) {
        lastError = err;
        Logger.error(`[SiteManager] rm failed for "${sitePath}" attempt ${attempt}`, err);
        if (attempt < maxAttempts && this.isRetryableRemoveError(err)) {
          await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          continue;
        }
        throw err;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Не удалось удалить папку сайта: ${sitePath}`);
  }

  private removePathRobust(targetPath: string): void {
    const readStat = (): fs.Stats | undefined => {
      try { return fs.lstatSync(targetPath); } catch { return undefined; }
    };
    const makeStillExistsError = (): Error & { code?: string } => {
      const err = new Error(`Не удалось удалить путь: ${targetPath}`) as Error & { code?: string };
      // The most common Windows case is that fs.rmSync returned without
      // throwing, but a handle from php/nginx/BrowserSync/AV still keeps a
      // child around. Mark it retryable for removeSiteDirectory().
      err.code = 'ENOTEMPTY';
      return err;
    };
    const assertRemoved = (): void => {
      if (readStat()) {
        throw makeStillExistsError();
      }
    };

    const initialStat = readStat();
    if (!initialStat) {
      return;
    }

    if (initialStat.isSymbolicLink()) {
      try { fs.unlinkSync(targetPath); } catch { fs.rmdirSync(targetPath); }
      assertRemoved();
      return;
    }

    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      assertRemoved();
      return;
    } catch (err: any) {
      const retryable = err?.code === 'EPERM' || err?.code === 'EBUSY' || err?.code === 'ENOTEMPTY';
      if (!retryable || os.platform() !== 'win32') {
        throw err;
      }
    }

    const stat = readStat();
    if (!stat) {return;}
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      try { fs.chmodSync(targetPath, 0o666); } catch { /* ignore */ }
      try { fs.unlinkSync(targetPath); } catch { fs.rmdirSync(targetPath); }
      assertRemoved();
      return;
    }

    for (const entry of fs.readdirSync(targetPath)) {
      this.removePathRobust(path.join(targetPath, entry));
    }

    try { fs.chmodSync(targetPath, 0o777); } catch { /* ignore */ }
    fs.rmdirSync(targetPath);
    assertRemoved();
  }

  private isRetryableRemoveError(err: any): boolean {
    return err?.code === 'EPERM'
      || err?.code === 'EBUSY'
      || err?.code === 'ENOTEMPTY'
      || /Не удалось удалить путь|directory not empty|resource busy|operation not permitted/i.test(String(err?.message ?? err));
  }

  /** Sync in-memory status with actual running processes. */
  async syncRunningSites(): Promise<void> {
    if (this.syncStatusesPromise) {
      await this.syncStatusesPromise;
      return;
    }
    this.syncStatusesPromise = this.syncRunningSitesInternal().finally(() => {
      this.syncStatusesPromise = null;
    });
    await this.syncStatusesPromise;
  }

  async getAdminPassword(siteId: string): Promise<string | undefined> {
    return this.storage.getSecret(`site-${siteId}-admin-pass`);
  }

  async getDbPassword(siteId: string): Promise<string | undefined> {
    return this.storage.getSecret(`site-${siteId}-db-pass`);
  }

  private async waitForSiteReady(
    site: WPSite,
    onProgress?: (msg: string) => void,
    isCancelled?: () => boolean
  ): Promise<void> {
    const host = site.domain ?? 'localhost';
    const timeoutMs = 90_000;
    const startedAt = Date.now();
    let attempt = 0;
    let lastError = '';

    while (Date.now() - startedAt < timeoutMs) {
      if (isCancelled?.()) {throw new SiteStartCancelledError(site.id);}
      attempt += 1;
      const remaining = timeoutMs - (Date.now() - startedAt);
      onProgress?.('Проверка доступности сайта...');

      // Probe nginx directly (127.0.0.1:port). The public URL goes through the
      // Windows portproxy + the in-process ProxyRouter, and that loopback path
      // intermittently 502s while a start is still in flight in this same
      // process — even though the site is up. A direct hit is the reliable
      // readiness signal; the proxy is already registered and serves real
      // (out-of-process) browser requests fine.
      const probe = await this.probeDirect(site.port, host, Math.min(30_000, remaining));
      if (probe.ready) {
        Logger.log(`[SiteManager] site ready: "${site.name}" host=${host} port=${site.port}`);
        // Best-effort public-URL check — log a warning if it fails, never block startup.
        const url = this.getSiteUrl(site);
        if (url) {
          const pub = await this.probeUrl(url, 5_000);
          if (!pub.ready) {
            Logger.log(`[SiteManager] public URL not ready yet for "${site.name}" (${url}): ${pub.error ?? '-'} — proxy will catch up`);
          }
        }
        return;
      }

      lastError = probe.error ?? lastError;
      const delay = Math.min(1_000 + attempt * 500, 4_000, Math.max(remaining, 0));
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error(lastError
      ? `Сайт ${site.name} не ответил: ${lastError}`
      : `Сайт ${site.name} не ответил за ${Math.round(timeoutMs / 1000)} секунд.`);
  }

  private async ensureSiteAccessReady(site: WPSite, onProgress?: (msg: string) => void): Promise<void> {
    const needsDomainAccess = Boolean(site.domain);
    const needsSslAccess = Boolean(site.domain && site.ssl);

    if (!needsDomainAccess && !needsSslAccess) {
      return;
    }

    const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
    if (this.proxyRouter && !this.proxyRouter.isRunning()) {
      onProgress?.('Запуск локального proxy...');
      try {
        await this.proxyRouter.start({ allowElevation: false });
      } catch (err) {
        Logger.error(`[SiteManager] proxy start failed for "${site.name}"`, err);
      }
    }

    const hostsReady = site.domain ? this.hasHostsEntry(site.domain, hostsIp) : true;
    const proxyReady = Boolean(this.proxyRouter?.isRunning());
    const requiresPortProxy = needsDomainAccess && os.platform() === 'win32';
    const portProxyReady = requiresPortProxy ? Boolean(this.proxyRouter?.portProxyActive) : true;
    const localAccessReady = proxyReady && portProxyReady && hostsReady;

    if (!localAccessReady) {
      Logger.log(
        `[SiteManager] local access repair required for "${site.name}" proxy=${proxyReady} portProxy=${portProxyReady} hosts=${hostsReady}`
      );
      onProgress?.('Запрашивается разрешение на локальный доступ (hosts / portproxy)...');

      if (this.setupLocalAccessHook) {
        await this.setupLocalAccessHook(onProgress);
      } else {
        await this.ensureHostsEntries(onProgress);
      }
    }

    if (site.domain && !this.hasHostsEntry(site.domain, hostsIp)) {
      throw new Error(`Локальный доступ не подготовлен: hosts не содержит запись для ${site.domain}.`);
    }

    if (requiresPortProxy && !this.proxyRouter?.portProxyActive) {
      throw new Error('Локальный доступ не подготовлен: Windows portproxy не активирован или разрешение UAC отклонено.');
    }

    if (needsSslAccess && this.ssl) {
      try {
        onProgress?.('Проверка SSL доверия...');
        await this.ssl.installCA();
      } catch (err: any) {
        throw new Error(`SSL доверие не подготовлено: ${err?.message ?? err}`);
      }
    }
  }

  private hasHostsEntry(domain: string, ip: string): boolean {
    const hostsPath = os.platform() === 'win32' ? HOSTS_WIN : HOSTS_UNIX;
    if (!fs.existsSync(hostsPath)) {return false;}
    try {
      const content = fs.readFileSync(hostsPath, 'utf-8');
      return content.includes(`${ip} ${domain} # WPDock:${domain}`);
    } catch {
      return false;
    }
  }

  private async checkSiteReachability(site: WPSite, timeoutMs: number): Promise<{ ready: boolean; error?: string }> {
    // Probe the web server directly (127.0.0.1:port) instead of the public URL.
    // The public URL travels Windows portproxy → in-process ProxyRouter → nginx;
    // while a start is in flight in this same extension-host process that loopback
    // path intermittently fails with 502 even though nginx is up and serving, which
    // would wrongly flag a working site as "error". A direct hit answers the only
    // question that matters here — is nginx + PHP responding for this host.
    const health = this.ensureHealthProbeFile(site);
    if (health) {
      return this.probeDirect(site.port, site.domain ?? 'localhost', timeoutMs, health.path, health.body);
    }
    return this.probeDirect(site.port, site.domain ?? 'localhost', timeoutMs);
  }

  /**
   * Probe the local web server directly over plain HTTP, bypassing the portproxy
   * and ProxyRouter. With an expected body, also verifies that the listener is
   * this WPDock site, not an unrelated process that reused the same port.
   */
  private probeDirect(
    port: number,
    host: string,
    timeoutMs: number,
    requestPath = '/',
    expectedBody?: string
  ): Promise<{ ready: boolean; error?: string }> {
    return new Promise((resolve) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: requestPath,
          method: 'GET',
          headers: {
            Host: host,
            'User-Agent': 'WPDock/1.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: timeoutMs,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          if (expectedBody === undefined) {
            res.resume(); // drain so the socket can close
            const ready = statusCode > 0 && statusCode < 500;
            resolve({ ready, error: ready ? undefined : `HTTP ${statusCode}` });
            return;
          }

          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => {
            if (body.length < expectedBody.length + 512) {
              body += chunk;
            }
          });
          res.on('end', () => {
            const ready = statusCode === 200 && body.trim() === expectedBody;
            resolve({
              ready,
              error: ready ? undefined : `health probe mismatch (HTTP ${statusCode})`,
            });
          });
          res.on('error', (err) => {
            resolve({ ready: false, error: err instanceof Error ? err.message : String(err) });
          });
        }
      );
      req.on('timeout', () => {
        req.destroy(new Error(`таймаут ${timeoutMs} мс`));
      });
      req.on('error', (err) => {
        resolve({ ready: false, error: err instanceof Error ? err.message : String(err) });
      });
      req.end();
    });
  }

  private probeUrl(url: string, timeoutMs: number, redirectDepth = 0): Promise<{ ready: boolean; error?: string }> {
    return new Promise((resolve) => {
      const parsed = new URL(url);
      const client = parsed.protocol === 'https:' ? https : http;
      const req = client.request(
        {
          protocol: parsed.protocol,
          hostname: parsed.hostname,
          port: parsed.port ? Number(parsed.port) : undefined,
          path: `${parsed.pathname}${parsed.search}`,
          method: 'GET',
          headers: {
            'User-Agent': 'WPDock/1.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          timeout: timeoutMs,
        },
        (res) => {
          const statusCode = res.statusCode ?? 0;
          const location = res.headers.location;

          if (statusCode >= 300 && statusCode < 400 && location) {
            res.resume();
            if (redirectDepth >= 5) {
              resolve({ ready: false, error: `слишком много редиректов (${statusCode})` });
              return;
            }

            const nextUrl = new URL(location, url).toString();
            void this.probeUrl(nextUrl, timeoutMs, redirectDepth + 1).then(resolve);
            return;
          }

          let body = '';
          res.setEncoding('utf8');
          res.on('data', (chunk) => { body += chunk; });
          res.on('end', () => {
            const ready = statusCode > 0 && statusCode < 500 && body.trim().length > 0;
            resolve({
              ready,
              error: ready ? undefined : `HTTP ${statusCode}${body.trim().length > 0 ? '' : ' без ответа'}`,
            });
          });
          res.on('error', (err) => {
            resolve({ ready: false, error: err instanceof Error ? err.message : String(err) });
          });
        }
      );

      req.on('timeout', () => {
        req.destroy(new Error(`таймаут ${timeoutMs} мс`));
      });
      req.on('error', (err) => {
        resolve({ ready: false, error: err instanceof Error ? err.message : String(err) });
      });
      req.end();
    });
  }

  private ensureHealthProbeFile(site: WPSite): { path: string; body: string } | undefined {
    try {
      const publicDir = this.processes.publicDir(site);
      if (!fs.existsSync(publicDir)) {return undefined;}

      const fileName = `wpdock-health-${site.id}.txt`;
      const filePath = path.join(publicDir, fileName);
      const body = `wpdock:${site.id}`;
      if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== body) {
        fs.writeFileSync(filePath, body, 'utf-8');
      }
      return { path: `/${fileName}`, body };
    } catch (err) {
      Logger.error(`[SiteManager] health probe file failed for "${site.name}"`, err);
      return undefined;
    }
  }

  private isStartingStatusStale(site: WPSite): boolean {
    if (site.status !== 'starting') {return false;}
    const updatedAt = site.statusUpdatedAt ? Date.parse(site.statusUpdatedAt) : NaN;
    if (!Number.isFinite(updatedAt)) {return true;}
    return Date.now() - updatedAt > STARTING_STATUS_STALE_MS;
  }

  private getStartVersion(siteId: string): number {
    return this.startVersions.get(siteId) ?? 0;
  }

  private cancelStart(siteId: string): void {
    this.startVersions.set(siteId, this.getStartVersion(siteId) + 1);
    this.startInFlight.delete(siteId);
  }

  private isStartCancelled(siteId: string, startVersion: number): boolean {
    return this.getStartVersion(siteId) !== startVersion;
  }

  private throwIfStartCancelled(siteId: string, startVersion: number): void {
    if (this.isStartCancelled(siteId, startVersion)) {
      throw new SiteStartCancelledError(siteId);
    }
  }

  private async exposeExternalRunningSite(
    site: WPSite,
    onProgress?: (msg: string) => void,
    prepareLocalAccess = false
  ): Promise<void> {
    if (!site.domain || !this.proxyRouter) {return;}

    if (prepareLocalAccess) {
      await this.ensureSiteAccessReady(site, onProgress);
    }
    if (!this.proxyRouter.isRunning()) {return;}

    this.proxyRouter.register(site);
    if (site.ssl && this.ssl) {
      try {
        const cert = await this.ssl.generateSiteCert(site.domain);
        await this.proxyRouter.registerSni(site.domain, cert.certPath, cert.keyPath);
      } catch (err) {
        Logger.error(`[SiteManager] external site SSL route failed for ${site.domain}`, err);
      }
    } else {
      this.proxyRouter.unregisterSni(site.domain);
    }
  }

  /** True if a process with this PID currently exists on the machine. */
  private isPidAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {return false;}
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      // EPERM => process exists but we may not signal it: still alive.
      return (err as NodeJS.ErrnoException)?.code === 'EPERM';
    }
  }

  /** A lock proves live ownership only if its owner is alive and its heartbeat is fresh. */
  private isRuntimeLockLive(lock: SiteRuntimeLock | undefined): boolean {
    if (!lock) {return false;}
    if (Date.now() - lock.heartbeatAt > RUNTIME_LOCK_FRESH_MS) {return false;}
    return this.isPidAlive(lock.ownerPid);
  }

  /** Claim/refresh ownership of a running site for this window. */
  private writeRuntimeLock(siteId: string): void {
    this.storage.setRuntimeLock(siteId, { ownerPid: this.instancePid, heartbeatAt: Date.now() });
  }

  private clearRuntimeLock(siteId: string): void {
    this.storage.clearRuntimeLock(siteId);
  }

  /** Tear down an orphaned web server that survived a window reload. */
  private async cleanupOrphanedSite(site: WPSite): Promise<void> {
    try {
      await this.processes.stopSite(site);
    } catch (err) {
      Logger.error(`[SiteManager] failed to stop orphaned server for "${site.name}"`, err);
    }
    this.proxyRouter?.unregister(site);
    if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}
  }

  private async syncRunningSitesInternal(): Promise<void> {
    for (const [id, site] of this.sites) {
      // A start initiated by this window is in flight — the process map may not
      // reflect reality yet, so skip to avoid killing a server we are spawning.
      if (this.startInFlight.has(id)) {continue;}

      const running = this.processes.isSiteRunning(id);

      if (!running) {
        this.syncProbeFailures.delete(id);
        if (site.status === 'running') {
          const probe = await this.checkSiteReachability(site, 1_500);
          if (probe.ready) {
            if (this.isRuntimeLockLive(this.storage.getRuntimeLock(id))) {
              // Owned by a live VS Code window. Keep the shared running status
              // without attempting local auto-recovery.
              await this.exposeExternalRunningSite(site);
              continue;
            }
            // Port answers but nobody owns it — an orphaned web server that
            // survived a window reload. Kill it and report the real state.
            Logger.log(
              `[SiteManager] "${site.name}" reachable but unowned (stale lock) — cleaning up orphaned server`
            );
            await this.cleanupOrphanedSite(site);
            this.updateStatus(id, 'stopped');
            continue;
          }

          if (!this.intentionalStops.has(id)) {
            Logger.log(
              `[SiteManager] "${site.name}" marked running but no local/external server was found — marking stopped`
            );
          }
          this.updateStatus(id, 'stopped');
          continue;
        }
        if (site.status === 'starting') {
          const probe = await this.checkSiteReachability(site, 1_500);
          const startOwnerLive = this.isRuntimeLockLive(this.storage.getRuntimeLock(id));
          if (probe.ready && startOwnerLive) {
            await this.exposeExternalRunningSite(site);
            this.updateStatus(id, 'running');
          } else if (!startOwnerLive) {
            if (probe.ready) {
              Logger.log(`[SiteManager] "${site.name}" is starting/reachable but unowned — cleaning up orphaned server`);
              await this.cleanupOrphanedSite(site);
            } else {
              Logger.log(`[SiteManager] unowned starting status for "${site.name}" — marking stopped`);
            }
            this.updateStatus(id, 'stopped');
          } else if (this.isStartingStatusStale(site)) {
            Logger.log(`[SiteManager] stale starting status for "${site.name}" — marking stopped`);
            this.updateStatus(id, 'stopped');
          }
          continue;
        }
        if (site.status !== 'stopped') {
          this.updateStatus(id, 'stopped');
        }
        continue;
      }

      if (site.status === 'starting') {
        continue;
      }

      const probe = await this.checkSiteReachability(site, 4_000);

      if (probe.ready) {
        this.syncProbeFailures.delete(id);
        // This window owns the live process — keep the shared lock fresh so other
        // windows can tell this is a real owner and not an orphan.
        this.writeRuntimeLock(id);
        if (site.status !== 'running') {
          Logger.log(`[SiteManager] sync status for "${site.name}": ${site.status} -> running`);
          this.updateStatus(id, 'running');
        }
        continue;
      }

      // Процесс жив, но проба не прошла — терпим разовые промахи под нагрузкой.
      // После нескольких неудач подряд автоматически перезапускаем сайт.
      const failures = (this.syncProbeFailures.get(id) ?? 0) + 1;
      this.syncProbeFailures.set(id, failures);
      if (failures < SITE_PROBE_FAILURES_BEFORE_RECOVERY) {
        Logger.log(
          `[SiteManager] sync probe miss #${failures} for "${site.name}"${probe.error ? ` (${probe.error})` : ''} — пропускаю`
        );
        continue;
      }
      Logger.log(
        `[SiteManager] "${site.name}" failed ${failures} health probes${probe.error ? ` (${probe.error})` : ''} — auto-recovery`
      );
      this.scheduleAutoRecovery(id, probe.error ? `health probe failed: ${probe.error}` : 'health probe failed');
    }
  }

  private scheduleAutoRecovery(siteId: string, reason: string): void {
    const site = this.sites.get(siteId);
    if (!site) {return;}
    if (this.intentionalStops.has(siteId)) {return;}
    if (this.autoRecoverInFlight.has(siteId)) {
      Logger.log(`[SiteManager] auto-recovery already running for "${site.name}"`);
      return;
    }

    const now = Date.now();
    const last = this.lastAutoRecoverAt.get(siteId) ?? 0;
    if (now - last < SITE_AUTO_RECOVERY_COOLDOWN_MS) {
      Logger.log(`[SiteManager] auto-recovery cooldown for "${site.name}" (${reason})`);
      if (site.status !== 'error') {
        this.updateStatus(siteId, 'error');
      }
      return;
    }

    void this.autoRecoverSite(siteId, reason);
  }

  private async autoRecoverSite(siteId: string, reason: string): Promise<void> {
    if (this.autoRecoverInFlight.has(siteId)) {return;}
    const site = this.sites.get(siteId);
    if (!site) {return;}

    this.autoRecoverInFlight.add(siteId);
    this.lastAutoRecoverAt.set(siteId, Date.now());
    this.syncProbeFailures.delete(siteId);
    Logger.log(`[SiteManager] auto-recovery START for "${site.name}": ${reason}`);

    try {
      this.updateStatus(siteId, 'starting');
      await this.processes.stopSite(site).catch((err) => {
        Logger.error(`[SiteManager] auto-recovery stop failed for "${site.name}"`, err);
      });
      this.proxyRouter?.unregister(site);
      if (site.domain) {this.proxyRouter?.unregisterSni(site.domain);}

      await this.startSite(siteId, (msg) => {
        Logger.log(`[SiteManager] auto-recovery "${site.name}": ${msg}`);
      });
      Logger.log(`[SiteManager] auto-recovery OK for "${site.name}"`);
    } catch (err) {
      Logger.error(`[SiteManager] auto-recovery FAILED for "${site.name}"`, err);
      this.updateStatus(siteId, 'error');
    } finally {
      this.autoRecoverInFlight.delete(siteId);
    }
  }

  /** Update editable site properties (name, port, web server). */
  async updateSite(
    siteId: string,
    updates: { name?: string; port?: number; webServer?: 'php' | 'nginx' | 'apache' }
  ): Promise<WPSite> {
    const site = this.requireSite(siteId);
    const wasRunning = site.status === 'running' && this.processes.isSiteRunning(siteId);
    const prevServer = site.webServer ?? 'php';
    const prevPort = site.port;

    if (updates.name !== undefined && updates.name.trim()) {
      site.name = updates.name.trim();
    }
    if (updates.port !== undefined && updates.port > 0) {
      site.port = updates.port;
    }
    if (updates.webServer !== undefined) {
      site.webServer = updates.webServer;
    }

    this.sites.set(siteId, site);
    this.storage.saveSite(site);

    const serverChanged = (site.webServer ?? 'php') !== prevServer;
    const portChanged = site.port !== prevPort;
    if (wasRunning && (serverChanged || portChanged)) {
      Logger.log(`[SiteManager] restart required for "${site.name}" after settings update`);
      await this.stopSite(siteId);
      await this.startSite(siteId);
      return this.requireSite(siteId);
    }

    return site;
  }

  setRemoteLinks(siteId: string, remoteIds: string[]): WPSite {
    const site = this.requireSite(siteId);
    site.remoteIds = Array.from(new Set(remoteIds.filter(Boolean)));
    this.sites.set(siteId, site);
    this.storage.saveSite(site);
    return site;
  }

  addRemoteLink(siteId: string, remoteId: string): WPSite {
    const site = this.requireSite(siteId);
    const remoteIds = Array.from(new Set([...(site.remoteIds ?? []), remoteId].filter(Boolean)));
    return this.setRemoteLinks(siteId, remoteIds);
  }

  removeRemoteLink(siteId: string, remoteId: string): WPSite {
    const site = this.requireSite(siteId);
    return this.setRemoteLinks(siteId, (site.remoteIds ?? []).filter((id) => id !== remoteId));
  }

  /** Update WP_DEBUG / WP_DEBUG_LOG / SCRIPT_DEBUG for this site. */
  async updateDebugSettings(
    siteId: string,
    debug: { wpDebug?: boolean; wpDebugLog?: boolean; wpScriptDebug?: boolean }
  ): Promise<WPSite> {
    const site = this.requireSite(siteId);
    if (debug.wpDebug !== undefined) {site.wpDebug = debug.wpDebug;}
    if (debug.wpDebugLog !== undefined) {site.wpDebugLog = debug.wpDebugLog;}
    if (debug.wpScriptDebug !== undefined) {site.wpScriptDebug = debug.wpScriptDebug;}
    this.sites.set(siteId, site);
    this.storage.saveSite(site);
    // Patch existing wp-config.php immediately
    this.processes.updateWpConfig(site);
    return site;
  }

  /** Update domain and optionally ssl flag. Returns updated site. */
  async updateDomain(siteId: string, domain: string | undefined, ssl: boolean): Promise<WPSite> {
    const site = this.requireSite(siteId);
    const oldDomain = site.domain;
    const oldUrl = this.processes.getSiteUrl(site);
    const requestedDomain = this.normalizeDomain(domain);
    const newDomain = requestedDomain ? this.makeUniqueDomain(requestedDomain, siteId) : undefined;
    site.domain = newDomain;
    site.ssl = ssl;
    this.sites.set(siteId, site);
    this.storage.saveSite(site);

    if (oldDomain && oldDomain !== newDomain) {
      await removeHostsEntry(oldDomain);
      this.proxyRouter?.unregister({ ...site, domain: oldDomain });
      this.proxyRouter?.unregisterSni(oldDomain);
    }

    if (site.status === 'running' && newDomain) {
      const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
      await addHostsEntry(newDomain, hostsIp);
      this.proxyRouter?.register(site);
      if (ssl && this.ssl && this.proxyRouter) {
        try {
          const cert = await this.ssl.generateSiteCert(newDomain);
          await this.proxyRouter.registerSni(newDomain, cert.certPath, cert.keyPath);
        } catch (err) {
          Logger.error(`[SiteManager] SSL cert failed for ${newDomain} during updateDomain`, err);
        }
      } else {
        this.proxyRouter?.unregisterSni(newDomain);
      }
    }

    this.processes.updateWpConfig(site);

    // Run WP search-replace if site is installed and URL changed
    const newUrl = this.processes.getSiteUrl(site);
    const publicDir = this.processes.publicDir(site);
    if (fs.existsSync(path.join(publicDir, 'wp-config.php')) && oldUrl !== newUrl) {
      try {
        await this.runtime.runWpCli(
          ['search-replace', oldUrl, newUrl, '--skip-columns=guid', '--allow-root'],
          publicDir,
          site.phpVersion,
          { WP_CLI_ALLOW_ROOT: '1' }
        );
        await this.runtime.runWpCli(
          ['option', 'update', 'siteurl', newUrl, `--path=${publicDir}`, '--allow-root'],
          publicDir,
          site.phpVersion,
          { WP_CLI_ALLOW_ROOT: '1' }
        );
        await this.runtime.runWpCli(
          ['option', 'update', 'home', newUrl, `--path=${publicDir}`, '--allow-root'],
          publicDir,
          site.phpVersion,
          { WP_CLI_ALLOW_ROOT: '1' }
        );
      } catch { /* ignore if WP not installed yet */ }
    }
    return site;
  }

  /**
   * Opens Adminer in the system browser for this site.
   * Downloads adminer.php on first use (single file, ~500 KB).
   */
  async openAdminer(siteId: string): Promise<void> {
    const site = this.requireSite(siteId);
    if (site.status !== 'running') {throw new Error('Сайт должен быть запущен, чтобы открыть базу данных');}
    const dbPass = await this.getDbPassword(siteId);
    const adminerSrc = await this.runtime.ensureAdminer();

    // Copy adminer.php to site's public/ on each open (so it's always fresh)
    const publicDir = this.processes.publicDir(site);
    const dest = path.join(publicDir, 'adminer.php');
    fs.copyFileSync(adminerSrc, dest);

    const base = this.processes.getSiteUrl(site);
    const esc = (v: string) =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const launcherPath = path.join(publicDir, 'wpdock-adminer-login.html');
    const launcherHtml = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>WPDock Adminer Login</title></head>
<body>
  <form id="f" action="adminer.php" method="post">
    <input type="hidden" name="auth[driver]" value="server">
    <input type="hidden" name="auth[server]" value="${esc(`127.0.0.1:${this.runtime.dbPort}`)}">
    <input type="hidden" name="auth[username]" value="${esc(site.dbUser ?? '')}">
    <input type="hidden" name="auth[password]" value="${esc(dbPass ?? '')}">
    <input type="hidden" name="auth[db]" value="${esc(site.dbName ?? '')}">
  </form>
  <script>document.getElementById('f').submit();</script>
</body>
</html>`;
    fs.writeFileSync(launcherPath, launcherHtml, 'utf-8');

    await this.openTrustedExternal(`${base}/wpdock-adminer-login.html`);
  }

  /**
   * Opens a VS Code terminal pre-configured for WP-CLI on this site.
   * Sets cwd = site/public, PHP path, WP-CLI path so `wp` works directly.
   */
  openWpCliTerminal(siteId: string): void {
    const site = this.requireSite(siteId);
    if (site.status !== 'running') {throw new Error('Сайт должен быть запущен, чтобы открыть WP-CLI');}
    const pubDir = this.processes.publicDir(site);
    const phpExe = this.runtime.phpExe(site.phpVersion);
    const wpcliIni = this.runtime.getWpCliPhpIniPath(site.phpVersion);
    const wpcli = this.runtime.wpcliPath;
    const q = (value: string) => value.replace(/'/g, "''");

    const phpExeQ = q(phpExe);
    const wpcliIniQ = q(wpcliIni);
    const wpcliQ = q(wpcli);
    const pubDirQ = q(pubDir);

    const term = vscode.window.createTerminal({
      name: `WP-CLI — ${site.name}`,
      cwd: pubDir,
      env: {
        WP_CLI_PHP: phpExe,
        WP_CLI_ALLOW_ROOT: '1',
      },
      shellPath: os.platform() === 'win32' ? 'powershell.exe' : undefined,
    });
    term.show();

    // Register a robust PowerShell helper that uses the same php.ini as runtime.runWpCli.
    if (os.platform() === 'win32') {
      term.sendText(
        `function global:wp { param([Parameter(ValueFromRemainingArguments=$true)][string[]]$WpArgs) & '${phpExeQ}' -c '${wpcliIniQ}' '${wpcliQ}' --no-color --path='${pubDirQ}' --allow-root @WpArgs }`,
        true
      );
    } else {
      term.sendText(`alias wp='${phpExe} -c ${wpcliIni} ${wpcli} --no-color --path=${pubDir} --allow-root'`, true);
    }
    term.sendText(`wp --info`, true);
  }

  /**
   * Runs a WP-CLI command for the given site and returns stdout.
   * Used by the UI "WP-CLI Console" section.
   */
  async runWpCliCommand(siteId: string, command: string): Promise<string> {
    const site = this.requireSite(siteId);
    if (site.status !== 'running') {throw new Error('Сайт должен быть запущен, чтобы выполнять WP-CLI команды');}
    const args = command.trim().split(/\s+/);
    if (args[0] === 'wp') {args.shift();} // strip leading 'wp'
    // Manual console: site is running (web server up, no loopback hang) and the
    // user may intentionally run plugin/theme/cron/eval — run args verbatim.
    return this.runtime.runWpCli(
      [`--path=${this.processes.publicDir(site)}`, ...args],
      this.processes.publicDir(site),
      site.phpVersion,
      { WP_CLI_ALLOW_ROOT: '1' },
      { rawExtensions: true }
    );
  }

  /**
   * Exports current local site DB to an SQL file.
   * Used by remote push to avoid uploading stale database.sql snapshots.
   */
  async exportSiteDatabase(siteId: string, outputPath: string): Promise<void> {
    const site = this.requireSite(siteId);
    if (!site.dbName) {
      throw new Error(`Site ${site.name} has no dbName — cannot export database.`);
    }

    await this.runtime.startDatabase();
    await this.runtime.dumpDatabase(site.dbName, outputPath);
    Logger.log(`[SiteManager] exportSiteDatabase complete site=${site.name} db=${site.dbName} output=${outputPath}`);
  }

  /**
   * Restores SQL dump into an existing local site after remote pull.
   * Also syncs site URLs and runs lightweight post-import sanity checks.
   */
  async applyPulledDatabase(
    siteId: string,
    sqlPath: string,
    onProgress?: (msg: string) => void,
    preserveCredentials = true
  ): Promise<PullDatabaseDiagnostic> {
    const site = this.requireSite(siteId);
    if (!site.dbName) {
      throw new Error(`Site ${site.name} has no dbName — cannot restore pulled database.`);
    }
    if (!fs.existsSync(sqlPath)) {
      throw new Error(`SQL dump not found: ${sqlPath}`);
    }

    const sqlContent = fs.readFileSync(sqlPath, 'utf-8');
    const remoteDbStats = this.readRemoteDbStats(sqlPath);
    const importedPrefix = this.resolveImportedTablePrefix(sqlContent, remoteDbStats);

    const diagnostic: PullDatabaseDiagnostic = {
      wpInstalled: false,
      expectedTableCount: this.extractExpectedTableNames(sqlContent).length,
      tablePrefix: importedPrefix,
      missingThemes: [],
      warnings: [],
      notes: [],
      summary: '',
    };

    Logger.log(`[SiteManager] applyPulledDatabase START site=${site.name} siteId=${siteId} sqlPath=${sqlPath} expectedTables=${diagnostic.expectedTableCount} preserveCredentials=${preserveCredentials}`);

    await this.runtime.startDatabase();
    this.normalizeSiteLayout(site);

    // ── Snapshot local credentials (before wipe) ──────────────────────────
    // We detect the prefix that will be used AFTER restore (from the dump),
    // then try to dump those same-named tables from the current local DB.
    // On first pull, or if prefixes differ, the dump will silently return empty
    // and we simply skip restoration.
    let credentialSql = '';
    if (preserveCredentials) {
      const prefix = this.detectSqlPrefix(sqlContent);
      const usersTbl    = `${prefix}users`;
      const usermetaTbl = `${prefix}usermeta`;
      const optsTbl     = `${prefix}options`;

      // Dump users & usermeta (full row replacement)
      const usersSql  = this.runtime.dumpTablesSql(site.dbName, [usersTbl, usermetaTbl]);

      // Dump only the 8 WP secret keys/salts rows from wp_options
      // We can't use WHERE in mysqldump, so we dump the whole options table and
      // post-filter the INSERT lines we need.
      const allOptsSql = this.runtime.dumpTablesSql(site.dbName, [optsTbl]);
      const authKeys   = ['auth_key', 'secure_auth_key', 'logged_in_key', 'nonce_key',
                          'auth_salt', 'secure_auth_salt', 'logged_in_salt', 'nonce_salt'];
      const authRegex  = new RegExp(
        `REPLACE INTO[^;]+option_name[^;]*'(${authKeys.join('|')})'[^;]+;`,
        'gi'
      );
      const authMatches = allOptsSql.match(authRegex) ?? [];
      const authSql     = authMatches.join('\n');

      credentialSql = [usersSql, authSql].filter(Boolean).join('\n');

      const linesCount = credentialSql.split('\n').filter((l) => l.startsWith('REPLACE')).length;
      Logger.log(`[SiteManager] applyPulledDatabase credentialSnapshot prefix=${prefix} replaceLines=${linesCount}`);
      if (linesCount > 0) {
        diagnostic.notes.push(`Учётные данные сохранены (${linesCount} строк) для восстановления после импорта.`);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    onProgress?.('Импорт базы данных в локальный сайт...');
    await this.runtime.restoreDatabase(site.dbName, sqlPath);
    Logger.log(`[SiteManager] applyPulledDatabase restoreDatabase complete site=${site.name} db=${site.dbName}`);

    const publicDir = this.processes.publicDir(site);
    const env = { WP_CLI_ALLOW_ROOT: '1' };
    const newUrl = this.processes.getSiteUrl(site);
    // --skip-plugins/--skip-themes: these post-import maintenance commands only
    // touch core tables (options/users). Loading the imported site's plugins here
    // triggers a blocking loopback request on bootstrap (wp-cron/Action Scheduler)
    // that hangs while the site's web server is not yet serving — the same hang
    // already worked around in the site-start path. Without this the whole Pull
    // stalls/aborts after the DB import, leaving URL sync / credential restore /
    // rewrite flush unapplied.
    const skipFlags = ['--skip-plugins', '--skip-themes'];

    // WordPress decides whether it is installed by looking for tables with the
    // prefix from wp-config.php. Remote hosts often use a non-default prefix, so
    // after importing the dump we must point local wp-config.php at that prefix
    // before running WP-CLI checks or opening the site.
    this.processes.setWpConfigTablePrefix(site, importedPrefix);
    diagnostic.notes.push(`Префикс таблиц синхронизирован: ${importedPrefix}`);

    const isInstalled = await this.runtime.runWpCli(
      ['core', 'is-installed', `--path=${publicDir}`, '--allow-root', ...skipFlags],
      publicDir,
      site.phpVersion,
      env
    ).then(() => true).catch(() => false);
    diagnostic.wpInstalled = isInstalled;

    if (!isInstalled) {
      const message = `После импорта БД WordPress не видит установленные таблицы (prefix=${importedPrefix}, expectedTables=${diagnostic.expectedTableCount}). Проверьте database.sql и table_prefix в wp-config.php.`;
      onProgress?.(message);
      diagnostic.warnings.push(message);
      diagnostic.summary = message;
      Logger.error(`[SiteManager] applyPulledDatabase WP not installed after restore site=${site.name} prefix=${importedPrefix}`);
      throw new Error(message);
    }

    try {
      const oldHome = (await this.runtime.runWpCli(
        ['option', 'get', 'home', `--path=${publicDir}`, '--allow-root', ...skipFlags],
        publicDir,
        site.phpVersion,
        env
      )).trim();

      if (oldHome && oldHome !== newUrl) {
        onProgress?.('Синхронизация URL в базе данных...');
        await this.runtime.runWpCli(
          ['search-replace', oldHome, newUrl, '--skip-columns=guid', `--path=${publicDir}`, '--allow-root', ...skipFlags],
          publicDir,
          site.phpVersion,
          env
        );
        diagnostic.notes.push(`URL search-replace: ${oldHome} -> ${newUrl}`);
      }
    } catch {
      // Ignore lookup/search-replace errors and still force siteurl/home below.
      diagnostic.warnings.push('Не удалось выполнить search-replace URL, продолжено через прямое обновление siteurl/home.');
    }

    await this.runtime.runWpCli(
      ['option', 'update', 'siteurl', newUrl, `--path=${publicDir}`, '--allow-root', ...skipFlags],
      publicDir,
      site.phpVersion,
      env
    );
    await this.runtime.runWpCli(
      ['option', 'update', 'home', newUrl, `--path=${publicDir}`, '--allow-root', ...skipFlags],
      publicDir,
      site.phpVersion,
      env
    );

    try {
      diagnostic.siteurl = (await this.runtime.runWpCli(
        ['option', 'get', 'siteurl', `--path=${publicDir}`, '--allow-root', ...skipFlags],
        publicDir,
        site.phpVersion,
        env
      )).trim();
      diagnostic.home = (await this.runtime.runWpCli(
        ['option', 'get', 'home', `--path=${publicDir}`, '--allow-root', ...skipFlags],
        publicDir,
        site.phpVersion,
        env
      )).trim();
    } catch {
      diagnostic.warnings.push('Не удалось прочитать siteurl/home после импорта.');
    }

    // ── Restore local credentials (after URL fix) ─────────────────────────
    if (preserveCredentials && credentialSql) {
      try {
        onProgress?.('Восстановление учётных данных (логины, пароли, auth-ключи)...');
        await this.runtime.runMysqlSql(site.dbName, credentialSql);
        diagnostic.notes.push('Учётные данные локального сайта восстановлены после импорта.');
        Logger.log(`[SiteManager] applyPulledDatabase credentials restored site=${site.name}`);
      } catch (credErr: any) {
        // Non-fatal: warn but continue — the user can reset their password manually.
        const msg = `Не удалось восстановить учётные данные: ${credErr?.message ?? credErr}`;
        diagnostic.warnings.push(msg);
        Logger.error(`[SiteManager] applyPulledDatabase credential restore failed site=${site.name}`, credErr);
      }
    }
    // ─────────────────────────────────────────────────────────────────────

    try {
      await this.runtime.runWpCli(
        ['rewrite', 'flush', '--hard', `--path=${publicDir}`, '--allow-root', ...skipFlags],
        publicDir,
        site.phpVersion,
        env
      );
      diagnostic.notes.push('Постоянные ссылки обновлены (rewrite flush).');
    } catch {
      // Ignore rewrite flush errors.
      diagnostic.warnings.push('Не удалось выполнить rewrite flush.');
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
      diagnostic.stylesheet = stylesheet;
      diagnostic.template = template;

      const missingThemes = [stylesheet, template]
        .filter(Boolean)
        .filter((themeSlug, index, arr) => arr.indexOf(themeSlug) === index)
        .filter((themeSlug) => !fs.existsSync(path.join(this.getSiteContentDir(site), 'themes', themeSlug)));

      diagnostic.missingThemes = missingThemes;

      if (missingThemes.length > 0) {
        onProgress?.(`Предупреждение: отсутствуют активные темы после pull: ${missingThemes.join(', ')}`);
        diagnostic.warnings.push(`Отсутствуют активные темы: ${missingThemes.join(', ')}`);
      } else if (stylesheet || template) {
        onProgress?.('Активная тема подтверждена после импорта БД.');
        diagnostic.notes.push(`Активная тема подтверждена: stylesheet=${stylesheet || '-'}, template=${template || '-'}`);
      }
    } catch {
      // Ignore theme sanity check errors.
      diagnostic.warnings.push('Не удалось проверить активную тему после импорта.');
    }

    try {
      const tableCountRaw = (await this.runtime.runWpCli(
        [
          'eval',
          "$tables = $GLOBALS['wpdb']->get_col('SHOW TABLES'); echo is_array($tables) ? count($tables) : 0;",
          `--path=${publicDir}`,
          '--allow-root',
        ],
        publicDir,
        site.phpVersion,
        env
      )).trim();
      const tableCount = Number.parseInt(tableCountRaw, 10);
      if (Number.isFinite(tableCount)) {
        diagnostic.actualTableCount = tableCount;
      }
    } catch {
      diagnostic.warnings.push('Не удалось подсчитать число таблиц в восстановленной БД.');
    }

    if (!remoteDbStats) {
      const message = 'Импорт БД не подтверждён: отсутствует database.meta.json со статистикой удалённой БД. Обновите/переустановите WPDock Agent и повторите pull.';
      diagnostic.warnings.push(message);
      Logger.error(`[SiteManager] applyPulledDatabase missing database.meta.json for site=${site.name}`);
      throw new Error(message);
    }
    const remoteTableCount = Object.keys(remoteDbStats?.tables ?? {}).length;
    if (remoteDbStats && remoteTableCount > 0) {
      onProgress?.('Проверка полноты ключевых таблиц после импорта...');
      try {
        const mismatches = await this.compareRemoteTableCounts(site, remoteDbStats);
        diagnostic.remoteStatsChecked = true;
        diagnostic.taxonomyCountMismatches = mismatches;
        if (mismatches.length > 0) {
          const preview = mismatches.slice(0, 3).join('; ');
          Logger.error(`[SiteManager] applyPulledDatabase table mismatches for site=${site.name}: ${mismatches.join(' | ')}`);
          throw new Error(
            `Импорт БД неполный: расхождение строк в ключевых таблицах (${preview}${mismatches.length > 3 ? '; ...' : ''}).`
          );
        }
        Logger.log(`[SiteManager] applyPulledDatabase remote table counts verified site=${site.name} tables=${remoteTableCount}`);
        diagnostic.notes.push('Сверка ключевых таблиц с удалённым сайтом: OK.');
      } catch (err: any) {
        const message = String(err?.message ?? err ?? 'Неизвестная ошибка сверки ключевых таблиц');
        diagnostic.warnings.push(message);
        Logger.error(`[SiteManager] applyPulledDatabase compareRemoteTableCounts failed for site=${site.name}`, err);
        throw new Error(message);
      }
    }

    const lines = [
      `WP: ${diagnostic.wpInstalled ? 'installed' : 'not-installed'}`,
      `tables: ${diagnostic.actualTableCount ?? '?'} / expected ${diagnostic.expectedTableCount}`,
      `prefix: ${diagnostic.tablePrefix || '-'}`,
      `siteurl: ${diagnostic.siteurl || '-'}`,
      `home: ${diagnostic.home || '-'}`,
      `theme: ${diagnostic.stylesheet || '-'} / ${diagnostic.template || '-'}`,
    ];
    diagnostic.summary = `Post-pull checks: ${lines.join(' | ')}`;

    if (diagnostic.warnings.length > 0) {
      onProgress?.(`Диагностика pull: ${diagnostic.warnings[0]}`);
    }

    Logger.log(`[SiteManager] applyPulledDatabase SUCCESS site=${site.name} summary=${diagnostic.summary}`);

    return diagnostic;
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

  /** Detect the table prefix from a SQL dump by matching known WP core table suffixes. */
  private detectSqlPrefix(sql: string): string {
    const knownSuffixes = [
      'options', 'posts', 'postmeta', 'users', 'usermeta',
      'term_relationships', 'term_taxonomy', 'termmeta', 'terms',
      'commentmeta', 'comments', 'links',
    ];
    const tables = this.extractExpectedTableNames(sql);
    for (const tbl of tables) {
      const lower = tbl.toLowerCase();
      for (const suffix of knownSuffixes) {
        if (lower.endsWith(suffix) && tbl.length > suffix.length) {
          const candidate = tbl.slice(0, tbl.length - suffix.length);
          if (/^[a-z0-9_]+$/i.test(candidate)) {return candidate;}
        }
      }
    }
    return 'wp_';
  }

  /** Prefer the agent-reported WP prefix, fall back to detecting it from CREATE TABLE names. */
  private resolveImportedTablePrefix(sql: string, remoteStats?: RemoteDbStats): string {
    const statPrefix = String(remoteStats?.prefix ?? '').trim();
    if (/^[a-zA-Z0-9_]+$/.test(statPrefix)) {
      return statPrefix;
    }

    return this.detectSqlPrefix(sql);
  }

  private readRemoteDbStats(sqlPath: string): RemoteDbStats | undefined {
    const metaPath = path.join(path.dirname(sqlPath), 'database.meta.json');
    if (!fs.existsSync(metaPath)) {
      return undefined;
    }

    try {
      const raw = fs.readFileSync(metaPath, 'utf-8');
      const parsed = JSON.parse(raw) as RemoteDbStats;
      if (!parsed || typeof parsed !== 'object') {
        return undefined;
      }
      if (!parsed.tables || typeof parsed.tables !== 'object') {
        return undefined;
      }

      const normalized: Record<string, number> = {};
      for (const [tableName, value] of Object.entries(parsed.tables)) {
        if (!/^[a-zA-Z0-9_]+$/.test(tableName)) {continue;}
        const num = Number.parseInt(String(value), 10);
        if (!Number.isFinite(num) || num < 0) {continue;}
        normalized[tableName] = num;
      }

      return {
        prefix: typeof parsed.prefix === 'string' ? parsed.prefix : undefined,
        tables: normalized,
      };
    } catch {
      return undefined;
    }
  }

  private async compareRemoteTableCounts(site: WPSite, remoteStats: RemoteDbStats): Promise<string[]> {
    const tableNames = Object.keys(remoteStats.tables ?? {}).filter((tableName) => /^[a-zA-Z0-9_]+$/.test(tableName));
    if (tableNames.length === 0) {
      return [];
    }

    const publicDir = this.processes.publicDir(site);
    const env = { WP_CLI_ALLOW_ROOT: '1' };

    const tableLiteral = tableNames.map((name) => `'${name}'`).join(',');
    const evalCode = [
      `$tables = array(${tableLiteral});`,
      '$out = array();',
      'foreach ($tables as $table) {',
      '  if (!preg_match("/^[a-zA-Z0-9_]+$/", $table)) { continue; }',
      '  $value = $GLOBALS["wpdb"]->get_var("SELECT COUNT(*) FROM `{$table}`");',
      '  $out[$table] = is_null($value) ? null : (int)$value;',
      '}',
      'echo wp_json_encode($out);',
    ].join(' ');

    const raw = (await this.runtime.runWpCli(
      ['eval', evalCode, `--path=${publicDir}`, '--allow-root'],
      publicDir,
      site.phpVersion,
      env
    )).trim();

    let localCounts: Record<string, number | null> = {};
    try {
      const parsed = JSON.parse(raw) as Record<string, number | null>;
      if (parsed && typeof parsed === 'object') {
        localCounts = parsed;
      }
    } catch {
      throw new Error('Не удалось прочитать JSON со счётчиками таблиц из WP-CLI.');
    }

    const mismatches: string[] = [];
    for (const tableName of tableNames) {
      const remoteCount = Number.parseInt(String((remoteStats.tables ?? {})[tableName]), 10);
      const localRaw = localCounts[tableName];
      const localCount = localRaw === null || localRaw === undefined
        ? Number.NaN
        : Number.parseInt(String(localRaw), 10);

      // wp_options can legitimately grow locally during post-pull steps
      // (siteurl/home sync, rewrite flush, transient creation). Treat only
      // lower local count as a real mismatch for options.
      const isOptionsTable = /_options$/i.test(tableName);
      if (isOptionsTable && Number.isFinite(remoteCount) && Number.isFinite(localCount) && localCount >= remoteCount) {
        continue;
      }

      if (!Number.isFinite(remoteCount) || !Number.isFinite(localCount) || remoteCount !== localCount) {
        mismatches.push(`${tableName}: remote=${Number.isFinite(remoteCount) ? remoteCount : 'n/a'}, local=${Number.isFinite(localCount) ? localCount : 'n/a'}`);
      }
    }

    return mismatches;
  }

  /**
   * Generates a one-time magic-link token via WP transient (Variant B).
   * Returns the full login URL to open in browser.
   */
  async getAutoLoginUrl(siteId: string): Promise<string> {
    const site = this.requireSite(siteId);
    const token = crypto.randomBytes(24).toString('hex');
    const pubDir = this.processes.publicDir(site);
    const adminLogin = String(site.adminUser ?? 'admin').replace(/\\/g, '\\\\').replace(/'/g, "\\'");

    // Store token in WP transient (1 hour TTL) with a concrete WP user ID.
    // Using a fixed value (e.g. 1) is unreliable on migrated/imported sites.
    await this.runtime.runWpCli(
      [
        '--path=' + pubDir,
        'eval',
        `$u = get_user_by('login', '${adminLogin}'); $uid = $u ? (int)$u->ID : 0; if (!$uid) { $uid = (int)get_current_user_id(); } if (!$uid) { $uid = 1; } set_transient('wpdock_autologin_${token}', $uid, 3600);`,
        '--allow-root',
      ],
      pubDir,
      site.phpVersion,
      { WP_CLI_ALLOW_ROOT: '1' }
    );

    const base = this.processes.getSiteUrl(site);
    return `${base}/?wpdock_token=${token}`;
  }

  /** Path to the WordPress document root for this site. */
  getPublicDir(site: WPSite): string {
    return this.processes.publicDir(site);
  }

  /** Returns the public-facing URL for the site (http/https, domain or localhost). */
  getSiteUrl(site: WPSite): string {
    return this.processes.getSiteUrl(site);
  }

  /** Ensures hosts entries for all known local domains using one elevated write if needed. */
  async ensureHostsEntries(onProgress?: (msg: string) => void): Promise<void> {
    const hostsIp = this.proxyRouter?.getHostsIp() ?? '127.0.0.1';
    const domains = this.getAllSites()
      .map((site) => site.domain)
      .filter((domain): domain is string => Boolean(domain));

    if (domains.length === 0) {return;}
    onProgress?.(`Обновление hosts для ${domains.length} сайт(ов)...`);
    await addHostsEntries(domains.map((domain) => ({ domain, ip: hostsIp })));
  }

  private async openTrustedExternal(url: string): Promise<void> {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    await vscode.env.openExternal(uri);
  }

  /**
   * Called when portproxy is activated mid-session.
   * Updates hosts entries for all sites to the new IP and syncs WordPress
   * siteurl/home via WP-CLI so portless URLs work for existing sites.
   */
  async activatePortlessUrls(hostsIp: string): Promise<void> {
    Logger.log(`[SiteManager] activatePortlessUrls hostsIp=${hostsIp}`);
    for (const site of this.sites.values()) {
      if (!site.domain) {continue;}

      // Re-write hosts entry with new IP (addHostsEntry removes old one first)
      await addHostsEntry(site.domain, hostsIp);

      // Regenerate wp-config.php with the updated portless URL
      this.processes.updateWpConfig(site);

      // Update WordPress siteurl/home so WP doesn't redirect to the old URL.
      // Skip if site is not running — DB is unreachable and WP-CLI will fail.
      if (!this.processes.isSiteRunning(site.id)) {
        Logger.log(`[SiteManager] skipping WP-CLI siteurl update for "${site.name}" — site not running`);
        continue;
      }
      const newUrl = this.processes.getSiteUrl(site);
      const pubDir = this.processes.publicDir(site);
      Logger.log(`[SiteManager] updating WP siteurl → ${newUrl} for "${site.name}"`);
      try {
        await this.runtime.runWpCli(
          ['option', 'update', 'siteurl', newUrl, `--path=${pubDir}`, '--allow-root'],
          pubDir, site.phpVersion, { WP_CLI_ALLOW_ROOT: '1' }
        );
        await this.runtime.runWpCli(
          ['option', 'update', 'home', newUrl, `--path=${pubDir}`, '--allow-root'],
          pubDir, site.phpVersion, { WP_CLI_ALLOW_ROOT: '1' }
        );
      } catch (err) {
        Logger.error(`[SiteManager] WP-CLI siteurl update failed for "${site.name}" — restart site to apply`, err);
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private requireSite(id: string): WPSite {
    const site = this.sites.get(id);
    if (!site) {throw new Error(`Site ${id} not found`);}
    return site;
  }

  private updateStatus(siteId: string, status: WPSite['status']): void {
    const site = this.sites.get(siteId);
    if (!site) {return;}
    if (site.status === status) {return;}
    // A site that is no longer running must not keep an ownership lock around,
    // or another window would treat the dead/orphaned server as live.
    if (status === 'stopped' || status === 'error') {
      this.clearRuntimeLock(siteId);
    }
    site.status = status;
    site.statusUpdatedAt = new Date().toISOString();
    this.sites.set(siteId, site);
    this.storage.saveSite(site);
    this.onDidChangeSiteStatusEmitter.fire(site);
  }

  private findFreePort(start: number): Promise<number> {
    return new Promise((resolve) => {
      const server = net.createServer();
      server.listen(start, '127.0.0.1', () => {
        const addr = server.address() as net.AddressInfo;
        server.close(() => resolve(addr.port));
      });
      server.on('error', () => resolve(this.findFreePort(start + 1)));
    });
  }

  private slugify(name: string): string {
    return this.transliterate(name)
      .toLowerCase()
      .replace(/[^a-z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private isSitePathTaken(candidatePath: string): boolean {
    const normalized = path.resolve(candidatePath).toLowerCase();
    return Array.from(this.sites.values()).some((site) => path.resolve(site.path).toLowerCase() === normalized);
  }

  private ensureOperationalDomain(site: WPSite): string {
    const fallbackSlug = this.slugify(site.name) || `site-${site.id.slice(0, 8)}`;
    const normalized = this.normalizeDomain(site.domain) || `${fallbackSlug}.local`;
    return this.makeUniqueDomain(normalized, site.id);
  }

  private makeUniqueDomain(candidate: string, excludeSiteId?: string): string {
    const normalized = this.normalizeDomain(candidate);
    if (!normalized) {
      return `site-${Date.now()}.local`;
    }
    if (!this.isDomainTaken(normalized, excludeSiteId)) {
      return normalized;
    }

    const dotIndex = normalized.lastIndexOf('.');
    const hasTld = dotIndex > 0;
    const base = hasTld ? normalized.slice(0, dotIndex) : normalized;
    const suffix = hasTld ? normalized.slice(dotIndex) : '';

    for (let i = 2; i < 1000; i++) {
      const next = `${base}-${i}${suffix}`;
      if (!this.isDomainTaken(next, excludeSiteId)) {
        return next;
      }
    }

    return `${base}-${Date.now()}${suffix}`;
  }

  private isDomainTaken(domain: string, excludeSiteId?: string): boolean {
    const normalized = this.normalizeDomain(domain);
    if (!normalized) {return false;}
    for (const [id, site] of this.sites.entries()) {
      if (excludeSiteId && id === excludeSiteId) {continue;}
      if (this.normalizeDomain(site.domain) === normalized) {
        return true;
      }
    }
    return false;
  }
}
