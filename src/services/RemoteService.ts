import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import { Readable, Transform } from 'stream';
import { RemoteSite, RemoteSyncEvent } from '../types';
import { StorageService } from './StorageService';
import { Logger } from '../utils/logger';

const AGENT_PLUGIN_BASENAME = 'wpdock-agent/wpdock-agent.php';
const MIN_AGENT_VERSION = '1.3.0';
// First agent version with the `list_files` action — the prerequisite for the
// direct (PHP-bypassing) resumable media download. Below this we fall back to
// packing uploads through the agent like any other file.
const MEDIA_DIRECT_AGENT_VERSION = '1.3.6';
// First agent version whose `reset_wp` action also wipes content files (plugins,
// themes, uploads) while preserving the admin user, its Application Passwords,
// one default theme and the WPDock agent itself. 1.3.8 reset DB only.
const RESET_WP_AGENT_VERSION = '1.3.9';
let DIRECT_UPLOAD_MAX_BYTES = 1024 * 1024;
// Configurable chunk size for uploads (default 768KB, increase for better hosts)
// Use 1-2 MB for hosts with higher limits (300MB+)
let CHUNK_UPLOAD_BYTES = 768 * 1024;
// How many chunks are uploaded in parallel. The real Push speed ceiling on most
// hosts is request overhead (TLS handshake + PHP worker start + a per-chunk
// option-table write in the agent), so more parallel streams saturate the link
// better than bigger chunks. Configurable via wpdock.remoteUpload.concurrency;
// kept modest so a tiny shared-host PHP worker pool isn't exhausted.
let CHUNK_UPLOAD_CONCURRENCY = 8;
// Smallest chunk we will fall back to when a host rejects an oversized body (413).
const MIN_CHUNK_UPLOAD_BYTES = 256 * 1024;
const UPLOAD_RETRY_COUNT = 3;
const UPLOAD_RETRY_DELAY_MS = 1000;
// Upload abort is driven by an *idle* timer (no bytes sent), not a fixed total
// timeout — so genuinely slow-but-working uploads to remote hosts are not killed.
// We only abort when the socket makes no progress for this long.
const UPLOAD_IDLE_TIMEOUT_MS = 90 * 1000;
// Absolute safety ceiling per single request so a pathological stall can't hang forever.
const UPLOAD_HARD_CAP_MS = 30 * 60 * 1000;
// Downloads (pack parts, db dump, manifest) get the SAME idle/hard-cap treatment as
// uploads: abort only when NO bytes arrive for this long (a truly stalled connection /
// silently dropped socket), not after a fixed total — otherwise a slow-but-working
// transfer would be killed. Without this a stalled part download hangs Pull forever.
const DOWNLOAD_IDLE_TIMEOUT_MS = 90 * 1000;
const DOWNLOAD_HARD_CAP_MS = 30 * 60 * 1000;
// Direct media download (curl) stall guard. The batch curl invocation produces no
// parseable per-file progress, so we watch the aggregate on-disk size of the batch
// instead: if it stops growing for this long, the transfer has silently stalled
// (dropped socket / host stopped sending) — kill curl so the batch retry+resume
// runs in ~90s instead of sitting out the 30-min execFile cap (the old "Pull hangs
// at 10/12" symptom). A slow-but-steady download keeps the timer re-armed.
const MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS = 90 * 1000;
// How often to sample on-disk batch size for the stall guard + live progress.
const MEDIA_DOWNLOAD_SAMPLE_MS = 2 * 1000;
// Re-download attempts for a single pack part on a stall/transient drop. Re-fetching
// the same part_token is idempotent (the part ZIP persists server-side as a temp file),
// so a transient stall mid-pull is recovered instead of failing the whole Pull at ~92%.
const PART_DOWNLOAD_RETRY_COUNT = 3;
// Default timeout for short agent JSON requests (ping, register, status, …).
const AGENT_REQUEST_TIMEOUT_MS = 60 * 1000;
// Heavy server-side agent ops (pack_files, export_db, extract_files, import_db)
// block on the remote with NO byte progress while WordPress zips/dumps/imports,
// so the upload idle-timer doesn't apply — give them a generous absolute cap
// instead of the 60s default that aborts big sites mid-pack.
const AGENT_HEAVY_OP_TIMEOUT_MS = 30 * 60 * 1000;
// A single pack_files CONTINUE batch is server-capped (~12s), so its response
// must come back quickly. Unlike the manifest-building START (which can run long
// on huge sites and keeps the heavy-op cap), a CONTINUE that doesn't answer
// within this window is a silently stalled socket. Capping it here turns the old
// 30-min hang into a fast, recoverable failure — the whole pack restarts with a
// fresh job_id (re-packs from line 0, so no batch is skipped).
const AGENT_PACK_POLL_TIMEOUT_MS = 90 * 1000;
// Max concurrent shard streams during a sharded pull. The agent may split the
// manifest into more slices than this; we still process only this many at once
// so we don't exhaust the remote's (often tiny) PHP worker pool — 6 simultaneous
// heavy requests can starve a shared host until new TLS connections can't even
// handshake. 3 captures most of the per-connection-throttle win at low risk.
const MAX_PARALLEL_SHARDS = 3;
// How often to log upload throughput.
const UPLOAD_PROGRESS_LOG_INTERVAL_MS = 5 * 1000;
// ZIP compression: 1 = fastest (store+minimal), 6 = balance (default), 9 = slowest
// For push during dev, speed matters more than size
const ZIP_COMPRESSION_LEVEL = 1;
// Files/folders excluded from push (cache, logs, temp, etc.)
const PUSH_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.gitignore',
  'wp-config.php',
  '**/wp-config.php',
  'database.sql',
  '**/database.sql',
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
  // Never include the WPDock agent — it must stay at its installed remote version.
  'wp-content/plugins/wpdock-agent/**',
  'wp-content/plugins/wpdock-agent.php',
  '.vscode/**',
  '.idea/**',
  '*.swp',
  '*.swo',
  '.env.local',
  '.env.*.local',
];

// Aggressive filters for dev mode: exclude large media folders and build artifacts
// This can reduce push time by 60-80% in typical scenarios
const PUSH_AGGRESSIVE_DEV_FILTERS = [
  ...PUSH_IGNORE_PATTERNS,
  'wp-content/uploads/**',              // ← -60% of files on typical sites
  'wp-content/plugins/*/vendor/**',
  'wp-content/plugins/*/node_modules/**',
  'wp-content/themes/*/vendor/**',
  'wp-content/themes/*/node_modules/**',
  '**/dist/**',
  '**/build/**',
  '**/.turbo/**',
  '**/.next/**',
  '**/.nuxt/**',
];

export interface AgentInstallDiagnostic {
  code: string;
  title: string;
  details: string;
  recommendations: string[];
}

export interface RemoteTokenDiagnostic {
  restAuthOk: boolean;
  restAuthDetails: string;
  tokenRegisterOk: boolean;
  tokenRegisterDetails: string;
  /** Token diagnostics do not require an installed agent; ping is informational only. */
  pingOk: boolean;
  pingDetails: string;
  success: boolean;
  recommendations: string[];
}

export class RemoteService {
  private readonly onDidChangeRemotesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRemotes = this.onDidChangeRemotesEmitter.event;

  constructor(
    private context: vscode.ExtensionContext,
    private storage: StorageService
  ) {
    this.loadUploadSettings();
    this.context.subscriptions.push(
      this.storage.onDidChangeRemotes(() => this.onDidChangeRemotesEmitter.fire()),
      this.onDidChangeRemotesEmitter
    );
  }

  private loadUploadSettings(): void {
    const config = vscode.workspace.getConfiguration('wpdock.remoteUpload');
    DIRECT_UPLOAD_MAX_BYTES = this.normalizeUploadSettingBytes(
      config.get<number>('directUploadLimitMb'),
      1,
      0.5,
      1024
    );
    CHUNK_UPLOAD_BYTES = this.normalizeUploadSettingBytes(
      config.get<number>('chunkSizeMb'),
      0.75,
      0.25,
      128
    );
    CHUNK_UPLOAD_CONCURRENCY = this.normalizeConcurrency(config.get<number>('concurrency'));
  }

  private normalizeConcurrency(value: number | undefined): number {
    const v = Number.isFinite(value) ? Number(value) : 8;
    return Math.min(16, Math.max(1, Math.round(v)));
  }

  private normalizeUploadSettingBytes(
    valueMb: number | undefined,
    defaultMb: number,
    minMb: number,
    maxMb: number
  ): number {
    const value = Number.isFinite(valueMb) ? Number(valueMb) : defaultMb;
    const clampedMb = Math.min(maxMb, Math.max(minMb, value));
    return Math.round(clampedMb * 1024 * 1024);
  }

  async setChunkUploadSize(sizeInBytes: number): Promise<void> {
    CHUNK_UPLOAD_BYTES = Math.max(256 * 1024, Math.min(128 * 1024 * 1024, sizeInBytes));
    await vscode.workspace.getConfiguration('wpdock.remoteUpload').update(
      'chunkSizeMb',
      Number((CHUNK_UPLOAD_BYTES / 1024 / 1024).toFixed(2)),
      vscode.ConfigurationTarget.Global
    );
    Logger.log(`[RemoteService] Chunk upload size set to ${this.formatBytes(CHUNK_UPLOAD_BYTES)}`);
  }

  getChunkUploadSize(): number {
    this.loadUploadSettings();
    return CHUNK_UPLOAD_BYTES;
  }

  async setDirectUploadLimit(sizeInBytes: number): Promise<void> {
    DIRECT_UPLOAD_MAX_BYTES = Math.max(512 * 1024, Math.min(1024 * 1024 * 1024, sizeInBytes));
    await vscode.workspace.getConfiguration('wpdock.remoteUpload').update(
      'directUploadLimitMb',
      Number((DIRECT_UPLOAD_MAX_BYTES / 1024 / 1024).toFixed(2)),
      vscode.ConfigurationTarget.Global
    );
    Logger.log(`[RemoteService] Direct upload limit set to ${this.formatBytes(DIRECT_UPLOAD_MAX_BYTES)}`);
  }

  getDirectUploadLimit(): number {
    this.loadUploadSettings();
    return DIRECT_UPLOAD_MAX_BYTES;
  }

  /** Called by DashboardPanel after settings are saved from UI. */
  reloadUploadSettings(): void {
    this.loadUploadSettings();
  }

  getAllRemotes(): RemoteSite[] {
    return this.storage.getRemotes();
  }

  getRemote(id: string): RemoteSite | undefined {
    return this.storage.getRemotes().find((r) => r.id === id);
  }

  async addRemote(
    options: {
      name: string;
      url: string;
      username: string;
      appPassword: string;
      autoInstallAgent?: boolean;
      preferCreateSiteOnPull?: boolean;
      defaultLocalSiteName?: string;
      defaultPhpVersion?: string;
      defaultLocale?: string;
      defaultWebServer?: 'php' | 'nginx' | 'apache';
      defaultSsl?: boolean;
    }
  ): Promise<RemoteSite> {
    const { v4: uuidv4 } = await import('uuid');
    const normalizedUrl = this.normalizeSiteUrl(options.url);
    const normalizedAppPassword = this.normalizeAppPassword(options.appPassword);
    const adminUrl = `${normalizedUrl}/wp-admin`;

    // Verify credentials
    await this.verifyCredentials(normalizedUrl, options.username, normalizedAppPassword);

    const remote: RemoteSite = {
      id: uuidv4(),
      name: options.name,
      url: normalizedUrl,
      adminUrl,
      username: options.username,
      appPassword: '', // don't store in plain JSON
      agentInstalled: false,
      autoInstallAgent: options.autoInstallAgent ?? true,
      preferCreateSiteOnPull: options.preferCreateSiteOnPull ?? false,
      defaultLocalSiteName: options.defaultLocalSiteName?.trim() || options.name,
      defaultPhpVersion: options.defaultPhpVersion ?? '8.2',
      defaultLocale: options.defaultLocale ?? 'ru_RU',
      defaultWebServer: options.defaultWebServer ?? 'nginx',
      defaultSsl: options.defaultSsl ?? true,
      linkedSiteIds: [],
      createdAt: new Date().toISOString(),
    };

    // Store app password securely
    await this.storage.saveSecret(`remote-${remote.id}-pass`, normalizedAppPassword);
    this.storage.saveRemote(remote);
    return remote;
  }

  updateRemote(remoteId: string, updates: Partial<RemoteSite>): RemoteSite {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}

    const updated: RemoteSite = {
      ...remote,
      ...updates,
    };
    this.storage.saveRemote(updated);
    return updated;
  }


  setLinkedSiteIds(remoteId: string, linkedSiteIds: string[]): RemoteSite {
    return this.updateRemote(remoteId, {
      linkedSiteIds: Array.from(new Set(linkedSiteIds.filter(Boolean))),
    });
  }

  addLinkedSite(remoteId: string, siteId: string): RemoteSite {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}
    return this.setLinkedSiteIds(remoteId, [...(remote.linkedSiteIds ?? []), siteId]);
  }

  removeLinkedSite(remoteId: string, siteId: string): RemoteSite {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}
    return this.setLinkedSiteIds(remoteId, (remote.linkedSiteIds ?? []).filter((id) => id !== siteId));
  }

  async updateRemoteSettings(
    remoteId: string,
    updates: {
      name?: string;
      url?: string;
      username?: string;
      appPassword?: string;
      autoInstallAgent?: boolean;
      preferCreateSiteOnPull?: boolean;
      defaultLocalSiteName?: string;
      defaultPhpVersion?: string;
      defaultLocale?: string;
      defaultWebServer?: 'php' | 'nginx' | 'apache';
      defaultSsl?: boolean;
    }
  ): Promise<RemoteSite> {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}

    const nextUrl = updates.url !== undefined
      ? this.normalizeSiteUrl(updates.url)
      : remote.url;
    const nextUsername = updates.username !== undefined
      ? updates.username.trim()
      : remote.username;
    const nextName = updates.name !== undefined
      ? updates.name.trim()
      : remote.name;
    const nextAppPassword = this.normalizeAppPassword(updates.appPassword ?? '');

    if (!nextName) {throw new Error('Название удаленного сайта не может быть пустым');}
    if (!nextUsername) {throw new Error('Логин WordPress не может быть пустым');}

    const currentPassword = await this.storage.getSecret(`remote-${remoteId}-pass`);
    const resolvedPassword = nextAppPassword || this.normalizeAppPassword(currentPassword || '');
    if (!resolvedPassword) {
      throw new Error('Application Password не найден. Укажите его заново.');
    }

    const credentialsChanged = (
      nextUrl !== remote.url ||
      nextUsername !== remote.username ||
      nextAppPassword.length > 0
    );

    if (credentialsChanged) {
      await this.verifyCredentials(nextUrl, nextUsername, resolvedPassword);
    }

    if (nextAppPassword.length > 0) {
      await this.storage.saveSecret(`remote-${remoteId}-pass`, nextAppPassword);
    }

    const updated: RemoteSite = {
      ...remote,
      name: nextName,
      url: nextUrl,
      adminUrl: `${nextUrl}/wp-admin`,
      username: nextUsername,
      autoInstallAgent: updates.autoInstallAgent ?? remote.autoInstallAgent,
      preferCreateSiteOnPull: updates.preferCreateSiteOnPull ?? remote.preferCreateSiteOnPull,
      defaultLocalSiteName: updates.defaultLocalSiteName?.trim() || remote.defaultLocalSiteName,
      defaultPhpVersion: updates.defaultPhpVersion ?? remote.defaultPhpVersion,
      defaultLocale: updates.defaultLocale ?? remote.defaultLocale,
      defaultWebServer: updates.defaultWebServer ?? remote.defaultWebServer,
      defaultSsl: updates.defaultSsl ?? remote.defaultSsl,
      // Force a fresh agent check when host or credentials changed.
      agentInstalled: credentialsChanged ? false : remote.agentInstalled,
    };

    this.storage.saveRemote(updated);
    return updated;
  }

  async checkAgent(remoteId: string, onProgress?: (msg: string) => void): Promise<{
    installed: boolean;
    active: boolean;
    responsive: boolean;
    version?: string;
  }> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    const token = await this.getAgentToken(appPassword);
    Logger.log(`[RemoteService] checkAgent start remote=${remote.name} id=${remote.id}`);

    onProgress?.('Проверка ответа агента...');
    const pingVersion = await this.getAgentVersionIfResponsive(remote.url, appPassword);
    if (pingVersion) {
      this.assertSupportedAgentVersion(pingVersion);
      remote.agentInstalled = true;
      remote.agentVersion = pingVersion;
      this.storage.saveRemote(remote);
      Logger.log(`[RemoteService] checkAgent ping OK remote=${remote.name} id=${remote.id} version=${pingVersion}`);
      return { installed: true, active: true, responsive: true, version: pingVersion };
    }

    // The agent can be installed/active, but token may be missing (manual install,
    // expired transient, first connection from this machine).
    onProgress?.('Пробую зарегистрировать токен агента...');
    try {
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
      const versionAfterRegister = await this.getAgentVersionIfResponsive(remote.url, appPassword);
      if (versionAfterRegister) {
        this.assertSupportedAgentVersion(versionAfterRegister);
        remote.agentInstalled = true;
        remote.agentVersion = versionAfterRegister;
        this.storage.saveRemote(remote);
        Logger.log(`[RemoteService] checkAgent register-token + ping OK remote=${remote.name} id=${remote.id} version=${versionAfterRegister}`);
        return { installed: true, active: true, responsive: true, version: versionAfterRegister };
      }
    } catch {
      // Continue with fallback checks below.
    }

    onProgress?.('Поиск плагина WPDock Agent в WordPress...');
    let pluginInfo: any;
    try {
      pluginInfo = await this.wpApiRequest(
        remote.url,
        remote.username,
        appPassword,
        'GET',
        `/wp/v2/plugins/${encodeURIComponent(AGENT_PLUGIN_BASENAME)}`
      );
    } catch (err: any) {
      const message = String(err?.message ?? err);
      if (/404|plugin_not_found|rest_no_route|Cannot find/i.test(message)) {
        if (remote.autoInstallAgent) {
          onProgress?.('Плагин агента не найден. Пробую автоустановку...');
          try {
            await this.installAgent(remote.id, onProgress);
            const versionAfterInstall = await this.getAgentVersionIfResponsive(remote.url, appPassword);
            remote.agentInstalled = Boolean(versionAfterInstall);
            remote.agentVersion = versionAfterInstall;
            this.storage.saveRemote(remote);
            if (versionAfterInstall) {
              Logger.log(`[RemoteService] checkAgent auto-install recovered remote=${remote.name} id=${remote.id} version=${versionAfterInstall}`);
              return { installed: true, active: true, responsive: true, version: versionAfterInstall };
            }
          } catch (installErr) {
            Logger.error(`[RemoteService] checkAgent auto-install failed remote=${remote.name} id=${remote.id}`, installErr);
          }
        }
        remote.agentInstalled = false;
        remote.agentVersion = undefined;
        this.storage.saveRemote(remote);
        Logger.log(`[RemoteService] checkAgent plugin not found remote=${remote.name} id=${remote.id}`);
        return { installed: false, active: false, responsive: false };
      }
      throw err;
    }

    let active = pluginInfo?.status === 'active';
    if (!active) {
      onProgress?.('Плагин найден, активирую...');
      await this.wpApiRequest(
        remote.url,
        remote.username,
        appPassword,
        'POST',
        `/wp/v2/plugins/${encodeURIComponent(AGENT_PLUGIN_BASENAME)}`,
        { status: 'active' }
      );
      active = true;
    }

    onProgress?.('Регистрация токена и финальная проверка...');
    await this.registerAgentToken(remote.url, remote.username, appPassword, token);
    const finalVersion = await this.getAgentVersionIfResponsive(remote.url, appPassword);
    if (finalVersion) {
      this.assertSupportedAgentVersion(finalVersion);
    }
    const responsive = Boolean(finalVersion);

    remote.agentInstalled = responsive;
    remote.agentVersion = finalVersion;
    this.storage.saveRemote(remote);
    Logger.log(`[RemoteService] checkAgent finish remote=${remote.name} id=${remote.id} active=${active} responsive=${responsive} version=${finalVersion ?? '?'}`);

    return { installed: true, active, responsive, version: finalVersion };
  }

  async diagnoseRemoteTokenAuth(remoteId: string, onProgress?: (msg: string) => void): Promise<RemoteTokenDiagnostic> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    const token = await this.getAgentToken(appPassword);
    Logger.log(`[RemoteService] diagnoseRemoteTokenAuth start remote=${remote.name} id=${remote.id}`);

    let restAuthOk = false;
    let restAuthDetails = '';
    let tokenRegisterOk = false;
    let tokenRegisterDetails = '';
    const pingOk = false;
    const pingDetails = 'Пропущено: диагностика токена выполняется без проверки агента (ping).';

    onProgress?.('Проверка REST авторизации...');
    try {
      const me = await this.wpApiRequest(
        remote.url,
        remote.username,
        appPassword,
        'GET',
        '/wp/v2/users/me?context=edit'
      );
      const login = String(me?.slug || me?.username || remote.username || 'unknown');
      restAuthOk = true;
      restAuthDetails = `OK: REST авторизация прошла (user: ${login})`;
      Logger.log(`[RemoteService] diagnose step=rest-auth OK remote=${remote.name} id=${remote.id} user=${login}`);
    } catch (err) {
      restAuthDetails = `Ошибка REST авторизации: ${this.formatShortError(err)}`;
      Logger.error(`[RemoteService] diagnose step=rest-auth failed remote=${remote.name} id=${remote.id}`, err);
    }

    onProgress?.('Проверка регистрации токена агента...');
    if (restAuthOk) {
      try {
        await this.registerAgentToken(remote.url, remote.username, appPassword, token);
        tokenRegisterOk = true;
        tokenRegisterDetails = 'OK: токен успешно зарегистрирован через endpoint WPDock.';
        Logger.log(`[RemoteService] diagnose step=register-token OK remote=${remote.name} id=${remote.id}`);
      } catch (err) {
        tokenRegisterDetails = `Ошибка регистрации токена: ${this.formatShortError(err)}`;
        Logger.error(`[RemoteService] diagnose step=register-token failed remote=${remote.name} id=${remote.id}`, err);
      }
    } else {
      tokenRegisterDetails = 'Пропущено: сначала нужно исправить REST авторизацию.';
      Logger.log(`[RemoteService] diagnose step=register-token skipped remote=${remote.name} id=${remote.id}`);
    }

    onProgress?.('Проверка токена завершена (без ping агента).');
    Logger.log(`[RemoteService] diagnose step=ping skipped (token-only mode) remote=${remote.name} id=${remote.id}`);

    const success = restAuthOk && tokenRegisterOk;
    const recommendations: string[] = [];

    if (!restAuthOk) {
      recommendations.push('Проверьте URL удалённого сайта: используйте базовый URL WordPress без /wp-admin.');
      recommendations.push('Проверьте логин WordPress и Application Password (именно пароль приложения, не обычный пароль).');
      recommendations.push('Убедитесь, что WordPress REST API доступен: /wp-json/wp/v2/users/me?context=edit.');
    }

    if (restAuthOk && !tokenRegisterOk) {
      recommendations.push('Проверьте, что endpoint регистрации токена WPDock доступен и не блокируется WAF/плагинами безопасности.');
      recommendations.push('Если endpoint не найден, обновите/активируйте WPDock Agent на удалённом сайте.');
    }

    if (success) {
      recommendations.push('Проверка токена успешна: REST и регистрация токена работают.');
      recommendations.push('Для Pull/Push дополнительно проверьте доступность агента отдельной кнопкой «Проверить агента».');
    }

    Logger.log(`[RemoteService] diagnoseRemoteTokenAuth finish remote=${remote.name} id=${remote.id} restAuthOk=${restAuthOk} tokenRegisterOk=${tokenRegisterOk} pingOk=${pingOk}`);

    return {
      restAuthOk,
      restAuthDetails,
      tokenRegisterOk,
      tokenRegisterDetails,
      pingOk,
      pingDetails,
      success,
      recommendations,
    };
  }

  async removeRemote(id: string): Promise<void> {
    await this.storage.deleteSecret(`remote-${id}-pass`);
    this.storage.removeRemote(id);
  }

  /**
   * Reset the remote WordPress to a factory-fresh install via the agent, while
   * preserving the admin user, its Application Password and the WPDock agent so
   * the VS Code ↔ agent connection keeps working without any re-setup.
   *
   * Requires agent ≥ {@link RESET_WP_AGENT_VERSION}; ensureAgent() auto-updates
   * a stale agent first. After the reset we re-register the token defensively
   * and confirm the agent still answers.
   */
  async resetRemoteWp(
    remoteId: string,
    onProgress?: (msg: string) => void
  ): Promise<{ userLogin?: string; siteurl?: string }> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    Logger.log(`[RemoteService] resetRemoteWp start remote=${remote.name} id=${remote.id}`);

    onProgress?.('Проверка агента перед сбросом...');
    const version = await this.ensureAgent(remote, appPassword);
    if (!version) {
      throw new Error('Агент WordPress не отвечает. Установите/проверьте WPDock Agent и повторите сброс.');
    }
    if (this.compareSemver(version, RESET_WP_AGENT_VERSION) < 0) {
      throw new Error(
        `На сервере установлена версия агента ${version}, для сброса нужна ${RESET_WP_AGENT_VERSION}. ` +
        'Обновите WPDock Agent (кнопка «Агент» → «Обновить») и повторите попытку.'
      );
    }

    onProgress?.('Сброс WordPress до заводских настроек...');
    const data = await this.agentRequest(remote.url, appPassword, 'reset_wp', {}, AGENT_HEAVY_OP_TIMEOUT_MS);

    // The agent restores the token transient during the reset, but re-register
    // defensively so the VS Code ↔ agent channel is guaranteed intact.
    onProgress?.('Восстановление связи с агентом...');
    try {
      const token = await this.getAgentToken(appPassword);
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
    } catch (err) {
      Logger.log(`[RemoteService] resetRemoteWp token re-register skipped: ${this.formatShortError(err)}`);
    }

    const pingVersion = await this.getAgentVersionIfResponsive(remote.url, appPassword);
    remote.agentInstalled = Boolean(pingVersion);
    this.storage.saveRemote(remote);
    if (!pingVersion) {
      throw new Error('WordPress сброшен, но агент не ответил после сброса. Проверьте сайт и переустановите агента при необходимости.');
    }

    onProgress?.('WordPress сброшен до заводских настроек.');
    Logger.log(`[RemoteService] resetRemoteWp success remote=${remote.name} id=${remote.id} userLogin=${data?.user_login ?? '?'}`);
    return { userLogin: data?.user_login, siteurl: data?.siteurl };
  }

  async recordSyncEvent(
    remoteId: string,
    event: {
      direction: 'pull' | 'push';
      status: 'success' | 'error';
      message: string;
      localSiteId?: string;
    }
  ): Promise<RemoteSite> {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}

    const syncEvent: RemoteSyncEvent = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      direction: event.direction,
      status: event.status,
      message: event.message,
      localSiteId: event.localSiteId,
    };

    const history = [syncEvent, ...(remote.syncHistory ?? [])].slice(0, 50);
    const updated: RemoteSite = {
      ...remote,
      lastSyncAt: syncEvent.at,
      lastSyncDirection: syncEvent.direction,
      lastSyncStatus: syncEvent.status,
      lastSyncMessage: syncEvent.message,
      syncHistory: history,
    };

    this.storage.saveRemote(updated);
    return updated;
  }

  // ── Agent management ──────────────────────────────────────────────────────

  async installAgent(remoteId: string, onProgress?: (msg: string) => void): Promise<void> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    const agentZipPath = this.getAgentZipPath();
    const token = await this.getAgentToken(appPassword);
    Logger.log(`[RemoteService] installAgent start remote=${remote.name} id=${remote.id}`);

    if (await this.isAgentResponsive(remote.url, appPassword)) {
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
      remote.agentInstalled = true;
      this.storage.saveRemote(remote);
      onProgress?.('Агент уже установлен и доступен.');
      Logger.log(`[RemoteService] installAgent skipped (already responsive) remote=${remote.name} id=${remote.id}`);
      return;
    }

    onProgress?.('Загрузка плагина WPDock Agent в WordPress...');
    await this.uploadAgentViaWpAdmin(remote.url, remote.username, appPassword, agentZipPath);

    onProgress?.('Активация плагина агента...');
    await this.wpApiRequest(
      remote.url,
      remote.username,
      appPassword,
      'POST',
      `/wp/v2/plugins/${encodeURIComponent(AGENT_PLUGIN_BASENAME)}`,
      { status: 'active' }
    );

    onProgress?.('Регистрация токена агента...');
    await this.registerAgentToken(remote.url, remote.username, appPassword, token);

    remote.agentInstalled = true;
    remote.agentVersion = await this.getAgentVersionIfResponsive(remote.url, appPassword);
    this.storage.saveRemote(remote);
    onProgress?.('Агент успешно установлен.');
    Logger.log(`[RemoteService] installAgent success remote=${remote.name} id=${remote.id}`);
  }

  /**
   * Update an already-installed WPDock Agent to the version bundled with the
   * extension. Re-uploads the ZIP through wp-admin and confirms WordPress's
   * overwrite step, then re-activates and re-registers the token. Works even
   * when the agent is currently responsive (unlike installAgent, which skips).
   */
  async updateAgent(
    remoteId: string,
    onProgress?: (msg: string) => void
  ): Promise<{ previousVersion?: string; version?: string }> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    const token = await this.getAgentToken(appPassword);
    const expectedVersion = await this.getBundledAgentVersion();
    Logger.log(`[RemoteService] updateAgent start remote=${remote.name} id=${remote.id} expected=${expectedVersion ?? 'unknown'}`);

    const previousVersion = await this.getAgentVersionIfResponsive(remote.url, appPassword);
    Logger.log(`[RemoteService] updateAgent previous version=${previousVersion ?? 'unknown'} remote=${remote.name} id=${remote.id}`);

    // Prefer updating the agent through its own (already working) REST channel.
    // wp-admin plugin upload requires a cookie session, which many hosts refuse
    // to grant for Application Passwords (those auth only the REST API) — that's
    // exactly the "WordPress вернул страницу входа" failure. When the agent is
    // alive we deliver a one-shot mu-plugin self-installer via the agent's
    // existing upload/extract_files, which overwrites the agent on the next
    // request. wp-admin remains a fallback for a dead/unreachable agent.
    let version: string | undefined;
    if (previousVersion) {
      try {
        version = await this.updateAgentViaAgent(remote, appPassword, expectedVersion, onProgress);
      } catch (agentErr) {
        Logger.log(`[RemoteService] updateAgent via-agent path failed, falling back to wp-admin: ${this.formatShortError(agentErr)}`);
        onProgress?.('REST-обновление не удалось, пробую через wp-admin...');
        version = await this.updateAgentViaWpAdmin(remote, appPassword, token, onProgress);
      }
    } else {
      version = await this.updateAgentViaWpAdmin(remote, appPassword, token, onProgress);
    }

    if (!version) {
      remote.agentInstalled = false;
      this.storage.saveRemote(remote);
      throw new Error('Агент не отвечает после обновления. Убедитесь, что плагин WPDock Agent активен, и повторите попытку или обновите ZIP вручную.');
    }
    this.assertSupportedAgentVersion(version);
    if (expectedVersion && this.compareSemver(version, expectedVersion) < 0) {
      throw new Error(`Обновление не применилось: на сервере осталась версия ${version}, ожидалась ${expectedVersion}. Возможно, хостинг запрещает замену файлов плагина или отключены mu-plugins — обновите WPDock Agent вручную через ZIP.`);
    }

    // The agent transient token is untouched by a self-update and pings during
    // the update already proved it valid; re-register best-effort for parity
    // with the install flow but never fail the update on it.
    try {
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
    } catch (regErr) {
      Logger.log(`[RemoteService] updateAgent token re-register skipped: ${this.formatShortError(regErr)}`);
    }

    remote.agentInstalled = true;
    remote.agentVersion = version;
    this.storage.saveRemote(remote);
    onProgress?.(`Агент обновлён до версии ${version}.`);
    Logger.log(`[RemoteService] updateAgent success remote=${remote.name} id=${remote.id} from=${previousVersion ?? '?'} to=${version}`);

    return { previousVersion, version };
  }

  /**
   * Update the agent over its own REST channel (no wp-admin). Delivers a
   * single-use mu-plugin self-installer through the agent's existing
   * upload + extract_files actions: the installer is dropped into
   * wp-content/mu-plugins (not a protected path), auto-loads on the next
   * request, overwrites wp-content/plugins/wpdock-agent/wpdock-agent.php,
   * invalidates opcache and deletes itself. Works with any agent old enough
   * to support Push. Returns the live agent version once it flips, or throws.
   */
  private async updateAgentViaAgent(
    remote: RemoteSite,
    appPassword: string,
    expectedVersion: string | undefined,
    onProgress?: (msg: string) => void
  ): Promise<string> {
    onProgress?.('Подготовка обновления агента (REST-канал)...');
    const installerPhp = await this.buildSelfUpdateInstaller(expectedVersion);
    const { zipSync } = await import('fflate');
    const zipBytes = zipSync(
      { 'wp-content/mu-plugins/wpdock-selfupdate.php': new Uint8Array(Buffer.from(installerPhp, 'utf8')) },
      { level: 0 }
    );
    const tmpZip = path.join(os.tmpdir(), `wpdock-agent-selfupdate-${Date.now()}.zip`);
    fs.writeFileSync(tmpZip, Buffer.from(zipBytes));
    try {
      onProgress?.('Загрузка обновления на сервер...');
      const uploadToken = await this.uploadToAgent(remote.url, appPassword, tmpZip);
      onProgress?.('Применение обновления на сервере...');
      await this.agentRequest(
        remote.url,
        appPassword,
        'extract_files',
        { file_token: uploadToken },
        AGENT_HEAVY_OP_TIMEOUT_MS
      );
      // The installer runs on the next request; poll ping until the version flips.
      const version = await this.waitForAgentVersion(remote.url, appPassword, expectedVersion, onProgress);
      Logger.log(`[RemoteService] updateAgentViaAgent applied version=${version} remote=${remote.name} id=${remote.id}`);
      return version;
    } finally {
      try { fs.unlinkSync(tmpZip); } catch { /* ignore temp cleanup */ }
    }
  }

  /** Legacy/fallback path: re-upload the ZIP through wp-admin overwrite. */
  private async updateAgentViaWpAdmin(
    remote: RemoteSite,
    appPassword: string,
    token: string,
    onProgress?: (msg: string) => void
  ): Promise<string | undefined> {
    const agentZipPath = this.getAgentZipPath();
    onProgress?.('Загрузка новой версии WPDock Agent через wp-admin...');
    await this.uploadAgentViaWpAdmin(remote.url, remote.username, appPassword, agentZipPath, true);

    onProgress?.('Активация обновлённого агента...');
    await this.wpApiRequest(
      remote.url,
      remote.username,
      appPassword,
      'POST',
      `/wp/v2/plugins/${encodeURIComponent(AGENT_PLUGIN_BASENAME)}`,
      { status: 'active' }
    );

    onProgress?.('Регистрация токена агента...');
    await this.registerAgentToken(remote.url, remote.username, appPassword, token);

    // Locale-independent success check: don't parse WordPress's localized
    // "Plugin updated successfully" HTML. Instead confirm the live agent now
    // reports the bundled version (or newer). The agent always answers with the
    // version of the PHP that is actually running on the server.
    return this.getAgentVersionIfResponsive(remote.url, appPassword);
  }

  /** Poll the agent until it reports `expectedVersion` (or newer), or time out. */
  private async waitForAgentVersion(
    siteUrl: string,
    appPassword: string,
    expectedVersion: string | undefined,
    onProgress?: (msg: string) => void
  ): Promise<string> {
    let lastVersion: string | undefined;
    const maxAttempts = 15;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const version = await this.getAgentVersionIfResponsive(siteUrl, appPassword);
      if (version) {
        lastVersion = version;
        if (!expectedVersion || this.compareSemver(version, expectedVersion) >= 0) {
          return version;
        }
      }
      onProgress?.(`Ожидание применения обновления на сервере... (${attempt}/${maxAttempts})`);
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(
      `Агент не сообщил ожидаемую версию${expectedVersion ? ` (${expectedVersion})` : ''} после обновления через REST-канал` +
      `${lastVersion ? `; текущая версия: ${lastVersion}` : ' (агент не ответил)'}.`
    );
  }

  /**
   * Builds a self-contained, single-use mu-plugin that writes the bundled
   * agent PHP into wp-content/plugins/wpdock-agent/ and then removes itself.
   * The agent source is read from the exact ZIP we ship and embedded as base64.
   */
  private async buildSelfUpdateInstaller(expectedVersion: string | undefined): Promise<string> {
    const { unzipSync } = await import('fflate');
    const zipData = fs.readFileSync(this.getAgentZipPath());
    const entries = unzipSync(new Uint8Array(zipData));
    let agentSource: Uint8Array | undefined;
    for (const [name, content] of Object.entries(entries)) {
      if (/(?:^|\/)wpdock-agent\.php$/i.test(name)) {
        agentSource = content;
        break;
      }
    }
    if (!agentSource || agentSource.length === 0) {
      throw new Error('Не удалось прочитать исходник WPDock Agent из ZIP для обновления.');
    }
    const payloadB64 = Buffer.from(agentSource).toString('base64');
    const version = (expectedVersion ?? '').replace(/['"\\]/g, '');

    return `<?php
/**
 * WPDock Agent self-updater (auto-generated, single-use mu-plugin).
 * Installed by the WPDock VS Code extension to update the agent over its own
 * REST channel when wp-admin plugin upload is unavailable. Runs once, then
 * deletes itself.
 */
if (!defined('ABSPATH')) { exit; }
(function () {
    $self = __FILE__;
    try {
        $base = defined('WP_PLUGIN_DIR')
            ? WP_PLUGIN_DIR
            : (defined('WP_CONTENT_DIR') ? WP_CONTENT_DIR . '/plugins' : ABSPATH . 'wp-content/plugins');
        $target_dir = $base . '/wpdock-agent';
        $target = $target_dir . '/wpdock-agent.php';
        $new_version = '${version}';
        $up_to_date = false;
        if ($new_version !== '' && is_readable($target)) {
            $head = @file_get_contents($target, false, null, 0, 4096);
            if ($head !== false && strpos($head, "WPDOCK_AGENT_VERSION', '" . $new_version . "'") !== false) {
                $up_to_date = true;
            }
        }
        if (!$up_to_date) {
            $payload = base64_decode('${payloadB64}');
            if ($payload !== false && strlen($payload) > 0) {
                if (!is_dir($target_dir) && function_exists('wp_mkdir_p')) { wp_mkdir_p($target_dir); }
                $tmp = $target . '.wpdock-new-' . getmypid();
                if (file_put_contents($tmp, $payload) !== false) {
                    if (!@rename($tmp, $target)) {
                        @copy($tmp, $target);
                        @unlink($tmp);
                    }
                    if (function_exists('opcache_invalidate')) { @opcache_invalidate($target, true); }
                }
            }
        }
    } catch (\\Throwable $e) {
        error_log('[WPDock] self-update error: ' . $e->getMessage());
    }
    @unlink($self);
})();
`;
  }

  getAgentInstallDiagnostic(error: unknown): AgentInstallDiagnostic {
    const rawMessage = String((error as any)?.message ?? error ?? 'Неизвестная ошибка установки агента');
    const message = rawMessage.trim();
    const lower = message.toLowerCase();

    if (/страниц[аы] входа|login form|log in|wp-login\.php|login instead/i.test(message)) {
      return {
        code: 'login_redirect',
        title: 'WordPress вернул страницу входа',
        details: message,
        recommendations: [
          'На многих хостингах Application Password работает только для REST API и не авторизует wp-admin: в этом случае используйте ручную установку ZIP.',
          'Проверьте URL сайта: используйте полный адрес, обычно https://example.com без /wp-admin.',
          'Убедитесь, что логин и Application Password относятся к администратору WordPress.',
          'Проверьте, что хостинг не блокирует доступ к /wp-admin по IP, WAF или Basic Auth.',
        ],
      };
    }

    if (/не разрешено|not allowed|forbidden|403|insufficient|capab/i.test(lower)) {
      return {
        code: 'insufficient_permissions',
        title: 'Недостаточно прав для установки плагина',
        details: message,
        recommendations: [
          'Используйте пользователя с ролью Administrator.',
          'Проверьте, что у пользователя есть права install_plugins и activate_plugins.',
          'Если это multisite, выполните установку под Super Admin.',
        ],
      };
    }

    if (/nonce|_wpnonce|csrf/i.test(lower)) {
      return {
        code: 'nonce_validation',
        title: 'WordPress отклонил nonce при установке',
        details: message,
        recommendations: [
          'Повторите установку через 10-15 секунд: nonce мог устареть.',
          'Проверьте, что на сервере корректное системное время.',
          'Отключите временно плагины безопасности, которые фильтруют wp-admin POST-запросы.',
        ],
      };
    }

    if (/filesystem|не удалось создать каталог|could not create directory|destination folder/i.test(lower)) {
      return {
        code: 'filesystem_access',
        title: 'Ошибка записи файлов на сервере',
        details: message,
        recommendations: [
          'Проверьте права записи для wp-content/plugins.',
          'Проверьте настройки FTP/FS_METHOD на хостинге.',
          'Если каталог плагина уже существует после неудачной попытки, удалите его и повторите установку.',
        ],
      };
    }

    if (/timed out|etimedout|econnreset|enotfound|network|fetch failed|socket hang up/i.test(lower)) {
      return {
        code: 'network_error',
        title: 'Сетевая ошибка при установке агента',
        details: message,
        recommendations: [
          'Проверьте доступность сайта из текущей сети и VPN/Proxy ограничения.',
          'Проверьте SSL-сертификат сайта и редиректы http/https.',
          'Повторите попытку позже: возможна временная недоступность хостинга.',
        ],
      };
    }

    return {
      code: 'unknown',
      title: 'Не удалось установить агент автоматически',
      details: message,
      recommendations: [
        'Откройте ручную установку и загрузите wpdock-agent.zip через Plugins -> Add New -> Upload Plugin.',
        'После ручной установки нажмите Проверить агент.',
      ],
    };
  }

  // ── Pull (remote → local) ─────────────────────────────────────────────────

  /**
   * Server-side incremental packing of `wp-content` into a ZIP, returning the
   * agent response that carries `file_token` + `file_size`. Resilient to a
   * corrupted/expired pack-job state: a transient bad `.job` file on the host
   * (e.g. an empty/torn write) makes the agent answer "Pack job state
   * corrupted"; instead of failing the whole pull we restart the pack from
   * scratch (a fresh `job_id`) a bounded number of times. Works with any
   * already-deployed agent ≥1.3.0 — no agent update required.
   */
  private async packRemoteFiles(
    remote: RemoteSite,
    appPassword: string,
    exclude: string[],
    localPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    agentVersion?: string
  ): Promise<any> {
    const MAX_ATTEMPTS = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        return await this.runPackJob(remote, appPassword, exclude, localPath, onProgress, agentVersion);
      } catch (err) {
        lastErr = err;
        if (!this.isRecoverablePackError(err) || attempt === MAX_ATTEMPTS) {
          throw err;
        }
        Logger.log(`[RemoteService] pullSite pack attempt ${attempt}/${MAX_ATTEMPTS} failed (${this.formatShortError(err)}); restarting pack job`);
        onProgress('packaging', 'Перезапуск упаковки на сервере...', 0);
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    throw lastErr;
  }

  /** A pack-job error that a fresh job_id can recover from (vs. a hard failure). */
  private isRecoverablePackError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return /Pack job state corrupted|Pack job not found|Pack job .*expired|Pack manifest missing|Pack stream stalled/i.test(msg);
  }

  /** Abort / read-timeout / dropped-socket failures during pack polling. These
   *  leave the job in an ambiguous state, so we never retry the same CONTINUE in
   *  place (could skip a batch); the caller restarts the whole job instead. */
  private isTransientPullError(err: unknown): boolean {
    const e = err as any;
    const msg = String(e?.message || err || '').toLowerCase();
    const name = String(e?.name || '').toLowerCase();
    const code = String(e?.code || e?.errno || '').toUpperCase();
    return (
      name.includes('abort') || msg.includes('abort') ||
      msg.includes('timeout') || msg.includes('timed out') ||
      msg.includes('socket hang up') ||
      code === 'ECONNRESET' || msg.includes('econnreset') ||
      this.isConnectRetryable(err)
    );
  }

  /** Turn an abort/timeout/stall into a recoverable pack error so the job is
   *  re-run from a fresh job_id (re-packs from line 0 — no batch is skipped).
   *  Hard agent errors pass through unchanged → caller fails fast. */
  private asRecoverablePackError(err: unknown, ctx: string): Error {
    if (this.isRecoverablePackError(err)) {
      return err instanceof Error ? err : new Error(String(err));
    }
    if (this.isTransientPullError(err)) {
      return new Error(`Pack stream stalled (${ctx}): ${this.formatShortError(err)}`);
    }
    return err instanceof Error ? err : new Error(String(err));
  }

  /** Runs a single pack job (START + poll to completion).
   *
   *  Agent ≥1.3.3 streams each batch as its own small ZIP part (`part_token`);
   *  we download + extract every part into `localPath` as it arrives, so the
   *  server never builds one giant archive (the O(n²) ZipArchive re-write that
   *  stalled 100k+ file sites). Returns `{streamed:true, ...}` once extraction
   *  is done. Older agents (≤1.3.2) return a single `file_token`; that result is
   *  returned as-is for the caller to download. Throws on stall. */
  private async runPackJob(
    remote: RemoteSite,
    appPassword: string,
    exclude: string[],
    localPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    agentVersion?: string
  ): Promise<any> {
    const { unzipBuffer } = await import('../utils/zipUtils');

    let packResult = await this.agentRequest(remote.url, appPassword, 'pack_files', {
      exclude,
    }, AGENT_HEAVY_OP_TIMEOUT_MS);

    const packJobId = packResult?.job_id ? String(packResult.job_id) : '';
    if (!packJobId) {
      // Non-incremental agent: it packed everything in one shot.
      if (!packResult?.file_token) {
        throw new Error('Агент не вернул file_token после упаковки файлов.');
      }
      return packResult;
    }

    const packTotal = Number(packResult?.total || 0);

    // Parallel shards (agent ≥1.3.5): the server split the manifest into K
    // disjoint slices, each with its own cursor. Pack+download them concurrently
    // to beat per-connection throttling on shared hosts.
    const packShards = Number(packResult?.shards || 0);
    if (packShards >= 2) {
      return await this.runPackJobSharded(
        remote, appPassword, localPath, onProgress, packJobId, packTotal, packShards, agentVersion,
      );
    }

    // Resumable single stream (agent ≥1.3.7): recover a stalled CONTINUE in place
    // (drain missed parts by seq + resume) instead of restarting the whole pack.
    const resumable = !!agentVersion && this.compareSemver(agentVersion, '1.3.7') >= 0;
    if (resumable) {
      Logger.log(`[RemoteService] pullSite pack_files START(resumable) job=${packJobId} total=${packTotal} agent=${agentVersion || '?'}`);
      const r = await this.runPackStreamResumable(
        remote, appPassword, localPath, packJobId, -1,
        (processed) => {
          const ratio = packTotal > 0 ? Math.min(1, processed / packTotal) : 0;
          onProgress('packaging', `Перенос файлов с сервера... ${processed}/${packTotal}`, Math.round(ratio * 60));
        },
      );
      Logger.log(`[RemoteService] pullSite pack_files(resumable) complete parts=${r.parts} size=${this.formatBytes(r.bytes)} total=${packTotal}`);
      return { streamed: true, parts: r.parts, bytes: r.bytes, total: packTotal };
    }

    let polls = 0;
    let lastProcessed = -1;
    let stalled = 0;
    let partsExtracted = 0;
    let bytesExtracted = 0;
    // Depth-1 pipeline (agent ≥1.3.4): issue the next batch request before
    // downloading+extracting the current part, so the server packs batch N+1
    // while we write batch N to disk. Per-file tokens (agent 1.3.4) make the
    // concurrent download(part N) + pack(part N+1) race-safe. Older agents are
    // kept on strict request→download→extract sequencing.
    const pipeline = !!agentVersion && this.compareSemver(agentVersion, '1.3.4') >= 0;
    Logger.log(`[RemoteService] pullSite pack_files START job=${packJobId} total=${packTotal} pipeline=${pipeline} agent=${agentVersion || '?'}`);

    const continueReq = () => this.agentRequest(remote.url, appPassword, 'pack_files', {
      job_id: packJobId,
    }, AGENT_PACK_POLL_TIMEOUT_MS);

    let inflight: Promise<any> | null = continueReq();
    try {
      while (inflight) {
        const current = inflight;
        inflight = null;
        packResult = await current;
        polls++;

        const done = !!packResult?.done || !!packResult?.file_token;
        const partToken = packResult?.part_token ? String(packResult.part_token) : '';

        // Prefetch the next batch before the (slower) download+extract of this
        // one, so server-side packing overlaps local disk writes.
        if (pipeline && partToken && !done) {
          inflight = continueReq();
        }

        // Streaming protocol (agent ≥1.3.3): each batch is its own ZIP part.
        // Download + extract immediately so server disk holds at most one part.
        if (partToken) {
          const partBuffer = await this.downloadPartWithRetry(remote.url, appPassword, partToken, Number(packResult?.part_size || 0));
          unzipBuffer(partBuffer, localPath);
          partsExtracted++;
          bytesExtracted += partBuffer.length;
        }

        const processed = Number(packResult?.processed || 0);
        const ratio = packTotal > 0 ? Math.min(1, processed / packTotal) : 0;
        // Streamed pack+download+extract occupies the 0–60% band of the pull.
        onProgress('packaging', `Перенос файлов с сервера... ${processed}/${packTotal}`, Math.round(ratio * 60));

        // Defensive stall guard: the agent always advances `processed`; if it
        // doesn't (and isn't done), bail instead of polling forever.
        if (!done) {
          if (processed <= lastProcessed) {
            if (++stalled >= 3) {
              throw new Error(`Pack stream stalled (processed=${processed}/${packTotal}).`);
            }
          } else {
            stalled = 0;
          }
        }
        lastProcessed = processed;
        if (polls % 25 === 0) {
          Logger.log(`[RemoteService] pullSite pack_files polling job=${packJobId} processed=${processed}/${packTotal} parts=${partsExtracted} polls=${polls}`);
        }

        // Sequential agents (≤1.3.3): only safe to fire the next batch now.
        if (!pipeline && !done) {
          inflight = continueReq();
        }
      }
    } catch (err) {
      // Don't leak an orphaned prefetch as an unhandled rejection on abort.
      if (inflight) { void (inflight as Promise<any>).catch(() => {}); }
      // A stalled CONTINUE (abort/read-timeout/dropped socket) is converted into
      // a recoverable error so packRemoteFiles restarts with a fresh job_id
      // instead of hanging on the old 30-min poll cap.
      throw this.asRecoverablePackError(err, `processed=${lastProcessed}/${packTotal}`);
    }

    // Streamed protocol: parts already downloaded + extracted above.
    if (partsExtracted > 0 || !packResult?.file_token) {
      Logger.log(`[RemoteService] pullSite pack_files streamed complete parts=${partsExtracted} size=${this.formatBytes(bytesExtracted)} processed=${lastProcessed}/${packTotal}`);
      return { streamed: true, parts: partsExtracted, bytes: bytesExtracted, total: packTotal };
    }

    // Legacy single-zip agent: caller downloads the one file_token.
    return packResult;
  }

  /**
   * Parallel sharded pack (agent ≥1.3.5). START already split the manifest into
   * `shards` disjoint slices with independent cursors; a worker pool drains them
   * at most MAX_PARALLEL_SHARDS at a time, each shard packing → downloading →
   * extracting its own ZIP parts. This trades one throttled stream for a few
   * streams — the win on hosts that cap per-connection throughput — while the
   * cap keeps us from starving a small PHP worker pool (which manifests as new
   * TLS connections failing to even handshake). Per-file tokens (1.3.4) keep
   * concurrent download/pack race-safe; each shard touches only its own cursor +
   * part files, so shards never collide. Connection-establishment failures are
   * retried (safe: request never reached the server). Same 0–60% progress band
   * and stall guard as the single-stream path. On any unrecoverable shard
   * failure we abort the siblings and rethrow — "fail → caller decides".
   */
  private async runPackJobSharded(
    remote: RemoteSite,
    appPassword: string,
    localPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    packJobId: string,
    packTotal: number,
    shards: number,
    agentVersion?: string,
  ): Promise<any> {
    const { unzipBuffer } = await import('../utils/zipUtils');
    const shardProcessed = new Array(shards).fill(0);
    let partsExtracted = 0;
    let bytesExtracted = 0;
    let polls = 0;
    let aborted = false;
    // Resumable shards (agent ≥1.3.7): recover a stalled shard CONTINUE in place
    // rather than restarting every shard from line 0.
    const resumable = !!agentVersion && this.compareSemver(agentVersion, '1.3.7') >= 0;

    const emitProgress = () => {
      const processed = shardProcessed.reduce((a: number, b: number) => a + b, 0);
      const ratio = packTotal > 0 ? Math.min(1, processed / packTotal) : 0;
      onProgress('packaging', `Перенос файлов с сервера... ${processed}/${packTotal}`, Math.round(ratio * 60));
    };

    Logger.log(`[RemoteService] pullSite pack_files START(sharded${resumable ? ',resumable' : ''}) job=${packJobId} total=${packTotal} shards=${shards} concurrency=${Math.min(shards, MAX_PARALLEL_SHARDS)} agent=${agentVersion || '?'}`);

    const runShard = async (k: number): Promise<void> => {
      if (resumable) {
        try {
          const r = await this.runPackStreamResumable(
            remote, appPassword, localPath, packJobId, k,
            (processed) => { shardProcessed[k] = processed; polls++; emitProgress(); },
            () => aborted,
          );
          partsExtracted += r.parts;
          bytesExtracted += r.bytes;
        } catch (err) {
          aborted = true;
          throw err;
        }
        return;
      }
      let lastProcessed = -1;
      let stalled = 0;
      let done = false;
      try {
        while (!done) {
          if (aborted) { return; }
          // Retry ONLY connection-establishment failures: those provably never
          // reached PHP (no TLS handshake ⇒ the shard cursor didn't advance), so
          // a repeat can't skip a batch. Ambiguous read timeouts are NOT retried
          // — re-issuing a CONTINUE the server may have already processed would
          // drop that part's files. Backoff also staggers shards, easing the
          // worker-pool contention that caused the disconnect in the first place.
          let res: any;
          for (let attempt = 1; ; attempt++) {
            try {
              res = await this.agentRequest(remote.url, appPassword, 'pack_files', {
                job_id: packJobId, shard: k,
              }, AGENT_PACK_POLL_TIMEOUT_MS);
              break;
            } catch (err) {
              // A stalled/aborted read can't be safely retried in place, but a
              // full job restart (fresh job_id) re-packs every shard from line 0,
              // so route it through asRecoverablePackError instead of hanging.
              if (aborted || attempt >= 4 || !this.isConnectRetryable(err)) {
                throw this.asRecoverablePackError(err, `shard=${k}`);
              }
              const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
              Logger.log(`[RemoteService] pack_files(sharded) conn retry shard=${k} attempt=${attempt} in ${backoff}ms: ${String((err as any)?.message || err)}`);
              await new Promise((r) => setTimeout(r, backoff));
            }
          }

          const partToken = res?.part_token ? String(res.part_token) : '';
          if (partToken) {
            const partBuffer = await this.downloadPartWithRetry(remote.url, appPassword, partToken, Number(res?.part_size || 0));
            unzipBuffer(partBuffer, localPath);
            partsExtracted++;
            bytesExtracted += partBuffer.length;
          }

          const processed = Number(res?.processed || 0);
          shardProcessed[k] = processed;
          polls++;
          emitProgress();
          done = !!res?.done;

          if (!done) {
            if (processed <= lastProcessed) {
              if (++stalled >= 3) {
                throw new Error(`Pack stream stalled (shard=${k}, processed=${processed}).`);
              }
            } else {
              stalled = 0;
            }
          }
          lastProcessed = processed;
          if (polls % 25 === 0) {
            const total = shardProcessed.reduce((a: number, b: number) => a + b, 0);
            Logger.log(`[RemoteService] pullSite pack_files(sharded) job=${packJobId} shards=${shards} processed=${total}/${packTotal} parts=${partsExtracted} polls=${polls}`);
          }
        }
      } catch (err) {
        aborted = true;
        throw err;
      }
    };

    // Cap concurrent streams below the agent's slice count: a pool of workers
    // drains the shard queue, so at most MAX_PARALLEL_SHARDS heavy requests hit
    // the remote at once even when it split into more (e.g. 6) slices.
    const concurrency = Math.min(shards, MAX_PARALLEL_SHARDS);
    let nextShard = 0;
    const worker = async (): Promise<void> => {
      while (!aborted) {
        const k = nextShard++;
        if (k >= shards) { return; }
        await runShard(k);
      }
    };
    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    Logger.log(`[RemoteService] pullSite pack_files(sharded) complete parts=${partsExtracted} size=${this.formatBytes(bytesExtracted)} total=${packTotal}`);
    return { streamed: true, parts: partsExtracted, bytes: bytesExtracted, total: packTotal };
  }

  // ── Resumable pack (agent ≥1.3.7) ─────────────────────────────────────────
  //
  // The server cursor (index/offset/parts) is persisted atomically after every
  // batch, so the job is already resumable — the gap was the client. The old
  // path turned any stalled CONTINUE into a "recoverable error" and restarted
  // the whole pack with a fresh job_id, re-packing from line 0 (the 411s / "stuck
  // at 1500/1990" symptom). Here a stall is recovered IN PLACE: the client asks
  // pack_status how far the cursor advanced, drains every part it missed by seq
  // (get_part — re-fetchable, doesn't delete), ack_part's each to free disk, then
  // resumes CONTINUE. No batch is re-packed and none is skipped.

  /** Drive one pack stream (single-stream: shard=-1; or one shard slice) to
   *  completion with in-place stall recovery. Returns extracted part/byte counts;
   *  `onStreamProgress` receives the slice-local `processed` for progress. */
  private async runPackStreamResumable(
    remote: RemoteSite,
    appPassword: string,
    localPath: string,
    jobId: string,
    shard: number,
    onStreamProgress: (processedInSlice: number) => void,
    isAborted: () => boolean = () => false,
  ): Promise<{ parts: number; bytes: number }> {
    const { unzipBuffer } = await import('../utils/zipUtils');
    const tag = `job=${jobId}${shard >= 0 ? ` shard=${shard}` : ''}`;
    let nextSeq = 0;
    let partsExtracted = 0;
    let bytesExtracted = 0;
    let processedInSlice = 0;
    let done = false;
    let polls = 0;

    const continueReq = () => {
      const params: any = { job_id: jobId, seq_dl: 1 };
      if (shard >= 0) {params.shard = shard;}
      return this.agentRequest(remote.url, appPassword, 'pack_files', params, AGENT_PACK_POLL_TIMEOUT_MS);
    };

    while (!done) {
      if (isAborted()) {return { parts: partsExtracted, bytes: bytesExtracted };}
      try {
        const res = await continueReq();
        polls++;
        done = !!res?.done;
        const serverParts = Number(res?.parts ?? nextSeq);
        processedInSlice = Number(res?.processed ?? processedInSlice);
        const knownSeq = res?.part_seq !== undefined ? Number(res.part_seq) : -1;
        const knownSize = Number(res?.part_size || 0);
        if (serverParts > nextSeq) {
          const d = await this.drainParts(remote, appPassword, localPath, jobId, shard, nextSeq, serverParts, unzipBuffer, knownSeq, knownSize);
          nextSeq = d.nextSeq; partsExtracted += d.count; bytesExtracted += d.bytes;
        }
        onStreamProgress(processedInSlice);
      } catch (err) {
        // A hard agent error (not a transient stall) is not resumable in place —
        // surface it; a "job gone" message routes to packRemoteFiles' fresh-job
        // restart as a last resort, anything else fails fast.
        if (!this.isTransientPullError(err)) {
          throw this.asRecoverablePackError(err, `resumable ${tag}`);
        }
        const rec = await this.recoverPackStream(remote, appPassword, localPath, jobId, shard, nextSeq, unzipBuffer);
        nextSeq = rec.nextSeq; partsExtracted += rec.count; bytesExtracted += rec.bytes;
        done = rec.done; processedInSlice = rec.processed;
        onStreamProgress(processedInSlice);
        Logger.log(`[RemoteService] pack resume ${tag} drained=${rec.count} nextSeq=${nextSeq} done=${done} processed=${processedInSlice}`);
      }
      if (polls > 0 && polls % 25 === 0) {
        Logger.log(`[RemoteService] pack(resumable) ${tag} processed=${processedInSlice} parts=${partsExtracted} polls=${polls}`);
      }
    }
    return { parts: partsExtracted, bytes: bytesExtracted };
  }

  /** Stall recovery: read the server cursor, then download+extract+ack every part
   *  the server created that we haven't taken yet (contiguous [nextSeq..parts-1]).
   *  Returns the new cursor + whether the slice is already done. */
  private async recoverPackStream(
    remote: RemoteSite,
    appPassword: string,
    localPath: string,
    jobId: string,
    shard: number,
    nextSeq: number,
    unzipBuffer: (buf: Buffer, dest: string) => void,
  ): Promise<{ nextSeq: number; count: number; bytes: number; done: boolean; processed: number }> {
    const tag = `job=${jobId}${shard >= 0 ? ` shard=${shard}` : ''}`;
    let status: any;
    for (let attempt = 1; ; attempt++) {
      try {
        const params: any = { job_id: jobId };
        if (shard >= 0) {params.shard = shard;}
        status = await this.agentRequest(remote.url, appPassword, 'pack_status', params, AGENT_REQUEST_TIMEOUT_MS);
        break;
      } catch (err) {
        // The status call itself is tiny; retry only genuinely transient failures.
        // A "Pack job not found/expired" (job vanished — e.g. 6h cron) is passed
        // through asRecoverablePackError so packRemoteFiles can restart from a
        // fresh job_id as the last resort.
        if (attempt >= 4 || !this.isTransientPullError(err)) {
          throw this.asRecoverablePackError(err, `pack_status ${tag}`);
        }
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        Logger.log(`[RemoteService] pack_status retry ${tag} attempt=${attempt} in ${backoff}ms: ${String((err as any)?.message || err)}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    const serverParts = Number(status?.parts ?? nextSeq);
    const d = await this.drainParts(remote, appPassword, localPath, jobId, shard, nextSeq, serverParts, unzipBuffer);
    return { nextSeq: d.nextSeq, count: d.count, bytes: d.bytes, done: !!status?.done, processed: Number(status?.processed || 0) };
  }

  /** Download + extract + ack a contiguous range of parts [fromSeq, toSeqExcl).
   *  ack is best-effort (a failed ack only leaves the part for the 6h cron). */
  private async drainParts(
    remote: RemoteSite,
    appPassword: string,
    localPath: string,
    jobId: string,
    shard: number,
    fromSeq: number,
    toSeqExcl: number,
    unzipBuffer: (buf: Buffer, dest: string) => void,
    knownPartSeq: number = -1,
    knownPartSize: number = 0,
  ): Promise<{ nextSeq: number; count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    let seq = fromSeq;
    for (; seq < toSeqExcl; seq++) {
      const expected = seq === knownPartSeq ? knownPartSize : 0;
      const buf = await this.downloadPartBySeq(remote.url, appPassword, jobId, seq, shard, expected);
      unzipBuffer(buf, localPath);
      count++;
      bytes += buf.length;
      await this.ackPart(remote, appPassword, jobId, seq, shard);
    }
    return { nextSeq: seq, count, bytes };
  }

  /** Tell the agent a part was extracted so it can delete it (bounds server disk).
   *  Best-effort: never fails the pull — leftover parts are cron-swept after 6h. */
  private async ackPart(remote: RemoteSite, appPassword: string, jobId: string, seq: number, shard: number): Promise<void> {
    try {
      const params: any = { job_id: jobId, seq };
      if (shard >= 0) {params.shard = shard;}
      await this.agentRequest(remote.url, appPassword, 'ack_part', params, AGENT_REQUEST_TIMEOUT_MS);
    } catch (err) {
      Logger.log(`[RemoteService] ackPart failed job=${jobId} seq=${seq}${shard >= 0 ? ` shard=${shard}` : ''}: ${this.formatShortError(err)}`);
    }
  }

  /**
   * True only for failures that provably happened BEFORE the request reached the
   * server (TLS never established, connection refused, DNS not resolved). For
   * these the remote did no work, so retrying a CONTINUE can't skip a batch.
   * Deliberately excludes generic ECONNRESET / "socket hang up" — those can
   * occur after the server sent the request to PHP, where a blind retry could
   * advance the cursor past an unprocessed part and silently drop files.
   */
  private isConnectRetryable(err: any): boolean {
    const msg = String(err?.message || err || '').toLowerCase();
    const code = String(err?.code || err?.errno || '').toUpperCase();
    return (
      msg.includes('before secure tls connection was established') ||
      msg.includes('network socket disconnected') ||
      code === 'ECONNREFUSED' || msg.includes('econnrefused') ||
      code === 'ENOTFOUND' || msg.includes('enotfound') ||
      code === 'EAI_AGAIN' || msg.includes('eai_again')
    );
  }

  async pullSite(
    remoteId: string,
    localPath: string,
    includeDb: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    /** Directory where database.sql / database.meta.json are written. Defaults to localPath. */
    dbOutPath?: string,
    /** Skip wp-content/uploads (media) entirely — biggest speedup for dev pulls. */
    skipUploads: boolean = false
  ): Promise<void> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);

    onProgress('connecting', 'Подключение к удаленному сайту...');
    Logger.log(`[RemoteService] pullSite START remoteId=${remoteId} url=${remote.url} includeDb=${includeDb} skipUploads=${skipUploads}`);
    const agentVersion = await this.ensureAgent(remote, appPassword);

    // Media (wp-content/uploads) is fetched DIRECTLY over HTTP — bypassing PHP —
    // whenever the agent supports it (≥1.3.6) and a system curl is available.
    // That's both far faster and resumable on fragile hosts. We then keep uploads
    // OUT of the agent pack. Fall back to packing uploads only on old agents or
    // when curl is missing.
    const useMediaDirect =
      !skipUploads &&
      !!agentVersion &&
      this.compareSemver(agentVersion, MEDIA_DIRECT_AGENT_VERSION) >= 0 &&
      !!RemoteService.curlPath();

    const exclude = ['wp-content/cache', 'node_modules', '.git'];
    if (skipUploads || useMediaDirect) {
      // Substring-matched on the server during manifest build, so these files
      // never enter the pack at all — `total` shrinks and progress stays honest.
      exclude.push('wp-content/uploads');
    }
    Logger.log(`[RemoteService] pullSite mediaStrategy=${skipUploads ? 'skip' : useMediaDirect ? 'direct' : 'packed'} agent=${agentVersion || '?'}`);

    onProgress('packaging', 'Подготовка файлов на удаленном сервере...');
    const packResult = await this.packRemoteFiles(
      remote,
      appPassword,
      exclude,
      localPath,
      onProgress,
      agentVersion
    );

    if (packResult?.streamed) {
      // Agent ≥1.3.3: files were downloaded + extracted part-by-part inside the
      // pack loop. Nothing more to fetch.
      Logger.log(`[RemoteService] pullSite files transferred (streamed) parts=${packResult.parts} size=${this.formatBytes(Number(packResult?.bytes || 0))}`);
      onProgress('extracting', 'Файлы перенесены', 60);
    } else {
      // Legacy single-zip agent: download the one archive, then extract.
      Logger.log(`[RemoteService] pullSite pack_files complete fileToken=${packResult.file_token} fileSize=${this.formatBytes(Number(packResult?.file_size || 0))}`);

      onProgress('uploading', 'Скачивание файлов...', 10);
      const zipBuffer = await this.downloadFromAgent(remote.url, appPassword, packResult.file_token);
      if (Number(packResult?.file_size || 0) > 0 && zipBuffer.length !== Number(packResult.file_size)) {
        throw new Error(`ZIP скачан не полностью: ожидалось ${this.formatBytes(Number(packResult.file_size))}, получено ${this.formatBytes(zipBuffer.length)}.`);
      }
      Logger.log(`[RemoteService] pullSite downloaded files zip size=${this.formatBytes(zipBuffer.length)}`);

      onProgress('extracting', 'Распаковка файлов...', 60);
      const { unzipBuffer } = await import('../utils/zipUtils');
      unzipBuffer(zipBuffer, localPath);
      Logger.log(`[RemoteService] pullSite extracted files to ${localPath}`);
    }

    if (useMediaDirect) {
      // Media phase occupies 60→90%; DB (if any) finishes the last 10%.
      const mediaResult = await this.pullUploadsDirect(remote, appPassword, localPath, onProgress, 60, 30);
      Logger.log(`[RemoteService] pullSite media transferred downloaded=${mediaResult.downloaded}/${mediaResult.total} failed=${mediaResult.failed} bytes=${this.formatBytes(mediaResult.bytes)}`);
    }

    if (includeDb) {
      onProgress('db', 'Экспорт базы данных...', 92);
      Logger.log(`[RemoteService] pullSite export_db START`);
      
      const dbResult = await this.agentRequest(remote.url, appPassword, 'export_db', {}, AGENT_HEAVY_OP_TIMEOUT_MS);
      Logger.log(`[RemoteService] pullSite export_db complete fileToken=${dbResult.file_token} fileSize=${this.formatBytes(Number(dbResult?.file_size || 0))} dumpMethod=${String(dbResult?.dump_method || 'unknown')} stats=${JSON.stringify(dbResult.db_stats)}`);
      
      const sqlBuffer = await this.downloadFromAgent(
        remote.url,
        appPassword,
        dbResult.file_token
      );
      if (Number(dbResult?.file_size || 0) > 0 && sqlBuffer.length !== Number(dbResult.file_size)) {
        throw new Error(`SQL дамп скачан не полностью: ожидалось ${this.formatBytes(Number(dbResult.file_size))}, получено ${this.formatBytes(sqlBuffer.length)}.`);
      }
      Logger.log(`[RemoteService] pullSite downloaded database.sql size=${this.formatBytes(sqlBuffer.length)}`);
      
      this.assertValidSqlDump(sqlBuffer);
      const dbDir = dbOutPath ?? localPath;
      fs.writeFileSync(path.join(dbDir, 'database.sql'), sqlBuffer);
      
      if (dbResult?.db_stats) {
        fs.writeFileSync(
          path.join(dbDir, 'database.meta.json'),
          JSON.stringify(dbResult.db_stats, null, 2),
          'utf-8'
        );
        Logger.log(`[RemoteService] pullSite database.meta.json written tableStats=${Object.keys(dbResult.db_stats.tables ?? {}).length}`);
      }
      onProgress('db', 'База данных экспортирована в database.sql', 98);
    }

    Logger.log(`[RemoteService] pullSite SUCCESS remoteId=${remoteId}`);
    onProgress('done', 'Pull завершен!', 100);
  }

  // ── Push (local → remote) ─────────────────────────────────────────────────

  async pushSite(
    remoteId: string,
    localPath: string,
    includeDb: boolean,
    devMode: boolean = false,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    /** Explicit path to database.sql. Defaults to database.sql inside localPath. */
    dbFilePath?: string,
    /** Keep remote WP users, usermeta and auth-keys intact after DB import. Default: true. */
    preserveCredentials = true
  ): Promise<void> {
    // ✅ OPTIMIZATION: Add timing to profile each phase
    const startTotal = Date.now();
    const timings: Record<string, number> = {};
    const markTime = (phase: string) => {
      const now = Date.now();
      timings[phase] = now - startTotal;
      Logger.log(`[PUSH-TIMING] ${phase}: +${now - startTotal}ms`);
    };

    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);

    onProgress('connecting', 'Подключение к удаленному сайту...');
    Logger.log(`[RemoteService] pushSite START remote=${remote.name} remoteId=${remoteId} localPath=${localPath} includeDb=${includeDb} devMode=${devMode}`);
    await this.ensureAgent(remote, appPassword);
    markTime('ensureAgent');

    onProgress('packaging', 'Подготовка локальных файлов...', 10);
    const packStart = Date.now();
    const archiver = (await import('archiver')).default;
    const zipPath = path.join(os.tmpdir(), `wpdock-push-${Date.now()}.zip`);
    try {
      await this.createZip(localPath, zipPath, archiver, devMode);
      
      const zipStats = fs.statSync(zipPath);
      const packElapsed = Date.now() - packStart;
      markTime('createZip');
      Logger.log(
        `[PUSH-STATS] packaging complete size=${this.formatBytes(zipStats.size)} ` +
        `elapsed=${packElapsed}ms speed=${this.formatBytes(zipStats.size / (packElapsed / 1000))}/s`
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
        `[PUSH-STATS] upload complete elapsed=${uploadElapsed}ms ` +
        `speed=${this.formatBytes(zipStats.size / (uploadElapsed / 1000))}/s`
      );
      Logger.log(`[RemoteService] pushSite files uploaded token=${uploadToken}`);

      onProgress('extracting', 'Распаковка на удаленном сервере...', 70);
      const extractStart = Date.now();
      const extractResult = await this.retryAsync('extract_files', 2, () => this.agentRequest(remote.url, appPassword, 'extract_files', {
        file_token: uploadToken,
      }, AGENT_HEAVY_OP_TIMEOUT_MS));
      const extractElapsed = Date.now() - extractStart;
      markTime('agentExtract');
      Logger.log(
        `[PUSH-STATS] extract complete elapsed=${extractElapsed}ms result=${JSON.stringify(extractResult ?? {})}`
      );

      if (includeDb) {
        const sqlFile = dbFilePath ?? path.join(localPath, 'database.sql');
        if (fs.existsSync(sqlFile)) {
          Logger.log(`[RemoteService] pushSite database.sql found path=${sqlFile} size=${this.formatBytes(fs.statSync(sqlFile).size)}`);
          onProgress('db', 'Загрузка базы данных...', 80);
          const dbToken = await this.uploadToAgent(
            remote.url,
            appPassword,
            sqlFile,
            (uploadedBytes, totalBytes) => {
              const ratio = totalBytes > 0 ? uploadedBytes / totalBytes : 1;
              const pct = 80 + Math.round(Math.min(1, ratio) * 15);
              onProgress(
                'db',
                `Загрузка базы данных... ${this.formatBytes(uploadedBytes)} / ${this.formatBytes(totalBytes)}`,
                pct
              );
            }
          );
          markTime('dbUpload');
          Logger.log(`[RemoteService] pushSite database uploaded token=${dbToken}`);
          onProgress('db', 'Импорт базы данных на сервере...', 92);
          const importResult = await this.agentRequest(remote.url, appPassword, 'import_db', {
            file_token: dbToken,
            target_url: remote.url,
            preserve_credentials: preserveCredentials,
          }, AGENT_HEAVY_OP_TIMEOUT_MS);
          markTime('dbImport');
          const importJson = importResult ?? {};
          Logger.log(
            `[RemoteService] pushSite import_db done` +
            ` method=${importJson.method ?? '?'}` +
            ` statements=${importJson.statements ?? '?'}` +
            ` skipped=${importJson.skipped ?? 0}` +
            ` expected_tables=${importJson.expected_tables ?? '?'}` +
            ` actual_tables=${importJson.actual_tables ?? '?'}` +
            ` prefix_rewritten=${importJson.prefix_rewritten ?? false}` +
            ` prefix_data_fixed=${importJson.prefix_data_fixed ?? false}` +
            ` url_updated=${importJson.url_updated ?? false}` +
            ` table_list=${JSON.stringify(importJson.table_list ?? [])}` +
            ` warnings_count=${(importJson.warnings ?? []).length}` +
            ` warnings=${JSON.stringify((importJson.warnings ?? []).slice(0, 5))}`
          );
          // Surface import warnings to the user if any
          const importWarnings: string[] = importJson.warnings ?? [];
          if (importWarnings.length > 0) {
            onProgress('db', `БД импортирована (${importJson.statements ?? 0} запросов, пропущено ${importJson.skipped ?? 0}, предупреждений ${importWarnings.length})`, 96);
          } else {
            onProgress('db', `БД импортирована: ${importJson.actual_tables ?? importJson.statements ?? '?'} таблиц через ${importJson.method ?? 'unknown'}`, 96);
          }
        } else {
          Logger.log(`[RemoteService] pushSite database.sql missing path=${sqlFile}`);
        }
      }

      Logger.log(
        `[RemoteService] pushSite SUCCESS remote=${remote.name} remoteId=${remoteId} ` +
        `totalTime=${Date.now() - startTotal}ms breakdown={${Object.entries(timings)
          .map(([k, v]) => `${k}=${v}ms`)
          .join(', ')}}`
      );
      onProgress('done', 'Push завершен!', 100);
    } finally {
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch {
          // ignore temp cleanup failures
        }
      }
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async getRemoteWithPass(
    remoteId: string
  ): Promise<{ remote: RemoteSite; appPassword: string }> {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}
    const storedAppPassword = await this.storage.getSecret(`remote-${remoteId}-pass`);
    const appPassword = this.normalizeAppPassword(storedAppPassword || '');
    if (!appPassword) {throw new Error('Данные авторизации удаленного сайта не найдены');}
    if (storedAppPassword !== appPassword) {
      await this.storage.saveSecret(`remote-${remoteId}-pass`, appPassword);
    }
    return { remote, appPassword };
  }

  /** Ensures the agent is reachable and returns its reported version (or undefined). */
  private async ensureAgent(remote: RemoteSite, appPassword: string): Promise<string | undefined> {
    Logger.log(`[RemoteService] ensureAgent start remote=${remote.name} id=${remote.id} flagInstalled=${remote.agentInstalled}`);
    // First try an already installed agent. The persisted flag can be stale.
    try {
      const ping = await this.agentRequest(remote.url, appPassword, 'ping', {});
      this.assertSupportedAgentVersion(ping?.version);
      if (!remote.agentInstalled) {
        remote.agentInstalled = true;
        this.storage.saveRemote(remote);
      }
      Logger.log(`[RemoteService] ensureAgent ping OK remote=${remote.name} id=${remote.id}`);
      const live = ping?.version ? String(ping.version) : undefined;
      return await this.maybeAutoUpdateAgent(remote, appPassword, live);
    } catch {
      // Continue with token registration / plugin checks.
      Logger.log(`[RemoteService] ensureAgent ping failed, continue remote=${remote.name} id=${remote.id}`);
    }

    try {
      const token = await this.getAgentToken(appPassword);
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
      const ping = await this.agentRequest(remote.url, appPassword, 'ping', {});
      this.assertSupportedAgentVersion(ping?.version);
      remote.agentInstalled = true;
      this.storage.saveRemote(remote);
      Logger.log(`[RemoteService] ensureAgent register-token + ping OK remote=${remote.name} id=${remote.id}`);
      return ping?.version ? String(ping.version) : undefined;
    } catch {
      // Continue with plugin inspection and activation below.
      Logger.log(`[RemoteService] ensureAgent register-token path failed, continue remote=${remote.name} id=${remote.id}`);
    }

    const status = await this.checkAgent(remote.id);
    if (status.responsive) {
      Logger.log(`[RemoteService] ensureAgent checkAgent resolved responsiveness remote=${remote.name} id=${remote.id}`);
      return this.getAgentVersionIfResponsive(remote.url, appPassword);
    }

    remote.agentInstalled = false;
    this.storage.saveRemote(remote);
    Logger.log(`[RemoteService] ensureAgent fallback reinstall start remote=${remote.name} id=${remote.id}`);
    await this.installAgent(remote.id);
    const finalPing = await this.agentRequest(remote.url, appPassword, 'ping', {});
    Logger.log(`[RemoteService] ensureAgent fallback reinstall success remote=${remote.name} id=${remote.id}`);
    const finalVersion = finalPing?.version ? String(finalPing.version) : undefined;
    return await this.maybeAutoUpdateAgent(remote, appPassword, finalVersion);
  }

  /**
   * If the live agent is older than the bundled one, self-update it over the
   * agent's own REST channel (a tiny one-shot mu-plugin installer — does not
   * touch the fragile host's worker pool the way a full pull does). Best-effort:
   * a failed update keeps the old version so the caller can still fall back to
   * the legacy path. Returns the resulting (possibly upgraded) version.
   */
  private async maybeAutoUpdateAgent(
    remote: RemoteSite,
    appPassword: string,
    liveVersion: string | undefined
  ): Promise<string | undefined> {
    const bundled = await this.getBundledAgentVersion();
    if (!liveVersion || !bundled || this.compareSemver(liveVersion, bundled) >= 0) {
      return liveVersion;
    }
    Logger.log(`[RemoteService] ensureAgent auto-update stale agent ${liveVersion} -> ${bundled} remote=${remote.name} id=${remote.id}`);
    try {
      const result = await this.updateAgent(remote.id);
      return result.version ?? liveVersion;
    } catch (err) {
      Logger.log(`[RemoteService] ensureAgent auto-update failed (keeping ${liveVersion}): ${this.formatShortError(err)}`);
      return liveVersion;
    }
  }

  private async verifyCredentials(
    siteUrl: string,
    username: string,
    appPassword: string
  ): Promise<void> {
    const fetch = (await import('node-fetch')).default;
    const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
    const maxAttempts = 3;
    let res: any;
    let lastError: Error | undefined;

    // Cold WP REST, WAF warm-up, rate limits and flaky networks make the very first
    // request fail intermittently — which previously surfaced as "Неверные учетные
    // данные" and forced users to retry connecting 2-3 times. Retry transient
    // failures here; fail fast only on real auth errors (401/403).
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        res = await fetch(`${siteUrl}/wp-json/wp/v2/users/me?context=edit`, {
          headers: { Authorization: `Basic ${auth}` },
          signal: this.createTimeoutSignal(20000),
        });
      } catch (err) {
        // Network error / timeout / abort — transient.
        lastError = new Error(`Не удалось связаться с сайтом: ${this.formatShortError(err)}`);
        Logger.log(`[RemoteService] verifyCredentials network error attempt=${attempt}/${maxAttempts} error=${this.formatShortError(err)}`);
        if (attempt < maxAttempts) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw lastError;
      }

      if (res.status === 401 || res.status === 403) {
        let details = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as any;
          details = body?.message ?? details;
        } catch {
          // ignore parse issues
        }
        throw new Error(`Неверные учетные данные: ${details}`);
      }

      if (!res.ok) {
        let details = `${res.status} ${res.statusText}`;
        try {
          const body = (await res.json()) as any;
          details = body?.message ?? details;
        } catch {
          // ignore parse issues
        }
        lastError = new Error(`Сайт ответил ошибкой ${details}. Возможно, временная недоступность — повторите попытку.`);
        Logger.log(`[RemoteService] verifyCredentials HTTP ${res.status} attempt=${attempt}/${maxAttempts}`);
        // 5xx / 429 / 408 are transient; other 4xx are not.
        if (attempt < maxAttempts && (res.status >= 500 || res.status === 429 || res.status === 408)) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
          continue;
        }
        throw lastError;
      }

      break;
    }

    if (!res || !res.ok) {
      throw lastError || new Error('Не удалось проверить учетные данные удалённого сайта.');
    }

    const user = (await res.json()) as any;
    const roles = Array.isArray(user?.roles)
      ? user.roles.map((r: unknown) => String(r).toLowerCase())
      : [];
    const capabilities = (user?.capabilities && typeof user.capabilities === 'object')
      ? user.capabilities as Record<string, unknown>
      : undefined;

    const hasAdminRole = roles.includes('administrator');
    const hasAdminCapability = Boolean(
      capabilities?.administrator || capabilities?.manage_options || capabilities?.install_plugins
    );

    // Some WP installs/plugins hide roles/capabilities in REST responses even for
    // valid app-password authentication. In that case we should not fail early.
    const hasRoleInfo = roles.length > 0;
    const hasCapabilityInfo = Boolean(capabilities && Object.keys(capabilities).length > 0);
    const canReliablyCheckAdmin = hasRoleInfo || hasCapabilityInfo;

    if (canReliablyCheckAdmin && !hasAdminCapability && !hasAdminRole) {
      throw new Error('Указанные учетные данные должны принадлежать администратору WordPress.');
    }

    if (!canReliablyCheckAdmin) {
      Logger.log('[RemoteService] verifyCredentials: roles/capabilities недоступны через REST, пропускаем строгую проверку администратора');
    }
  }

  private normalizeSiteUrl(rawUrl: string): string {
    const value = String(rawUrl ?? '').trim();
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      throw new Error('Введите корректный URL WordPress сайта (например, https://example.com)');
    }

    const pathname = this.normalizeWpBasePath(parsed.pathname || '/');
    parsed.pathname = pathname;
    parsed.search = '';
    parsed.hash = '';

    return parsed.toString().replace(/\/$/, '');
  }

  private normalizeWpBasePath(pathname: string): string {
    let normalized = pathname.replace(/\/{2,}/g, '/');
    normalized = normalized.replace(/\/(?:wp-admin|wp-login\.php)(?:\/.*)?$/i, '');
    if (!normalized) {return '/';}
    return normalized;
  }

  private async wpApiRequest(
    siteUrl: string,
    username: string,
    appPassword: string,
    method: string,
    endpoint: string,
    body?: object,
    formData?: any
  ): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');
    const url = `${siteUrl}/wp-json${endpoint}`;

    const options: any = {
      method,
      headers: { Authorization: `Basic ${auth}` },
    };

    if (formData) {
      options.body = formData;
      Object.assign(options.headers, formData.getHeaders());
    } else if (body) {
      options.body = JSON.stringify(body);
      options.headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, options);
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`WP API error ${res.status}: ${text}`);
    }
    return res.json();
  }

  private async uploadAgentViaWpAdmin(
    siteUrl: string,
    username: string,
    appPassword: string,
    agentZipPath: string,
    overwrite = false
  ): Promise<void> {
    const session = await this.getPluginUploadSession(siteUrl, username, appPassword);
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    const referer = '/wp-admin/plugin-install.php?tab=upload';

    form.append('_wpnonce', session.nonce);
    form.append('_wp_http_referer', referer);
    form.append('pluginzip', fs.createReadStream(agentZipPath), {
      filename: path.basename(agentZipPath),
      contentType: 'application/zip',
    });
    form.append('install-plugin-submit', 'Install Now');

    const response = await this.fetchWithBasicAuth(
      `${siteUrl}/wp-admin/update.php?action=upload-plugin`,
      username,
      appPassword,
      {
        method: 'POST',
        headers: {
          ...form.getHeaders(),
          Cookie: session.cookieHeader,
        },
        body: form as any,
      }
    );

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Не удалось загрузить агент в WordPress: ${this.extractWpAdminError(html) || `${response.status} ${response.statusText}`}`);
    }

    const normalized = html.replace(/\s+/g, ' ');
    if (this.isWpLoginHtml(normalized)) {
      throw new Error('WordPress вернул страницу входа вместо страницы установки плагина. Возможно, этот сайт не разрешает авторизацию wp-admin через Application Password. Обновите WPDock Agent вручную через ZIP.');
    }

    // Update flow: when the plugin folder already exists, WordPress refuses to
    // unpack over it and instead offers a "Replace current with uploaded" link
    // (WP 5.5+). Detect that link by its query/CSS class — locale-independent,
    // unlike the "destination folder already exists" message — and follow it to
    // actually overwrite the files.
    if (overwrite) {
      const overwriteUrl = this.extractOverwriteUrl(html, siteUrl);
      if (overwriteUrl) {
        await this.followPluginOverwrite(siteUrl, username, appPassword, overwriteUrl, session.cookieHeader);
        return;
      }
      // No overwrite offered: the upload either installed a fresh copy or already
      // completed. Real success is verified by the caller via the agent's
      // ping/version, so we don't gate on localized "success" strings here.
      return;
    }

    const successPatterns = [
      /plugin installed successfully/i,
      /destination folder already exists/i,
      /плагин успешно установлен/i,
      /каталог назначения уже существует/i,
    ];

    if (!successPatterns.some((pattern) => pattern.test(html))) {
      const error = this.extractWpAdminError(html);
      if (error) {
        throw new Error(`Автоустановка агента не удалась: ${error}`);
      }
      throw new Error('WordPress не подтвердил установку плагина. Проверьте, что для сайта разрешена установка плагинов и файловая система доступна на запись.');
    }
  }

  /**
   * Follow WordPress's "Replace current with uploaded" link to overwrite an
   * existing plugin (WP 5.5+). The anchor points back to update.php with
   * `overwrite=update-plugin`, a fresh nonce and the temp package reference —
   * we just follow it with the same auth/cookies.
   *
   * Locale-independent: we only hard-fail on a transport error or a login
   * redirect. The actual update success is confirmed by the caller via the
   * agent's ping/version, not by parsing WordPress's localized success text.
   */
  private async followPluginOverwrite(
    siteUrl: string,
    username: string,
    appPassword: string,
    overwriteUrl: string,
    cookieHeader: string
  ): Promise<void> {
    const response = await this.fetchWithBasicAuth(
      overwriteUrl,
      username,
      appPassword,
      {
        method: 'GET',
        headers: { Cookie: cookieHeader },
      }
    );

    const html = await response.text();
    if (!response.ok) {
      throw new Error(`Не удалось заменить плагин агента: ${this.extractWpAdminError(html) || `${response.status} ${response.statusText}`}`);
    }
    if (this.isWpLoginHtml(html.replace(/\s+/g, ' '))) {
      throw new Error('WordPress вернул страницу входа при замене плагина — авторизация wp-admin недоступна. Обновите WPDock Agent вручную через ZIP.');
    }
  }

  /** Reads the agent version from the bundled ZIP — the exact file we upload. */
  private async getBundledAgentVersion(): Promise<string | undefined> {
    if (this.bundledAgentVersionCache !== undefined) {
      return this.bundledAgentVersionCache || undefined;
    }
    let version = '';
    try {
      const { unzipSync } = await import('fflate');
      const zipData = fs.readFileSync(this.getAgentZipPath());
      const entries = unzipSync(new Uint8Array(zipData));
      for (const [name, content] of Object.entries(entries)) {
        if (!/(?:^|\/)wpdock-agent\.php$/i.test(name)) {
          continue;
        }
        const text = Buffer.from(content).toString('utf8');
        const match =
          text.match(/WPDOCK_AGENT_VERSION['"]\s*,\s*['"]([^'"]+)['"]/i) ||
          text.match(/Version:\s*([0-9][0-9A-Za-z.-]*)/i);
        if (match?.[1]) {
          version = match[1].trim();
          break;
        }
      }
    } catch (err) {
      Logger.log(`[RemoteService] getBundledAgentVersion failed: ${this.formatShortError(err)}`);
    }
    this.bundledAgentVersionCache = version;
    return version || undefined;
  }
  private bundledAgentVersionCache?: string;

  private extractOverwriteUrl(html: string, siteUrl: string): string | undefined {
    const normalized = html.replace(/\s+/g, ' ');
    const patterns = [
      /<a[^>]*class=["'][^"']*update-from-upload-overwrite[^"']*["'][^>]*href=["']([^"']+)["']/i,
      /<a[^>]*href=["']([^"']+)["'][^>]*class=["'][^"']*update-from-upload-overwrite[^"']*["']/i,
      /href=["']([^"']*overwrite=update-plugin[^"']*)["']/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        const href = match[1].replace(/&amp;/g, '&');
        try {
          return new URL(href, `${siteUrl}/wp-admin/`).toString();
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  private async getPluginUploadSession(
    siteUrl: string,
    username: string,
    appPassword: string
  ): Promise<{ nonce: string; cookieHeader: string }> {
    const jar = new Map<string, string>();
    const response = await this.fetchWithBasicAuth(
      `${siteUrl}/wp-admin/plugin-install.php?tab=upload`,
      username,
      appPassword,
      { method: 'GET' },
      jar
    );
    const html = await response.text();
    const normalized = html.replace(/\s+/g, ' ');

    if (!response.ok) {
      throw new Error(`Не удалось открыть страницу загрузки плагинов: ${this.extractWpAdminError(html) || `${response.status} ${response.statusText}`}`);
    }

    if (this.isWpLoginHtml(normalized)) {
      throw new Error(
        'WordPress вернул страницу входа вместо установки плагина. Возможно, этот сайт не разрешает авторизацию wp-admin через Application Password (только REST API). Используйте ручную установку ZIP или проверьте ограничения хостинга/WAF.'
      );
    }

    const nonceMatch = html.match(/name=["']_wpnonce["'][^>]*value=["']([^"']+)["']/i);
    if (!nonceMatch?.[1]) {
      const error = this.extractWpAdminError(html);
      if (error) {
        throw new Error(`WordPress отклонил доступ к установке плагинов: ${error}`);
      }
      throw new Error('Не удалось получить nonce для установки плагина. На этом сайте автоустановка через Application Password может быть запрещена.');
    }

    const cookieHeader = this.serializeCookieJar(jar);
    return { nonce: nonceMatch[1], cookieHeader };
  }

  private async registerAgentToken(
    siteUrl: string,
    username: string,
    appPassword: string,
    token: string
  ): Promise<void> {
    Logger.log(`[RemoteService] registerAgentToken request url=${siteUrl}`);
    const primaryEndpoint = '/wpdock/v1/register-token';
    try {
      await this.wpApiRequest(siteUrl, username, appPassword, 'POST', primaryEndpoint, { token });
      Logger.log(`[RemoteService] registerAgentToken success endpoint=${primaryEndpoint} url=${siteUrl}`);
      return;
    } catch (err) {
      const raw = String((err as any)?.message ?? err ?? '').toLowerCase();
      const notFound = raw.includes('rest_no_route') || raw.includes('wp api error 404');
      if (!notFound) {
        throw err;
      }

      Logger.log(`[RemoteService] registerAgentToken primary endpoint missing, trying route discovery url=${siteUrl}`);
      const discoveredEndpoint = await this.findRegisterTokenEndpoint(siteUrl, username, appPassword);
      if (discoveredEndpoint) {
        await this.wpApiRequest(siteUrl, username, appPassword, 'POST', discoveredEndpoint, { token });
        Logger.log(`[RemoteService] registerAgentToken success endpoint=${discoveredEndpoint} url=${siteUrl}`);
        return;
      }

      throw new Error(
        'WPDock endpoint регистрации токена не найден (rest_no_route). Обычно это означает, что WPDock Agent не установлен/не активирован или установлена устаревшая версия плагина.'
      );
    }
  }

  private async findRegisterTokenEndpoint(
    siteUrl: string,
    username: string,
    appPassword: string
  ): Promise<string | undefined> {
    try {
      const index = await this.wpApiRequest(siteUrl, username, appPassword, 'GET', '/');
      const routes = (index?.routes && typeof index.routes === 'object')
        ? index.routes as Record<string, any>
        : {};
      const entries = Object.entries(routes);

      const supportsPost = (routeInfo: any): boolean => {
        if (!routeInfo || !Array.isArray(routeInfo.endpoints)) {return false;}
        return routeInfo.endpoints.some((ep: any) => {
          const methods = ep?.methods;
          if (Array.isArray(methods)) {
            return methods.map((m) => String(m).toUpperCase()).includes('POST');
          }
          if (typeof methods === 'object' && methods) {
            return Object.keys(methods).some((m) => m.toUpperCase() === 'POST');
          }
          if (typeof methods === 'string') {
            return methods.toUpperCase().includes('POST');
          }
          return false;
        });
      };

      const candidates = entries
        .filter(([route, info]) => (
          route.startsWith('/wpdock/') &&
          /register[-_]?token/i.test(route) &&
          supportsPost(info)
        ))
        .map(([route]) => route);

      if (candidates.length === 0) {
        return undefined;
      }

      // wpApiRequest prepends /wp-json, so we return route as endpoint.
      return candidates[0];
    } catch {
      return undefined;
    }
  }

  private isRegisterTokenRouteMissingError(err: unknown): boolean {
    const raw = String((err as any)?.message ?? err ?? '').toLowerCase();
    return raw.includes('rest_no_route') || raw.includes('wp api error 404');
  }

  private async isAgentResponsive(siteUrl: string, appPassword: string): Promise<boolean> {
    try {
      await this.agentRequest(siteUrl, appPassword, 'ping', {});
      return true;
    } catch {
      return false;
    }
  }

  private async getAgentVersionIfResponsive(siteUrl: string, appPassword: string): Promise<string | undefined> {
    try {
      const ping = await this.agentRequest(siteUrl, appPassword, 'ping', {});
      const version = String(ping?.version ?? '').trim();
      return version || undefined;
    } catch {
      return undefined;
    }
  }

  private extractWpAdminError(html: string): string | undefined {
    const normalized = html.replace(/\s+/g, ' ');
    const patterns = [
      /<div[^>]*class=["'][^"']*notice-error[^"']*["'][^>]*>.*?<p>(.*?)<\/p>/i,
      /<div[^>]*class=["'][^"']*error[^"']*["'][^>]*>.*?<p>(.*?)<\/p>/i,
      /<p>(Sorry, you are not allowed to .*?)<\/p>/i,
      /<p>(Извините, вам не разрешено .*?)<\/p>/i,
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern);
      if (match?.[1]) {
        return match[1].replace(/<[^>]+>/g, '').trim();
      }
    }

    if (this.isWpLoginHtml(normalized)) {
      return 'WordPress вернул страницу входа вместо страницы установки плагинов.';
    }

    return undefined;
  }

  private isWpLoginHtml(normalizedHtml: string): boolean {
    const hasLoginForm = /(id|name)=["']loginform["']/i.test(normalizedHtml);
    const hasLoginAction = /action=["'][^"']*wp-login\.php/i.test(normalizedHtml);
    const hasPasswordField = /name=["']pwd["']/i.test(normalizedHtml);
    const hasLoginTitle = /<title>[^<]*(log in|вход|войти)[^<]*<\/title>/i.test(normalizedHtml);

    return (hasLoginForm && hasLoginAction) || (hasLoginAction && hasPasswordField) || (hasLoginTitle && hasLoginAction);
  }

  private async fetchWithBasicAuth(
    url: string,
    username: string,
    appPassword: string,
    options: any,
    cookieJar?: Map<string, string>
  ): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    const auth = Buffer.from(`${username}:${appPassword}`).toString('base64');

    const requestWithRedirects = async (
      currentUrl: string,
      redirectLeft: number,
      currentOptions: any
    ): Promise<any> => {
      const cookieHeader = this.serializeCookieJar(cookieJar);
      const response = await fetch(currentUrl, {
        redirect: 'manual',
        ...currentOptions,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
          ...(currentOptions?.headers ?? {}),
        },
      });

      this.collectResponseCookies(response, cookieJar);

      const status = Number(response.status);
      if ((status === 301 || status === 302 || status === 303 || status === 307 || status === 308) && redirectLeft > 0) {
        const location = response.headers.get('location');
        if (!location) {return response;}

        const nextUrl = new URL(location, currentUrl).toString();
        const isSwitchToGet = status === 303 || ((status === 301 || status === 302) && String(currentOptions?.method || 'GET').toUpperCase() !== 'GET');
        const nextOptions = isSwitchToGet
          ? { ...currentOptions, method: 'GET', body: undefined }
          : currentOptions;

        return requestWithRedirects(nextUrl, redirectLeft - 1, nextOptions);
      }

      return response;
    };

    return requestWithRedirects(url, 8, options);
  }

  private collectResponseCookies(response: any, cookieJar?: Map<string, string>): void {
    if (!cookieJar) {return;}

    const raw = response.headers?.raw?.();
    const rawSetCookies = raw?.['set-cookie'];
    if (!Array.isArray(rawSetCookies)) {return;}

    for (const cookie of rawSetCookies) {
      const firstPart = String(cookie).split(';')[0] ?? '';
      const eqIndex = firstPart.indexOf('=');
      if (eqIndex <= 0) {continue;}
      const name = firstPart.slice(0, eqIndex).trim();
      const value = firstPart.slice(eqIndex + 1).trim();
      if (!name) {continue;}
      cookieJar.set(name, value);
    }
  }

  private serializeCookieJar(cookieJar?: Map<string, string>): string {
    if (!cookieJar || cookieJar.size === 0) {return '';}
    return Array.from(cookieJar.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
  }

  private async agentRequest(
    siteUrl: string,
    appPassword: string,
    action: string,
    params: object,
    timeoutMs: number = AGENT_REQUEST_TIMEOUT_MS
  ): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    const token = await this.getAgentToken(appPassword);
    const startTime = Date.now();
    Logger.log(`[RemoteService] agentRequest START action=${action} url=${siteUrl} timeout=${timeoutMs}ms params=${JSON.stringify(params)}`);

    try {
      const res = await fetch(`${siteUrl}/?wpdock-agent=1&action=${action}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-WPDock-Token': token,
        },
        body: JSON.stringify(params),
        signal: this.createTimeoutSignal(timeoutMs),
      });
      
      if (!res.ok) {
        const text = await res.text();
        const duration = Date.now() - startTime;
        Logger.log(`[RemoteService] agentRequest FAILED action=${action} status=${res.status} duration=${duration}ms url=${siteUrl} error=${text}`);
        throw new Error(`Agent error ${res.status}: ${text}`);
      }
      
      const data = (await res.json()) as any;
      const duration = Date.now() - startTime;
      
      if (!data.success) {
        Logger.log(`[RemoteService] agentRequest FAILED (success=false) action=${action} duration=${duration}ms url=${siteUrl} message=${data.message}`);
        throw new Error(data.message || 'Agent request failed');
      }
      
      Logger.log(`[RemoteService] agentRequest SUCCESS action=${action} duration=${duration}ms url=${siteUrl}`);
      return data.data;
    } catch (err: any) {
      const duration = Date.now() - startTime;
      Logger.log(`[RemoteService] agentRequest EXCEPTION action=${action} duration=${duration}ms error=${err.message}`);
      throw err;
    }
  }

  // ── Direct media download (uploads) ───────────────────────────────────────
  //
  // The bulk of any WordPress pull is wp-content/uploads (media). Packing it
  // through the agent serializes every byte through PHP — brutal on a fragile
  // shared host with a tiny worker pool. Instead we fetch media as what it is:
  // PUBLIC static files served by the web server, downloaded in parallel by
  // system `curl`, bypassing PHP entirely. Resume is by disk — a file whose
  // on-disk size already matches the remote manifest is "done", so an
  // interrupted pull simply re-runs and continues from where it stopped.

  /** Cached path to a usable system `curl`, or '' if none. */
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

  /** Whether the system curl is new enough (≥7.66) for `--parallel`. */
  private static _curlParallel: boolean | null = null;
  private static curlSupportsParallel(): boolean {
    if (this._curlParallel !== null) { return this._curlParallel; }
    const curl = this.curlPath();
    if (!curl) { this._curlParallel = false; return false; }
    try {
      const out = cp.execFileSync(curl, ['--version'], { timeout: 5000 }).toString();
      const m = out.match(/curl\s+(\d+)\.(\d+)/i);
      if (m) {
        const major = Number(m[1]);
        const minor = Number(m[2]);
        this._curlParallel = major > 7 || (major === 7 && minor >= 66);
        return this._curlParallel;
      }
    } catch { /* ignore */ }
    this._curlParallel = false;
    return false;
  }

  /**
   * Whether a file under `wp-content/uploads` can never be served over plain
   * HTTP, so direct-media download must skip it (it is not a real media asset):
   *  - `.ht*` (`.htaccess`/`.htpasswd`) → Apache returns 403
   *  - `*.php`/`*.phtml`/`*.phps`/`*.pht`/`*.phpN` → blocked by security rules,
   *    or executed by the server (returns output, not source → size mismatch)
   *  - `web.config` → hidden by IIS
   */
  private static isWebInaccessibleUpload(rel: string): boolean {
    const name = rel.slice(rel.lastIndexOf('/') + 1).toLowerCase();
    if (name.startsWith('.ht')) { return true; }
    if (name === 'web.config') { return true; }
    if (/\.(php|phtml|phps|pht|php[0-9])$/.test(name)) { return true; }
    return false;
  }

  /**
   * Download wp-content/uploads directly over HTTP (no PHP), resumably.
   * Progress is reported into the [basePct, basePct+rangePct] band. Returns a
   * tally; never throws on individual unfetchable files — those are reported as
   * a non-fatal partial result so the rest of the pull (and a later resume)
   * still proceed.
   */
  private async pullUploadsDirect(
    remote: RemoteSite,
    appPassword: string,
    localPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    basePct: number,
    rangePct: number,
  ): Promise<{ total: number; downloaded: number; bytes: number; failed: number }> {
    const curl = RemoteService.curlPath();
    if (!curl) {
      throw new Error('Системный curl не найден — он нужен для быстрой загрузки медиафайлов.');
    }

    onProgress('media', 'Получение списка медиафайлов...', basePct);
    const listRes = await this.agentRequest(
      remote.url, appPassword, 'list_files', { subtree: 'uploads' }, AGENT_HEAVY_OP_TIMEOUT_MS,
    );
    const totalBytes = Number(listRes?.bytes || 0);
    const contentBaseUrl = String(listRes?.content_base_url || '').replace(/\/+$/, '');
    Logger.log(`[RemoteService] pullUploadsDirect list_files total=${Number(listRes?.total || 0)} bytes=${this.formatBytes(totalBytes)} base=${contentBaseUrl}`);

    if (Number(listRes?.total || 0) === 0 || !listRes?.token) {
      onProgress('media', 'Медиафайлов нет', basePct + rangePct);
      return { total: 0, downloaded: 0, bytes: 0, failed: 0 };
    }
    if (!contentBaseUrl) {
      throw new Error('Агент не вернул URL медиафайлов (content_base_url). Обновите WPDock Agent.');
    }

    // Pull the manifest (one `rel\tsize` line per file), served via a token.
    const manifestBuf = await this.downloadFromAgent(remote.url, appPassword, String(listRes.token));
    const entries: Array<{ rel: string; size: number; out: string }> = [];
    const skippedUnfetchable: string[] = [];
    for (const line of manifestBuf.toString('utf8').split('\n')) {
      if (!line) { continue; }
      const tab = line.lastIndexOf('\t');
      if (tab < 0) { continue; }
      const rel = line.slice(0, tab);
      const size = Number(line.slice(tab + 1)) || 0;
      // Some files under uploads can never be fetched over plain HTTP: Apache
      // returns 403 for `.ht*`, security rules block `.php` (or the server
      // EXECUTES it, returning output instead of source → size mismatch), and
      // IIS hides `web.config`. They are security stubs a local mirror does not
      // need; listing them only produces permanent "failed" entries. Drop them.
      if (RemoteService.isWebInaccessibleUpload(rel)) {
        skippedUnfetchable.push(rel);
        continue;
      }
      const out = path.join(localPath, 'wp-content', ...rel.split('/'));
      entries.push({ rel, size, out });
    }
    if (skippedUnfetchable.length > 0) {
      Logger.log(`[RemoteService] pullUploadsDirect skipped ${skippedUnfetchable.length} web-inaccessible file(s): ${skippedUnfetchable.slice(0, 8).join(', ')}${skippedUnfetchable.length > 8 ? ', …' : ''}`);
    }
    Logger.log(`[RemoteService] pullUploadsDirect manifest parsed entries=${entries.length}`);

    // Resume by disk: a file already at the expected size is done; one larger
    // than expected is stale/corrupt and gets deleted so curl refetches it; a
    // smaller (or missing) one is queued for download/resume.
    let presentBytes = 0;
    let presentCount = 0;
    const pending: Array<{ rel: string; size: number; out: string }> = [];
    for (const e of entries) {
      let onDisk = -1;
      try { onDisk = fs.statSync(e.out).size; } catch { /* missing */ }
      if (onDisk === e.size) {
        presentBytes += e.size; presentCount++;
        continue;
      }
      if (onDisk > e.size) {
        try { fs.unlinkSync(e.out); } catch { /* ignore */ }
      }
      pending.push(e);
    }
    Logger.log(`[RemoteService] pullUploadsDirect resume present=${presentCount}/${entries.length} (${this.formatBytes(presentBytes)}) pending=${pending.length}`);

    let doneCount = presentCount;
    let doneBytes = presentBytes;
    const reportProgress = () => {
      const frac = totalBytes > 0 ? Math.min(1, doneBytes / totalBytes) : 1;
      const pct = Math.min(basePct + rangePct, basePct + Math.round(frac * rangePct));
      onProgress('media', `Медиа: ${doneCount}/${entries.length} файлов (${this.formatBytes(doneBytes)})`, pct);
    };
    reportProgress();

    if (pending.length === 0) {
      onProgress('media', `Медиа уже синхронизированы (${entries.length} файлов)`, basePct + rangePct);
      return { total: entries.length, downloaded: presentCount, bytes: presentBytes, failed: 0 };
    }

    // Download in bounded chunks so progress advances steadily and a transient
    // failure only re-checks a small slice (everything else stays on disk).
    const CHUNK = 1200;
    const parallel = RemoteService.curlSupportsParallel();
    const failures: string[] = [];
    for (let i = 0; i < pending.length; i += CHUNK) {
      const chunk = pending.slice(i, i + CHUNK);
      // Live progress for the (otherwise opaque) curl batch: re-stat the whole
      // chunk so the bar advances as bytes land on disk — a large/slow file no
      // longer looks frozen at the pre-batch "N/M files" snapshot.
      const liveReport = () => {
        let cBytes = 0;
        let cCount = 0;
        for (const e of chunk) {
          let onDisk = -1;
          try { onDisk = fs.statSync(e.out).size; } catch { /* missing */ }
          if (onDisk > 0) { cBytes += Math.min(onDisk, e.size); }
          if (onDisk === e.size) { cCount++; }
        }
        const liveBytes = doneBytes + cBytes;
        const liveCount = doneCount + cCount;
        const frac = totalBytes > 0 ? Math.min(1, liveBytes / totalBytes) : 1;
        const pct = Math.min(basePct + rangePct, basePct + Math.round(frac * rangePct));
        onProgress('media', `Медиа: ${liveCount}/${entries.length} файлов (${this.formatBytes(liveBytes)})`, pct);
      };
      let remaining = chunk;
      for (let attempt = 1; attempt <= 3 && remaining.length > 0; attempt++) {
        if (attempt > 1) {
          // Clear unresumable partials so each retry starts these files fresh.
          for (const e of remaining) { try { fs.unlinkSync(e.out); } catch { /* ignore */ } }
          await new Promise((r) => setTimeout(r, 1500 * attempt));
        }
        try {
          await this.curlDownloadBatch(curl, contentBaseUrl, remaining, parallel, 8, liveReport);
        } catch (err) {
          // A non-zero curl exit just means SOME file in the batch failed; the
          // rest still landed on disk. Re-verify below to find what's left.
          Logger.log(`[RemoteService] pullUploadsDirect batch curl error attempt=${attempt}: ${this.formatShortError(err)}`);
        }
        const next: typeof remaining = [];
        for (const e of remaining) {
          let onDisk = -1;
          try { onDisk = fs.statSync(e.out).size; } catch { /* missing */ }
          if (onDisk !== e.size) { next.push(e); }
        }
        remaining = next;
      }
      for (const e of chunk) {
        if (!remaining.includes(e)) { doneCount++; doneBytes += e.size; }
      }
      for (const e of remaining) { failures.push(e.rel); }
      reportProgress();
    }

    if (failures.length > 0) {
      Logger.log(`[RemoteService] pullUploadsDirect completed with ${failures.length} failures: ${failures.slice(0, 8).join(', ')}${failures.length > 8 ? ', …' : ''}`);
      onProgress('media', `Медиа перенесены частично: ${doneCount}/${entries.length}, не удалось ${failures.length} (повторите Pull, чтобы дозагрузить)`, basePct + rangePct);
    } else {
      Logger.log(`[RemoteService] pullUploadsDirect DONE downloaded=${doneCount}/${entries.length} bytes=${this.formatBytes(doneBytes)}`);
      onProgress('media', `Медиа перенесены: ${doneCount} файлов (${this.formatBytes(doneBytes)})`, basePct + rangePct);
    }
    return { total: entries.length, downloaded: doneCount, bytes: doneBytes, failed: failures.length };
  }

  /**
   * Download a batch of files with one `curl` invocation driven by a `-K`
   * config file (sidesteps command-line length limits). `--parallel` fans out
   * several transfers at once; `-C -` resumes any partial local file. A disk-size
   * watchdog kills a silently stalled transfer after the idle window so it can't
   * sit out the 30-min execFile cap. Rejects on a non-zero curl exit or a stall —
   * the caller verifies real success by disk and retries/resumes. `onTick` fires
   * per sample so the caller can report live progress for the opaque batch.
   */
  private curlDownloadBatch(
    curl: string,
    contentBaseUrl: string,
    files: Array<{ rel: string; size: number; out: string }>,
    parallel: boolean,
    parallelMax: number,
    onTick?: () => void,
  ): Promise<void> {
    // Each entry is a url/output pair. Output paths use forward slashes — inside
    // curl's quoted config values a backslash is an escape character.
    const lines: string[] = [];
    for (const f of files) {
      const encRel = f.rel.split('/').map(encodeURIComponent).join('/');
      lines.push(`url = "${contentBaseUrl}/${encRel}"`);
      lines.push(`output = "${f.out.replace(/\\/g, '/')}"`);
    }
    const cfgPath = path.join(os.tmpdir(), `wpdock-media-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(cfgPath, lines.join('\n'), 'utf8');

    const args = [
      ...(parallel ? ['--parallel', '--parallel-max', String(parallelMax)] : []),
      '-C', '-',                 // resume partial files
      '--create-dirs',
      '--location',              // follow http→https / CDN redirects to the real asset
      '--fail',                  // non-2xx ⇒ error
      '--retry', '3',
      '--retry-delay', '2',
      '--retry-connrefused',
      '--connect-timeout', '30',
      '--speed-limit', '1024',   // <1KB/s ...
      '--speed-time', '60',      // ... for 60s ⇒ abort that transfer (then --retry)
      '--silent', '--show-error',
      '-K', cfgPath,
    ];

    // Sum the on-disk size of the batch — the stall guard's progress signal.
    const sampleBytes = (): number => {
      let total = 0;
      for (const f of files) {
        let s = -1;
        try { s = fs.statSync(f.out).size; } catch { /* missing */ }
        if (s > 0) { total += Math.min(s, f.size); }
      }
      return total;
    };

    return new Promise<void>((resolve, reject) => {
      let stalled = false;
      let lastBytes = sampleBytes();
      let lastProgressAt = Date.now();
      let proc: cp.ChildProcess;
      // Watchdog: while curl runs with no parseable progress, watch the bytes it
      // writes to disk. Growth ⇒ re-arm; flatline past the idle window ⇒ a silently
      // stalled socket — kill curl so the caller's retry/resume runs (vs. hanging
      // out the 30-min execFile cap). Re-stat is cheap relative to the network I/O.
      const watchdog = setInterval(() => {
        const bytes = sampleBytes();
        if (bytes > lastBytes) {
          lastBytes = bytes;
          lastProgressAt = Date.now();
        } else if (Date.now() - lastProgressAt > MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS) {
          stalled = true;
          try { proc?.kill(); } catch { /* already gone */ }
          return;
        }
        try { onTick?.(); } catch { /* progress reporting must never break the download */ }
      }, MEDIA_DOWNLOAD_SAMPLE_MS);

      proc = cp.execFile(
        curl, args,
        { timeout: AGENT_HEAVY_OP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, _stdout, stderr) => {
          clearInterval(watchdog);
          try { fs.unlinkSync(cfgPath); } catch { /* ignore */ }
          try { onTick?.(); } catch { /* ignore */ }
          if (stalled) {
            reject(new Error(`media download stalled — no bytes for ${Math.round(MEDIA_DOWNLOAD_IDLE_TIMEOUT_MS / 1000)}s`));
            return;
          }
          if (err) {
            reject(new Error((stderr || err.message || '').toString().trim() || 'curl failed'));
            return;
          }
          resolve();
        },
      );
      proc.on('error', (e) => { clearInterval(watchdog); try { fs.unlinkSync(cfgPath); } catch { /* ignore */ } reject(e); });
    });
  }

  private async downloadFromAgent(
    siteUrl: string,
    appPassword: string,
    fileToken: string
  ): Promise<Buffer> {
    const { buffer } = await this.streamDownload(
      siteUrl, appPassword, `action=download&token=${fileToken}`, `downloadFromAgent token=${fileToken}`,
    );
    return buffer;
  }

  /**
   * Streamed GET download with idle/hard-cap abort: a silently stalled connection
   * (no body bytes arriving) aborts instead of hanging the whole Pull forever. The
   * idle timer re-arms on every received chunk, so a slow-but-steady transfer is
   * never killed mid-stream. Returns the body plus its declared Content-Length so
   * callers can validate a complete read. `query` is the agent query string after
   * `?wpdock-agent=1&` (e.g. `action=download&token=…` or `action=get_part&…`).
   */
  private async streamDownload(
    siteUrl: string,
    appPassword: string,
    query: string,
    logLabel: string,
  ): Promise<{ buffer: Buffer; contentLength: number }> {
    const fetch = (await import('node-fetch')).default;
    const token = await this.getAgentToken(appPassword);
    const startTime = Date.now();
    Logger.log(`[RemoteService] ${logLabel} START url=${siteUrl}`);

    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    let aborted = false;
    const fire = (reason: string) => {
      if (aborted) {return;}
      aborted = true;
      Logger.log(`[RemoteService] ${logLabel} ABORT reason=${reason}`);
      controller.abort();
    };
    const hardTimer = setTimeout(() => fire(`hard cap ${DOWNLOAD_HARD_CAP_MS}ms exceeded`), DOWNLOAD_HARD_CAP_MS);
    if (typeof (hardTimer as any).unref === 'function') {(hardTimer as any).unref();}
    const arm = () => {
      if (aborted) {return;}
      if (idleTimer) {clearTimeout(idleTimer);}
      idleTimer = setTimeout(() => fire(`idle ${DOWNLOAD_IDLE_TIMEOUT_MS}ms — no download progress (stalled connection)`), DOWNLOAD_IDLE_TIMEOUT_MS);
      if (typeof (idleTimer as any).unref === 'function') {(idleTimer as any).unref();}
    };

    try {
      arm();
      const res = await fetch(
        `${siteUrl}/?wpdock-agent=1&${query}`,
        { headers: { 'X-WPDock-Token': token }, signal: controller.signal }
      );
      if (!res.ok) {
        Logger.log(`[RemoteService] ${logLabel} FAILED status=${res.status} duration=${Date.now() - startTime}ms`);
        throw new Error(`Download failed: ${res.status}`);
      }
      const contentLength = Number(res.headers.get('content-length') || 0);
      // Read the body as a stream (node-fetch v2 exposes a Node Readable) so the idle
      // timer re-arms per chunk; `arrayBuffer()` alone gives no mid-transfer signal.
      const chunks: Buffer[] = [];
      await new Promise<void>((resolve, reject) => {
        const body = res.body as unknown as Readable;
        body.on('data', (chunk: Buffer) => { chunks.push(chunk); arm(); });
        body.on('end', () => resolve());
        body.on('error', (err) => reject(err));
      });
      const buffer = Buffer.concat(chunks);
      Logger.log(`[RemoteService] ${logLabel} SUCCESS size=${this.formatBytes(buffer.length)} duration=${Date.now() - startTime}ms`);
      return { buffer, contentLength };
    } finally {
      if (idleTimer) {clearTimeout(idleTimer);}
      clearTimeout(hardTimer);
    }
  }

  /**
   * Download a pack part addressed by sequence (agent ≥1.3.7 `get_part`). Unlike
   * the token `download`, get_part does NOT delete the part server-side, so it's
   * re-fetchable until the client ack_part's it — that's what makes a stalled
   * pull resumable by seq instead of restarting from line 0. Size is validated
   * against `expectedBytes` (from the CONTINUE response) or the Content-Length.
   */
  private async downloadPartBySeq(
    siteUrl: string,
    appPassword: string,
    jobId: string,
    seq: number,
    shard: number,
    expectedBytes: number,
  ): Promise<Buffer> {
    let query = `action=get_part&job_id=${encodeURIComponent(jobId)}&seq=${seq}`;
    if (shard >= 0) {query += `&shard=${shard}`;}
    const label = `get_part job=${jobId} seq=${seq}${shard >= 0 ? ` shard=${shard}` : ''}`;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PART_DOWNLOAD_RETRY_COUNT; attempt++) {
      try {
        const { buffer, contentLength } = await this.streamDownload(siteUrl, appPassword, query, label);
        const want = expectedBytes > 0 ? expectedBytes : contentLength;
        if (want > 0 && buffer.length !== want) {
          throw new Error(`Часть архива скачана не полностью: ожидалось ${this.formatBytes(want)}, получено ${this.formatBytes(buffer.length)}.`);
        }
        return buffer;
      } catch (err) {
        lastErr = err;
        const retryable = this.isAbortError(err) || this.isConnectRetryable(err) || /скачана не полностью/.test(String((err as any)?.message || ''));
        if (attempt >= PART_DOWNLOAD_RETRY_COUNT || !retryable) {throw err;}
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        Logger.log(`[RemoteService] downloadPartBySeq retry ${label} attempt=${attempt} in ${backoff}ms: ${String((err as any)?.message || err)}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  /**
   * Downloads one pack part with size validation + retry. Re-fetching the same
   * `partToken` is idempotent (the part ZIP persists server-side as a temp file),
   * so a stalled connection (now aborted by `downloadFromAgent`'s idle timer), a
   * transient connect drop, or a short read is recovered with a fresh download
   * instead of failing the whole Pull near the end. A `done`/non-stall mismatch
   * after the last attempt is fatal.
   */
  private async downloadPartWithRetry(
    siteUrl: string,
    appPassword: string,
    partToken: string,
    expectedBytes: number,
  ): Promise<Buffer> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= PART_DOWNLOAD_RETRY_COUNT; attempt++) {
      try {
        const buffer = await this.downloadFromAgent(siteUrl, appPassword, partToken);
        if (expectedBytes > 0 && buffer.length !== expectedBytes) {
          throw new Error(`Часть архива скачана не полностью: ожидалось ${this.formatBytes(expectedBytes)}, получено ${this.formatBytes(buffer.length)}.`);
        }
        return buffer;
      } catch (err) {
        lastErr = err;
        const retryable = this.isAbortError(err) || this.isConnectRetryable(err) || /скачана не полностью/.test(String((err as any)?.message || ''));
        if (attempt >= PART_DOWNLOAD_RETRY_COUNT || !retryable) {throw err;}
        const backoff = Math.min(8000, 500 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 500);
        Logger.log(`[RemoteService] downloadPartWithRetry retry token=${partToken} attempt=${attempt} in ${backoff}ms: ${String((err as any)?.message || err)}`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
    throw lastErr;
  }

  private assertValidSqlDump(sqlBuffer: Buffer): void {
    if (!sqlBuffer || sqlBuffer.length < 128) {
      throw new Error('Экспорт БД вернул слишком маленький SQL-файл. Pull остановлен, чтобы избежать частичного импорта.');
    }

    const preview = sqlBuffer.toString('utf8', 0, Math.min(sqlBuffer.length, 256 * 1024));
     Logger.log(`[RemoteService] assertValidSqlDump totalSize=${this.formatBytes(sqlBuffer.length)} preview=${preview.substring(0, 200)}`);
   
    if (/mysqldump:\s+Got error|Access denied|Unknown database|Can't connect/i.test(preview)) {
       Logger.log(`[RemoteService] assertValidSqlDump ERROR: mysqldump error detected in preview`);
      throw new Error('Экспорт БД на удаленном сайте завершился ошибкой mysqldump. Проверьте права/настройки БД на remote.');
    }

    const looksLikeSql = /CREATE\s+TABLE|INSERT\s+INTO|DROP\s+TABLE|LOCK\s+TABLES|--\s+MySQL dump/i.test(preview);
    if (!looksLikeSql) {
       Logger.log(`[RemoteService] assertValidSqlDump ERROR: does not look like valid SQL dump`);
      throw new Error('Полученный database.sql не похож на корректный дамп MySQL. Pull остановлен для защиты данных.');
    }
   
     Logger.log(`[RemoteService] assertValidSqlDump OK size=${this.formatBytes(sqlBuffer.length)}`);
  }

  private assertSupportedAgentVersion(versionRaw: unknown): void {
    const version = String(versionRaw ?? '').trim();
    if (!version) {
      return;
    }

    if (this.compareSemver(version, MIN_AGENT_VERSION) < 0) {
      throw new Error(
        `Устаревший WPDock Agent (${version}). Требуется версия ${MIN_AGENT_VERSION} или новее для надежного Pull БД. Обновите агент на удаленном сайте.`
      );
    }
  }

  private compareSemver(a: string, b: string): number {
    const pa = a.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const pb = b.split('.').map((part) => Number.parseInt(part, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const av = pa[i] ?? 0;
      const bv = pb[i] ?? 0;
      if (av > bv) {return 1;}
      if (av < bv) {return -1;}
    }
    return 0;
  }

  private async uploadToAgent(
    siteUrl: string,
    appPassword: string,
    filePath: string,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  ): Promise<string> {
    this.loadUploadSettings();
    const totalBytes = fs.statSync(filePath).size;
    const preferChunked = totalBytes > DIRECT_UPLOAD_MAX_BYTES;
    Logger.log(`[RemoteService] uploadToAgent file=${path.basename(filePath)} size=${this.formatBytes(totalBytes)} mode=${preferChunked ? 'chunked' : 'direct'} directLimit=${this.formatBytes(DIRECT_UPLOAD_MAX_BYTES)} chunkSize=${this.formatBytes(CHUNK_UPLOAD_BYTES)}`);

    if (!preferChunked) {
      try {
        const directToken = await this.uploadToAgentDirect(siteUrl, appPassword, filePath);
        onProgress?.(totalBytes, totalBytes);
        return directToken;
      } catch (err) {
        Logger.log(`[RemoteService] uploadToAgent direct upload failed for ${path.basename(filePath)} error=${String((err as any)?.message ?? err ?? '')}`);
        // A direct upload can fail on payload limits, timeouts/aborts (slow or stalled
        // host), or transient network/5xx errors. In all of these cases the resilient
        // chunked path (smaller requests + per-chunk retries + concurrency) is far more
        // likely to succeed, so we fall back instead of failing the whole Push.
        const canFallbackToChunked =
          this.isPayloadLimitError(err) ||
          this.isAbortError(err) ||
          this.isRetryableUploadError(err);
        if (!canFallbackToChunked) {
          throw err;
        }
        Logger.log(`[RemoteService] uploadToAgent falling back to chunked mode for ${path.basename(filePath)}`);
      }
    }

    try {
      return await this.uploadToAgentChunked(siteUrl, appPassword, filePath, totalBytes, onProgress);
    } catch (err) {
      if (this.isMissingChunkApiError(err)) {
        if (preferChunked) {
          throw new Error(
            'Сервер отклонил крупную загрузку, а установленный WPDock Agent не поддерживает батчевую передачу. Обновите агент до последней версии.'
          );
        }
        return this.uploadToAgentDirect(siteUrl, appPassword, filePath);
      }
      throw err;
    }
  }

  private async uploadToAgentDirect(
    siteUrl: string,
    appPassword: string,
    filePath: string
  ): Promise<string> {
    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('form-data')).default;
    const token = await this.getAgentToken(appPassword);
    const filename = path.basename(filePath);
    const totalBytes = fs.statSync(filePath).size;
    let lastError: Error | undefined;

    for (let attempt = 1; attempt <= UPLOAD_RETRY_COUNT; attempt++) {
      const upload = this.createUploadController(`direct ${filename}`, UPLOAD_IDLE_TIMEOUT_MS, UPLOAD_HARD_CAP_MS);
      const logProgress = this.makeUploadProgressLogger(`direct ${filename} attempt=${attempt}`, totalBytes);
      let sentBytes = 0;
      const body = this.streamWithProgress(fs.createReadStream(filePath), (delta) => {
        sentBytes += delta;
        upload.arm();
        logProgress(sentBytes);
      });
      const form = new FormData();
      form.append('file', body, { filename, contentType: 'application/zip', knownLength: totalBytes });
      const startedAt = Date.now();

      try {
        Logger.log(`[RemoteService] uploadToAgentDirect START attempt=${attempt}/${UPLOAD_RETRY_COUNT} file=${filename} size=${this.formatBytes(totalBytes)} idleTimeout=${UPLOAD_IDLE_TIMEOUT_MS}ms`);
        const res = await fetch(`${siteUrl}/?wpdock-agent=1&action=upload`, {
          method: 'POST',
          headers: { ...form.getHeaders(), 'X-WPDock-Token': token },
          body: form,
          signal: upload.controller.signal,
        });
        upload.clear();
        if (!res.ok) {
          const text = await res.text();
          lastError = new Error(`Upload failed: ${res.status} ${text}`);
          Logger.log(`[RemoteService] uploadToAgentDirect FAILED attempt=${attempt}/${UPLOAD_RETRY_COUNT} status=${res.status} duration=${Date.now() - startedAt}ms`);
          if (attempt < UPLOAD_RETRY_COUNT && this.isRetryableUploadError(lastError)) {
            await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * attempt));
            continue;
          }
          throw lastError;
        }
        const data = (await res.json()) as any;
        if (!data?.success || !data?.data?.file_token) {
          lastError = new Error(data?.message || 'Upload failed: invalid agent response');
          Logger.log(`[RemoteService] uploadToAgentDirect FAILED invalid response attempt=${attempt}/${UPLOAD_RETRY_COUNT} duration=${Date.now() - startedAt}ms`);
          if (attempt < UPLOAD_RETRY_COUNT && this.isRetryableUploadError(lastError)) {
            await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * attempt));
            continue;
          }
          throw lastError;
        }
        Logger.log(`[RemoteService] uploadToAgentDirect SUCCESS attempt=${attempt}/${UPLOAD_RETRY_COUNT} token=${data.data.file_token} duration=${Date.now() - startedAt}ms`);
        return data.data.file_token;
      } catch (err: any) {
        upload.clear();
        lastError = err;
        Logger.log(`[RemoteService] uploadToAgentDirect EXCEPTION attempt=${attempt}/${UPLOAD_RETRY_COUNT} error=${err.message} sent=${this.formatBytes(sentBytes)}/${this.formatBytes(totalBytes)}`);
        if (attempt >= UPLOAD_RETRY_COUNT || !this.isRetryableUploadError(err) || this.isPayloadLimitError(err)) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * attempt));
      }
    }

    throw lastError || new Error('Upload failed');
  }

  private async uploadToAgentChunked(
    siteUrl: string,
    appPassword: string,
    filePath: string,
    totalBytes: number,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  ): Promise<string> {
    // Start with the configured chunk size (can be large for capable hosts). If the
    // host rejects an oversized POST body (413), halve and re-run the session rather
    // than failing the whole Push — this makes a high chunk-size setting safe.
    let chunkSize = CHUNK_UPLOAD_BYTES;
    while (true) {
      try {
        return await this.runChunkedUploadSession(siteUrl, appPassword, filePath, totalBytes, chunkSize, onProgress);
      } catch (err) {
        if (this.isChunkSizeRejection(err) && chunkSize > MIN_CHUNK_UPLOAD_BYTES) {
          const reduced = Math.max(MIN_CHUNK_UPLOAD_BYTES, Math.floor(chunkSize / 2));
          Logger.log(`[RemoteService] uploadToAgentChunked host rejected chunkSize=${this.formatBytes(chunkSize)} (413) — retrying with ${this.formatBytes(reduced)}`);
          chunkSize = reduced;
          continue;
        }
        throw err;
      }
    }
  }

  private async runChunkedUploadSession(
    siteUrl: string,
    appPassword: string,
    filePath: string,
    totalBytes: number,
    chunkSize: number,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  ): Promise<string> {
    const filename = path.basename(filePath);
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    Logger.log(`[RemoteService] runChunkedUploadSession START file=${filename} totalChunks=${totalChunks} chunkSize=${this.formatBytes(chunkSize)} concurrency=${CHUNK_UPLOAD_CONCURRENCY} totalSize=${this.formatBytes(totalBytes)}`);
    const init = await this.agentRequest(siteUrl, appPassword, 'upload_init', {
      filename,
      total_chunks: totalChunks,
    });

    const uploadId = String(init?.upload_id || '');
    if (!uploadId) {
      throw new Error('Agent did not return upload_id for chunked upload');
    }

    const fileHandle = await fs.promises.open(filePath, 'r');
    let uploadedBytes = 0;
    let nextChunkIndex = 0;
    // When one worker fails, the others stop pulling new chunks so we surface the
    // error fast (e.g. a 413) instead of letting every worker exhaust its retries.
    let aborted = false;

    try {
      const workerCount = Math.min(CHUNK_UPLOAD_CONCURRENCY, totalChunks);
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIndex < totalChunks && !aborted) {
          const currentIndex = nextChunkIndex++;
          if (currentIndex >= totalChunks) {
            return;
          }

          const start = currentIndex * chunkSize;
          const remaining = Math.max(0, totalBytes - start);
          const expectedSize = Math.min(chunkSize, remaining);
          const buffer = Buffer.allocUnsafe(expectedSize);
          const readResult = await fileHandle.read(buffer, 0, expectedSize, start);
          const chunkBuffer = readResult.bytesRead === expectedSize
            ? buffer
            : buffer.subarray(0, readResult.bytesRead);

          try {
            await this.uploadChunkToAgent(
              siteUrl,
              appPassword,
              uploadId,
              currentIndex,
              filename,
              chunkBuffer
            );
          } catch (err) {
            aborted = true;
            throw err;
          }

          uploadedBytes += readResult.bytesRead;
          onProgress?.(Math.min(uploadedBytes, totalBytes), totalBytes);
        }
      });

      await Promise.all(workers);
    } finally {
      await fileHandle.close();
    }

    const finalize = await this.agentRequest(siteUrl, appPassword, 'upload_finalize', {
      upload_id: uploadId,
    });

    const token = String(finalize?.file_token || '');
    if (!token) {
      throw new Error('Agent did not return file token after chunk finalize');
    }
    Logger.log(`[RemoteService] runChunkedUploadSession SUCCESS file=${filename} token=${token} result=${JSON.stringify(finalize ?? {})}`);
    onProgress?.(totalBytes, totalBytes);
    return token;
  }

  private async uploadChunkToAgent(
    siteUrl: string,
    appPassword: string,
    uploadId: string,
    chunkIndex: number,
    filename: string,
    chunk: Buffer
  ): Promise<void> {
    const fetch = (await import('node-fetch')).default;
    const FormData = (await import('form-data')).default;
    const token = await this.getAgentToken(appPassword);

    let lastError: Error | undefined;
    
    for (let attempt = 1; attempt <= UPLOAD_RETRY_COUNT; attempt++) {
      const upload = this.createUploadController(`chunk #${chunkIndex} ${filename}`, UPLOAD_IDLE_TIMEOUT_MS, UPLOAD_HARD_CAP_MS);
      try {
        const body = this.streamWithProgress(this.bufferToStream(chunk), () => upload.arm());
        const form = new FormData();
        form.append('upload_id', uploadId);
        form.append('chunk_index', String(chunkIndex));
        form.append('chunk', body, {
          filename: `${filename}.part`,
          contentType: 'application/octet-stream',
          knownLength: chunk.length,
        });

        const startTime = Date.now();
        const res = await fetch(`${siteUrl}/?wpdock-agent=1&action=upload_chunk`, {
          method: 'POST',
          headers: { ...form.getHeaders(), 'X-WPDock-Token': token },
          body: form,
          signal: upload.controller.signal,
        });
        upload.clear();
        const duration = Date.now() - startTime;

        if (!res.ok) {
          const text = await res.text();
          lastError = new Error(`Chunk upload failed: ${res.status} ${text}`);
          Logger.log(`[RemoteService] uploadChunkToAgent FAILED attempt=${attempt}/${UPLOAD_RETRY_COUNT} chunkIndex=${chunkIndex} status=${res.status} duration=${duration}ms`);
          
          if (attempt < UPLOAD_RETRY_COUNT && !this.isPermanentError(res.status)) {
            await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY_MS * attempt));
            continue;
          }
          throw lastError;
        }

        const data = (await res.json()) as any;
        if (!data?.success) {
          lastError = new Error(data?.message || 'Chunk upload failed');
          Logger.log(`[RemoteService] uploadChunkToAgent FAILED (success=false) attempt=${attempt}/${UPLOAD_RETRY_COUNT} chunkIndex=${chunkIndex} duration=${duration}ms message=${data?.message}`);
          
          if (attempt < UPLOAD_RETRY_COUNT) {
            await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY_MS * attempt));
            continue;
          }
          throw lastError;
        }

        Logger.log(`[RemoteService] uploadChunkToAgent SUCCESS chunkIndex=${chunkIndex} size=${this.formatBytes(chunk.length)} duration=${duration}ms`);
        return;
      } catch (err: any) {
        upload.clear();
        lastError = err;
        if (attempt === UPLOAD_RETRY_COUNT) {
          Logger.log(`[RemoteService] uploadChunkToAgent FAILED ALL ATTEMPTS chunkIndex=${chunkIndex} error=${err.message}`);
          throw err;
        }
        Logger.log(`[RemoteService] uploadChunkToAgent RETRY attempt=${attempt}/${UPLOAD_RETRY_COUNT} chunkIndex=${chunkIndex} error=${err.message}`);
        await new Promise(r => setTimeout(r, UPLOAD_RETRY_DELAY_MS * attempt));
      }
    }

    throw lastError || new Error('Chunk upload failed');
  }

  private isPermanentError(status: number): boolean {
    // 4xx errors (except 429) are usually permanent
    // 5xx errors are usually temporary
    return status >= 400 && status < 500 && status !== 429;
  }

  private isRetryableUploadError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    if (this.isPayloadLimitError(error)) {
      return false;
    }
    return /timed out|timeout|econnreset|socket hang up|fetch failed|network|bad gateway|gateway timeout|service unavailable|upload session expired|502|503|504/.test(raw);
  }

  private async retryAsync<T>(label: string, attempts: number, task: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        return await task();
      } catch (err) {
        lastError = err;
        Logger.log(`[RemoteService] retryAsync FAILED label=${label} attempt=${attempt}/${attempts} error=${String((err as any)?.message ?? err ?? '')}`);
        if (attempt >= attempts || !this.isRetryableUploadError(err)) {
          throw err;
        }
        await new Promise((resolve) => setTimeout(resolve, UPLOAD_RETRY_DELAY_MS * attempt));
      }
    }
    throw lastError;
  }

  private isPayloadLimitError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return (
      raw.includes('413') ||
      raw.includes('payload too large') ||
      raw.includes('upload failed')
    );
  }

  /**
   * Strict check for a host rejecting an oversized request body. Unlike
   * isPayloadLimitError (which loosely matches "upload failed" and so triggers on
   * generic chunk errors too), this only fires on a genuine 413 / entity-too-large
   * so the chunk-size auto-reduction doesn't kick in on transient 5xx/network drops.
   */
  private isChunkSizeRejection(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return /\b413\b|payload too large|request entity too large|entity too large/.test(raw);
  }

  private isMissingChunkApiError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return raw.includes('unknown action: upload_init');
  }

  /** Detects fetch AbortError (request timed out via createTimeoutSignal or was cancelled). */
  private isAbortError(error: unknown): boolean {
    const name = String((error as any)?.name ?? '').toLowerCase();
    const type = String((error as any)?.type ?? '').toLowerCase();
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return (
      name === 'aborterror' ||
      type === 'aborted' ||
      raw.includes('operation was aborted') ||
      raw.includes('user aborted') ||
      raw.includes('aborted')
    );
  }

  private formatBytes(value: number): string {
    const size = Math.max(0, value || 0);
    if (size < 1024) {return `${size} B`;}
    if (size < 1024 * 1024) {return `${(size / 1024).toFixed(1)} KB`;}
    if (size < 1024 * 1024 * 1024) {return `${(size / (1024 * 1024)).toFixed(1)} MB`;}
    return `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  private createTimeoutSignal(timeoutMs: number): AbortSignal {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    // Don't keep the event loop alive solely for this fallback timer.
    if (typeof (timer as any).unref === 'function') {(timer as any).unref();}
    return controller.signal;
  }

  /**
   * Builds an AbortController whose abort fires only when an upload makes NO
   * progress for `idleMs` (a real stall), not after a fixed total duration.
   * Slow-but-steady uploads to remote hosts therefore complete instead of being
   * killed mid-transfer. A `hardCapMs` ceiling guards against pathological hangs.
   * Call `arm()` on every progress event and `clear()` in a finally block.
   */
  private createUploadController(
    label: string,
    idleMs: number,
    hardCapMs: number
  ): { controller: AbortController; arm: () => void; clear: () => void } {
    const controller = new AbortController();
    let idleTimer: NodeJS.Timeout | undefined;
    let aborted = false;

    const fire = (reason: string) => {
      if (aborted) {return;}
      aborted = true;
      Logger.log(`[RemoteService] upload ABORT ${label} reason=${reason}`);
      controller.abort();
    };
    const hardTimer = setTimeout(() => fire(`hard cap ${hardCapMs}ms exceeded`), hardCapMs);
    if (typeof (hardTimer as any).unref === 'function') {(hardTimer as any).unref();}
    const arm = () => {
      if (aborted) {return;}
      if (idleTimer) {clearTimeout(idleTimer);}
      idleTimer = setTimeout(() => fire(`idle ${idleMs}ms — no upload progress (stalled connection)`), idleMs);
      if (typeof (idleTimer as any).unref === 'function') {(idleTimer as any).unref();}
    };
    arm();

    const clear = () => {
      if (idleTimer) {clearTimeout(idleTimer);}
      if (hardTimer) {clearTimeout(hardTimer);}
    };
    return { controller, arm, clear };
  }

  /**
   * Wraps a source stream so each byte that flows through (as form-data is
   * consumed by the socket, i.e. with backpressure) invokes `onBytes(delta)`.
   * A Transform is used (not a 'data' listener) so the source is never forced
   * into flowing mode prematurely, which would corrupt the multipart body.
   */
  private streamWithProgress(source: Readable, onBytes: (delta: number) => void): Readable {
    const counter = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        onBytes(chunk.length);
        cb(null, chunk);
      },
    });
    source.on('error', (err) => counter.destroy(err));
    // When the request is aborted/finished node-fetch destroys `counter`; make sure
    // the underlying source (e.g. a file handle) is released too, to avoid fd leaks
    // across upload retries.
    counter.on('close', () => {
      if (!source.destroyed) {source.destroy();}
    });
    source.pipe(counter);
    return counter;
  }

  /**
   * Streams an in-memory buffer in small pull-based slices so upload progress is
   * observable (and the idle timer re-arms) as the socket drains — instead of
   * handing the whole multi-MB chunk to the socket in one push.
   */
  private bufferToStream(buf: Buffer, sliceSize = 64 * 1024): Readable {
    let offset = 0;
    return new Readable({
      read() {
        if (offset >= buf.length) {
          this.push(null);
          return;
        }
        const end = Math.min(offset + sliceSize, buf.length);
        this.push(buf.subarray(offset, end));
        offset = end;
      },
    });
  }

  /** Returns a throttled progress logger for an upload of `totalBytes`. */
  private makeUploadProgressLogger(
    label: string,
    totalBytes: number
  ): (sentBytes: number) => void {
    const startedAt = Date.now();
    let lastLog = startedAt;
    return (sentBytes: number) => {
      const now = Date.now();
      if (now - lastLog < UPLOAD_PROGRESS_LOG_INTERVAL_MS && sentBytes < totalBytes) {return;}
      lastLog = now;
      const elapsedSec = Math.max(0.001, (now - startedAt) / 1000);
      const pct = totalBytes > 0 ? ((sentBytes / totalBytes) * 100).toFixed(1) : '?';
      const kbs = (sentBytes / elapsedSec / 1024).toFixed(0);
      Logger.log(
        `[RemoteService] upload PROGRESS ${label} sent=${this.formatBytes(sentBytes)}/${this.formatBytes(totalBytes)} (${pct}%) avg=${kbs}KB/s elapsed=${Math.round(elapsedSec)}s`
      );
    };
  }

  private async getAgentToken(appPassword: string): Promise<string> {
    // Token = SHA256 of app password (deterministic, no storage needed)
    const { createHash } = await import('crypto');
    const normalized = this.normalizeAppPassword(appPassword);
    return createHash('sha256').update(normalized).digest('hex');
  }

  private normalizeAppPassword(rawValue: string): string {
    // WordPress application passwords are often shown as grouped chunks with spaces.
    // Normalize to a stable token/auth value regardless of input formatting.
    return String(rawValue ?? '').trim().replace(/\s+/g, '');
  }

  private formatShortError(error: unknown, maxLen = 260): string {
    const raw = String((error as any)?.message ?? error ?? 'unknown error').replace(/\s+/g, ' ').trim();
    return raw.length > maxLen ? `${raw.slice(0, maxLen - 3)}...` : raw;
  }

  private getAgentZipPath(): string {
    return path.join(this.context.extensionPath, 'resources', 'wpdock-agent.zip');
  }

  private createZip(sourceDir: string, destZip: string, archiver: any, devMode: boolean = false, enableLogging: boolean = true): Promise<void> {
    return new Promise((resolve, reject) => {
      const normalizedSourceDir = path.resolve(sourceDir);
      const externalWpContentDir = path.resolve(path.dirname(normalizedSourceDir), 'wp-content');
      const internalWpContentDir = path.resolve(normalizedSourceDir, 'wp-content');
      const hasExternalWpContent =
        fs.existsSync(externalWpContentDir) &&
        externalWpContentDir !== internalWpContentDir &&
        fs.statSync(externalWpContentDir).isDirectory() &&
        (
          !fs.existsSync(internalWpContentDir) ||
          fs.lstatSync(internalWpContentDir).isSymbolicLink()
        );
      const output = fs.createWriteStream(destZip);
      
      // ✅ OPTIMIZATION: Disable compression in dev mode (store mode = no compression)
      // Store mode is 20-30% faster than even compression level 1
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
            `compression=${useCompression ? 'level=' + ZIP_COMPRESSION_LEVEL : 'none (store)'}`
          );
        }
        resolve();
      });
      archive.on('error', reject);
      archive.pipe(output);

      // ✅ OPTIMIZATION: Use aggressive filters in dev mode to exclude uploads and build artifacts
      const ignorePatterns = devMode ? PUSH_AGGRESSIVE_DEV_FILTERS : PUSH_IGNORE_PATTERNS;
      
      if (enableLogging) {
        Logger.log(
          `[ZIP] scanning sourceDir=${sourceDir} devMode=${devMode} ` +
          `patterns=${ignorePatterns.length} (${devMode ? 'aggressive' : 'normal'} filters)`
        );
        if (hasExternalWpContent) {
          Logger.log(`[ZIP] external wp-content source detected: ${externalWpContentDir}`);
        }
      }

      // Use a single recursive glob. The pattern {**/*,*} captures both
      // root-level files (wp-login.php etc.) and nested files/dirs.
      archive.glob('{**/*,*}', {
        cwd: normalizedSourceDir,
        ignore: hasExternalWpContent
          ? [...ignorePatterns, 'wp-content', 'wp-content/**']
          : ignorePatterns,
        dot: false,
      });

      if (hasExternalWpContent) {
        archive.directory(externalWpContentDir, 'wp-content');
      }
      archive.finalize();
    });
  }
}
