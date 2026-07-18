export interface WPSite {
  id: string;
  name: string;
  path: string;
  port: number;
  phpVersion: string;
  wpVersion?: string;
  status: 'starting' | 'running' | 'stopped' | 'error';
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
  dbName?: string;
  dbUser?: string;
  locale?: string;
  domain?: string;
  ssl?: boolean;
  webServer?: 'php' | 'nginx' | 'apache';
  wpDebug?: boolean;
  wpDebugLog?: boolean;
  wpScriptDebug?: boolean;
  httpsPort?: number;
  /** Computed public URL sent from extension (portless when proxy/portproxy active). */
  siteUrl?: string;
  livePreviewRunning?: boolean;
}

export interface RemoteSite {
  id: string;
  name: string;
  url: string;
  adminUrl: string;
  username: string;
  appPassword: string;
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
  linkedSiteIds?: string[];
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
  rootPath: string;
  secure?: boolean;
}

export interface RemoteSyncEvent {
  id: string;
  at: string;
  direction: 'pull' | 'push';
  status: 'success' | 'error';
  message: string;
  localSiteId?: string;
}
