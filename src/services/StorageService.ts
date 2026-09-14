import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WPSite, RemoteSite, BackupEntry, BackupConfig, DEFAULT_BACKUP_CONFIG } from '../types';
import { Logger } from '../utils/logger';

export type StorageChangeOrigin = 'local' | 'external';

export interface StorageChangeEvent {
  origin: StorageChangeOrigin;
  path: string;
}

type StorageChangeKind = 'sites' | 'remotes' | 'backups' | 'backupConfig';

/**
 * Per-site runtime ownership lock, shared across VS Code windows via runtime.json.
 * Lets a window tell "a live window owns this running site" apart from
 * "an orphaned/zombie web-server process nobody controls" after a reload.
 */
export interface SiteRuntimeLock {
  /** PID of the extension host that actually runs the site's web server. */
  ownerPid: number;
  /** Last heartbeat timestamp (ms). Refreshed by the owner on each sync tick. */
  heartbeatAt: number;
}

export class StorageService implements vscode.Disposable {
  private storageDir: string;
  private sitesPath: string;
  private remotesPath: string;
  private backupsPath: string;
  private backupConfigPath: string;
  private runtimePath: string;
  private readonly watchers: fs.FSWatcher[] = [];
  private readonly selfWriteUntil = new Map<string, number>();
  private readonly externalChangeTimers = new Map<StorageChangeKind, NodeJS.Timeout>();
  private readonly onDidChangeSitesEmitter = new vscode.EventEmitter<StorageChangeEvent>();
  private readonly onDidChangeRemotesEmitter = new vscode.EventEmitter<StorageChangeEvent>();
  private readonly onDidChangeBackupsEmitter = new vscode.EventEmitter<StorageChangeEvent>();
  private readonly onDidChangeBackupConfigEmitter = new vscode.EventEmitter<StorageChangeEvent>();

  readonly onDidChangeSites = this.onDidChangeSitesEmitter.event;
  readonly onDidChangeRemotes = this.onDidChangeRemotesEmitter.event;
  readonly onDidChangeBackups = this.onDidChangeBackupsEmitter.event;
  readonly onDidChangeBackupConfig = this.onDidChangeBackupConfigEmitter.event;

  constructor(private context: vscode.ExtensionContext) {
    this.storageDir = context.globalStorageUri.fsPath;
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
    this.sitesPath = path.join(this.storageDir, 'sites.json');
    this.remotesPath = path.join(this.storageDir, 'remotes.json');
    this.backupsPath = path.join(this.storageDir, 'backups.json');
    this.backupConfigPath = path.join(this.storageDir, 'backup-config.json');
    this.runtimePath = path.join(this.storageDir, 'runtime.json');
    this.watchStorageDirectory();
  }


  private normalizeSite(site: any): WPSite {
    const remoteIds = Array.isArray(site?.remoteIds)
      ? site.remoteIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : typeof site?.remoteId === 'string' && site.remoteId
        ? [site.remoteId]
        : [];
    return {
      ...site,
      remoteIds,
      statusUpdatedAt: typeof site?.statusUpdatedAt === 'string' ? site.statusUpdatedAt : undefined,
      git: site?.git && typeof site.git === 'object'
        ? {
            repoInitialized: Boolean(site.git.repoInitialized),
            remoteUrl: typeof site.git.remoteUrl === 'string' ? site.git.remoteUrl : undefined,
            defaultBranch: typeof site.git.defaultBranch === 'string' ? site.git.defaultBranch : undefined,
            githubRepo: typeof site.git.githubRepo === 'string' ? site.git.githubRepo : undefined,
          }
        : undefined,
    };
  }

  private normalizeRemote(remote: any): RemoteSite {
    const linkedSiteIds = Array.isArray(remote?.linkedSiteIds)
      ? remote.linkedSiteIds.filter((id: unknown): id is string => typeof id === 'string' && id.length > 0)
      : typeof remote?.linkedSiteId === 'string' && remote.linkedSiteId
        ? [remote.linkedSiteId]
        : [];
    const fileTransferMode = remote?.fileTransferMode === 'ftp' ? 'ftp' : 'agent';
    const ftp = remote?.ftp && typeof remote.ftp === 'object'
      ? {
          host: typeof remote.ftp.host === 'string' ? remote.ftp.host : '',
          port: Number.isFinite(remote.ftp.port) ? Number(remote.ftp.port) : undefined,
          username: typeof remote.ftp.username === 'string' ? remote.ftp.username : '',
          rootPath: typeof remote.ftp.rootPath === 'string' ? remote.ftp.rootPath : '/',
          secure: Boolean(remote.ftp.secure),
        }
      : undefined;
    return {
      ...remote,
      fileTransferMode,
      ftp,
      linkedSiteIds,
      syncHistory: Array.isArray(remote?.syncHistory) ? remote.syncHistory.slice(0, 50) : [],
    };
  }

  private normalizeBackup(entry: any): BackupEntry {
    return {
      ...entry,
      cloudUploads: Array.isArray(entry?.cloudUploads) ? entry.cloudUploads : [],
      source: entry?.source === 'cloud' || entry?.source === 'export' ? entry.source : 'local',
      backupKind: entry?.backupKind === 'zip-export' ? entry.backupKind : 'site-backup',
    };
  }

  getSites(): WPSite[] {
    try {
      if (!fs.existsSync(this.sitesPath)) {return [];}
      const raw = JSON.parse(fs.readFileSync(this.sitesPath, 'utf-8'));
      return Array.isArray(raw) ? raw.map((site) => this.normalizeSite(site)) : [];
    } catch (err) {
      Logger.error('[Storage] getSites parse failed', err);
      return [];
    }
  }

  saveSites(sites: WPSite[]): void {
    this.writeJson(this.sitesPath, sites, 'sites');
  }

  saveSite(site: WPSite): void {
    const sites = this.getSites();
    const idx = sites.findIndex((s) => s.id === site.id);
    if (idx >= 0) {
      sites[idx] = site;
    } else {
      sites.push(site);
    }
    this.saveSites(sites);
  }

  removeSite(siteId: string): void {
    const sites = this.getSites().filter((s) => s.id !== siteId);
    this.saveSites(sites);
  }

  // ── Runtime ownership locks (shared across windows) ────────────────────────

  private getRuntimeLocks(): Record<string, SiteRuntimeLock> {
    try {
      if (!fs.existsSync(this.runtimePath)) {return {};}
      const raw = JSON.parse(fs.readFileSync(this.runtimePath, 'utf-8'));
      return raw && typeof raw === 'object' ? raw as Record<string, SiteRuntimeLock> : {};
    } catch {
      return {};
    }
  }

  private writeRuntimeLocks(locks: Record<string, SiteRuntimeLock>): void {
    try {
      fs.writeFileSync(this.runtimePath, JSON.stringify(locks, null, 2));
    } catch (err) {
      Logger.error('[Storage] failed to write runtime locks', err);
    }
  }

  getRuntimeLock(siteId: string): SiteRuntimeLock | undefined {
    const lock = this.getRuntimeLocks()[siteId];
    return lock && typeof lock.ownerPid === 'number' && typeof lock.heartbeatAt === 'number'
      ? lock
      : undefined;
  }

  setRuntimeLock(siteId: string, lock: SiteRuntimeLock): void {
    const locks = this.getRuntimeLocks();
    locks[siteId] = lock;
    this.writeRuntimeLocks(locks);
  }

  clearRuntimeLock(siteId: string): void {
    const locks = this.getRuntimeLocks();
    if (locks[siteId] === undefined) {return;}
    delete locks[siteId];
    this.writeRuntimeLocks(locks);
  }

  getRemotes(): RemoteSite[] {
    try {
      if (!fs.existsSync(this.remotesPath)) {return [];}
      const raw = JSON.parse(fs.readFileSync(this.remotesPath, 'utf-8'));
      return Array.isArray(raw) ? raw.map((remote) => this.normalizeRemote(remote)) : [];
    } catch (err) {
      Logger.error('[Storage] getRemotes parse failed', err);
      return [];
    }
  }

  saveRemotes(remotes: RemoteSite[]): void {
    this.writeJson(this.remotesPath, remotes, 'remotes');
  }

  saveRemote(remote: RemoteSite): void {
    const remotes = this.getRemotes();
    const idx = remotes.findIndex((r) => r.id === remote.id);
    if (idx >= 0) {
      remotes[idx] = remote;
    } else {
      remotes.push(remote);
    }
    this.saveRemotes(remotes);
  }

  removeRemote(remoteId: string): void {
    const remotes = this.getRemotes().filter((r) => r.id !== remoteId);
    this.saveRemotes(remotes);
  }

  // Secure credential storage via VS Code SecretStorage
  async saveSecret(key: string, value: string): Promise<void> {
    await this.context.secrets.store(key, value);
  }

  async getSecret(key: string): Promise<string | undefined> {
    return this.context.secrets.get(key);
  }

  async deleteSecret(key: string): Promise<void> {
    await this.context.secrets.delete(key);
  }

  getSitesDirectory(): string {
    const config = vscode.workspace.getConfiguration('wpdock');
    const configured = config.get<string>('sitesDirectory');
    if (configured && fs.existsSync(configured)) {return configured;}

    // Default: ~/WPDock/sites
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const defaultDir = path.join(home, 'WPDock', 'sites');
    if (!fs.existsSync(defaultDir)) {
      fs.mkdirSync(defaultDir, { recursive: true });
    }
    return defaultDir;
  }

  // ── Backups ──────────────────────────────────────────────────────────────

  getBackups(siteId?: string): BackupEntry[] {
    try {
      if (!fs.existsSync(this.backupsPath)) {return [];}
      const raw = JSON.parse(fs.readFileSync(this.backupsPath, 'utf-8'));
      const all: BackupEntry[] = Array.isArray(raw) ? raw.map((entry) => this.normalizeBackup(entry)) : [];
      return siteId ? all.filter((b) => b.siteId === siteId) : all;
    } catch {
      return [];
    }
  }

  saveBackup(entry: BackupEntry): void {
    const all = this.getBackups();
    const idx = all.findIndex((b) => b.id === entry.id);
    if (idx >= 0) {
      all[idx] = entry;
    } else {
      all.unshift(entry);
    }
    this.writeJson(this.backupsPath, all, 'backups');
  }

  deleteBackup(backupId: string): void {
    const all = this.getBackups().filter((b) => b.id !== backupId);
    this.writeJson(this.backupsPath, all, 'backups');
  }

  getBackupConfig(): BackupConfig {
    try {
      if (!fs.existsSync(this.backupConfigPath)) {return { ...DEFAULT_BACKUP_CONFIG };}
      return JSON.parse(fs.readFileSync(this.backupConfigPath, 'utf-8'));
    } catch {
      return { ...DEFAULT_BACKUP_CONFIG };
    }
  }

  saveBackupConfig(config: BackupConfig): void {
    this.writeJson(this.backupConfigPath, config, 'backupConfig');
  }

  getBackupsDirectory(): string {
    const home = process.env.USERPROFILE || process.env.HOME || '';
    const dir = path.join(home, 'WPDock', 'backups');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  dispose(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers.length = 0;
    for (const timer of this.externalChangeTimers.values()) {
      clearTimeout(timer);
    }
    this.externalChangeTimers.clear();
    this.onDidChangeSitesEmitter.dispose();
    this.onDidChangeRemotesEmitter.dispose();
    this.onDidChangeBackupsEmitter.dispose();
    this.onDidChangeBackupConfigEmitter.dispose();
  }

  private writeJson(filePath: string, value: unknown, kind: StorageChangeKind): void {
    this.markSelfWrite(filePath);
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
    this.fireChange(kind, 'local');
  }

  private watchStorageDirectory(): void {
    try {
      const watcher = fs.watch(this.storageDir, { persistent: false }, (_eventType, filename) => {
        const fileName = this.normalizeWatcherFileName(filename);
        if (!fileName) {return;}

        const kind = this.kindForFileName(fileName);
        if (!kind) {return;}

        const filePath = this.pathForKind(kind);
        if (this.isSelfWrite(filePath)) {return;}

        this.scheduleExternalChange(kind);
      });
      this.watchers.push(watcher);
    } catch (err) {
      Logger.error('[Storage] failed to watch global storage directory', err);
    }
  }

  private normalizeWatcherFileName(filename: string | Buffer | null): string | undefined {
    if (!filename) {return undefined;}
    return typeof filename === 'string' ? filename : filename.toString('utf-8');
  }

  private kindForFileName(fileName: string): StorageChangeKind | undefined {
    switch (path.basename(fileName)) {
      case 'sites.json':
        return 'sites';
      case 'remotes.json':
        return 'remotes';
      case 'backups.json':
        return 'backups';
      case 'backup-config.json':
        return 'backupConfig';
      default:
        return undefined;
    }
  }

  private pathForKind(kind: StorageChangeKind): string {
    switch (kind) {
      case 'sites':
        return this.sitesPath;
      case 'remotes':
        return this.remotesPath;
      case 'backups':
        return this.backupsPath;
      case 'backupConfig':
        return this.backupConfigPath;
    }
  }

  private markSelfWrite(filePath: string): void {
    this.selfWriteUntil.set(filePath, Date.now() + 1500);
  }

  private isSelfWrite(filePath: string): boolean {
    const until = this.selfWriteUntil.get(filePath);
    if (!until) {return false;}
    if (Date.now() <= until) {return true;}
    this.selfWriteUntil.delete(filePath);
    return false;
  }

  private scheduleExternalChange(kind: StorageChangeKind): void {
    const existing = this.externalChangeTimers.get(kind);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      this.externalChangeTimers.delete(kind);
      this.fireChange(kind, 'external');
    }, 150);
    this.externalChangeTimers.set(kind, timer);
  }

  private fireChange(kind: StorageChangeKind, origin: StorageChangeOrigin): void {
    const event = { origin, path: this.pathForKind(kind) };
    switch (kind) {
      case 'sites':
        this.onDidChangeSitesEmitter.fire(event);
        break;
      case 'remotes':
        this.onDidChangeRemotesEmitter.fire(event);
        break;
      case 'backups':
        this.onDidChangeBackupsEmitter.fire(event);
        break;
      case 'backupConfig':
        this.onDidChangeBackupConfigEmitter.fire(event);
        break;
    }
  }
}
