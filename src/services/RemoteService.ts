import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { Readable, Transform } from 'stream';
import { RemoteFtpConfig, RemoteSite, RemoteSyncEvent } from '../types';
import { StorageService } from './StorageService';
import { Logger } from '../utils/logger';

const AGENT_PLUGIN_BASENAME = 'wpdock-agent/wpdock-agent.php';
const MIN_AGENT_VERSION = '1.3.0';
// Fatal server-side condition reported by ping (agent ≥1.3.17): wpdock-temp is
// not writable (disk full / hosting quota exceeded). Must escape ensureAgent's
// fallback chain — reinstalling the agent cannot fix the disk, and continuing
// means the push fails only after minutes of local packing.
class AgentTempUnwritableError extends Error {}
// First agent version with the `list_files` action — the prerequisite for the
// direct (PHP-bypassing) resumable media download. Below this we fall back to
// packing uploads through the agent like any other file.
const MEDIA_DIRECT_AGENT_VERSION = '1.3.6';
// First agent version whose `reset_wp` action also wipes content files (plugins,
// themes, uploads) while preserving the admin user, its Application Passwords,
// one default theme and the WPDock agent itself. 1.3.8 reset DB only.
const RESET_WP_AGENT_VERSION = '1.3.9';
// Agent with single-file incremental manifest/download/delete actions.
const INCREMENTAL_AGENT_VERSION = '1.3.13';
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
// During one Push we can temporarily cap concurrency below the user setting when
// the host starts returning transient TLS/socket/idle errors. This keeps a huge
// split-push moving instead of retrying every next ZIP part with the same pressure.
const MIN_ADAPTIVE_UPLOAD_CONCURRENCY = 1;
// Smallest chunk we will fall back to when a host rejects an oversized body (413).
const MIN_CHUNK_UPLOAD_BYTES = 256 * 1024;
const UPLOAD_RETRY_COUNT = 3;
// How many times a chunked-upload session is re-opened after a transient failure.
// Agent ≥1.3.12 resumes by resume_key and skips chunks already stored remotely.
const UPLOAD_SESSION_RETRY_COUNT = 3;
type AgentUploadWriteMode = 'single_file' | 'chunks';
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
// Upload control-plane requests (upload_init/finalize/abort) are tiny JSON calls,
// but shared hosts can leave them queued behind slow chunk workers. Give them more
// time than ordinary ping/status so a large split-push does not die between parts.
const AGENT_UPLOAD_CONTROL_TIMEOUT_MS = 5 * 60 * 1000;
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
// Very large single ZIP uploads can fail on shared hosting even when
// disk_free_space() reports plenty of room (account quota/per-file limits,
// sparse-file writes, ZipArchive limits). Above this estimate, push files as
// several independent ZIPs and extract each one immediately on the remote.
const PUSH_SPLIT_THRESHOLD_BYTES = 1536 * 1024 * 1024;
const PUSH_SPLIT_PART_TARGET_BYTES = 512 * 1024 * 1024;
const TRANSFER_STATE_TTL_MS = 24 * 60 * 60 * 1000;
// Files/folders excluded from push (cache, logs, temp, etc.)
const PUSH_IGNORE_PATTERNS = [
  'node_modules/**',
  '.git/**',
  '.gitignore',
  'wp-config.php',
  '**/wp-config.php',
  'database.sql',
  '**/database.sql',
  'wpdock-db-bridge-*.php',
  'wpdock-db-*.sql',
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

// Exclude patterns for the native bsdtar packer. bsdtar's `*` matches across `/`,
// so a single `*/x/*` covers any depth. Mirrors PUSH_IGNORE_PATTERNS. The remote
// agent additionally refuses to overwrite wpdock-agent, but we still exclude it
// here to save bandwidth.
const PUSH_TAR_EXCLUDES = [
  '*/.*',                              // nested dotfiles/dirs (matches archiver dot:false)
  '*/node_modules/*', 'node_modules/*',
  '*/.git/*', '.git/*', '*/.git', '.git',
  '*/.gitignore', '.gitignore',
  'wp-config.php', '*/wp-config.php',
  'database.sql', '*/database.sql',
  'wpdock-db-bridge-*.php',
  'wpdock-db-*.sql',
  '*.DS_Store', 'Thumbs.db', 'thumbs.db',
  'wp-content/cache/*', 'wp-content/cache',
  'wp-content/upgrade/*',
  'wp-content/backup/*',
  'wp-content/debug.log',
  'wp-content/plugins/wpdock-agent/*', 'wp-content/plugins/wpdock-agent',
  'wp-content/plugins/wpdock-agent.php',
  '*.swp', '*.swo',
  '.env.local', '*/.env.local',
];

// Extra aggressive excludes for dev mode (mirror PUSH_AGGRESSIVE_DEV_FILTERS).
const PUSH_TAR_EXCLUDES_DEV = [
  ...PUSH_TAR_EXCLUDES,
  'wp-content/uploads/*', 'wp-content/uploads',
  '*/vendor/*',
  '*/dist/*', '*/build/*',
  '*/.turbo/*', '*/.next/*', '*/.nuxt/*',
];

// Top-level entries inside the WP root that are never packed (handled as members,
// not glob excludes, so bsdtar never even descends into them).
const PUSH_TAR_TOPLEVEL_SKIP = new Set([
  'wp-config.php', 'database.sql', '.gitignore', '.git',
  'node_modules', '.vscode', '.idea', '.DS_Store', 'Thumbs.db', 'thumbs.db',
]);

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

interface PushArchiveEntry {
  abs: string;
  rel: string;
  size: number;
  mtimeMs: number;
}

interface PushArchivePart {
  entries: PushArchiveEntry[];
  estimatedBytes: number;
}

interface PushArchivePlan {
  entries: PushArchiveEntry[];
  parts: PushArchivePart[];
  totalBytes: number;
}

interface FileManifestEntry {
  rel: string;
  size: number;
  mtimeMs: number;
}

interface HostingSyncState {
  version: 1;
  remoteId: string;
  updatedAt: string;
  local: Record<string, FileManifestEntry>;
  remote: Record<string, FileManifestEntry>;
}

interface PullPackStreamState {
  nextSeq: number;
  processed: number;
  done?: boolean;
}

interface PullPackTransferState {
  key: string;
  jobId: string;
  total: number;
  shards: number;
  agentVersion: string;
  streams: Record<string, PullPackStreamState>;
  completed?: boolean;
  parts?: number;
  bytes?: number;
}

interface PushFilesTransferState {
  planKey: string;
  mode: 'single' | 'split' | 'ftp';
  completed?: boolean;
  completedParts?: number[];
  completedFiles?: Record<string, FileManifestEntry>;
}

interface RemoteTransferState {
  version: 1;
  remoteId: string;
  updatedAt: string;
  pullPack?: PullPackTransferState;
  pushFiles?: PushFilesTransferState;
  ftpPull?: PushFilesTransferState;
}

type FileTransferMode = 'agent' | 'ftp';

interface FtpDbBridgeSession {
  id: string;
  secret: string;
  bridgeName: string;
  sqlName: string;
  bridgeUrl: string;
  remoteBridgePath: string;
  remoteSqlPath: string;
}

export class RemoteService {
  private readonly onDidChangeRemotesEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeRemotes = this.onDidChangeRemotesEmitter.event;
  private adaptiveUploadConcurrencyLimit: number | undefined;

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

  private resetAdaptiveUploadTuning(): void {
    this.adaptiveUploadConcurrencyLimit = undefined;
  }

  private getEffectiveUploadConcurrency(): number {
    const configured = this.normalizeConcurrency(CHUNK_UPLOAD_CONCURRENCY);
    const adaptiveLimit = this.adaptiveUploadConcurrencyLimit;
    if (!Number.isFinite(adaptiveLimit)) {
      return configured;
    }
    return Math.min(configured, this.normalizeConcurrency(adaptiveLimit));
  }

  private reduceAdaptiveUploadConcurrency(reason: string): void {
    const current = this.getEffectiveUploadConcurrency();
    if (current <= MIN_ADAPTIVE_UPLOAD_CONCURRENCY) {return;}

    const next = Math.max(MIN_ADAPTIVE_UPLOAD_CONCURRENCY, Math.ceil(current / 2));
    if (next >= current) {return;}

    this.adaptiveUploadConcurrencyLimit = next;
    Logger.log(
      `[RemoteService] adaptive upload throttling concurrency ${current} -> ${next} reason=${reason}`
    );
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
      fileTransferMode?: FileTransferMode;
      ftp?: RemoteFtpConfig & { password?: string };
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
    const ftp = this.normalizeFtpConfig(options.ftp);
    const fileTransferMode: FileTransferMode = options.fileTransferMode === 'ftp' ? 'ftp' : 'agent';
    const adminUrl = `${normalizedUrl}/wp-admin`;

    if (!normalizedAppPassword && fileTransferMode !== 'ftp') {
      throw new Error('Для подключения через агент нужен WordPress Application Password. Для FTP укажите FTP-настройки и выберите FTP как способ передачи файлов.');
    }
    if (fileTransferMode === 'ftp') {
      if (!ftp) { throw new Error('Укажите FTP host, логин и корневую папку WordPress.'); }
      if (!options.ftp?.password) { throw new Error('Укажите FTP пароль.'); }
      await this.verifyFtpConnection(ftp, options.ftp.password);
    }

    // Verify WP credentials only when provided. FTP remotes can sync files without
    // the agent; DB sync uses a temporary one-shot PHP bridge uploaded via FTP.
    if (normalizedAppPassword) {
      await this.verifyCredentials(normalizedUrl, options.username, normalizedAppPassword);
    }

    const remote: RemoteSite = {
      id: uuidv4(),
      name: options.name,
      url: normalizedUrl,
      adminUrl,
      username: options.username,
      appPassword: '', // don't store in plain JSON
      fileTransferMode,
      ftp,
      agentInstalled: false,
      autoInstallAgent: normalizedAppPassword ? (options.autoInstallAgent ?? true) : false,
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
    if (normalizedAppPassword) {
      await this.storage.saveSecret(`remote-${remote.id}-pass`, normalizedAppPassword);
    }
    if (fileTransferMode === 'ftp' && options.ftp?.password) {
      await this.storage.saveSecret(`remote-${remote.id}-ftp-pass`, options.ftp.password);
    }
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
      fileTransferMode?: FileTransferMode;
      ftp?: (RemoteFtpConfig & { password?: string }) | null;
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
    const nextFileTransferMode: FileTransferMode = updates.fileTransferMode === 'ftp'
      ? 'ftp'
      : updates.fileTransferMode === 'agent'
        ? 'agent'
        : (remote.fileTransferMode === 'ftp' ? 'ftp' : 'agent');
    const nextFtp = updates.ftp !== undefined
      ? this.normalizeFtpConfig(updates.ftp ?? undefined)
      : remote.ftp;

    if (!nextName) {throw new Error('Название удаленного сайта не может быть пустым');}
    if (!nextUsername && nextFileTransferMode !== 'ftp') {throw new Error('Логин WordPress не может быть пустым');}

    const currentPassword = await this.storage.getSecret(`remote-${remoteId}-pass`);
    const resolvedPassword = nextAppPassword || this.normalizeAppPassword(currentPassword || '');
    if (!resolvedPassword && nextFileTransferMode !== 'ftp') {
      throw new Error('Application Password не найден. Укажите его заново или выберите FTP для передачи файлов.');
    }

    if (nextFileTransferMode === 'ftp') {
      if (!nextFtp) { throw new Error('Укажите FTP host, логин и корневую папку WordPress.'); }
      const nextFtpPassword = String(updates.ftp?.password ?? '');
      const storedFtpPassword = await this.storage.getSecret(`remote-${remoteId}-ftp-pass`);
      const resolvedFtpPassword = nextFtpPassword || storedFtpPassword || '';
      if (!resolvedFtpPassword) { throw new Error('FTP пароль не найден. Укажите его заново.'); }
      const ftpChanged = JSON.stringify(nextFtp) !== JSON.stringify(remote.ftp ?? undefined) || nextFtpPassword.length > 0;
      if (ftpChanged) {
        await this.verifyFtpConnection(nextFtp, resolvedFtpPassword);
      }
      if (nextFtpPassword.length > 0) {
        await this.storage.saveSecret(`remote-${remoteId}-ftp-pass`, nextFtpPassword);
      }
    }

    const credentialsChanged = (
      nextUrl !== remote.url ||
      nextUsername !== remote.username ||
      nextAppPassword.length > 0
    );

    if (credentialsChanged && resolvedPassword) {
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
      fileTransferMode: nextFileTransferMode,
      ftp: nextFileTransferMode === 'ftp' ? nextFtp : remote.ftp,
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
    await this.storage.deleteSecret(`remote-${id}-ftp-pass`);
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

  async cleanupRemoteUploadResidue(
    remoteId: string,
    onProgress?: (msg: string) => void
  ): Promise<any> {
    const { remote, appPassword } = await this.getRemoteWithPass(remoteId);
    Logger.log(`[RemoteService] cleanupRemoteUploadResidue start remote=${remote.name} id=${remote.id}`);

    onProgress?.('Проверка агента перед очисткой...');
    await this.ensureAgent(remote, appPassword);

    onProgress?.('Очистка незавершённых Push-загрузок на сервере...');
    const result = await this.agentRequest(remote.url, appPassword, 'cleanup_uploads', {}, AGENT_HEAVY_OP_TIMEOUT_MS);
    Logger.log(`[RemoteService] cleanupRemoteUploadResidue success remote=${remote.name} id=${remote.id} result=${JSON.stringify(result ?? {})}`);
    return result;
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
        this.clearTransferState(localPath, remote.id);
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

  private async canResumePackJob(
    remote: RemoteSite,
    appPassword: string,
    state: PullPackTransferState
  ): Promise<boolean> {
    if (!state.jobId || state.completed) { return !!state.completed; }
    try {
      const params: any = { job_id: state.jobId };
      if (state.shards >= 2) { params.shard = 0; }
      await this.agentRequest(remote.url, appPassword, 'pack_status', params, AGENT_REQUEST_TIMEOUT_MS);
      return true;
    } catch (err) {
      Logger.log(`[RemoteService] pack resume state validation failed job=${state.jobId}: ${this.formatShortError(err)}`);
      return false;
    }
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
    const resumable = !!agentVersion && this.compareSemver(agentVersion, '1.3.7') >= 0;
    const packKey = this.makePullPackKey(remote, exclude);
    const transferState = this.readTransferState(localPath, remote.id) ?? this.baseTransferState(remote.id);
    let pullPack = resumable && transferState.pullPack?.key === packKey
      ? transferState.pullPack
      : undefined;
    if (pullPack && (!pullPack.streams || typeof pullPack.streams !== 'object')) {
      pullPack.streams = {};
    }

    if (pullPack?.completed) {
      Logger.log(`[RemoteService] pullSite pack_files RESUME already completed job=${pullPack.jobId} parts=${pullPack.parts ?? 0} bytes=${this.formatBytes(pullPack.bytes ?? 0)}`);
      onProgress('packaging', 'Файлы уже перенесены, продолжаю Pull...', 60);
      return { streamed: true, parts: pullPack.parts ?? 0, bytes: pullPack.bytes ?? 0, total: pullPack.total };
    }

    if (pullPack) {
      const stillUsable = await this.canResumePackJob(remote, appPassword, pullPack);
      if (!stillUsable) {
        Logger.log(`[RemoteService] pullSite pack_files resume state is stale; starting fresh job=${pullPack.jobId}`);
        transferState.pullPack = undefined;
        this.writeTransferState(localPath, remote.id, transferState);
        pullPack = undefined;
      }
    }

    let packResult: any;
    if (!pullPack) {
      packResult = await this.agentRequest(remote.url, appPassword, 'pack_files', {
        exclude,
      }, AGENT_HEAVY_OP_TIMEOUT_MS);
    } else {
      packResult = {
        job_id: pullPack.jobId,
        total: pullPack.total,
        shards: pullPack.shards,
        resumed: true,
      };
    }

    const packJobId = packResult?.job_id ? String(packResult.job_id) : '';
    if (!packJobId) {
      // Non-incremental agent: it packed everything in one shot.
      if (!packResult?.file_token) {
        throw new Error('Агент не вернул file_token после упаковки файлов.');
      }
      return packResult;
    }

    const packTotal = Number(packResult?.total || 0);
    if (resumable && !pullPack) {
      pullPack = {
        key: packKey,
        jobId: packJobId,
        total: packTotal,
        shards: Number(packResult?.shards || 0) || 1,
        agentVersion: agentVersion || '',
        streams: {},
      };
      transferState.pullPack = pullPack;
      this.writeTransferState(localPath, remote.id, transferState);
    }

    const persistPullPack = () => {
      if (!pullPack) { return; }
      transferState.pullPack = pullPack;
      this.writeTransferState(localPath, remote.id, transferState);
    };

    // Parallel shards (agent ≥1.3.5): the server split the manifest into K
    // disjoint slices, each with its own cursor. Pack+download them concurrently
    // to beat per-connection throttling on shared hosts.
    const packShards = Number(packResult?.shards || 0);
    if (packShards >= 2) {
      const result = await this.runPackJobSharded(
        remote, appPassword, localPath, onProgress, packJobId, packTotal, packShards, agentVersion, pullPack, persistPullPack,
      );
      if (pullPack) {
        pullPack.completed = true;
        pullPack.parts = Object.values(pullPack.streams).reduce((sum, stream) => sum + Math.max(0, Number(stream.nextSeq || 0)), 0);
        pullPack.bytes = Number(result?.bytes || 0);
        persistPullPack();
      }
      return result;
    }

    // Resumable single stream (agent ≥1.3.7): recover a stalled CONTINUE in place
    // (drain missed parts by seq + resume) instead of restarting the whole pack.
    if (resumable) {
      Logger.log(`[RemoteService] pullSite pack_files START(resumable) job=${packJobId} total=${packTotal} agent=${agentVersion || '?'}`);
      const r = await this.runPackStreamResumable(
        remote, appPassword, localPath, packJobId, -1,
        (processed) => {
          const ratio = packTotal > 0 ? Math.min(1, processed / packTotal) : 0;
          onProgress('packaging', `Перенос файлов с сервера... ${processed}/${packTotal}`, Math.round(ratio * 60));
        },
        () => false,
        pullPack,
        persistPullPack,
      );
      Logger.log(`[RemoteService] pullSite pack_files(resumable) complete parts=${r.parts} size=${this.formatBytes(r.bytes)} total=${packTotal}`);
      if (pullPack) {
        pullPack.completed = true;
        pullPack.parts = Object.values(pullPack.streams).reduce((sum, stream) => sum + Math.max(0, Number(stream.nextSeq || 0)), 0) || r.parts;
        pullPack.bytes = r.bytes;
        persistPullPack();
      }
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
    pullPack?: PullPackTransferState,
    persistPullPack: () => void = () => {},
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
            pullPack,
            persistPullPack,
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
    pullPack?: PullPackTransferState,
    persistPullPack: () => void = () => {},
  ): Promise<{ parts: number; bytes: number }> {
    const { unzipBuffer } = await import('../utils/zipUtils');
    const tag = `job=${jobId}${shard >= 0 ? ` shard=${shard}` : ''}`;
    const streamKey = shard >= 0 ? `s${shard}` : 'main';
    const savedStream = pullPack?.streams?.[streamKey];
    if (savedStream?.done) {
      Logger.log(`[RemoteService] pack resume ${tag} stream already done nextSeq=${savedStream.nextSeq} processed=${savedStream.processed}`);
      onStreamProgress(Number(savedStream.processed || 0));
      return { parts: 0, bytes: 0 };
    }
    let nextSeq = Math.max(0, Number(savedStream?.nextSeq || 0));
    let partsExtracted = 0;
    let bytesExtracted = 0;
    let processedInSlice = Math.max(0, Number(savedStream?.processed || 0));
    let done = false;
    let polls = 0;

    if (nextSeq > 0 || processedInSlice > 0) {
      Logger.log(`[RemoteService] pack resume ${tag} client state nextSeq=${nextSeq} processed=${processedInSlice}`);
      onStreamProgress(processedInSlice);
    }

    const persistStream = (doneFlag = false) => {
      if (!pullPack) { return; }
      pullPack.streams[streamKey] = {
        nextSeq,
        processed: processedInSlice,
        done: doneFlag || done,
      };
      persistPullPack();
    };

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
          await this.drainParts(
            remote, appPassword, localPath, jobId, shard, nextSeq, serverParts, unzipBuffer, knownSeq, knownSize,
            async (newNextSeq, partBytes) => {
              nextSeq = newNextSeq;
              partsExtracted++;
              bytesExtracted += partBytes;
              persistStream(false);
            },
          );
        }
        onStreamProgress(processedInSlice);
      } catch (err) {
        // A hard agent error (not a transient stall) is not resumable in place —
        // surface it; a "job gone" message routes to packRemoteFiles' fresh-job
        // restart as a last resort, anything else fails fast.
        if (!this.isTransientPullError(err)) {
          throw this.asRecoverablePackError(err, `resumable ${tag}`);
        }
        const rec = await this.recoverPackStream(
          remote, appPassword, localPath, jobId, shard, nextSeq, unzipBuffer,
          async (newNextSeq, partBytes) => {
            nextSeq = newNextSeq;
            partsExtracted++;
            bytesExtracted += partBytes;
            persistStream(false);
          },
        );
        nextSeq = rec.nextSeq;
        done = rec.done; processedInSlice = rec.processed;
        onStreamProgress(processedInSlice);
        Logger.log(`[RemoteService] pack resume ${tag} drained=${rec.count} nextSeq=${nextSeq} done=${done} processed=${processedInSlice}`);
      }
      if (polls > 0 && polls % 25 === 0) {
        Logger.log(`[RemoteService] pack(resumable) ${tag} processed=${processedInSlice} parts=${partsExtracted} polls=${polls}`);
      }
    }
    persistStream(true);
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
    onPartExtracted?: (nextSeq: number, partBytes: number) => Promise<void>,
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
    const d = await this.drainParts(remote, appPassword, localPath, jobId, shard, nextSeq, serverParts, unzipBuffer, -1, 0, onPartExtracted);
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
    onPartExtracted?: (nextSeq: number, partBytes: number) => Promise<void>,
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
      await onPartExtracted?.(seq + 1, buf.length);
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
    skipUploads: boolean = false,
    /** Transfer only files changed since the last successful hosting sync. */
    incremental: boolean = false
  ): Promise<void> {
    const { remote, appPassword } = await this.getRemoteWithOptionalPass(remoteId);
    if (incremental) {
      await this.pullChangedFiles(remote, localPath, skipUploads, onProgress, appPassword);
      if (includeDb) {
        if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
          const ftpPassword = await this.getRemoteFtpPassword(remote.id);
          await this.exportDatabaseViaFtpBridge(remote, ftpPassword, dbOutPath ?? localPath, onProgress);
        } else {
          if (!appPassword) {
            throw new Error('Для incremental Pull базы через агент нужен WordPress Application Password.');
          }
          onProgress('db', 'Экспорт базы данных...', 92);
          const dbResult = await this.agentRequest(remote.url, appPassword, 'export_db', {}, AGENT_HEAVY_OP_TIMEOUT_MS);
          const sqlBuffer = await this.downloadFromAgent(remote.url, appPassword, dbResult.file_token);
          this.assertValidSqlDump(sqlBuffer);
          const dbDir = dbOutPath ?? localPath;
          fs.writeFileSync(path.join(dbDir, 'database.sql'), sqlBuffer);
          if (dbResult?.db_stats) {
            fs.writeFileSync(path.join(dbDir, 'database.meta.json'), JSON.stringify(dbResult.db_stats, null, 2), 'utf-8');
          }
        }
      }
      onProgress('done', 'Incremental Pull завершен!', 100);
      this.clearTransferState(localPath, remote.id);
      return;
    }
    if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
      await this.pullSiteViaFtp(remote, localPath, includeDb, onProgress, dbOutPath, skipUploads);
      return;
    }
    if (!appPassword) {
      throw new Error('Для Pull через агент нужен WordPress Application Password. Укажите его в настройках remote или выберите FTP.');
    }

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
      const mediaResult = await this.pullUploadsDirect(remote, appPassword, localPath, onProgress, 60, 30, agentVersion);
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
    await this.saveSyncStateFromRemote(remote, localPath, false, skipUploads, appPassword);
    this.clearTransferState(localPath, remote.id);
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
    preserveCredentials = true,
    /** Transfer only files changed since the last successful hosting sync. */
    incremental: boolean = false
  ): Promise<void> {
    this.resetAdaptiveUploadTuning();

    if (incremental) {
      const { remote, appPassword } = await this.getRemoteWithOptionalPass(remoteId);
      await this.pushChangedFiles(remote, localPath, devMode, onProgress, appPassword);
      if (includeDb) {
        const sqlFile = dbFilePath ?? path.join(localPath, 'database.sql');
        if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
          const ftpPassword = await this.getRemoteFtpPassword(remote.id);
          await this.importDatabaseViaFtpBridge(remote, ftpPassword, sqlFile, preserveCredentials, onProgress);
        } else {
          if (!appPassword) {
            throw new Error('Для incremental Push базы через агент нужен WordPress Application Password.');
          }
          if (fs.existsSync(sqlFile)) {
            onProgress('db', 'Загрузка базы данных...', 80);
            const dbToken = await this.uploadToAgent(remote.url, appPassword, sqlFile);
            onProgress('db', 'Импорт базы данных на сервере...', 92);
            await this.agentRequest(remote.url, appPassword, 'import_db', {
              file_token: dbToken,
              target_url: remote.url,
              preserve_credentials: preserveCredentials,
            }, AGENT_HEAVY_OP_TIMEOUT_MS);
          }
        }
      }
      onProgress('done', 'Incremental Push завершен!', 100);
      this.clearTransferState(localPath, remote.id);
      return;
    }

    const remoteForMode = this.getRemote(remoteId);
    if ((remoteForMode?.fileTransferMode ?? 'agent') === 'ftp') {
      const { remote } = await this.getRemoteWithOptionalPass(remoteId);
      await this.pushSiteViaFtp(remote, localPath, includeDb, devMode, onProgress, dbFilePath, preserveCredentials);
      return;
    }

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

    // Packaging emits no intrinsic progress, so without a heartbeat the UI sits
    // frozen at 10% for the whole archive build. Tick live elapsed time + packed
    // object count (fed by the packer) so the user always sees activity.
    let packedCount = 0;
    const packHeartbeat = setInterval(() => {
      // onProgress may throw on cancellation; swallow it inside the timer (the
      // main flow re-checks cancellation right after packaging).
      try {
        const secs = Math.round((Date.now() - packStart) / 1000);
        const pct = Math.min(28, 11 + secs);
        const countPart = packedCount > 0 ? ` — ${packedCount} объектов` : '';
        onProgress('packaging', `Подготовка локальных файлов… ${secs} c${countPart}`, pct);
      } catch { /* ignore — cancellation handled by the awaited path */ }
    }, 800);

    try {
      const splitPlan = await this.createPushArchivePlan(localPath, devMode);
      const useSplitPush = splitPlan.totalBytes > PUSH_SPLIT_THRESHOLD_BYTES && splitPlan.parts.length > 1;
      const pushPlanKey = this.makePushPlanKey(splitPlan, devMode);
      const expectedPushMode: PushFilesTransferState['mode'] = useSplitPush ? 'split' : 'single';
      let transferState = this.readTransferState(localPath, remote.id) ?? this.baseTransferState(remote.id);
      const pushFilesState = transferState.pushFiles?.planKey === pushPlanKey && transferState.pushFiles.mode === expectedPushMode
        ? transferState.pushFiles
        : undefined;

      if (transferState.pushFiles && !pushFilesState) {
        transferState.pushFiles = undefined;
        this.writeTransferState(localPath, remote.id, transferState);
      }

      // Resume-состояние "файлы уже перенесены" нельзя брать на веру: сервер могли
      // очистить/переустановить после прошлого Push. Сверяем план с реальным manifest.
      let filesAlreadyApplied = false;
      let prefetchedRemoteMap: Record<string, FileManifestEntry> | undefined;
      if (pushFilesState?.completed) {
        clearInterval(packHeartbeat);
        onProgress('verifying', 'Проверка ранее перенесённых файлов на сервере...', 65);
        try {
          prefetchedRemoteMap = await this.fetchAgentManifestMap(remote.url, appPassword, devMode);
          const missing = this.findMissingOnRemote(splitPlan.entries, prefetchedRemoteMap);
          filesAlreadyApplied = missing.length === 0;
          if (!filesAlreadyApplied) {
            Logger.log(
              `[RemoteService] pushSite RESUME state stale: на сервере нет ${missing.length} файлов ` +
              `sample=${missing.slice(0, 5).join(', ')} — загружаю заново`
            );
            onProgress('verifying', `На сервере не хватает ${missing.length} файлов — загружаю заново...`, 66);
          }
        } catch (err) {
          Logger.log(`[RemoteService] pushSite RESUME verify failed (${this.formatShortError(err)}) — загружаю заново`);
        }
        if (!filesAlreadyApplied) {
          if (pushFilesState.mode === 'split') {
            // Оставляем completedParts: pushSplitArchives проверит каждую часть и
            // перезальёт только те, чьих файлов реально нет на сервере.
            pushFilesState.completed = false;
          } else {
            transferState.pushFiles = undefined;
          }
          this.writeTransferState(localPath, remote.id, transferState);
        }
      }

      if (filesAlreadyApplied) {
        Logger.log(`[RemoteService] pushSite RESUME files already applied (verified on remote) plan=${pushPlanKey}`);
        onProgress('extracting', 'Файлы уже перенесены (проверено на сервере), продолжаю Push...', 70);
        markTime('filesAlreadyApplied');
      } else if (useSplitPush) {
        clearInterval(packHeartbeat);
        const filesStart = Date.now();
        const splitResult = await this.pushSplitArchives(
          remote.id,
          remote.url,
          appPassword,
          localPath,
          splitPlan,
          pushPlanKey,
          archiver,
          devMode,
          onProgress,
          prefetchedRemoteMap
        );
        markTime('pushSplitArchives');
        Logger.log(
          `[PUSH-STATS] split files push complete archives=${splitResult.archiveCount} ` +
          `uploaded=${this.formatBytes(splitResult.archiveBytes)} elapsed=${Date.now() - filesStart}ms`
        );
      } else {
        await this.createZip(localPath, zipPath, archiver, devMode, true, (n) => { packedCount = n; });
        clearInterval(packHeartbeat);

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
        transferState = this.readTransferState(localPath, remote.id) ?? this.baseTransferState(remote.id);
        transferState.pushFiles = { planKey: pushPlanKey, mode: 'single', completed: true };
        this.writeTransferState(localPath, remote.id, transferState);
      }

      // Контрольная сверка: не верим "успеху" распаковки на слово — проверяем,
      // что все файлы плана реально существуют на сервере.
      if (!filesAlreadyApplied) {
        onProgress('verifying', 'Проверка загруженных файлов на сервере...', 77);
        let verifyMap: Record<string, FileManifestEntry> | undefined;
        try {
          verifyMap = await this.fetchAgentManifestMap(remote.url, appPassword, devMode);
        } catch (err) {
          Logger.log(`[PUSH-VERIFY] manifest недоступен, проверка пропущена: ${this.formatShortError(err)}`);
          onProgress('verifying', 'Проверка файлов недоступна (агент не поддерживает manifest) — пропускаю', 78);
        }
        if (verifyMap) {
          const missing = this.findMissingOnRemote(splitPlan.entries, verifyMap);
          markTime('verifyFiles');
          if (missing.length > 0) {
            const uploadsMissing = missing.filter((rel) => rel.toLowerCase().startsWith('wp-content/uploads/')).length;
            Logger.log(`[PUSH-VERIFY] FAILED missing=${missing.length} uploads=${uploadsMissing} sample=${missing.slice(0, 20).join(', ')}`);
            throw new Error(
              `Push не подтверждён: после загрузки на сервере отсутствует ${missing.length} файлов` +
              (uploadsMissing > 0 ? ` (из них в uploads: ${uploadsMissing})` : '') +
              `. Примеры: ${missing.slice(0, 5).join(', ')}. Повторите Push — недостающие части будут догружены.`
            );
          }
          Logger.log(`[PUSH-VERIFY] OK files=${splitPlan.entries.length}`);
          onProgress('verifying', `Проверено: все ${splitPlan.entries.length} файлов на сервере`, 78);
        }
      }

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
      await this.saveSyncStateFromRemote(remote, localPath, devMode, false, appPassword);
      this.clearTransferState(localPath, remote.id);
      onProgress('done', 'Push завершен!', 100);
    } finally {
      clearInterval(packHeartbeat);
      if (fs.existsSync(zipPath)) {
        try {
          fs.unlinkSync(zipPath);
        } catch {
          // ignore temp cleanup failures
        }
      }
    }
  }

  // ── FTP + incremental hosting sync ───────────────────────────────────────

  private async pullSiteViaFtp(
    remote: RemoteSite,
    localPath: string,
    includeDb: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    dbOutPath: string | undefined,
    skipUploads: boolean
  ): Promise<void> {
    if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
    const ftpPassword = await this.getRemoteFtpPassword(remote.id);
    onProgress('connecting', 'Подключение по FTP...', 5);
    let remoteManifest: FileManifestEntry[] = [];

    await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
      remoteManifest = await this.listFtpManifest(client, remote.ftp!, false, skipUploads);
      const planKey = this.makeManifestPlanKey(remoteManifest, { mode: 'ftp-pull', skipUploads });
      const transferState = this.readTransferState(localPath, remote.id) ?? this.baseTransferState(remote.id);
      let pullState = transferState.ftpPull?.planKey === planKey && transferState.ftpPull.mode === 'ftp'
        ? transferState.ftpPull
        : undefined;
      if (!pullState) {
        pullState = { planKey, mode: 'ftp', completedFiles: {} };
        transferState.ftpPull = pullState;
        this.writeTransferState(localPath, remote.id, transferState);
      }
      const totalBytes = remoteManifest.reduce((sum, item) => sum + item.size, 0);
      let doneBytes = 0;
      let doneCount = 0;
      onProgress('downloading', `FTP Pull: найдено ${remoteManifest.length} файлов`, 10);
      for (const entry of remoteManifest) {
        const localFile = this.resolveLocalRel(localPath, entry.rel);
        const completed = pullState.completedFiles?.[entry.rel];
        const localEntry = this.localFileManifestEntry(localFile, entry.rel);
        if (completed && this.sameFileSig(completed, entry, false) && this.sameFileSig(localEntry, entry, false)) {
          Logger.log(`[RemoteService] FTP Pull resume skip completed rel=${entry.rel}`);
        } else {
          fs.mkdirSync(path.dirname(localFile), { recursive: true });
          await this.downloadFtpFileResumable(client, this.ftpJoin(remote.ftp!.rootPath, entry.rel), localFile, entry, localPath, remote.id);
          pullState.completedFiles = pullState.completedFiles ?? {};
          pullState.completedFiles[entry.rel] = entry;
          transferState.ftpPull = pullState;
          this.writeTransferState(localPath, remote.id, transferState);
        }
        doneBytes += entry.size;
        doneCount++;
        const pct = 10 + Math.round((doneBytes / Math.max(1, totalBytes)) * 75);
        onProgress('downloading', `FTP Pull: ${doneCount}/${remoteManifest.length} файлов (${this.formatBytes(doneBytes)})`, pct);
      }
    });

    if (includeDb) {
      await this.exportDatabaseViaFtpBridge(remote, ftpPassword, dbOutPath ?? localPath, onProgress);
    }

    await this.saveSyncStateFromManifests(remote.id, localPath, remoteManifest);
    this.clearTransferState(localPath, remote.id);
    onProgress('done', 'FTP Pull завершен!', 100);
  }

  private async pushSiteViaFtp(
    remote: RemoteSite,
    localPath: string,
    includeDb: boolean,
    devMode: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    dbFilePath: string | undefined,
    preserveCredentials: boolean
  ): Promise<void> {
    if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
    const ftpPassword = await this.getRemoteFtpPassword(remote.id);
    const localManifest = await this.listLocalManifest(localPath, devMode, false);
    const planKey = this.makeManifestPlanKey(localManifest, { mode: 'ftp-push', devMode });
    onProgress('connecting', 'Подключение по FTP...', 5);

    await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
      await client.ensureDir(remote.ftp!.rootPath || '/');
      const transferState = this.readTransferState(localPath, remote.id) ?? this.baseTransferState(remote.id);
      let pushState = transferState.pushFiles?.planKey === planKey && transferState.pushFiles.mode === 'ftp'
        ? transferState.pushFiles
        : undefined;
      if (!pushState) {
        pushState = { planKey, mode: 'ftp', completedFiles: {} };
        transferState.pushFiles = pushState;
        this.writeTransferState(localPath, remote.id, transferState);
      }
      const totalBytes = localManifest.reduce((sum, item) => sum + item.size, 0);
      let doneBytes = 0;
      let doneCount = 0;
      onProgress('uploading', `FTP Push: загрузка ${localManifest.length} файлов`, 10);
      for (const entry of localManifest) {
        const localFile = this.resolveLocalRel(localPath, entry.rel);
        const remoteFile = this.ftpJoin(remote.ftp!.rootPath, entry.rel);
        const completed = pushState.completedFiles?.[entry.rel];
        const remoteSize = await this.getFtpFileSize(client, remoteFile);
        if (completed && this.sameFileSig(completed, entry, false) && remoteSize === entry.size) {
          Logger.log(`[RemoteService] FTP Push resume skip completed rel=${entry.rel}`);
        } else {
          await client.ensureDir(path.posix.dirname(remoteFile));
          await this.uploadFtpFileResumable(client, localFile, remoteFile, entry.size);
          pushState.completedFiles = pushState.completedFiles ?? {};
          pushState.completedFiles[entry.rel] = entry;
          transferState.pushFiles = pushState;
          this.writeTransferState(localPath, remote.id, transferState);
        }
        doneBytes += entry.size;
        doneCount++;
        const pct = 10 + Math.round((doneBytes / Math.max(1, totalBytes)) * 75);
        onProgress('uploading', `FTP Push: ${doneCount}/${localManifest.length} файлов (${this.formatBytes(doneBytes)})`, pct);
      }
    });

    if (includeDb) {
      await this.importDatabaseViaFtpBridge(remote, ftpPassword, dbFilePath ?? path.join(localPath, 'database.sql'), preserveCredentials, onProgress);
    }

    await this.saveSyncStateFromRemote(remote, localPath, devMode, false);
    this.clearTransferState(localPath, remote.id);
    onProgress('done', 'FTP Push завершен!', 100);
  }

  private async pullChangedFiles(
    remote: RemoteSite,
    localPath: string,
    skipUploads: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    appPassword?: string
  ): Promise<void> {
    onProgress('connecting', 'Проверка изменённых файлов на хостинге...', 5);
    const remoteManifest = await this.getRemoteFileManifest(remote, false, skipUploads, appPassword);
    const remoteMap = this.manifestMap(remoteManifest);
    const localMap = this.manifestMap(await this.listLocalManifest(localPath, false, skipUploads));
    const state = this.readSyncState(localPath, remote.id);
    const baseline = state?.remote ?? {};
    const hasBaseline = Object.keys(baseline).length > 0;

    const changed = remoteManifest.filter((entry) => {
      const local = localMap[entry.rel];
      if (local && this.sameFileSig(entry, local, false)) { return false; }
      const previous = baseline[entry.rel];
      if (hasBaseline) { return !previous || !this.sameFileSig(entry, previous); }
      return !local || !this.sameFileSig(entry, local, false);
    });
    const deleted = hasBaseline
      ? Object.keys(baseline).filter((rel) => !remoteMap[rel] && !!localMap[rel])
      : [];

    const totalBytes = changed.reduce((sum, item) => sum + item.size, 0);
    let doneBytes = 0;
    let doneCount = 0;
    onProgress('downloading', `Incremental Pull: ${changed.length} изменённых, ${deleted.length} удалённых`, 10);

    if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
      if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
      const ftpPassword = await this.getRemoteFtpPassword(remote.id);
      await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
        for (const entry of changed) {
          const localFile = this.resolveLocalRel(localPath, entry.rel);
          fs.mkdirSync(path.dirname(localFile), { recursive: true });
          await this.downloadFtpFileResumable(client, this.ftpJoin(remote.ftp!.rootPath, entry.rel), localFile, entry, localPath, remote.id);
          doneBytes += entry.size;
          doneCount++;
          onProgress('downloading', `Incremental Pull: ${doneCount}/${changed.length} файлов`, 10 + Math.round((doneBytes / Math.max(1, totalBytes)) * 80));
        }
      });
    } else {
      if (!appPassword) { throw new Error('Для incremental Pull через агент нужен WordPress Application Password.'); }
      await this.assertIncrementalAgent(remote, appPassword);
      for (const entry of changed) {
        const buffer = await this.downloadAgentPath(remote, appPassword, entry.rel);
        const localFile = this.resolveLocalRel(localPath, entry.rel);
        fs.mkdirSync(path.dirname(localFile), { recursive: true });
        fs.writeFileSync(localFile, buffer);
        this.setLocalFileMtime(localFile, entry.mtimeMs);
        doneBytes += entry.size;
        doneCount++;
        onProgress('downloading', `Incremental Pull: ${doneCount}/${changed.length} файлов`, 10 + Math.round((doneBytes / Math.max(1, totalBytes)) * 80));
      }
    }

    for (const rel of deleted) {
      const localFile = this.resolveLocalRel(localPath, rel);
      try { if (fs.existsSync(localFile)) { fs.unlinkSync(localFile); } } catch (err) {
        Logger.log(`[RemoteService] incremental pull delete local skipped rel=${rel}: ${this.formatShortError(err)}`);
      }
    }

    await this.writeSyncState(localPath, remote.id, {
      version: 1,
      remoteId: remote.id,
      updatedAt: new Date().toISOString(),
      local: this.manifestMap(await this.listLocalManifest(localPath, false, skipUploads)),
      remote: remoteMap,
    });
    Logger.log(`[RemoteService] incremental Pull done remote=${remote.name} changed=${changed.length} deleted=${deleted.length}`);
  }

  private async pushChangedFiles(
    remote: RemoteSite,
    localPath: string,
    devMode: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    appPassword?: string
  ): Promise<void> {
    onProgress('connecting', 'Проверка локальных изменений...', 5);
    const localManifest = await this.listLocalManifest(localPath, devMode, false);
    const localMap = this.manifestMap(localManifest);
    const state = this.readSyncState(localPath, remote.id);
    const baseline = state?.local ?? {};
    const hasBaseline = Object.keys(baseline).length > 0;
    const remoteManifest = await this.getRemoteFileManifest(remote, devMode, false, appPassword);
    const remoteMap = this.manifestMap(remoteManifest);

    const changed = localManifest.filter((entry) => {
      const remoteEntry = remoteMap[entry.rel];
      // Файла нет на сервере — загружаем всегда, даже если baseline говорит
      // "не менялся": сервер могли очистить после последнего sync.
      if (!remoteEntry) { return true; }
      if (this.sameFileSig(entry, remoteEntry, false)) { return false; }
      const previous = baseline[entry.rel];
      if (hasBaseline) { return !previous || !this.sameFileSig(entry, previous); }
      return true;
    });
    const deleted = hasBaseline
      ? Object.keys(baseline).filter((rel) => !localMap[rel] && !!remoteMap[rel])
      : [];

    onProgress('uploading', `Incremental Push: ${changed.length} изменённых, ${deleted.length} удалённых`, 10);

    if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
      if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
      const ftpPassword = await this.getRemoteFtpPassword(remote.id);
      await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
        const totalBytes = changed.reduce((sum, item) => sum + item.size, 0);
        let doneBytes = 0;
        let doneCount = 0;
        for (const entry of changed) {
          const localFile = this.resolveLocalRel(localPath, entry.rel);
          const remoteFile = this.ftpJoin(remote.ftp!.rootPath, entry.rel);
          await client.ensureDir(path.posix.dirname(remoteFile));
          await this.uploadFtpFileResumable(client, localFile, remoteFile, entry.size);
          doneBytes += entry.size;
          doneCount++;
          onProgress('uploading', `Incremental FTP Push: ${doneCount}/${changed.length} файлов`, 10 + Math.round((doneBytes / Math.max(1, totalBytes)) * 75));
        }
        for (const rel of deleted) {
          await client.remove(this.ftpJoin(remote.ftp!.rootPath, rel), true);
        }
      });
    } else {
      if (!appPassword) { throw new Error('Для incremental Push через агент нужен WordPress Application Password.'); }
      await this.assertIncrementalAgent(remote, appPassword);
      if (changed.length > 0) {
        const archiver = (await import('archiver')).default;
        const zipPath = path.join(os.tmpdir(), `wpdock-incremental-${Date.now()}.zip`);
        try {
          await this.createZipPart(localPath, zipPath, changed.map((entry) => ({
            abs: this.resolveLocalRel(localPath, entry.rel),
            rel: entry.rel,
            size: entry.size,
            mtimeMs: entry.mtimeMs,
          })), archiver, devMode, true);
          const token = await this.uploadToAgent(remote.url, appPassword, zipPath, (uploaded, total) => {
            onProgress('uploading', `Incremental Push: ${this.formatBytes(uploaded)} / ${this.formatBytes(total)}`, 10 + Math.round((uploaded / Math.max(1, total)) * 60));
          });
          onProgress('extracting', 'Применение изменённых файлов на сервере...', 75);
          await this.agentRequest(remote.url, appPassword, 'extract_files', { file_token: token }, AGENT_HEAVY_OP_TIMEOUT_MS);
        } finally {
          try { fs.unlinkSync(zipPath); } catch { /* ignore */ }
        }
      }
      if (deleted.length > 0) {
        onProgress('extracting', `Удаление файлов на сервере: ${deleted.length}`, 85);
        await this.agentRequest(remote.url, appPassword, 'delete_paths', { paths: deleted }, AGENT_HEAVY_OP_TIMEOUT_MS);
      }
    }

    await this.saveSyncStateFromRemote(remote, localPath, devMode, false, appPassword);
    Logger.log(`[RemoteService] incremental Push done remote=${remote.name} changed=${changed.length} deleted=${deleted.length}`);
  }

  private async getRemoteFileManifest(
    remote: RemoteSite,
    devMode: boolean,
    skipUploads: boolean,
    appPassword?: string
  ): Promise<FileManifestEntry[]> {
    if ((remote.fileTransferMode ?? 'agent') === 'ftp') {
      if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
      const ftpPassword = await this.getRemoteFtpPassword(remote.id);
      return this.withFtpClient(remote.ftp, ftpPassword, (client) => this.listFtpManifest(client, remote.ftp!, devMode, skipUploads));
    }
    if (!appPassword) { throw new Error('Для получения manifest через агент нужен WordPress Application Password.'); }
    await this.assertIncrementalAgent(remote, appPassword);
    const res = await this.agentRequest(remote.url, appPassword, 'file_manifest', {
      dev_mode: devMode,
      skip_uploads: skipUploads,
    }, AGENT_HEAVY_OP_TIMEOUT_MS);
    const token = String(res?.file_token || res?.token || '');
    if (!token) { throw new Error('Агент не вернул manifest token.'); }
    const buf = await this.downloadFromAgent(remote.url, appPassword, token);
    return this.parseManifestBuffer(buf);
  }

  private async fetchAgentManifestMap(
    siteUrl: string,
    appPassword: string,
    devMode: boolean
  ): Promise<Record<string, FileManifestEntry>> {
    const res = await this.agentRequest(siteUrl, appPassword, 'file_manifest', {
      dev_mode: devMode,
      skip_uploads: false,
    }, AGENT_HEAVY_OP_TIMEOUT_MS);
    const token = String(res?.file_token || res?.token || '');
    if (!token) { throw new Error('Агент не вернул manifest token.'); }
    const buf = await this.downloadFromAgent(siteUrl, appPassword, token);
    return this.manifestMap(this.parseManifestBuffer(buf));
  }

  private findMissingOnRemote(entries: Array<{ rel: string }>, remoteMap: Record<string, FileManifestEntry>): string[] {
    const missing: string[] = [];
    for (const entry of entries) {
      const rel = entry.rel.replace(/\\/g, '/').replace(/^\/+/, '');
      const lower = rel.toLowerCase();
      // Пути, которые серверный manifest фильтрует у себя, — не считаем пропавшими
      if (lower === 'wp-content/wpdock-temp' || lower.startsWith('wp-content/wpdock-temp/')) { continue; }
      if (rel.includes('\t') || rel.includes('\n')) { continue; }
      if (!remoteMap[rel]) { missing.push(rel); }
    }
    return missing;
  }

  private async assertIncrementalAgent(remote: RemoteSite, appPassword: string): Promise<void> {
    const version = await this.ensureAgent(remote, appPassword);
    if (!version || this.compareSemver(version, INCREMENTAL_AGENT_VERSION) < 0) {
      throw new Error(
        `Для incremental sync через агент нужна версия WPDock Agent ${INCREMENTAL_AGENT_VERSION}+` +
        `${version ? ` (сейчас ${version})` : ''}. Нажмите «Агент → Обновить» и повторите.`
      );
    }
  }

  private async downloadAgentPath(remote: RemoteSite, appPassword: string, rel: string): Promise<Buffer> {
    const query = `action=download_path&path=${encodeURIComponent(rel)}`;
    const { buffer, contentLength } = await this.streamDownload(remote.url, appPassword, query, `download_path rel=${rel}`);
    if (contentLength > 0 && buffer.length !== contentLength) {
      throw new Error(`Файл ${rel} скачан не полностью: ожидалось ${this.formatBytes(contentLength)}, получено ${this.formatBytes(buffer.length)}.`);
    }
    return buffer;
  }

  private async withFtpClient<T>(
    config: RemoteFtpConfig,
    password: string,
    fn: (client: any) => Promise<T>
  ): Promise<T> {
    const { Client } = await import('basic-ftp');
    const client = new Client(60 * 1000);
    client.ftp.verbose = false;
    try {
      await client.access({
        host: config.host,
        port: config.port ?? (config.secure ? 21 : 21),
        user: config.username,
        password,
        secure: config.secure ?? false,
      });
      return await fn(client);
    } finally {
      client.close();
    }
  }

  private async listFtpManifest(
    client: any,
    config: RemoteFtpConfig,
    devMode: boolean,
    skipUploads: boolean
  ): Promise<FileManifestEntry[]> {
    const entries: FileManifestEntry[] = [];
    const root = config.rootPath || '/';
    const walk = async (relDir: string): Promise<void> => {
      const remoteDir = relDir ? this.ftpJoin(root, relDir) : root;
      let items: any[] = [];
      try {
        items = await client.list(remoteDir);
      } catch (err) {
        Logger.log(`[RemoteService] FTP list skipped dir=${remoteDir}: ${this.formatShortError(err)}`);
        return;
      }
      for (const item of items) {
        const name = String(item.name ?? '');
        if (!name || name === '.' || name === '..') { continue; }
        const rel = (relDir ? `${relDir}/${name}` : name).replace(/\\/g, '/');
        const isDir = Boolean(item.isDirectory);
        const isFile = Boolean(item.isFile);
        if (this.shouldSkipHostingPath(rel, isDir, devMode, skipUploads)) { continue; }
        if (isDir) {
          await walk(rel);
        } else if (isFile) {
          entries.push({
            rel,
            size: Number(item.size || 0),
            mtimeMs: item.modifiedAt instanceof Date ? item.modifiedAt.getTime() : 0,
          });
        }
      }
    };
    await walk('');
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    return entries;
  }

  private async listLocalManifest(
    localPath: string,
    devMode: boolean,
    skipUploads: boolean
  ): Promise<FileManifestEntry[]> {
    const entries: FileManifestEntry[] = [];
    const root = path.resolve(localPath);
    const stack = [{ abs: root, rel: '' }];
    const seenDirs = new Set<string>([fs.realpathSync.native?.(root) ?? fs.realpathSync(root)]);

    while (stack.length > 0) {
      const current = stack.pop()!;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(current.abs, { withFileTypes: true });
      } catch (err) {
        Logger.log(`[RemoteService] local manifest skip unreadable dir=${current.abs}: ${this.formatShortError(err)}`);
        continue;
      }

      for (const item of items) {
        const rel = (current.rel ? `${current.rel}/${item.name}` : item.name).replace(/\\/g, '/');
        const isDir = item.isDirectory();
        if (this.shouldSkipHostingPath(rel, isDir, devMode, skipUploads)) { continue; }
        const abs = path.join(current.abs, item.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch {
          continue;
        }
        if (stat.isDirectory()) {
          let real = abs;
          try { real = fs.realpathSync(abs); } catch { /* ignore */ }
          if (seenDirs.has(real)) { continue; }
          seenDirs.add(real);
          stack.push({ abs, rel });
        } else if (stat.isFile()) {
          entries.push({ rel, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
        }
      }
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    return entries;
  }

  private shouldSkipHostingPath(relPath: string, isDir: boolean, devMode: boolean, skipUploads: boolean): boolean {
    const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const lower = rel.toLowerCase();
    if (skipUploads && (lower === 'wp-content/uploads' || lower.startsWith('wp-content/uploads/'))) {
      return true;
    }
    return this.shouldSkipPushArchivePath(rel, isDir, devMode);
  }

  private manifestMap(entries: FileManifestEntry[]): Record<string, FileManifestEntry> {
    const out: Record<string, FileManifestEntry> = {};
    for (const entry of entries) {
      out[entry.rel] = entry;
    }
    return out;
  }

  private sameFileSig(a?: FileManifestEntry, b?: FileManifestEntry, useMtime = true): boolean {
    if (!a || !b) { return false; }
    if (a.size !== b.size) { return false; }
    if (!useMtime) { return true; }
    if (!a.mtimeMs || !b.mtimeMs) { return true; }
    return Math.abs(a.mtimeMs - b.mtimeMs) <= 2500;
  }

  private parseManifestBuffer(buf: Buffer): FileManifestEntry[] {
    const entries: FileManifestEntry[] = [];
    for (const line of buf.toString('utf8').split('\n')) {
      if (!line.trim()) { continue; }
      const parts = line.split('\t');
      if (parts.length < 3) { continue; }
      const rel = parts[0].replace(/\\/g, '/').replace(/^\/+/, '');
      if (!rel || rel.includes('..')) { continue; }
      entries.push({
        rel,
        size: Number(parts[1] || 0),
        mtimeMs: Number(parts[2] || 0) * 1000,
      });
    }
    entries.sort((a, b) => a.rel.localeCompare(b.rel));
    return entries;
  }

  private syncStatePath(localPath: string, remoteId: string): string {
    return path.join(localPath, '.wpdock', `hosting-sync-${remoteId}.json`);
  }

  private readSyncState(localPath: string, remoteId: string): HostingSyncState | undefined {
    const file = this.syncStatePath(localPath, remoteId);
    try {
      if (!fs.existsSync(file)) { return undefined; }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.version !== 1 || raw?.remoteId !== remoteId) { return undefined; }
      return {
        version: 1,
        remoteId,
        updatedAt: String(raw.updatedAt || ''),
        local: raw.local && typeof raw.local === 'object' ? raw.local : {},
        remote: raw.remote && typeof raw.remote === 'object' ? raw.remote : {},
      };
    } catch (err) {
      Logger.log(`[RemoteService] read sync state failed: ${this.formatShortError(err)}`);
      return undefined;
    }
  }

  private async writeSyncState(localPath: string, remoteId: string, state: HostingSyncState): Promise<void> {
    const file = this.syncStatePath(localPath, remoteId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  }

  private transferStatePath(localPath: string, remoteId: string): string {
    return path.join(localPath, '.wpdock', `transfer-state-${remoteId}.json`);
  }

  private readTransferState(localPath: string, remoteId: string): RemoteTransferState | undefined {
    const file = this.transferStatePath(localPath, remoteId);
    try {
      if (!fs.existsSync(file)) { return undefined; }
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (raw?.version !== 1 || raw?.remoteId !== remoteId) { return undefined; }
      const updatedAt = String(raw.updatedAt || '');
      if (!this.isFreshIsoDate(updatedAt, TRANSFER_STATE_TTL_MS)) {
        Logger.log(`[RemoteService] transfer state expired file=${file}`);
        try { fs.unlinkSync(file); } catch { /* ignore */ }
        return undefined;
      }
      return {
        version: 1,
        remoteId,
        updatedAt,
        pullPack: raw.pullPack && typeof raw.pullPack === 'object' ? raw.pullPack : undefined,
        pushFiles: raw.pushFiles && typeof raw.pushFiles === 'object' ? raw.pushFiles : undefined,
        ftpPull: raw.ftpPull && typeof raw.ftpPull === 'object' ? raw.ftpPull : undefined,
      };
    } catch (err) {
      Logger.log(`[RemoteService] read transfer state failed: ${this.formatShortError(err)}`);
      return undefined;
    }
  }

  private writeTransferState(localPath: string, remoteId: string, state: RemoteTransferState): void {
    const file = this.transferStatePath(localPath, remoteId);
    state.updatedAt = new Date().toISOString();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  }

  private clearTransferState(localPath: string, remoteId: string): void {
    try { fs.unlinkSync(this.transferStatePath(localPath, remoteId)); } catch { /* ignore */ }
    try { fs.rmSync(path.join(localPath, '.wpdock', 'transfer-temp', remoteId), { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /** Полный сброс локального состояния sync: resume-отметки Push/Pull и manifest последнего sync. */
  resetSyncState(remoteId: string, localPath: string): { removed: string[] } {
    const removed: string[] = [];
    for (const file of [this.transferStatePath(localPath, remoteId), this.syncStatePath(localPath, remoteId)]) {
      try {
        if (fs.existsSync(file)) {
          fs.unlinkSync(file);
          removed.push(path.basename(file));
        }
      } catch (err) {
        Logger.log(`[RemoteService] resetSyncState unlink failed file=${file}: ${this.formatShortError(err)}`);
      }
    }
    try { fs.rmSync(path.join(localPath, '.wpdock', 'transfer-temp', remoteId), { recursive: true, force: true }); } catch { /* ignore */ }
    Logger.log(`[RemoteService] resetSyncState remoteId=${remoteId} localPath=${localPath} removed=[${removed.join(', ')}]`);
    return { removed };
  }

  private baseTransferState(remoteId: string): RemoteTransferState {
    return { version: 1, remoteId, updatedAt: new Date().toISOString() };
  }

  private isFreshIsoDate(value: string, ttlMs: number): boolean {
    const time = Date.parse(value);
    return Number.isFinite(time) && Date.now() - time <= ttlMs;
  }

  private hashString(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private makePullPackKey(remote: RemoteSite, exclude: string[]): string {
    return this.hashString(JSON.stringify({
      url: this.normalizeBaseUrl(remote.url),
      exclude: [...exclude].sort(),
    }));
  }

  private makePushPlanKey(plan: PushArchivePlan, devMode: boolean): string {
    return this.hashString(JSON.stringify({
      devMode,
      totalBytes: plan.totalBytes,
      entries: plan.entries.map((entry) => ({
        rel: entry.rel,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      })),
    }));
  }

  private makeManifestPlanKey(entries: FileManifestEntry[], options: object = {}): string {
    return this.hashString(JSON.stringify({
      ...options,
      entries: entries.map((entry) => ({
        rel: entry.rel,
        size: entry.size,
        mtimeMs: entry.mtimeMs,
      })),
    }));
  }

  private normalizeBaseUrl(url: string): string {
    return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
  }

  private ftpJoin(root: string, rel: string): string {
    const cleanRoot = this.normalizeFtpRootPath(root || '/');
    const cleanRel = rel.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleanRel) { return cleanRoot; }
    return cleanRoot === '/' ? `/${cleanRel}` : `${cleanRoot}/${cleanRel}`;
  }

  private resolveLocalRel(root: string, rel: string): string {
    const normalizedRoot = path.resolve(root);
    const target = path.resolve(normalizedRoot, rel.replace(/\//g, path.sep));
    if (!this.isPathInside(normalizedRoot, target)) {
      throw new Error(`Небезопасный путь файла: ${rel}`);
    }
    return target;
  }

  private localFileManifestEntry(abs: string, rel: string): FileManifestEntry | undefined {
    try {
      if (!fs.existsSync(abs)) { return undefined; }
      const stat = fs.statSync(abs);
      if (!stat.isFile()) { return undefined; }
      return { rel, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) };
    } catch {
      return undefined;
    }
  }

  private setLocalFileMtime(abs: string, mtimeMs: number): void {
    if (!mtimeMs || !Number.isFinite(mtimeMs)) { return; }
    try {
      const mtime = new Date(mtimeMs);
      fs.utimesSync(abs, mtime, mtime);
    } catch (err) {
      Logger.log(`[RemoteService] set mtime skipped path=${abs}: ${this.formatShortError(err)}`);
    }
  }

  private localTransferTempPath(localRoot: string, remoteId: string, rel: string, kind: string): string {
    const key = this.hashString(`${kind}:${rel}`);
    return path.join(localRoot, '.wpdock', 'transfer-temp', remoteId, kind, `${key}.part`);
  }

  private async getFtpFileSize(client: any, remotePath: string): Promise<number | undefined> {
    try {
      const size = await client.size(remotePath);
      return Number.isFinite(Number(size)) ? Number(size) : undefined;
    } catch {
      return undefined;
    }
  }

  private async downloadFtpFileResumable(
    client: any,
    remoteFile: string,
    localFile: string,
    entry: FileManifestEntry,
    localRoot: string,
    remoteId: string
  ): Promise<void> {
    const tempFile = this.localTransferTempPath(localRoot, remoteId, entry.rel, 'ftp-pull');
    fs.mkdirSync(path.dirname(tempFile), { recursive: true });
    fs.mkdirSync(path.dirname(localFile), { recursive: true });

    let startAt = fs.existsSync(tempFile) ? fs.statSync(tempFile).size : 0;
    if (startAt > entry.size) {
      fs.rmSync(tempFile, { force: true });
      startAt = 0;
    }

    if (startAt < entry.size) {
      Logger.log(`[RemoteService] FTP download ${startAt > 0 ? 'resume' : 'start'} rel=${entry.rel} from=${this.formatBytes(startAt)}/${this.formatBytes(entry.size)}`);
      await client.downloadTo(tempFile, remoteFile, startAt);
    } else if (!fs.existsSync(tempFile)) {
      fs.closeSync(fs.openSync(tempFile, 'w'));
    }

    const finalSize = fs.existsSync(tempFile) ? fs.statSync(tempFile).size : 0;
    if (finalSize !== entry.size) {
      throw new Error(`FTP файл скачан не полностью: ${entry.rel}, ожидалось ${this.formatBytes(entry.size)}, получено ${this.formatBytes(finalSize)}.`);
    }

    try { fs.rmSync(localFile, { force: true }); } catch { /* ignore */ }
    fs.renameSync(tempFile, localFile);
    this.setLocalFileMtime(localFile, entry.mtimeMs);
  }

  private async uploadFtpFileResumable(
    client: any,
    localFile: string,
    remoteFile: string,
    totalBytes: number
  ): Promise<void> {
    const remoteDir = path.posix.dirname(remoteFile);
    const remoteBase = path.posix.basename(remoteFile);
    const tempRemote = this.ftpJoin(remoteDir, `.${remoteBase}.wpdock-upload`);

    let remoteTempSize = await this.getFtpFileSize(client, tempRemote);
    if (remoteTempSize !== undefined && remoteTempSize > totalBytes) {
      try { await client.remove(tempRemote, true); } catch { /* ignore */ }
      remoteTempSize = undefined;
    }

    const startAt = Math.max(0, remoteTempSize ?? 0);
    if (startAt < totalBytes) {
      Logger.log(`[RemoteService] FTP upload ${startAt > 0 ? 'resume' : 'start'} file=${path.basename(localFile)} from=${this.formatBytes(startAt)}/${this.formatBytes(totalBytes)}`);
      if (startAt > 0) {
        await client.appendFrom(localFile, tempRemote, { localStart: startAt });
      } else {
        await client.uploadFrom(localFile, tempRemote);
      }
    } else if (remoteTempSize === undefined) {
      await client.uploadFrom(localFile, tempRemote);
    }

    const uploadedSize = await this.getFtpFileSize(client, tempRemote);
    if (uploadedSize !== totalBytes) {
      throw new Error(`FTP файл загружен не полностью: ${remoteFile}, ожидалось ${this.formatBytes(totalBytes)}, получено ${this.formatBytes(uploadedSize ?? 0)}.`);
    }

    await this.renameFtpOverwrite(client, tempRemote, remoteFile);
  }

  private async renameFtpOverwrite(client: any, src: string, dest: string): Promise<void> {
    try {
      await client.rename(src, dest);
      return;
    } catch {
      // Some FTP servers refuse RNTO when the destination exists.
    }
    try { await client.remove(dest, true); } catch { /* ignore */ }
    await client.rename(src, dest);
  }

  private async exportDatabaseViaFtpBridge(
    remote: RemoteSite,
    ftpPassword: string,
    dbOutPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void
  ): Promise<void> {
    if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
    fs.mkdirSync(dbOutPath, { recursive: true });
    onProgress('db', 'FTP DB bridge: загрузка временного PHP-файла...', 88);
    const session = await this.withFtpClient(remote.ftp, ftpPassword, (client) => this.createFtpDbBridge(remote, client));
    try {
      onProgress('db', 'FTP DB bridge: экспорт базы данных...', 92);
      const result = await this.callFtpDbBridge(session, 'export');
      const outFile = path.join(dbOutPath, 'database.sql');

      onProgress('db', 'FTP DB bridge: скачивание database.sql...', 96);
      await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
        await client.downloadTo(outFile, session.remoteSqlPath);
      });

      const sqlBuffer = fs.readFileSync(outFile);
      this.assertValidSqlDump(sqlBuffer);
      const meta = {
        ...(result?.db_stats && typeof result.db_stats === 'object' ? result.db_stats : {}),
        method: 'ftp-bridge',
        fileSize: sqlBuffer.length,
        exportedAt: new Date().toISOString(),
      };
      fs.writeFileSync(path.join(dbOutPath, 'database.meta.json'), JSON.stringify(meta, null, 2), 'utf-8');
      onProgress('db', 'База данных экспортирована через FTP DB bridge', 98);
    } finally {
      await this.cleanupFtpDbBridge(remote, ftpPassword, session);
    }
  }

  private async importDatabaseViaFtpBridge(
    remote: RemoteSite,
    ftpPassword: string,
    sqlFile: string,
    preserveCredentials: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void
  ): Promise<void> {
    if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
    if (!fs.existsSync(sqlFile)) {
      Logger.log(`[RemoteService] FTP DB bridge import skipped: SQL file missing path=${sqlFile}`);
      return;
    }

    onProgress('db', 'FTP DB bridge: загрузка временного PHP-файла...', 86);
    const session = await this.withFtpClient(remote.ftp, ftpPassword, (client) => this.createFtpDbBridge(remote, client));
    try {
      onProgress('db', 'FTP DB bridge: загрузка database.sql...', 90);
      await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
        await client.ensureDir(path.posix.dirname(session.remoteSqlPath));
        await client.uploadFrom(sqlFile, path.posix.basename(session.remoteSqlPath));
      });

      onProgress('db', 'FTP DB bridge: импорт базы данных на сервере...', 95);
      await this.callFtpDbBridge(session, 'import', {
        target_url: remote.url,
        preserve_credentials: preserveCredentials,
      });
      onProgress('db', 'База данных импортирована через FTP DB bridge', 98);
    } finally {
      await this.cleanupFtpDbBridge(remote, ftpPassword, session);
    }
  }

  private async createFtpDbBridge(remote: RemoteSite, client: any): Promise<FtpDbBridgeSession> {
    if (!remote.ftp) { throw new Error('FTP настройки не заданы для этого remote.'); }
    const id = crypto.randomBytes(12).toString('hex');
    const secret = crypto.randomBytes(32).toString('hex');
    const bridgeName = `wpdock-db-bridge-${id}.php`;
    const sqlName = `wpdock-db-${id}.sql`;
    const remoteBridgePath = this.ftpJoin(remote.ftp.rootPath, bridgeName);
    const remoteSqlPath = this.ftpJoin(remote.ftp.rootPath, sqlName);
    const bridgeUrl = `${remote.url.replace(/\/+$/, '')}/${encodeURIComponent(bridgeName)}`;
    const tempFile = path.join(os.tmpdir(), bridgeName);

    fs.writeFileSync(tempFile, this.buildFtpDbBridgePhp(secret, sqlName), { encoding: 'utf8', mode: 0o600 });
    try {
      await client.ensureDir(path.posix.dirname(remoteBridgePath));
      await client.uploadFrom(tempFile, path.posix.basename(remoteBridgePath));
    } finally {
      try { fs.unlinkSync(tempFile); } catch { /* ignore */ }
    }

    Logger.log(`[RemoteService] FTP DB bridge uploaded url=${bridgeUrl} remote=${remote.name}`);
    return { id, secret, bridgeName, sqlName, bridgeUrl, remoteBridgePath, remoteSqlPath };
  }

  private async cleanupFtpDbBridge(
    remote: RemoteSite,
    ftpPassword: string,
    session: FtpDbBridgeSession
  ): Promise<void> {
    try {
      await this.callFtpDbBridge(session, 'cleanup', {}, AGENT_REQUEST_TIMEOUT_MS);
    } catch (err) {
      Logger.log(`[RemoteService] FTP DB bridge HTTP cleanup skipped id=${session.id}: ${this.formatShortError(err)}`);
    }
    if (!remote.ftp) { return; }
    try {
      await this.withFtpClient(remote.ftp, ftpPassword, async (client) => {
        for (const remotePath of [session.remoteSqlPath, session.remoteBridgePath]) {
          try {
            await client.remove(remotePath);
          } catch {
            // The HTTP cleanup may already have removed the file.
          }
        }
      });
    } catch (err) {
      Logger.log(`[RemoteService] FTP DB bridge FTP cleanup failed id=${session.id}: ${this.formatShortError(err)}`);
    }
  }

  private async callFtpDbBridge(
    session: FtpDbBridgeSession,
    action: 'export' | 'import' | 'cleanup',
    body: object = {},
    timeoutMs: number = AGENT_HEAVY_OP_TIMEOUT_MS
  ): Promise<any> {
    const fetch = (await import('node-fetch')).default;
    const url = `${session.bridgeUrl}?action=${encodeURIComponent(action)}&token=${encodeURIComponent(session.secret)}`;
    const started = Date.now();
    Logger.log(`[RemoteService] FTP DB bridge request START action=${action} id=${session.id}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-WPDock-DB-Token': session.secret,
      },
      body: JSON.stringify(body),
      signal: this.createTimeoutSignal(timeoutMs),
    });
    const text = await res.text();
    let data: any;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`FTP DB bridge вернул не JSON (${res.status}): ${text.slice(0, 500)}`);
    }
    const duration = Date.now() - started;
    if (!res.ok || !data?.success) {
      Logger.log(`[RemoteService] FTP DB bridge request FAILED action=${action} id=${session.id} status=${res.status} duration=${duration}ms message=${data?.message || text}`);
      throw new Error(data?.message || `FTP DB bridge error ${res.status}`);
    }
    Logger.log(`[RemoteService] FTP DB bridge request SUCCESS action=${action} id=${session.id} duration=${duration}ms`);
    return data.data;
  }

  private buildFtpDbBridgePhp(secret: string, sqlName: string): string {
    if (!/^[a-f0-9]{64}$/.test(secret) || !/^wpdock-db-[a-f0-9]{24}\.sql$/.test(sqlName)) {
      throw new Error('Некорректные параметры FTP DB bridge.');
    }
    const templatePath = path.join(this.context.extensionPath, 'resources', 'ftp-db-bridge.php');
    const template = fs.readFileSync(templatePath, 'utf8');
    return template
      .split('__WPDOCK_SECRET__').join(secret)
      .split('__WPDOCK_SQL_NAME__').join(sqlName);
  }

  private async exportDatabaseToLocal(
    remote: RemoteSite,
    appPassword: string,
    dbOutPath: string,
    onProgress: (phase: string, msg: string, pct?: number) => void
  ): Promise<void> {
    onProgress('db', 'Экспорт базы данных...', 90);
    await this.ensureAgent(remote, appPassword);
    const dbResult = await this.agentRequest(remote.url, appPassword, 'export_db', {}, AGENT_HEAVY_OP_TIMEOUT_MS);
    const sqlBuffer = await this.downloadFromAgent(remote.url, appPassword, dbResult.file_token);
    this.assertValidSqlDump(sqlBuffer);
    fs.writeFileSync(path.join(dbOutPath, 'database.sql'), sqlBuffer);
    if (dbResult?.db_stats) {
      fs.writeFileSync(path.join(dbOutPath, 'database.meta.json'), JSON.stringify(dbResult.db_stats, null, 2), 'utf-8');
    }
    onProgress('db', 'База данных экспортирована в database.sql', 96);
  }

  private async importDatabaseFromLocal(
    remote: RemoteSite,
    appPassword: string,
    sqlFile: string,
    preserveCredentials: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void
  ): Promise<void> {
    if (!fs.existsSync(sqlFile)) {
      Logger.log(`[RemoteService] FTP/import DB skipped: SQL file missing path=${sqlFile}`);
      return;
    }
    await this.ensureAgent(remote, appPassword);
    onProgress('db', 'Загрузка базы данных...', 88);
    const dbToken = await this.uploadToAgent(remote.url, appPassword, sqlFile);
    onProgress('db', 'Импорт базы данных на сервере...', 94);
    await this.agentRequest(remote.url, appPassword, 'import_db', {
      file_token: dbToken,
      target_url: remote.url,
      preserve_credentials: preserveCredentials,
    }, AGENT_HEAVY_OP_TIMEOUT_MS);
  }

  private async saveSyncStateFromManifests(
    remoteId: string,
    localPath: string,
    remoteManifest: FileManifestEntry[]
  ): Promise<void> {
    await this.writeSyncState(localPath, remoteId, {
      version: 1,
      remoteId,
      updatedAt: new Date().toISOString(),
      local: this.manifestMap(await this.listLocalManifest(localPath, false, false)),
      remote: this.manifestMap(remoteManifest),
    });
  }

  private async saveSyncStateFromRemote(
    remote: RemoteSite,
    localPath: string,
    devMode: boolean,
    skipUploads: boolean,
    appPassword?: string
  ): Promise<void> {
    const [localManifest, remoteManifest] = await Promise.all([
      this.listLocalManifest(localPath, devMode, skipUploads),
      this.getRemoteFileManifest(remote, devMode, skipUploads, appPassword).catch((err) => {
        Logger.log(`[RemoteService] saveSyncState remote manifest fallback: ${this.formatShortError(err)}`);
        return [] as FileManifestEntry[];
      }),
    ]);
    await this.writeSyncState(localPath, remote.id, {
      version: 1,
      remoteId: remote.id,
      updatedAt: new Date().toISOString(),
      local: this.manifestMap(localManifest),
      remote: this.manifestMap(remoteManifest),
    });
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

  private async getRemoteWithOptionalPass(
    remoteId: string
  ): Promise<{ remote: RemoteSite; appPassword?: string }> {
    const remote = this.getRemote(remoteId);
    if (!remote) {throw new Error(`Удаленный сайт ${remoteId} не найден`);}
    const storedAppPassword = await this.storage.getSecret(`remote-${remoteId}-pass`);
    const appPassword = this.normalizeAppPassword(storedAppPassword || '');
    if (storedAppPassword && storedAppPassword !== appPassword) {
      await this.storage.saveSecret(`remote-${remoteId}-pass`, appPassword);
    }
    return { remote, appPassword: appPassword || undefined };
  }

  private async getRemoteFtpPassword(remoteId: string): Promise<string> {
    const password = await this.storage.getSecret(`remote-${remoteId}-ftp-pass`);
    if (!password) {
      throw new Error('FTP пароль не найден. Откройте настройки remote и укажите FTP пароль заново.');
    }
    return password;
  }

  /** Ensures the agent is reachable and returns its reported version (or undefined). */
  private async ensureAgent(remote: RemoteSite, appPassword: string): Promise<string | undefined> {
    Logger.log(`[RemoteService] ensureAgent start remote=${remote.name} id=${remote.id} flagInstalled=${remote.agentInstalled}`);
    // First try an already installed agent. The persisted flag can be stale.
    try {
      const ping = await this.agentRequest(remote.url, appPassword, 'ping', {});
      this.assertSupportedAgentVersion(ping?.version);
      this.assertAgentTempWritable(ping, remote);
      if (!remote.agentInstalled) {
        remote.agentInstalled = true;
        this.storage.saveRemote(remote);
      }
      Logger.log(`[RemoteService] ensureAgent ping OK remote=${remote.name} id=${remote.id}`);
      const live = ping?.version ? String(ping.version) : undefined;
      return await this.maybeAutoUpdateAgent(remote, appPassword, live);
    } catch (err) {
      if (err instanceof AgentTempUnwritableError) { throw err; }
      // Continue with token registration / plugin checks.
      Logger.log(`[RemoteService] ensureAgent ping failed, continue remote=${remote.name} id=${remote.id}`);
    }

    try {
      const token = await this.getAgentToken(appPassword);
      await this.registerAgentToken(remote.url, remote.username, appPassword, token);
      const ping = await this.agentRequest(remote.url, appPassword, 'ping', {});
      this.assertSupportedAgentVersion(ping?.version);
      this.assertAgentTempWritable(ping, remote);
      remote.agentInstalled = true;
      this.storage.saveRemote(remote);
      Logger.log(`[RemoteService] ensureAgent register-token + ping OK remote=${remote.name} id=${remote.id}`);
      const live = ping?.version ? String(ping.version) : undefined;
      return await this.maybeAutoUpdateAgent(remote, appPassword, live);
    } catch (err) {
      if (err instanceof AgentTempUnwritableError) { throw err; }
      // Continue with plugin inspection and activation below.
      Logger.log(`[RemoteService] ensureAgent register-token path failed, continue remote=${remote.name} id=${remote.id}`);
    }

    const status = await this.checkAgent(remote.id);
    if (status.responsive) {
      Logger.log(`[RemoteService] ensureAgent checkAgent resolved responsiveness remote=${remote.name} id=${remote.id}`);
      const live = await this.getAgentVersionIfResponsive(remote.url, appPassword);
      return await this.maybeAutoUpdateAgent(remote, appPassword, live);
    }

    remote.agentInstalled = false;
    this.storage.saveRemote(remote);
    Logger.log(`[RemoteService] ensureAgent fallback reinstall start remote=${remote.name} id=${remote.id}`);
    await this.installAgent(remote.id);
    const finalPing = await this.agentRequest(remote.url, appPassword, 'ping', {});
    this.assertAgentTempWritable(finalPing, remote);
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

  private normalizeFtpConfig(raw?: (RemoteFtpConfig & { password?: string }) | null): RemoteFtpConfig | undefined {
    if (!raw) { return undefined; }
    const host = String(raw.host ?? '').trim();
    const username = String(raw.username ?? '').trim();
    const rootPath = this.normalizeFtpRootPath(String(raw.rootPath ?? '/'));
    const port = Number.isFinite(raw.port) ? Math.round(Number(raw.port)) : undefined;
    if (!host && !username && rootPath === '/') { return undefined; }
    if (!host) { throw new Error('FTP host не может быть пустым'); }
    if (!username) { throw new Error('FTP логин не может быть пустым'); }
    if (port !== undefined && (port < 1 || port > 65535)) {
      throw new Error('FTP порт должен быть от 1 до 65535');
    }
    return {
      host,
      username,
      rootPath,
      port,
      secure: Boolean(raw.secure),
    };
  }

  private normalizeFtpRootPath(value: string): string {
    const trimmed = value.trim().replace(/\\/g, '/').replace(/\/{2,}/g, '/');
    if (!trimmed || trimmed === '.') { return '/'; }
    return trimmed.startsWith('/') ? trimmed.replace(/\/+$/, '') || '/' : trimmed.replace(/\/+$/, '') || '/';
  }

  private async verifyFtpConnection(config: RemoteFtpConfig, password: string): Promise<void> {
    await this.withFtpClient(config, password, async (client) => {
      await client.cd(config.rootPath || '/');
      // Make sure this is probably a WordPress root, but don't be too strict:
      // some hosts hide dotfiles or use custom layouts.
      const list = await client.list();
      const names = new Set(list.map((item: any) => String(item.name).toLowerCase()));
      if (!names.has('wp-content') && !names.has('wp-admin') && !names.has('wp-includes')) {
        Logger.log(`[RemoteService] FTP root ${config.rootPath} does not look like WP root (wp-content/wp-admin not listed), accepting anyway`);
      }
    });
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
    agentVersion?: string,
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
    const canFallbackToAgentPath = Boolean(
      agentVersion && this.compareSemver(agentVersion, INCREMENTAL_AGENT_VERSION) >= 0
    );
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
      if (canFallbackToAgentPath && remaining.length <= 8) {
        remaining = await this.downloadMediaLeftoversViaAgent(remote, appPassword, remaining);
      } else {
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
          if (canFallbackToAgentPath && remaining.length > 0 && remaining.length <= 8) {
            Logger.log(`[RemoteService] pullUploadsDirect switching ${remaining.length} leftover file(s) to agent fallback`);
            break;
          }
        }
        if (remaining.length > 0 && canFallbackToAgentPath) {
          remaining = await this.downloadMediaLeftoversViaAgent(remote, appPassword, remaining);
        }
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

  private async downloadMediaLeftoversViaAgent(
    remote: RemoteSite,
    appPassword: string,
    files: Array<{ rel: string; size: number; out: string }>
  ): Promise<Array<{ rel: string; size: number; out: string }>> {
    // Some upload paths are listed in the media manifest but are not actually
    // fetchable as static public files (e.g. plugin backup folders protected by
    // .htaccess). Direct curl can sit until the idle watchdog for each retry.
    // Agent 1.3.13+ can stream a single root-relative file safely, so use it as a
    // slow-path fallback for the few leftovers.
    Logger.log(`[RemoteService] pullUploadsDirect agent fallback for ${files.length} leftover media file(s)`);
    const stillRemaining: Array<{ rel: string; size: number; out: string }> = [];
    for (const e of files) {
      try {
        const rootRel = `wp-content/${e.rel.replace(/^\/+/, '')}`;
        const buf = await this.downloadAgentPath(remote, appPassword, rootRel);
        if (buf.length !== e.size) {
          throw new Error(`size mismatch: expected ${this.formatBytes(e.size)}, got ${this.formatBytes(buf.length)}`);
        }
        await fs.promises.mkdir(path.dirname(e.out), { recursive: true });
        await fs.promises.writeFile(e.out, buf);
        Logger.log(`[RemoteService] pullUploadsDirect agent fallback OK rel=${e.rel} size=${this.formatBytes(buf.length)}`);
      } catch (err) {
        Logger.log(`[RemoteService] pullUploadsDirect agent fallback failed rel=${e.rel} error=${this.formatShortError(err)}`);
        stillRemaining.push(e);
      }
    }
    return stillRemaining;
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

      const proc = cp.execFile(
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

  /** Agent ≥1.3.17 reports a real write probe of wp-content/wpdock-temp in
   *  ping. Older agents omit the field — then no check. `is_writable`/
   *  `disk_free_space` on the server can't see a hosting quota, so only this
   *  probe catches «диск переполнен» before minutes of packing. */
  private assertAgentTempWritable(ping: any, remote: RemoteSite): void {
    if (!ping || ping.temp_writable !== false) {
      return;
    }
    const reason = ping.temp_write_error ? ` (${String(ping.temp_write_error)})` : '';
    const free = typeof ping.temp_free_bytes === 'number'
      ? ` disk_free_space раздела: ${this.formatBytes(ping.temp_free_bytes)} — квота аккаунта может быть исчерпана раньше.`
      : '';
    throw new AgentTempUnwritableError(
      `Сервер «${remote.name}» не может записывать во временную папку wp-content/wpdock-temp${reason}. ` +
      `Обычно это переполненный диск или превышенная квота хостинга: очистите wp-content/wpdock-temp ` +
      `(старые upload-*.zip от прежних попыток Push) и проверьте свободное место.${free}`
    );
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
    Logger.log(`[RemoteService] uploadToAgentChunked hashing file=${path.basename(filePath)} size=${this.formatBytes(totalBytes)} for resumable upload`);
    const fileHash = await this.hashFile(filePath);
    const resumeKey = this.makeUploadResumeKey(fileHash, totalBytes, path.extname(filePath));
    // Start with the configured chunk size (can be large for capable hosts). If the
    // host rejects an oversized POST body (413), halve and re-run the session rather
    // than failing the whole Push — this makes a high chunk-size setting safe.
    //
    // New agents normally assemble resumable uploads directly into one file by
    // offset writes (low disk usage). Some shared hosts intermittently fail those
    // writes even after concurrency drops to 1. In that case fall back to the older
    // per-chunk-files assembly for this archive part: it needs more temporary space
    // for one split part, but avoids sparse/offset writes and keeps the Push moving.
    let chunkSize = CHUNK_UPLOAD_BYTES;
    let sessionRetries = 0;
    let writeMode: AgentUploadWriteMode = 'single_file';
    for (;;) {
      try {
        return await this.runChunkedUploadSession(siteUrl, appPassword, filePath, totalBytes, chunkSize, resumeKey, writeMode, onProgress);
      } catch (err) {
        if (this.isChunkSizeRejection(err) && chunkSize > MIN_CHUNK_UPLOAD_BYTES) {
          const reduced = Math.max(MIN_CHUNK_UPLOAD_BYTES, Math.floor(chunkSize / 2));
          Logger.log(`[RemoteService] uploadToAgentChunked host rejected chunkSize=${this.formatBytes(chunkSize)} (413) — retrying with ${this.formatBytes(reduced)}`);
          chunkSize = reduced;
          sessionRetries = 0;
          continue;
        }
        if (
          this.isTransientChunkWriteError(err) &&
          writeMode === 'single_file' &&
          this.getEffectiveUploadConcurrency() <= MIN_ADAPTIVE_UPLOAD_CONCURRENCY
        ) {
          writeMode = 'chunks';
          sessionRetries = 0;
          Logger.log(
            `[RemoteService] uploadToAgentChunked persistent single-file chunk write failure at concurrency=1 — ` +
            `retrying ${path.basename(filePath)} with chunk-file assembly`
          );
          continue;
        }
        // The server-side upload session expired or was lost mid-transfer (410/404).
        // A fresh runChunkedUploadSession re-runs upload_init. New agents resume
        // by resume_key; if the server already deleted the expired session, this
        // safely starts a new one. Bounded so repeated drops surface the error.
        if (this.isUploadSessionExpired(err) && sessionRetries < UPLOAD_SESSION_RETRY_COUNT) {
          sessionRetries++;
          Logger.log(`[RemoteService] uploadToAgentChunked upload session expired/lost — re-initializing (attempt ${sessionRetries}/${UPLOAD_SESSION_RETRY_COUNT})`);
          continue;
        }
        if (this.isRetryableUploadError(err) && sessionRetries < UPLOAD_SESSION_RETRY_COUNT) {
          sessionRetries++;
          this.reduceAdaptiveUploadConcurrency(`session transient ${this.formatShortError(err)}`);
          Logger.log(`[RemoteService] uploadToAgentChunked transient failure — re-initializing/resuming upload session (attempt ${sessionRetries}/${UPLOAD_SESSION_RETRY_COUNT}) error=${this.formatShortError(err)}`);
          continue;
        }
        if (this.isTransientChunkWriteError(err) && chunkSize > MIN_CHUNK_UPLOAD_BYTES) {
          const reduced = Math.max(MIN_CHUNK_UPLOAD_BYTES, Math.floor(chunkSize / 2));
          chunkSize = reduced;
          sessionRetries = 0;
          Logger.log(
            `[RemoteService] uploadToAgentChunked persistent chunk write failure — ` +
            `retrying ${path.basename(filePath)} with smaller chunkSize=${this.formatBytes(reduced)}`
          );
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
    resumeKey: string,
    writeMode: AgentUploadWriteMode,
    onProgress?: (uploadedBytes: number, totalBytes: number) => void
  ): Promise<string> {
    const filename = path.basename(filePath);
    const totalChunks = Math.max(1, Math.ceil(totalBytes / chunkSize));
    const configuredConcurrency = this.normalizeConcurrency(CHUNK_UPLOAD_CONCURRENCY);
    const effectiveConcurrency = this.getEffectiveUploadConcurrency();
    const workerCount = Math.min(effectiveConcurrency, totalChunks);
    const adaptiveSuffix = effectiveConcurrency < configuredConcurrency
      ? ` adaptiveCap=${effectiveConcurrency} configured=${configuredConcurrency}`
      : '';
    Logger.log(`[RemoteService] runChunkedUploadSession START file=${filename} totalChunks=${totalChunks} chunkSize=${this.formatBytes(chunkSize)} concurrency=${workerCount}${adaptiveSuffix} writeMode=${writeMode} totalSize=${this.formatBytes(totalBytes)}`);
    const init = await this.agentRequest(siteUrl, appPassword, 'upload_init', {
      filename,
      total_chunks: totalChunks,
      total_bytes: totalBytes,
      chunk_size: chunkSize,
      concurrency: workerCount,
      resume_key: resumeKey,
      write_mode: writeMode,
    }, AGENT_UPLOAD_CONTROL_TIMEOUT_MS);

    const completedToken = String(init?.file_token || '');
    if (completedToken) {
      Logger.log(`[RemoteService] runChunkedUploadSession RESUME completed upload file=${filename} token=${completedToken}`);
      onProgress?.(totalBytes, totalBytes);
      return completedToken;
    }

    const uploadId = String(init?.upload_id || '');
    if (!uploadId) {
      throw new Error('Agent did not return upload_id for chunked upload');
    }

    const receivedIndices = new Set<number>(
      Array.isArray(init?.received_indices)
        ? init.received_indices
          .map((value: unknown) => Number(value))
          .filter((value: number) => Number.isInteger(value) && value >= 0 && value < totalChunks)
        : []
    );
    let uploadedBytes = 0;
    for (const index of receivedIndices) {
      const start = index * chunkSize;
      const remaining = Math.max(0, totalBytes - start);
      uploadedBytes += Math.min(chunkSize, remaining);
    }
    uploadedBytes = Math.min(uploadedBytes, totalBytes);
    if (receivedIndices.size > 0 || init?.resumed) {
      Logger.log(
        `[RemoteService] runChunkedUploadSession RESUME uploadId=${uploadId} ` +
        `received=${receivedIndices.size}/${totalChunks} uploaded=${this.formatBytes(uploadedBytes)}`
      );
      onProgress?.(uploadedBytes, totalBytes);
    }

    const fileHandle = await fs.promises.open(filePath, 'r');
    let nextChunkIndex = 0;
    // When one worker fails, the others stop pulling new chunks so we surface the
    // error fast (e.g. a 413) instead of letting every worker exhaust its retries.
    let aborted = false;
    // Set when any worker sees a genuine 413. Under concurrency the error that wins
    // the Promise.all race is often a connection reset (nginx drops the socket on an
    // oversized body) rather than a clean 413, which would hide the real cause from
    // the chunk-size auto-reduction in uploadToAgentChunked. This flag lets us
    // re-surface it as a payload-limit error regardless of which error rejected first.
    let sawPayloadLimit = false;
    let transientChunkRetries = 0;

    try {
      const workers = Array.from({ length: workerCount }, async () => {
        while (nextChunkIndex < totalChunks && !aborted) {
          const currentIndex = nextChunkIndex++;
          if (currentIndex >= totalChunks) {
            return;
          }
          if (receivedIndices.has(currentIndex)) {
            continue;
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
            const retriesUsed = await this.uploadChunkToAgent(
              siteUrl,
              appPassword,
              uploadId,
              currentIndex,
              filename,
              chunkBuffer
            );
            transientChunkRetries += retriesUsed;
          } catch (err) {
            aborted = true;
            if (this.isChunkSizeRejection(err)) { sawPayloadLimit = true; }
            throw err;
          }

          uploadedBytes += readResult.bytesRead;
          onProgress?.(Math.min(uploadedBytes, totalBytes), totalBytes);
        }
      });

      await Promise.all(workers);
      if (transientChunkRetries > 0) {
        this.reduceAdaptiveUploadConcurrency(`chunk retries=${transientChunkRetries} file=${filename}`);
      }
    } catch (err) {
      // A 413 seen by any worker means the chunk size is too big for this host.
      // Normalize whatever won the Promise.all race (often a socket hang up /
      // ECONNRESET from nginx closing the connection on the oversized body) into a
      // payload-limit error so uploadToAgentChunked halves the chunk size and
      // re-runs the session instead of failing the whole Push.
      if (sawPayloadLimit || this.isChunkSizeRejection(err)) {
        await this.abortUploadSession(siteUrl, appPassword, uploadId);
      } else {
        Logger.log(`[RemoteService] runChunkedUploadSession keeping resumable upload session uploadId=${uploadId} after error=${this.formatShortError(err)}`);
      }
      if (sawPayloadLimit && !this.isChunkSizeRejection(err)) {
        throw new Error(`Chunk upload failed: 413 Request Entity Too Large (chunk size ${this.formatBytes(chunkSize)} exceeds host limit)`);
      }
      throw err;
    } finally {
      await fileHandle.close();
    }

    let finalize: any;
    try {
      finalize = await this.agentRequest(siteUrl, appPassword, 'upload_finalize', {
        upload_id: uploadId,
      }, AGENT_UPLOAD_CONTROL_TIMEOUT_MS);
    } catch (err) {
      Logger.log(`[RemoteService] upload_finalize failed; keeping resumable upload session uploadId=${uploadId} error=${this.formatShortError(err)}`);
      throw err;
    }

    const token = String(finalize?.file_token || '');
    if (!token) {
      throw new Error('Agent did not return file token after chunk finalize');
    }
    Logger.log(`[RemoteService] runChunkedUploadSession SUCCESS file=${filename} token=${token} result=${JSON.stringify(finalize ?? {})}`);
    onProgress?.(totalBytes, totalBytes);
    return token;
  }

  private async abortUploadSession(siteUrl: string, appPassword: string, uploadId: string): Promise<void> {
    if (!uploadId) {return;}
    try {
      await this.agentRequest(siteUrl, appPassword, 'upload_abort', { upload_id: uploadId }, AGENT_UPLOAD_CONTROL_TIMEOUT_MS);
      Logger.log(`[RemoteService] upload_abort SUCCESS uploadId=${uploadId}`);
    } catch (err) {
      // Best effort only. Older agents do not have upload_abort, and the cleanup
      // cron will eventually remove expired sessions.
      Logger.log(`[RemoteService] upload_abort SKIPPED/FAILED uploadId=${uploadId} error=${this.formatShortError(err)}`);
    }
  }

  private async uploadChunkToAgent(
    siteUrl: string,
    appPassword: string,
    uploadId: string,
    chunkIndex: number,
    filename: string,
    chunk: Buffer
  ): Promise<number> {
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
          
          if (attempt < UPLOAD_RETRY_COUNT && !this.isPermanentError(res.status) && !this.isUploadStorageError(lastError)) {
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
        return attempt - 1;
      } catch (err: any) {
        upload.clear();
        lastError = err;
        // A 413 is permanent for this chunk size: retrying the same oversized body
        // only hammers the host and lets a connection reset race ahead and mask the
        // 413. Fail fast so the session aborts and the chunk size is halved upstream.
        // Storage/quota failures are also permanent until the server frees space;
        // retrying the same chunk wastes minutes on slow hosts.
        if (attempt === UPLOAD_RETRY_COUNT || this.isChunkSizeRejection(err) || this.isUploadStorageError(err)) {
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
    return (status >= 400 && status < 500 && status !== 429) || status === 507;
  }

  private isRetryableUploadError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    // Agent single-file uploads can report 507 "Failed to write chunk data" when
    // a shared host flakes under concurrent offset writes even though
    // disk_free_space still shows plenty of room. Keep the resumable session and
    // retry with adaptive concurrency instead of aborting the whole split-push.
    if (this.isTransientChunkWriteError(error)) {
      return true;
    }
    if (this.isChunkSizeRejection(error) || this.isUploadStorageError(error)) {
      return false;
    }
    if (this.isAbortError(error)) {
      return true;
    }
    // Agent 1.3.15+: sha256 mismatch resets the server session (retry re-uploads
    // from scratch); partial extract failures keep the uploaded archive server-side
    // (retry re-runs extraction of the same token without re-uploading).
    if (raw.includes('sha256 mismatch') || raw.includes('zip direct extract failed')) {
      return true;
    }
    return /timed out|timeout|econnreset|etimedout|socket hang up|fetch failed|network|wrong_version_number|ssl routines|bad gateway|gateway timeout|service unavailable|upload session expired|502|503|504/.test(raw);
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

  /**
   * The agent returns these when PHP received the request but the remote
   * filesystem could not persist it (disk quota, full partition, permissions).
   * They are not solved by retrying the identical chunk.
   */
  private isUploadStorageError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return (
      raw.includes('cannot store uploaded chunk') ||
      raw.includes('insufficient server disk space') ||
      raw.includes('no space left on device') ||
      raw.includes('disk quota') ||
      raw.includes('quota exceeded') ||
      raw.includes('cannot create destination file') ||
      raw.includes('cannot assemble uploaded chunks')
    );
  }

  private isTransientChunkWriteError(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return (
      raw.includes('failed to write chunk data') ||
      raw.includes('failed to mark uploaded chunk')
    );
  }

  /**
   * True when the agent reports the chunked-upload session is gone — either expired
   * (410) or not found (404). The agent's messages are "Upload session expired" and
   * "Upload session not found or expired"; matching those (and the bare status) lets
   * uploadToAgentChunked re-init a fresh session instead of failing the whole Push.
   */
  private isUploadSessionExpired(error: unknown): boolean {
    const raw = String((error as any)?.message ?? error ?? '').toLowerCase();
    return /\b410\b|upload session expired|upload session not found|session not found or expired/.test(raw);
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

  private async hashFile(filePath: string): Promise<string> {
    const { createHash } = await import('crypto');
    const hash = createHash('sha256');
    await new Promise<void>((resolve, reject) => {
      const stream = fs.createReadStream(filePath);
      stream.on('data', (chunk) => hash.update(chunk));
      stream.on('error', reject);
      stream.on('end', resolve);
    });
    return hash.digest('hex');
  }

  private makeUploadResumeKey(fileHash: string, totalBytes: number, ext: string): string {
    // Stable across local temp filenames, but changes if the archive/SQL bytes change.
    return `sha256:${fileHash}:bytes:${totalBytes}:ext:${String(ext || '').toLowerCase().replace(/[^a-z0-9.]/g, '')}`;
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

  private async createPushArchivePlan(sourceDir: string, devMode: boolean): Promise<PushArchivePlan> {
    const entries = this.collectPushArchiveEntries(sourceDir, devMode)
      .sort((a, b) => a.rel.localeCompare(b.rel));
    if (entries.length === 0) {
      throw new Error('nothing to pack (empty WP root)');
    }

    const parts: PushArchivePart[] = [];
    let current: PushArchiveEntry[] = [];
    let currentBytes = 0;
    let totalBytes = 0;

    const flush = () => {
      if (current.length === 0) { return; }
      parts.push({ entries: current, estimatedBytes: currentBytes });
      current = [];
      currentBytes = 0;
    };

    for (const entry of entries) {
      totalBytes += entry.size;
      if (current.length > 0 && currentBytes + entry.size > PUSH_SPLIT_PART_TARGET_BYTES) {
        flush();
      }
      current.push(entry);
      currentBytes += entry.size;
    }
    flush();

    Logger.log(
      `[PUSH-SPLIT] plan files=${entries.length} estimated=${this.formatBytes(totalBytes)} ` +
      `parts=${parts.length} threshold=${this.formatBytes(PUSH_SPLIT_THRESHOLD_BYTES)} ` +
      `target=${this.formatBytes(PUSH_SPLIT_PART_TARGET_BYTES)} devMode=${devMode}`
    );

    return { entries, parts, totalBytes };
  }

  private collectPushArchiveEntries(sourceDir: string, devMode: boolean): PushArchiveEntry[] {
    const normalizedSourceDir = path.resolve(sourceDir);
    const externalWpContentDir = path.resolve(path.dirname(normalizedSourceDir), 'wp-content');
    const internalWpContentDir = path.resolve(normalizedSourceDir, 'wp-content');
    const hasExternalWpContent =
      fs.existsSync(externalWpContentDir) &&
      externalWpContentDir !== internalWpContentDir &&
      fs.statSync(externalWpContentDir).isDirectory() &&
      (!fs.existsSync(internalWpContentDir) || fs.lstatSync(internalWpContentDir).isSymbolicLink());

    const entries: PushArchiveEntry[] = [];
    const seenDirs = new Set<string>();
    this.collectPushArchiveEntriesFromDir(
      normalizedSourceDir,
      '',
      devMode,
      entries,
      seenDirs,
      hasExternalWpContent ? 'wp-content' : undefined
    );
    if (hasExternalWpContent) {
      this.collectPushArchiveEntriesFromDir(externalWpContentDir, 'wp-content', devMode, entries, seenDirs);
    }
    return entries;
  }

  private collectPushArchiveEntriesFromDir(
    rootDir: string,
    relPrefix: string,
    devMode: boolean,
    entries: PushArchiveEntry[],
    seenDirs: Set<string>,
    skipTopLevelName?: string
  ): void {
    const rootReal = fs.realpathSync(rootDir);
    const stack: Array<{ abs: string; rel: string }> = [{ abs: rootDir, rel: relPrefix }];
    seenDirs.add(rootReal);

    while (stack.length > 0) {
      const current = stack.pop()!;
      let items: fs.Dirent[];
      try {
        items = fs.readdirSync(current.abs, { withFileTypes: true });
      } catch (err) {
        Logger.log(`[PUSH-SPLIT] skip unreadable dir=${current.abs} error=${this.formatShortError(err)}`);
        continue;
      }

      for (const item of items) {
        if (!current.rel && skipTopLevelName && item.name === skipTopLevelName) {
          continue;
        }
        const rel = (current.rel ? `${current.rel}/${item.name}` : item.name).replace(/\\/g, '/');
        if (this.shouldSkipPushArchivePath(rel, item.isDirectory(), devMode)) {
          continue;
        }

        const abs = path.join(current.abs, item.name);
        let stat: fs.Stats;
        try {
          stat = fs.statSync(abs);
        } catch (err) {
          Logger.log(`[PUSH-SPLIT] skip unreadable path=${abs} error=${this.formatShortError(err)}`);
          continue;
        }

        if (stat.isDirectory()) {
          let real: string;
          try {
            real = fs.realpathSync(abs);
          } catch {
            real = abs;
          }
          if (seenDirs.has(real)) {
            continue;
          }
          seenDirs.add(real);
          stack.push({ abs, rel });
        } else if (stat.isFile()) {
          entries.push({ abs, rel, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
        }
      }
    }
  }

  private shouldSkipPushArchivePath(relPath: string, _isDir: boolean, devMode: boolean): boolean {
    const rel = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const lower = rel.toLowerCase();
    const segments = lower.split('/').filter(Boolean);
    const name = segments[segments.length - 1] ?? '';

    if (!rel || segments.some((segment) => segment.startsWith('.'))) { return true; }
    if (segments.includes('node_modules') || segments.includes('.git')) { return true; }
    if (segments.includes('.vscode') || segments.includes('.idea')) { return true; }
    if (name === 'wp-config.php' || name === 'database.sql' || name === '.gitignore') { return true; }
    if (/^wpdock-db-bridge-[a-f0-9]{24}\.php$/.test(name) || /^wpdock-db-[a-f0-9]{24}\.sql$/.test(name)) {
      return true;
    }
    if (name === '.ds_store' || name === 'thumbs.db') { return true; }
    if (name.endsWith('.swp') || name.endsWith('.swo')) { return true; }
    if (name === '.env.local' || (name.startsWith('.env.') && name.endsWith('.local'))) { return true; }
    if (lower === 'wp-content/debug.log') { return true; }
    if (lower === 'wp-content/cache' || lower.startsWith('wp-content/cache/')) { return true; }
    if (lower === 'wp-content/upgrade' || lower.startsWith('wp-content/upgrade/')) { return true; }
    if (lower === 'wp-content/backup' || lower.startsWith('wp-content/backup/')) { return true; }
    if (lower === 'wp-content/plugins/wpdock-agent.php') { return true; }
    if (lower === 'wp-content/plugins/wpdock-agent' || lower.startsWith('wp-content/plugins/wpdock-agent/')) {
      return true;
    }

    if (devMode) {
      if (lower === 'wp-content/uploads' || lower.startsWith('wp-content/uploads/')) { return true; }
      if (segments.includes('vendor') || segments.includes('dist') || segments.includes('build')) { return true; }
      if (segments.includes('.turbo') || segments.includes('.next') || segments.includes('.nuxt')) { return true; }
    }

    return false;
  }

  private async pushSplitArchives(
    remoteId: string,
    siteUrl: string,
    appPassword: string,
    sourceDir: string,
    plan: PushArchivePlan,
    planKey: string,
    archiver: any,
    devMode: boolean,
    onProgress: (phase: string, msg: string, pct?: number) => void,
    prefetchedRemoteMap?: Record<string, FileManifestEntry>
  ): Promise<{ archiveCount: number; archiveBytes: number }> {
    const totalEstimated = Math.max(1, plan.totalBytes);
    const transferState = this.readTransferState(sourceDir, remoteId) ?? this.baseTransferState(remoteId);
    let pushState = transferState.pushFiles?.planKey === planKey && transferState.pushFiles.mode === 'split'
      ? transferState.pushFiles
      : undefined;
    if (!pushState) {
      pushState = { planKey, mode: 'split', completedParts: [] };
      transferState.pushFiles = pushState;
      this.writeTransferState(sourceDir, remoteId, transferState);
    }
    const completedParts = new Set<number>(
      (pushState.completedParts ?? [])
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value >= 0 && value < plan.parts.length)
    );

    // Resume-части проверяем по реальному manifest сервера: часть считается
    // перенесённой только если все её файлы существуют на сервере.
    if (completedParts.size > 0) {
      onProgress('verifying', `Проверка уже перенесённых частей на сервере (${completedParts.size}/${plan.parts.length})...`, 8);
      let remoteMap = prefetchedRemoteMap;
      if (!remoteMap) {
        try {
          remoteMap = await this.fetchAgentManifestMap(siteUrl, appPassword, devMode);
        } catch (err) {
          Logger.log(`[PUSH-SPLIT] resume verify недоступен — все части будут загружены заново: ${this.formatShortError(err)}`);
        }
      }
      if (!remoteMap) {
        completedParts.clear();
      } else {
        for (const index of Array.from(completedParts)) {
          const missing = this.findMissingOnRemote(plan.parts[index].entries, remoteMap);
          if (missing.length > 0) {
            completedParts.delete(index);
            Logger.log(
              `[PUSH-SPLIT] resume part ${index + 1}/${plan.parts.length} невалидна: ` +
              `на сервере нет ${missing.length} файлов sample=${missing.slice(0, 3).join(', ')}`
            );
          }
        }
      }
      pushState.completedParts = Array.from(completedParts).sort((a, b) => a - b);
      pushState.completed = false;
      transferState.pushFiles = pushState;
      this.writeTransferState(sourceDir, remoteId, transferState);
      Logger.log(`[PUSH-SPLIT] resume verify done valid_parts=${completedParts.size}/${plan.parts.length}`);
    }

    // Дисковый бюджет сервера: пик должен быть ≈ размер сайта + 1 часть.
    // Остатки прошлых неудачных попыток (upload-*.zip и chunks-* сессии живут
    // до 24 ч ради resume) способны удвоить требуемое место. Если resume не
    // нашёл ни одной перенесённой части, переиспользовать нечего — освобождаем
    // место до начала загрузки.
    if (completedParts.size === 0) {
      await this.cleanupUploadLeftovers(siteUrl, appPassword, 'fresh split push');
    }

    let completedEstimated = plan.parts.reduce((sum, part, index) => (
      completedParts.has(index) ? sum + part.estimatedBytes : sum
    ), 0);
    let archiveBytes = 0;

    Logger.log(
      `[PUSH-SPLIT] START parts=${plan.parts.length} files=${plan.entries.length} ` +
      `estimated=${this.formatBytes(plan.totalBytes)}`
    );
    try {
      for (let i = 0; i < plan.parts.length; i++) {
        const part = plan.parts[i];
        const partNo = i + 1;
        if (completedParts.has(i)) {
          Logger.log(`[PUSH-SPLIT] resume skip already extracted part ${partNo}/${plan.parts.length}`);
          onProgress(
            'extracting',
            `Файлы уже перенесены: часть ${partNo}/${plan.parts.length}`,
            65 + Math.round((completedEstimated / totalEstimated) * 5)
          );
          continue;
        }
        const zipPath = path.join(os.tmpdir(), `wpdock-push-${Date.now()}-part-${partNo}-of-${plan.parts.length}.zip`);
        const partBasePct = 10 + Math.round((completedEstimated / totalEstimated) * 20);

        try {
          onProgress(
            'packaging',
            `Упаковка файлов: часть ${partNo}/${plan.parts.length} (${part.entries.length} файлов)...`,
            partBasePct
          );
          const packStart = Date.now();
          await this.createZipPart(sourceDir, zipPath, part.entries, archiver, devMode, true);
          const zipStats = fs.statSync(zipPath);
          archiveBytes += zipStats.size;
          Logger.log(
            `[PUSH-SPLIT] part ${partNo}/${plan.parts.length} packed ` +
            `files=${part.entries.length} estimated=${this.formatBytes(part.estimatedBytes)} ` +
            `zip=${this.formatBytes(zipStats.size)} elapsed=${Date.now() - packStart}ms`
          );

          const uploadToken = await this.uploadToAgent(
            siteUrl,
            appPassword,
            zipPath,
            (uploadedBytes, totalBytes) => {
              const ratio = totalBytes > 0 ? Math.min(1, uploadedBytes / totalBytes) : 1;
              const weighted = (completedEstimated + part.estimatedBytes * ratio) / totalEstimated;
              const pct = 30 + Math.round(Math.min(1, weighted) * 35);
              onProgress(
                'uploading',
                `Загрузка файлов: часть ${partNo}/${plan.parts.length} — ${this.formatBytes(uploadedBytes)} / ${this.formatBytes(totalBytes)}`,
                pct
              );
            }
          );

          const extractPct = 65 + Math.round(((i + 0.5) / plan.parts.length) * 5);
          onProgress('extracting', `Распаковка файлов: часть ${partNo}/${plan.parts.length}...`, extractPct);
          const extractResult = await this.retryAsync(`extract_files part ${partNo}/${plan.parts.length}`, 2, () => this.agentRequest(siteUrl, appPassword, 'extract_files', {
            file_token: uploadToken,
          }, AGENT_HEAVY_OP_TIMEOUT_MS));
          Logger.log(
            `[PUSH-SPLIT] part ${partNo}/${plan.parts.length} extracted result=${JSON.stringify(extractResult ?? {})}`
          );

          completedEstimated += part.estimatedBytes;
          completedParts.add(i);
          pushState.completedParts = Array.from(completedParts).sort((a, b) => a - b);
          pushState.completed = completedParts.size === plan.parts.length;
          transferState.pushFiles = pushState;
          this.writeTransferState(sourceDir, remoteId, transferState);
          onProgress(
            'extracting',
            `Файлы перенесены: часть ${partNo}/${plan.parts.length}`,
            65 + Math.round((completedEstimated / totalEstimated) * 5)
          );
        } finally {
          if (fs.existsSync(zipPath)) {
            try { fs.unlinkSync(zipPath); } catch { /* ignore temp cleanup failures */ }
          }
        }
      }
    } catch (err) {
      Logger.log(`[PUSH-SPLIT] failed; keeping resumable state for retry error=${this.formatShortError(err)}`);
      throw err;
    }

    pushState.completed = true;
    transferState.pushFiles = pushState;
    this.writeTransferState(sourceDir, remoteId, transferState);
    Logger.log(
      `[PUSH-SPLIT] SUCCESS parts=${plan.parts.length} uploaded=${this.formatBytes(archiveBytes)}`
    );
    // Каждая часть удаляется агентом сразу после распаковки, но прерванные
    // ранее сессии/completed-записи ждут TTL 24 ч — подчищаем их сейчас.
    await this.cleanupUploadLeftovers(siteUrl, appPassword, 'split push success');
    return { archiveCount: plan.parts.length, archiveBytes };
  }

  /**
   * Best-effort очистка upload-остатков на сервере (upload-*.zip, chunks-*
   * сессии, completed-uploads). Ошибка не прерывает push — это оптимизация
   * дискового бюджета, а не обязательный шаг.
   */
  private async cleanupUploadLeftovers(siteUrl: string, appPassword: string, reason: string): Promise<void> {
    try {
      const result = await this.agentRequest(siteUrl, appPassword, 'cleanup_uploads', {}, AGENT_HEAVY_OP_TIMEOUT_MS);
      Logger.log(`[PUSH-SPLIT] cleanup_uploads (${reason}) result=${JSON.stringify(result ?? {})}`);
    } catch (err) {
      Logger.log(`[PUSH-SPLIT] cleanup_uploads (${reason}) failed (ignored): ${this.formatShortError(err)}`);
    }
  }

  private async createZipPart(
    sourceDir: string,
    destZip: string,
    entries: PushArchiveEntry[],
    archiver: any,
    devMode: boolean,
    enableLogging: boolean
  ): Promise<void> {
    if (entries.length === 0) {
      throw new Error('cannot pack empty archive part');
    }

    const normalizedSourceDir = path.resolve(sourceDir);
    const canUseNative =
      process.platform === 'win32' &&
      entries.every((entry) => this.isPathInside(normalizedSourceDir, entry.abs));

    if (canUseNative) {
      try {
        await this.createZipPartNative(normalizedSourceDir, destZip, entries, devMode, enableLogging);
        return;
      } catch (err: any) {
        if (enableLogging) {
          Logger.log(`[ZIP] native split part failed (${err?.message ?? err}); fallback → archiver`);
        }
        try { fs.rmSync(destZip, { force: true }); } catch { /* ignore */ }
      }
    }

    await this.createZipPartArchiver(destZip, entries, archiver, devMode, enableLogging);
  }

  private async createZipPartNative(
    sourceDir: string,
    destZip: string,
    entries: PushArchiveEntry[],
    devMode: boolean,
    enableLogging: boolean
  ): Promise<void> {
    const tarBin = (() => {
      const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
      return fs.existsSync(sys) ? sys : 'tar';
    })();
    const listPath = path.join(os.tmpdir(), `wpdock-tar-list-${Date.now()}-${Math.random().toString(16).slice(2)}.txt`);
    fs.writeFileSync(listPath, entries.map((entry) => entry.rel).join('\n'), 'utf8');

    const args = [
      '--format=zip',
      `--options=zip:compression=${devMode ? 'store' : 'deflate'}`,
      '--dereference',
      '-v',
      '-c', '-f', destZip,
      '-C', sourceDir,
      '-T', listPath,
    ];

    if (enableLogging) {
      Logger.log(
        `[ZIP] native split tar bin=${tarBin} entries=${entries.length} ` +
        `estimated=${this.formatBytes(entries.reduce((sum, entry) => sum + entry.size, 0))} ` +
        `compression=${devMode ? 'store' : 'deflate'}`
      );
    }

    let packed = 0;
    let stderrTail = '';
    const countLines = (s: string) => {
      for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) { packed++; } }
    };

    try {
      await new Promise<void>((resolve, reject) => {
        const proc = cp.spawn(tarBin, args, { windowsHide: true });
        proc.stdout?.on('data', (d) => countLines(d.toString()));
        proc.stderr?.on('data', (d) => {
          const s = d.toString();
          countLines(s);
          stderrTail = (stderrTail + s).slice(-2000);
        });
        proc.on('error', reject);
        proc.on('close', (code) => {
          const size = fs.existsSync(destZip) ? fs.statSync(destZip).size : 0;
          if (code === 0 || (code === 1 && size > 0)) {
            resolve();
          } else {
            reject(new Error(`tar exit ${code}: ${stderrTail.slice(-500)}`));
          }
        });
      });
    } finally {
      try { fs.unlinkSync(listPath); } catch { /* ignore */ }
    }

    const size = fs.existsSync(destZip) ? fs.statSync(destZip).size : 0;
    if (size === 0) { throw new Error('native split zip produced empty file'); }
    if (enableLogging) {
      Logger.log(`[ZIP] native split tar created path=${destZip} size=${this.formatBytes(size)} objects=${packed}`);
    }
  }

  private createZipPartArchiver(
    destZip: string,
    entries: PushArchiveEntry[],
    archiver: any,
    devMode: boolean,
    enableLogging: boolean
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(destZip);
      const archive = archiver('zip', {
        zlib: devMode ? false : { level: ZIP_COMPRESSION_LEVEL },
      });

      output.on('close', () => {
        const bytes = fs.statSync(destZip).size;
        if (enableLogging) {
          Logger.log(`[ZIP] split archiver created path=${destZip} size=${this.formatBytes(bytes)} entries=${entries.length}`);
        }
        resolve();
      });
      output.on('error', reject);
      archive.on('error', reject);
      archive.pipe(output);
      for (const entry of entries) {
        archive.file(entry.abs, { name: entry.rel });
      }
      archive.finalize();
    });
  }

  private isPathInside(parentDir: string, childPath: string): boolean {
    const rel = path.relative(path.resolve(parentDir), path.resolve(childPath));
    return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private getAgentZipPath(): string {
    return path.join(this.context.extensionPath, 'resources', 'wpdock-agent.zip');
  }

  /**
   * Detects the legacy layout where the real wp-content lives next to (not inside)
   * the WP root and the in-root wp-content is missing or a symlink. The native
   * packer can't remap such a path, so this gates the archiver fallback.
   */
  private hasExternalWpContent(sourceDir: string): boolean {
    const normalized = path.resolve(sourceDir);
    const externalWpContentDir = path.resolve(path.dirname(normalized), 'wp-content');
    const internalWpContentDir = path.resolve(normalized, 'wp-content');
    return (
      fs.existsSync(externalWpContentDir) &&
      externalWpContentDir !== internalWpContentDir &&
      fs.statSync(externalWpContentDir).isDirectory() &&
      (!fs.existsSync(internalWpContentDir) || fs.lstatSync(internalWpContentDir).isSymbolicLink())
    );
  }

  /**
   * Packs the WP root into a ZIP for push. Prefers native bsdtar (tar.exe on
   * Windows 10+) which packs tens of thousands of wp-content files in seconds;
   * pure-JS archiver does the same in minutes. Falls back to archiver on any
   * problem or for the legacy external-wp-content layout. `onPacked` reports the
   * running object count so the caller can show live packaging progress.
   */
  private async createZip(
    sourceDir: string,
    destZip: string,
    archiver: any,
    devMode: boolean = false,
    enableLogging: boolean = true,
    onPacked?: (count: number) => void
  ): Promise<void> {
    if (process.platform === 'win32' && !this.hasExternalWpContent(sourceDir)) {
      try {
        await this.createZipNative(sourceDir, destZip, devMode, enableLogging, onPacked);
        return;
      } catch (err: any) {
        if (enableLogging) {
          Logger.log(`[ZIP] native tar failed (${err?.message ?? err}); fallback → archiver`);
        }
        try { fs.rmSync(destZip, { force: true }); } catch { /* ignore */ }
      }
    }
    await this.createZipArchiver(sourceDir, destZip, archiver, devMode, enableLogging, onPacked);
  }

  /** Native bsdtar packer. See createZip() for rationale. */
  private async createZipNative(
    sourceDir: string,
    destZip: string,
    devMode: boolean,
    enableLogging: boolean,
    onPacked?: (count: number) => void
  ): Promise<void> {
    const tarBin = (() => {
      const sys = path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'tar.exe');
      return fs.existsSync(sys) ? sys : 'tar';
    })();

    // Top-level members to pack, dropping never-shipped entries so bsdtar never
    // descends into them. `--dereference` follows a wp-content junction/symlink.
    // Skip dotfiles/dirs (matches archiver's dot:false — avoids pushing local
    // .htaccess/.user.ini over the remote's) and the never-shipped entries.
    const members = fs.readdirSync(sourceDir)
      .filter((name) => !name.startsWith('.') && !PUSH_TAR_TOPLEVEL_SKIP.has(name));
    if (members.length === 0) {
      throw new Error('nothing to pack (empty WP root)');
    }

    const excludes = devMode ? PUSH_TAR_EXCLUDES_DEV : PUSH_TAR_EXCLUDES;
    const excludeArgs: string[] = [];
    for (const ex of excludes) { excludeArgs.push('--exclude', ex); }

    const args = [
      '--format=zip',
      `--options=zip:compression=${devMode ? 'store' : 'deflate'}`,
      '--dereference',
      '-v',
      ...excludeArgs,
      '-c', '-f', destZip,
      '-C', sourceDir,
      ...members,
    ];

    if (enableLogging) {
      Logger.log(
        `[ZIP] native tar bin=${tarBin} devMode=${devMode} members=${members.length} ` +
        `excludes=${excludes.length} compression=${devMode ? 'store' : 'deflate'}`
      );
    }

    let packed = 0;
    let stderrTail = '';
    // bsdtar prints one path per line in verbose mode; depending on the build it
    // goes to stdout or stderr, so count newlines on both.
    const countLines = (s: string) => {
      for (let i = 0; i < s.length; i++) { if (s.charCodeAt(i) === 10) { packed++; } }
      onPacked?.(packed);
    };

    await new Promise<void>((resolve, reject) => {
      const proc = cp.spawn(tarBin, args, { windowsHide: true });
      proc.stdout?.on('data', (d) => countLines(d.toString()));
      proc.stderr?.on('data', (d) => {
        const s = d.toString();
        countLines(s);
        stderrTail = (stderrTail + s).slice(-2000);
      });
      proc.on('error', reject); // tar missing / failed to launch
      proc.on('close', (code) => {
        const size = fs.existsSync(destZip) ? fs.statSync(destZip).size : 0;
        // code 1 = warnings (e.g. a file vanished mid-pack). Accept if archive exists.
        if (code === 0 || (code === 1 && size > 0)) {
          resolve();
        } else {
          reject(new Error(`tar exit ${code}: ${stderrTail.slice(-500)}`));
        }
      });
    });

    const size = fs.existsSync(destZip) ? fs.statSync(destZip).size : 0;
    if (size === 0) { throw new Error('native zip produced empty file'); }
    if (enableLogging) {
      Logger.log(`[ZIP] native tar created path=${destZip} size=${this.formatBytes(size)} objects=${packed}`);
    }
  }

  /** Pure-JS archiver packer — fallback path. */
  private createZipArchiver(sourceDir: string, destZip: string, archiver: any, devMode: boolean = false, enableLogging: boolean = true, onPacked?: (count: number) => void): Promise<void> {
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
      if (onPacked) {
        let packed = 0;
        archive.on('entry', () => { onPacked(++packed); });
      }
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
