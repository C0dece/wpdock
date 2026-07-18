export interface WPSite {
  id: string;
  name: string;
  path: string;
  port: number;
  phpVersion: string;
  wpVersion?: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
  /** Last status transition time; used to expire stale cross-window "starting" state. */
  statusUpdatedAt?: string;
  createdAt: string;
  adminUser?: string;
  adminEmail?: string;
  remoteIds?: string[];
  git?: {
    repoInitialized: boolean;
    remoteUrl?: string;
    defaultBranch?: string;
    githubRepo?: string;
  };
  /** Database name for this site (local runtime mode). */
  dbName?: string;
  /** Database user for this site (local runtime mode). */
  dbUser?: string;
  /** WordPress locale, e.g. 'ru_RU' (default) or 'en_US'. */
  locale?: string;
  /** Custom domain for this site, e.g. 'mysite.local'. Falls back to localhost. */
  domain?: string;
  /** Whether HTTPS is enabled via mkcert. */
  ssl?: boolean;
  /** Web server: PHP built-in (default), nginx, or apache. */
  webServer?: 'php' | 'nginx' | 'apache';
  /** WP_DEBUG constant value. */
  wpDebug?: boolean;
  /** WP_DEBUG_LOG constant value. */
  wpDebugLog?: boolean;
  /** SCRIPT_DEBUG constant value. */
  wpScriptDebug?: boolean;
  /** HTTPS port when ssl=true (separate from the internal PHP server port). */
  httpsPort?: number;
  /** Live Preview state for UI surfaces. */
  livePreviewRunning?: boolean;
}

export interface RemoteSite {
  id: string;
  name: string;
  url: string;           // e.g. https://example.com
  adminUrl: string;      // WP admin URL
  username: string;
  appPassword: string;   // WP Application Password
  fileTransferMode?: 'agent' | 'ftp';
  ftp?: RemoteFtpConfig;
  agentInstalled: boolean;
  /** Live version reported by the agent on the server (kept fresh on every check/update). */
  agentVersion?: string;
  autoInstallAgent?: boolean;
  preferCreateSiteOnPull?: boolean;
  defaultLocalSiteName?: string;
  defaultPhpVersion?: string;
  defaultLocale?: string;
  defaultWebServer?: 'php' | 'nginx' | 'apache';
  defaultSsl?: boolean;
  linkedSiteIds?: string[]; // linked local site IDs
  lastSyncAt?: string;
  lastSyncDirection?: 'pull' | 'push';
  lastSyncStatus?: 'success' | 'error';
  lastSyncMessage?: string;
  syncHistory?: RemoteSyncEvent[];
  createdAt: string;
}

export interface RemoteFtpConfig {
  host: string;
  port?: number;
  username: string;
  rootPath: string;      // FTP path to WordPress root, e.g. /public_html
  secure?: boolean;      // explicit FTPS
}

export interface RemoteSyncEvent {
  id: string;
  at: string;
  direction: 'pull' | 'push';
  status: 'success' | 'error';
  message: string;
  localSiteId?: string;
}

export interface SiteCreateOptions {
  name: string;
  phpVersion: string;
  wpVersion?: string;
  adminUser: string;
  adminPassword: string;
  adminEmail: string;
  path?: string;
  locale?: string;
  domain?: string;
  ssl?: boolean;
  webServer?: 'php' | 'nginx' | 'apache';
  wpDebug?: boolean;
  wpDebugLog?: boolean;
  wpScriptDebug?: boolean;
}

export interface DeployOptions {
  siteId: string;
  remoteId: string;
  includeDb: boolean;
  excludePaths: string[];
}

export interface SyncProgress {
  phase: 'creating' | 'connecting' | 'packaging' | 'uploading' | 'extracting' | 'db' | 'done' | 'error';
  message: string;
  percent?: number;
}

export interface RuntimeStatus {
  available: boolean;
  dbRunning: boolean;
  phpInstalled: boolean;
  mariadbInstalled: boolean;
}

export type DashboardRoute =
  | 'home'
  | 'create-site'
  | 'connect-remote'
  | 'edit-remote'
  | 'remote-detail'
  | 'pull-remote'
  | 'push-remote'
  | 'deploy'
  | 'backup'
  | 'import-site'
  | 'github-manager';

// ── Backup & Export ──────────────────────────────────────────────────────────

export interface BackupEntry {
  id: string;
  siteId: string;
  siteName: string;
  createdAt: string;
  size: number;        // bytes
  localPath: string;   // full path to the .zip
  includesDb: boolean;
  source?: 'local' | 'cloud' | 'export';
  backupKind?: 'site-backup' | 'zip-export';
  cloudUploads: CloudUploadInfo[];
}

export interface CloudUploadInfo {
  provider: 'yandex' | 'google';
  remotePath: string;  // Yandex: /WPDock/... | Google: fileId
  uploadedAt: string;
}

export interface BackupConfig {
  autoBackup: boolean;
  intervalHours: number;  // 0 = disabled, 24 = daily, 168 = weekly
  keepCount: number;      // max local backups to keep per site
  includeDb: boolean;
  cloudProviders: ('yandex' | 'google')[];
}

export const DEFAULT_BACKUP_CONFIG: BackupConfig = {
  autoBackup: false,
  intervalHours: 24,
  keepCount: 5,
  includeDb: true,
  cloudProviders: [],
};

// ── GitHub ───────────────────────────────────────────────────────────────────

export interface GitHubRepoInfo {
  id: number;
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  stars: number;
  updatedAt: string;
}

export interface GitHubUser {
  login: string;
  name: string;
  avatarUrl: string;
  publicRepos: number;
}
