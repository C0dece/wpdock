const site = {
  id: 'preview-site', name: 'Демо-магазин', path: 'C:\\WPDock\\demo-shop', port: 8082,
  phpVersion: '8.2', wpVersion: '6.6', status: 'stopped', createdAt: '2026-08-10T08:00:00.000Z',
  adminUser: 'admin', adminEmail: 'admin@example.local', remoteIds: ['preview-remote'],
  git: { repoInitialized: true, remoteUrl: 'https://github.com/example/demo-shop.git', defaultBranch: 'main', githubRepo: 'example/demo-shop' },
  dbName: 'wp_demo', dbUser: 'wp_demo', locale: 'ru_RU', domain: 'demo-shop.local', ssl: true,
  webServer: 'nginx', wpDebug: false, wpDebugLog: true, wpScriptDebug: false,
  siteUrl: 'https://demo-shop.local', livePreviewRunning: false,
};

const sites = [
  site,
  { ...site, id: 'preview-site-2', name: 'crithit.local', path: 'C:\\WPDock\\crithit', domain: 'crithit-local.local', siteUrl: 'https://crithit-local.local', port: 8083, remoteIds: [] },
  { ...site, id: 'preview-site-3', name: 'https://test2.crithit.ru', path: 'C:\\WPDock\\test2', domain: 'test2.crithit.local', siteUrl: 'https://test2.crithit.local', port: 8084, remoteIds: [] },
  { ...site, id: 'preview-site-4', name: 'shkolnik-blg', path: 'C:\\WPDock\\shkolnik-blg', domain: 'shkolnik-blg.local', siteUrl: 'https://shkolnik-blg.local', port: 8085, remoteIds: [] },
  { ...site, id: 'preview-site-5', name: 'vsevseshkolu', path: 'C:\\WPDock\\vsevseshkolu', domain: 'vsevseshkolu.local', siteUrl: 'https://vsevseshkolu.local', port: 8086, remoteIds: [] },
];

const remote = {
  id: 'preview-remote', name: 'Продакшен', url: 'https://example.com', adminUrl: 'https://example.com/wp-admin',
  username: 'admin', appPassword: '', fileTransferMode: 'agent', agentInstalled: true, agentVersion: '1.3.19',
  autoInstallAgent: true, linkedSiteIds: ['preview-site'], lastSyncAt: '2026-08-19T08:30:00.000Z',
  lastSyncDirection: 'pull', lastSyncStatus: 'success', lastSyncMessage: 'Синхронизация завершена',
  createdAt: '2026-08-01T08:00:00.000Z',
  syncHistory: [{ id: 'sync-1', at: '2026-08-19T08:30:00.000Z', direction: 'pull', status: 'success', message: 'Файлы и БД обновлены', localSiteId: 'preview-site' }],
};

const backups = [{
  id: 'preview-backup', siteId: site.id, siteName: site.name, createdAt: '2026-08-19T09:00:00.000Z',
  size: 157286400, localPath: 'C:\\WPDock\\backups\\demo-shop.zip', includesDb: true,
  source: 'local', backupKind: 'site-backup',
  cloudUploads: [{ provider: 'yandex', remotePath: '/WPDock/demo-shop.zip', uploadedAt: '2026-08-19T09:05:00.000Z' }],
}];

const emit = (data: unknown) => window.setTimeout(() => window.dispatchEvent(new MessageEvent('message', { data })), 0);

export function handlePreviewMessage(message: any) {
  switch (message?.type) {
    case 'ready':
      emit({
        type: 'state',
        sites,
        remotes: [remote],
        viewContext: new URLSearchParams(window.location.search).has('project')
          ? { mode: 'project', siteId: site.id, workspacePath: site.path }
          : { mode: 'dashboard' },
      });
      emit({ type: 'localAccessStatus', status: { proxyRunning: true, portProxyActive: true } });
      break;
    case 'getSettings':
      emit({ type: 'settingsLoaded', settings: { sitesDirectory: 'C:\\WPDock\\sites', defaultPhpVersion: '8.2', directUploadLimitMb: 8, chunkSizeMb: 4, uploadConcurrency: 4, autoBackup: true, backupIntervalHours: 24, backupKeepCount: 5 } });
      break;
    case 'getBackups':
      emit({ type: 'backupsData', backups, config: { autoBackup: true, intervalHours: 24, keepCount: 5, includeDb: true, cloudProviders: ['yandex'] } });
      break;
    case 'cloudGetStatus':
      emit({ type: 'cloudStatus', providers: ['yandex'], available: { yandex: true, google: true } });
      break;
    case 'githubGetUser':
      emit({ type: 'githubUser', user: { login: 'wpdock-demo', name: 'WPDock Demo', avatarUrl: '', publicRepos: 3 } });
      emit({ type: 'githubRepos', repos: [{ id: 1, name: 'demo-shop', fullName: 'wpdock-demo/demo-shop', url: 'https://github.com/wpdock-demo/demo-shop', cloneUrl: 'https://github.com/wpdock-demo/demo-shop.git', sshUrl: 'git@github.com:wpdock-demo/demo-shop.git', isPrivate: true, description: 'Демо-проект WordPress', defaultBranch: 'main', stars: 0, updatedAt: '2026-08-19T09:00:00.000Z' }] });
      break;
    case 'checkRemoteAgent':
      emit({ type: 'agentCheckResult', remoteId: remote.id, status: { installed: true, active: true, responsive: true } });
      break;
    case 'gitStatus':
      emit({ type: 'gitStatusResult', branch: 'main', clean: false, files: ['style.css', 'functions.php'], ahead: 0, behind: 0 });
      break;
  }
}
