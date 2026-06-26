import React, { useEffect, useMemo, useRef, useState } from 'react';
import { WPSite, RemoteSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  modified: string[];
  staged: string[];
  untracked: string[];
}

interface SiteCredentials {
  adminUser?: string;
  adminPass?: string;
  dbName?: string;
  dbUser?: string;
  dbPass?: string;
  dbPort?: number;
}

interface BackupConfig {
  autoBackup: boolean;
  intervalHours: number;
  keepCount: number;
  includeDb: boolean;
  cloudProviders: ('yandex' | 'google')[];
}

type CloudProvider = 'yandex' | 'google';
type SectionKey = 'overview' | 'git' | 'deploy' | 'backup' | 'settings';

interface CloudUploadInfo {
  provider: CloudProvider;
  remotePath: string;
  uploadedAt?: string;
}

interface BackupEntry {
  id: string;
  siteId: string;
  siteName: string;
  createdAt: string;
  size: number;
  localPath: string;
  includesDb: boolean;
  cloudUploads: CloudUploadInfo[];
}

interface Props {
  siteId: string;
  sites: WPSite[];
  remotes: RemoteSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  projectMode?: boolean;
}

export default function SiteDetailPage({ siteId, sites, remotes, navigate, onToast, projectMode = false }: Props) {
  const site = sites.find((s) => s.id === siteId);
  const linkedRemotes = useMemo(() => remotes.filter((r) => (site?.remoteIds ?? []).includes(r.id)), [remotes, site?.remoteIds]);
  const availableRemotes = useMemo(() => remotes.filter((r) => !(site?.remoteIds ?? []).includes(r.id)), [remotes, site?.remoteIds]);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    overview: true,
    git: false,
    // In the project panel the remote linking/management lives here — keep it
    // open so "привязать ещё один сайт" and per-remote actions are visible.
    deploy: projectMode,
    backup: false,
    settings: false,
  });
  const [selectedRemoteId, setSelectedRemoteId] = useState('');
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const [gitMsg, setGitMsg] = useState('');
  const [githubUrl, setGithubUrl] = useState('');
  const [newRepoName, setNewRepoName] = useState('');
  const [newRepoPrivate, setNewRepoPrivate] = useState(true);
  const [wpCliCmd, setWpCliCmd] = useState('');
  const [wpCliOutput, setWpCliOutput] = useState('');
  const [wpCliRunning, setWpCliRunning] = useState(false);
  const [creds, setCreds] = useState<SiteCredentials | null>(null);
  const [showCreds, setShowCreds] = useState(false);
  const [backupConfig, setBackupConfig] = useState<BackupConfig | null>(null);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [openBackupMenu, setOpenBackupMenu] = useState<string | null>(null);
  const [openDangerMenu, setOpenDangerMenu] = useState(false);
  const dangerMenuRef = useRef<HTMLDivElement | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<CloudProvider[]>([]);
  const [selectedCloudProviders, setSelectedCloudProviders] = useState<CloudProvider[]>([]);
  const [savingSiteSettings, setSavingSiteSettings] = useState(false);
  const [siteSettings, setSiteSettings] = useState({
    name: site?.name ?? '',
    domain: site?.domain ?? '',
    ssl: site?.ssl ?? false,
    webServer: (site?.webServer ?? 'php') as 'php' | 'nginx' | 'apache',
    wpDebug: site?.wpDebug ?? false,
    wpDebugLog: site?.wpDebugLog ?? false,
    wpScriptDebug: site?.wpScriptDebug ?? false,
  });

  useEffect(() => {
    if (!site) return;
    setSiteSettings({
      name: site.name ?? '',
      domain: site.domain ?? '',
      ssl: site.ssl ?? false,
      webServer: (site.webServer ?? 'php') as 'php' | 'nginx' | 'apache',
      wpDebug: site.wpDebug ?? false,
      wpDebugLog: site.wpDebugLog ?? false,
      wpScriptDebug: site.wpScriptDebug ?? false,
    });
  }, [site?.id, site?.name, site?.domain, site?.ssl, site?.webServer, site?.wpDebug, site?.wpDebugLog, site?.wpScriptDebug]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'gitStatusResult') setGitStatus(msg);
      if (msg.type === 'gitInit') onToast('Git инициализирован', 'success');
      if (msg.type === 'gitPushed') onToast('Push выполнен', 'success');
      if (msg.type === 'gitRemoteAdded') onToast('Git remote обновлён', 'success');
      if (msg.type === 'githubRepoCreated') onToast(`GitHub repo создан: ${msg.repo.fullName}`, 'success');
      if (msg.type === 'githubLinked') onToast('GitHub repo привязан', 'success');
      if (msg.type === 'backupsData') {
        setBackupConfig(msg.config ?? null);
        setBackups(Array.isArray(msg.backups) ? msg.backups.filter((b: BackupEntry) => b.siteId === siteId) : []);
      }
      if (msg.type === 'cloudFileDeleted') {
        setOpenBackupMenu(null);
        onToast('Облачная копия удалена', 'info');
      }
      if (msg.type === 'backupCreated' || msg.type === 'backupRestored' || msg.type === 'backupDeleted') {
        vscode.postMessage({ type: 'getBackups', payload: { siteId } });
      }
      if (msg.type === 'backupRestored' && msg.siteId === siteId) {
        onToast('Восстановление завершено', 'success');
      }
      if (msg.type === 'cloudStatus') {
        const providers = (msg.providers ?? []) as CloudProvider[];
        setConfiguredProviders(providers);
        setSelectedCloudProviders((prev) => prev.length > 0 ? prev.filter((item) => providers.includes(item)) : providers);
      }
      if (msg.type === 'cloudConfigSaved') {
        onToast(`${msg.provider === 'yandex' ? 'Yandex Disk' : 'Google Drive'} подключён`, 'success');
        vscode.postMessage({ type: 'cloudGetStatus', payload: {} });
      }
      if (msg.type === 'backupConfigSaved') onToast('Настройки бэкапов сохранены', 'success');
      if (msg.type === 'cloudUploadDone') onToast('Бэкап загружен в облако', 'success');
      if (msg.type === 'siteUpdated') {
        setSavingSiteSettings(false);
        onToast('Настройки сайта сохранены', 'success');
      }
      if (msg.type === 'error' && savingSiteSettings) setSavingSiteSettings(false);
      if (msg.type === 'siteCredentials' && msg.siteId === siteId) {
        setCreds({ adminUser: msg.adminUser, adminPass: msg.adminPass, dbName: msg.dbName, dbUser: msg.dbUser, dbPass: msg.dbPass, dbPort: msg.dbPort });
        setShowCreds(true);
      }
      if (msg.type === 'wpCliOutput') {
        setWpCliOutput(msg.output ?? '');
        setWpCliRunning(false);
      }
      if (msg.type === 'localAgentInstalled' && msg.siteId === siteId) {
        const ver = msg.version ? ` v${msg.version}` : '';
        onToast(`Плагин WPDock Agent${ver} установлен${msg.activated ? ' и активирован' : ''}`, 'success');
      }
      if (msg.type === 'remoteLinked' && msg.siteId === siteId) onToast('Remote привязан', 'success');
      if (msg.type === 'remoteUnlinked' && msg.siteId === siteId) onToast('Remote отвязан', 'info');
      if (msg.type === 'siteDeleted' && msg.siteId === siteId) {
        setOpenDangerMenu(false);
        onToast('Сайт удалён', 'info');
        navigate({ name: 'home' });
      }
      if (msg.type === 'siteReset' && msg.siteId === siteId) {
        setOpenDangerMenu(false);
        onToast('Сайт полностью сброшен', 'success');
      }
      if (msg.type === 'siteDbReset' && msg.siteId === siteId) {
        setOpenDangerMenu(false);
        onToast('База данных сброшена', 'success');
      }
      if (msg.type === 'siteReinstalled' && msg.siteId === siteId) {
        setOpenDangerMenu(false);
        onToast('WordPress переустановлен', 'success');
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getBackups', payload: { siteId } });
    vscode.postMessage({ type: 'cloudGetStatus', payload: {} });
    return () => window.removeEventListener('message', handler);
  }, [onToast, savingSiteSettings, siteId, navigate]);

  useEffect(() => {
    if (!openDangerMenu) {return;}

    const handleOutsideClick = (event: MouseEvent) => {
      if (!dangerMenuRef.current) {return;}
      if (!dangerMenuRef.current.contains(event.target as Node)) {
        setOpenDangerMenu(false);
      }
    };

    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, [openDangerMenu]);

  if (!site) {
    return <div className="page"><div className="empty-state"><h3>Сайт не найден</h3></div></div>;
  }

  const isRunning = site.status === 'running';
  const siteUrl = site.siteUrl ?? (site.ssl ? `https://${site.domain ?? 'localhost'}` : `http://${site.domain ?? 'localhost'}:${site.port}`);
  const displayUrl = (() => { try { const u = new URL(siteUrl); return `${u.protocol}//${u.hostname}`; } catch { return siteUrl; } })();

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const openOnly = (key: SectionKey) => {
    setOpenSections({
      overview: false,
      git: false,
      deploy: false,
      backup: false,
      settings: false,
      [key]: true,
    });
  };

  const handleGitStatus = () => vscode.postMessage({ type: 'gitStatus', payload: { siteId } });
  const handleCommitPush = () => {
    if (!gitMsg.trim()) return onToast('Введите сообщение коммита', 'error');
    vscode.postMessage({ type: 'gitCommitPush', payload: { siteId, message: gitMsg } });
    setGitMsg('');
  };
  const handleGitPull = () => vscode.postMessage({ type: 'gitPull', payload: { siteId } });
  const handleAddGitRemote = () => {
    if (!githubUrl.includes('github.com')) return onToast('Введите корректный GitHub URL', 'error');
    vscode.postMessage({ type: 'addGitRemote', payload: { siteId, githubUrl } });
  };
  const handleCreateRepo = () => {
    if (!newRepoName.trim()) return onToast('Введите имя репозитория', 'error');
    vscode.postMessage({ type: 'githubCreateRepo', payload: { name: newRepoName, description: site.name, private: newRepoPrivate, siteId } });
  };
  const handleCreateCloudBackup = () => {
    if (configuredProviders.length === 0) {
      openOnly('backup');
      navigate({ name: 'backup', siteId, tab: 'cloud' });
      onToast('Сначала настройте облачное хранилище', 'info');
      return;
    }
    if (selectedCloudProviders.length === 0) return onToast('Выберите, куда загружать бэкап', 'error');
    vscode.postMessage({ type: 'createCloudBackup', payload: { siteId, providers: selectedCloudProviders } });
  };
  const handleRunWpCli = () => {
    if (!wpCliCmd.trim()) return;
    setWpCliRunning(true);
    setWpCliOutput('');
    vscode.postMessage({ type: 'runWpCli', payload: { siteId, command: wpCliCmd } });
  };
  const buildEditableUrl = (domain: string, ssl: boolean, port?: number) => {
    if (domain.trim()) return `${ssl ? 'https' : 'http'}://${domain.trim()}`;
    return `http://localhost:${port ?? 80}`;
  };
  const parseEditableUrl = (value: string) => {
    const raw = value.trim();
    if (!raw) return { domain: '', ssl: false };
    const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
    try {
      const parsed = new URL(withScheme);
      return { domain: parsed.hostname, ssl: parsed.protocol === 'https:' };
    } catch {
      return {
        domain: raw.replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, ''),
        ssl: /^https:\/\//i.test(raw),
      };
    }
  };
  const toggleCloudProvider = (provider: CloudProvider) => {
    setSelectedCloudProviders((prev) => prev.includes(provider) ? prev.filter((item) => item !== provider) : [...prev, provider]);
  };
  const handleSaveSiteSettings = () => {
    const trimmedName = siteSettings.name.trim();
    if (!trimmedName) return onToast('Введите название сайта', 'error');
    setSavingSiteSettings(true);
    vscode.postMessage({ type: 'updateSite', payload: { siteId, updates: { name: trimmedName, webServer: siteSettings.webServer } } });
    vscode.postMessage({ type: 'updateDebug', payload: { siteId, wpDebug: siteSettings.wpDebug, wpDebugLog: siteSettings.wpDebugLog, wpScriptDebug: siteSettings.wpScriptDebug } });
    if (siteSettings.domain !== (site.domain ?? '') || siteSettings.ssl !== (site.ssl ?? false)) {
      vscode.postMessage({ type: 'updateDomain', payload: { siteId, domain: siteSettings.domain || undefined, ssl: siteSettings.ssl } });
    }
  };
  const providerLabel = (provider: CloudProvider) => provider === 'yandex' ? 'Yandex Disk' : 'Google Drive';

  const formatSize = (bytes: number) => {
    if (!bytes) return '—';
    const mb = bytes / (1024 * 1024);
    return mb >= 1 ? `${mb.toFixed(1)} МБ` : `${(bytes / 1024).toFixed(0)} КБ`;
  };
  const formatDate = (iso: string) => {
    try { return new Date(iso).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch { return iso; }
  };
  const handleRestoreBackup = (backupId: string) => {
    vscode.postMessage({ type: 'restoreBackup', payload: { backupId, siteId } });
    setOpenBackupMenu(null);
  };
  const handleDeleteCloudCopy = (backup: BackupEntry, provider: CloudProvider) => {
    const upload = backup.cloudUploads.find((u) => u.provider === provider);
    if (!upload) return;
    vscode.postMessage({ type: 'deleteCloudFile', payload: { backupId: backup.id, siteId, provider, remotePath: upload.remotePath } });
    setOpenBackupMenu(null);
  };
  const handleDeleteEverywhere = (backupId: string) => {
    vscode.postMessage({ type: 'deleteBackupEverywhere', payload: { backupId, siteId } });
    setOpenBackupMenu(null);
  };

  return (
    <div className={`page sidebar-detail-page ${projectMode ? 'project-site-page' : ''}`}>
      <div className="page-header">
        {!projectMode && <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>}
        <div className="page-title-wrap">
          <h1 className="page-title">{projectMode ? 'WPDock проекта' : site.name}</h1>
          <div className="page-subtitle">{displayUrl}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className={`badge ${isRunning ? 'badge-green' : site.status === 'starting' ? 'badge-yellow' : site.status === 'error' ? 'badge-red' : 'badge-gray'}`}>{site.status}</span>
          <span className="site-card-chip">PHP {site.phpVersion}</span>
          <span className="site-card-chip">{site.webServer ?? 'php'}</span>
          {site.domain && <span className="site-card-chip">{site.domain}</span>}
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{linkedRemotes.length}</span><span className="overview-stat-label">remotes</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{site.git?.repoInitialized ? 'git' : '—'}</span><span className="overview-stat-label">repo</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{site.dbName ?? '—'}</span><span className="overview-stat-label">db</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{isRunning ? 'on' : 'off'}</span><span className="overview-stat-label">runtime</span></div>
        </div>
        <div className="action-cluster">
          {isRunning ? (
            <>
              <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'stopSite', payload: { siteId } })}>⏹ Остановить</button>
              <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'forceRestartSite', payload: { siteId } })}>🔁 Перезапустить</button>
              <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: siteUrl } })}>🌐 Сайт</button>
              <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'autoLoginAdmin', payload: { siteId } })}>🔑 Админ</button>
            </>
          ) : (
            <>
              <button className="btn btn-primary" onClick={() => vscode.postMessage({ type: 'startSite', payload: { siteId } })}>▶ Запустить</button>
              <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'forceRestartSite', payload: { siteId } })}>🔁 Убить и запустить</button>
            </>
          )}
          <button className="btn btn-danger" onClick={() => vscode.postMessage({ type: 'forceStopSite', payload: { siteId } })}>⛔ Убить процессы</button>
          <button className="btn btn-secondary" disabled={!isRunning} onClick={() => vscode.postMessage({ type: 'openDatabase', payload: { siteId } })}>🗄 База</button>
          <button className="btn btn-secondary" disabled={!isRunning} onClick={() => vscode.postMessage({ type: 'openWpCliTerminal', payload: { siteId } })}>$ WP-CLI</button>
          <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'openLocalMailFolder', payload: { siteId } })}>✉ Почта</button>
          <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'openSiteLogs', payload: { siteId } })}>📜 Логи</button>
          <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'openInExplorer', payload: { siteId } })}>📁 Файлы</button>
        </div>
      </div>

      <AccordionSection title="Обзор" open={openSections.overview} onToggle={() => toggleSection('overview')}>
        <div className="detail-grid">
          <div className="card">
            <div className="card-header"><span className="card-title">Информация</span></div>
            {[
              ['Статус', site.status],
              ['URL', displayUrl],
              ['PHP', site.phpVersion],
              ['Веб-сервер', site.webServer ?? 'php'],
              ['База данных', site.dbName ?? '—'],
              ['Git', site.git?.repoInitialized ? (site.git.githubRepo ?? site.git.remoteUrl ?? 'локальный репозиторий создан') : 'не настроен'],
              ['Удалённые сайты', linkedRemotes.length > 0 ? linkedRemotes.map((r) => r.name).join(', ') : 'не подключены'],
            ].map(([label, value]) => (
              <div className="detail-info-row" key={label}><span className="detail-info-label">{label}</span><span className="detail-info-value">{value}</span></div>
            ))}
          </div>
          <div className="card">
            <div className="card-header"><span className="card-title">Быстрые действия</span></div>
            <div className="sidebar-preview-actions">
              {isRunning ? (
                <>
                  <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: siteUrl } })}>Открыть сайт</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'autoLoginAdmin', payload: { siteId } })}>Войти в админку</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'forceRestartSite', payload: { siteId } })}>Принудительно перезапустить</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary btn-sm" onClick={() => vscode.postMessage({ type: 'startSite', payload: { siteId } })}>Запустить сайт</button>
                  <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'forceRestartSite', payload: { siteId } })}>Убить и запустить</button>
                </>
              )}
              <button className="btn btn-danger btn-sm" onClick={() => vscode.postMessage({ type: 'forceStopSite', payload: { siteId } })}>Убить процессы</button>
              <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openInExplorer', payload: { siteId } })}>Открыть папку</button>
              <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openLocalMailFolder', payload: { siteId } })}>Открыть письма</button>
              <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openSiteLogs', payload: { siteId } })}>Открыть логи</button>
              <button className="btn btn-danger btn-sm" onClick={() => vscode.postMessage({ type: 'resetSite', payload: { siteId } })}>Полный сброс</button>
              <button className="btn btn-secondary btn-sm" onClick={() => openOnly('backup')}>Бэкапы</button>
              <button className="btn btn-secondary btn-sm" onClick={() => openOnly('settings')}>Настройки</button>
            </div>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection title="Git и GitHub" open={openSections.git} onToggle={() => toggleSection('git')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Локальный Git</span></div>
          <div className="section-copy">
            {site.git?.repoInitialized ? `Git уже включён${site.git.remoteUrl ? ` · ${site.git.remoteUrl}` : ''}` : 'Git ещё не включён для этого сайта'}
          </div>
          <div className="toolbar-wrap">
            <button className="btn btn-secondary btn-sm" onClick={handleGitStatus}>Обновить статус</button>
            {!site.git?.repoInitialized && <button className="btn btn-primary btn-sm" onClick={() => vscode.postMessage({ type: 'initGit', payload: { siteId } })}>Включить Git</button>}
            {site.git?.repoInitialized && <button className="btn btn-secondary btn-sm" onClick={handleGitPull}>Pull</button>}
          </div>
          {gitStatus && (
            <div className="section-copy">
              Ветка: {gitStatus.branch} · изменено: {gitStatus.modified.length} · новых: {gitStatus.untracked.length} · ahead: {gitStatus.ahead} · behind: {gitStatus.behind}
            </div>
          )}
          {site.git?.repoInitialized && (
            <div className="inline-form">
              <input className="input" placeholder="Сообщение коммита" value={gitMsg} onChange={(e) => setGitMsg(e.target.value)} />
              <button className="btn btn-primary" onClick={handleCommitPush}>Commit + Push</button>
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">GitHub</span></div>
          <div className="section-copy">Создайте новый репозиторий или привяжите существующий.</div>
          <div className="stack-sm">
            <div className="inline-form">
              <input className="input" placeholder="my-wordpress-site" value={newRepoName} onChange={(e) => setNewRepoName(e.target.value)} />
              <button className="btn btn-secondary" onClick={handleCreateRepo}>Создать repo</button>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={newRepoPrivate} onChange={(e) => setNewRepoPrivate(e.target.checked)} /> приватный репозиторий</label>
            <div className="inline-form">
              <input className="input" placeholder="https://github.com/user/repo.git" value={githubUrl} onChange={(e) => setGithubUrl(e.target.value)} />
              <button className="btn btn-secondary" onClick={handleAddGitRemote}>Привязать</button>
            </div>
            <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'github-manager', siteId })}>Открыть менеджер GitHub</button>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection title="Deploy и remotes" open={openSections.deploy} onToggle={() => toggleSection('deploy')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Плагин WPDock Agent</span></div>
          <div className="section-copy">Установить свежую версию плагина-агента WPDock прямо в этот локальный сайт (wp-content/plugins). Если сайт запущен — плагин будет автоматически активирован.</div>
          <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'installLocalAgent', payload: { siteId } })}>Установить плагин WPDock</button>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Подключённые remotes</span></div>
          {linkedRemotes.length === 0 ? <div className="section-copy">Удалённые сайты ещё не подключены.</div> : (
            <div className="stack-sm">
              {linkedRemotes.map((remote) => (
                <div key={remote.id} className="mini-item-card">
                  <div>
                    <div className="mini-item-title">{remote.name}</div>
                    <div className="mini-item-subtitle">{remote.url}</div>
                  </div>
                  <div className="toolbar-wrap">
                    <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId: remote.id, direction: 'pull', localSiteId: site.id, quickPull: true })}>Pull</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId: remote.id, direction: 'push', localSiteId: site.id })}>Push</button>
                    <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'remote-detail', remoteId: remote.id })}>Открыть</button>
                    <button className="btn btn-danger btn-sm" onClick={() => vscode.postMessage({ type: 'unlinkRemoteFromSite', payload: { siteId, remoteId: remote.id } })}>Отвязать</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Подключить remote</span></div>
          {availableRemotes.length > 0 && (
            <div className="inline-form" style={{ marginBottom: 10 }}>
              <select className="select" value={selectedRemoteId} onChange={(e) => setSelectedRemoteId(e.target.value)}>
                <option value="">Выберите подключение</option>
                {availableRemotes.map((remote) => <option key={remote.id} value={remote.id}>{remote.name}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" disabled={!selectedRemoteId} onClick={() => vscode.postMessage({ type: 'linkRemoteToSite', payload: { siteId, remoteId: selectedRemoteId } })}>Подключить</button>
            </div>
          )}
          <div className="section-copy">Если подключения ещё нет — создайте новое.</div>
          <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'connect-remote', siteId })}>Добавить новое подключение</button>
        </div>
      </AccordionSection>

      <AccordionSection title="Бэкапы" open={openSections.backup} onToggle={() => toggleSection('backup')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Создание и экспорт</span></div>
          <div className="sidebar-preview-actions">
            <button className="btn btn-primary" onClick={() => vscode.postMessage({ type: 'createBackup', payload: { siteId, includeDb: backupConfig?.includeDb ?? true, askTargetPath: true } })}>Локальный бэкап</button>
            <button className="btn btn-secondary" onClick={handleCreateCloudBackup}>В облако</button>
            <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'exportSite', payload: { siteId } })}>Экспорт ZIP</button>
            <button className="btn btn-secondary" onClick={() => navigate({ name: 'import-site' })}>Импорт ZIP</button>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Бэкапы этого сайта</span></div>
          {backups.length === 0 ? (
            <div className="section-copy">Бэкапов пока нет.</div>
          ) : (
            <div className="stack-sm">
              {backups.map((backup) => {
                const hasYandex = backup.cloudUploads.some((u) => u.provider === 'yandex');
                const hasGoogle = backup.cloudUploads.some((u) => u.provider === 'google');
                return (
                  <div key={backup.id} className="mini-item-card">
                    <div>
                      <div className="mini-item-title">{formatDate(backup.createdAt)}</div>
                      <div className="mini-item-subtitle">
                        {formatSize(backup.size)}{backup.includesDb ? ' · с БД' : ''}
                      </div>
                      <div className="toolbar-wrap" style={{ marginTop: 6, gap: 4 }}>
                        <span className="site-card-chip">💾 Локально</span>
                        {hasYandex && <span className="site-card-chip">☁ Yandex</span>}
                        {hasGoogle && <span className="site-card-chip">☁ Google</span>}
                      </div>
                    </div>
                    <div className="toolbar-wrap" style={{ position: 'relative' }}>
                      <button className="btn btn-secondary btn-sm" onClick={() => handleRestoreBackup(backup.id)}>Восстановить</button>
                      <button className="btn btn-danger btn-sm" onClick={() => setOpenBackupMenu(openBackupMenu === backup.id ? null : backup.id)}>Удалить ▾</button>
                      {openBackupMenu === backup.id && (
                        <div className="card" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10, marginTop: 4, padding: 6, minWidth: 180 }}>
                          {hasYandex && <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => handleDeleteCloudCopy(backup, 'yandex')}>С Yandex Disk</button>}
                          {hasGoogle && <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => handleDeleteCloudCopy(backup, 'google')}>С Google Drive</button>}
                          <button className="btn btn-danger btn-sm" style={{ width: '100%' }} onClick={() => handleDeleteEverywhere(backup.id)}>Удалить везде</button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Облако</span></div>
          {configuredProviders.length === 0 ? (
            <div className="stack-sm">
              <div className="section-copy">Облачное хранилище ещё не настроено.</div>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'backup', siteId, tab: 'cloud' })}>Настроить облако</button>
            </div>
          ) : (
            <div className="stack-sm">
              <div className="section-copy">Выберите, куда загружать бэкап:</div>
              {configuredProviders.map((provider) => (
                <label key={provider} className="checkbox-row">
                  <input type="checkbox" checked={selectedCloudProviders.includes(provider)} onChange={() => toggleCloudProvider(provider)} />
                  {providerLabel(provider)}
                </label>
              ))}
            </div>
          )}
        </div>
        {backupConfig && (
          <div className="card">
            <div className="card-header"><span className="card-title">Автобэкап</span></div>
            <div className="stack-sm">
              <label className="checkbox-row"><input type="checkbox" checked={backupConfig.autoBackup} onChange={(e) => setBackupConfig({ ...backupConfig, autoBackup: e.target.checked })} /> Включить автобэкапы</label>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Интервал</label>
                  <select className="form-input" value={backupConfig.intervalHours} onChange={(e) => setBackupConfig({ ...backupConfig, intervalHours: Number(e.target.value) })}>
                    <option value={6}>Каждые 6 часов</option><option value={12}>Каждые 12 часов</option><option value={24}>Ежедневно</option><option value={168}>Еженедельно</option>
                  </select>
                </div>
                <div className="form-group">
                  <label className="form-label">Хранить</label>
                  <select className="form-input" value={backupConfig.keepCount} onChange={(e) => setBackupConfig({ ...backupConfig, keepCount: Number(e.target.value) })}>
                    <option value={3}>3</option><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option>
                  </select>
                </div>
              </div>
              <label className="checkbox-row"><input type="checkbox" checked={backupConfig.includeDb} onChange={(e) => setBackupConfig({ ...backupConfig, includeDb: e.target.checked })} /> Включать базу данных</label>
              <button className="btn btn-primary" onClick={() => vscode.postMessage({ type: 'saveBackupConfig', payload: { config: { ...backupConfig, cloudProviders: selectedCloudProviders } } })}>Сохранить настройки</button>
            </div>
          </div>
        )}
      </AccordionSection>

      <AccordionSection title="Настройки" open={openSections.settings} onToggle={() => toggleSection('settings')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Основные</span></div>
          <div className="form-group">
            <label className="form-label">Название сайта</label>
            <input className="input" value={siteSettings.name} onChange={(e) => setSiteSettings((prev) => ({ ...prev, name: e.target.value }))} />
          </div>
          <div className="form-group">
            <label className="form-label">URL сайта</label>
            <input className="input" value={buildEditableUrl(siteSettings.domain, siteSettings.ssl, site?.port)} onChange={(e) => {
              const parsed = parseEditableUrl(e.target.value);
              setSiteSettings((prev) => ({ ...prev, domain: parsed.domain, ssl: parsed.ssl }));
            }} />
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Версия PHP</label>
              <input className="input" value={site.phpVersion} disabled style={{ opacity: 0.6, cursor: 'not-allowed' }} />
            </div>
            <div className="form-group">
              <label className="form-label">Веб-сервер</label>
              <select className="select" value={siteSettings.webServer} onChange={(e) => setSiteSettings((prev) => ({ ...prev, webServer: e.target.value as 'php' | 'nginx' | 'apache' }))}>
                <option value="php">PHP встроенный сервер</option><option value="nginx">Nginx</option><option value="apache">Apache</option>
              </select>
            </div>
          </div>
          <div className="stack-sm">
            <label className="checkbox-row"><input type="checkbox" checked={siteSettings.ssl} onChange={() => setSiteSettings((prev) => ({ ...prev, ssl: !prev.ssl }))} /> Включить HTTPS / SSL</label>
            <label className="checkbox-row"><input type="checkbox" checked={siteSettings.wpDebug} onChange={() => setSiteSettings((prev) => ({ ...prev, wpDebug: !prev.wpDebug }))} /> WP_DEBUG</label>
            <label className="checkbox-row"><input type="checkbox" checked={siteSettings.wpDebugLog} onChange={() => setSiteSettings((prev) => ({ ...prev, wpDebugLog: !prev.wpDebugLog }))} /> WP_DEBUG_LOG</label>
            <label className="checkbox-row"><input type="checkbox" checked={siteSettings.wpScriptDebug} onChange={() => setSiteSettings((prev) => ({ ...prev, wpScriptDebug: !prev.wpScriptDebug }))} /> SCRIPT_DEBUG</label>
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Доступ и WP-CLI</span></div>
          <div className="detail-info-row"><span className="detail-info-label">Логин</span><span className="detail-info-value">{site.adminUser ?? '—'}</span></div>
          <div className="detail-info-row"><span className="detail-info-label">Email</span><span className="detail-info-value">{site.adminEmail ?? '—'}</span></div>
          {showCreds && creds && (
            <div className="section-copy" style={{ marginTop: 10 }}>
              <div>Пароль: {creds.adminPass}</div>
              <div>Пользователь БД: {creds.dbUser}</div>
              <div>Пароль БД: {creds.dbPass}</div>
            </div>
          )}
          <div className="toolbar-wrap" style={{ marginTop: 10 }}>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'getSiteCredentials', payload: { siteId } })}>{showCreds ? 'Обновить пароли' : 'Показать пароли'}</button>
            <button className="btn btn-secondary btn-sm" disabled={!isRunning} onClick={() => vscode.postMessage({ type: 'openDatabase', payload: { siteId } })}>Открыть БД</button>
            <button className="btn btn-secondary btn-sm" disabled={!isRunning} onClick={() => vscode.postMessage({ type: 'openWpCliTerminal', payload: { siteId } })}>Открыть WP-CLI</button>
          </div>
          <div className="inline-form" style={{ marginTop: 12 }}>
            <input className="input" disabled={!isRunning} placeholder="wp plugin list" value={wpCliCmd} onChange={(e) => setWpCliCmd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && isRunning && handleRunWpCli()} />
            <button className="btn btn-primary" disabled={!isRunning || wpCliRunning} onClick={handleRunWpCli}>{wpCliRunning ? '...' : 'Выполнить'}</button>
          </div>
          {wpCliOutput && <pre className="cli-output">{wpCliOutput}</pre>}
        </div>
        <div className="toolbar-wrap">
          <button className="btn btn-primary" onClick={handleSaveSiteSettings} disabled={savingSiteSettings}>{savingSiteSettings ? 'Сохранение...' : 'Сохранить настройки'}</button>
          <button className="btn btn-secondary" onClick={() => setSiteSettings({
            name: site.name ?? '',
            domain: site.domain ?? '',
            ssl: site.ssl ?? false,
            webServer: (site.webServer ?? 'php') as 'php' | 'nginx' | 'apache',
            wpDebug: site.wpDebug ?? false,
            wpDebugLog: site.wpDebugLog ?? false,
            wpScriptDebug: site.wpScriptDebug ?? false,
          })}>Сбросить</button>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Опасная зона</span></div>
          <div className="section-copy">Полный сброс пересоздаст файлы и базу сайта с чистым WordPress. Удаление сайта остановит его и удалит запись. Можно также удалить все файлы и базу данных с диска.</div>
          <div className="toolbar-wrap" style={{ marginTop: 10, position: 'relative' }} ref={dangerMenuRef}>
            <button className="btn btn-danger" onClick={() => setOpenDangerMenu((prev) => !prev)}>
              Опасные действия {openDangerMenu ? '▴' : '▾'}
            </button>
            {openDangerMenu && (
              <div className="card" style={{ position: 'absolute', top: '100%', left: 0, zIndex: 10, marginTop: 6, padding: 6, minWidth: 280 }}>
                <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 6 }} onClick={() => {
                  setOpenDangerMenu(false);
                  vscode.postMessage({ type: 'resetSiteDatabase', payload: { siteId } });
                }}>🗄 Сбросить только БД</button>
                <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 6 }} onClick={() => {
                  setOpenDangerMenu(false);
                  vscode.postMessage({ type: 'reinstallSiteKeepContent', payload: { siteId } });
                }}>♻ Переустановить WP без удаления wp-content</button>
                <button className="btn btn-danger btn-sm" style={{ width: '100%', marginBottom: 6 }} onClick={() => {
                  setOpenDangerMenu(false);
                  vscode.postMessage({ type: 'resetSite', payload: { siteId } });
                }}>↺ Полный сброс</button>
                <button className="btn btn-danger btn-sm" style={{ width: '100%' }} onClick={() => {
                  setOpenDangerMenu(false);
                  vscode.postMessage({ type: 'deleteSite', payload: { siteId } });
                }}>🗑 Удалить сайт</button>
              </div>
            )}
          </div>
        </div>
      </AccordionSection>

      <div className="sticky-bottom-bar">
        {isRunning ? (
          <>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: siteUrl } })}>🌐 Сайт</button>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'autoLoginAdmin', payload: { siteId } })}>🔑 Админ</button>
          </>
        ) : (
          <button className="btn btn-primary btn-sm" onClick={() => vscode.postMessage({ type: 'startSite', payload: { siteId } })}>▶ Запуск</button>
        )}
        <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openInExplorer', payload: { siteId } })}>📁 Файлы</button>
        <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openSiteLogs', payload: { siteId } })}>📜 Логи</button>
        <button className="btn btn-secondary btn-sm" onClick={() => openOnly('settings')}>⚙ Настройки</button>
      </div>
    </div>
  );
}

function AccordionSection({ title, open, onToggle, children }: { title: string; open: boolean; onToggle: () => void; children: React.ReactNode }) {
  return (
    <section className={`accordion-section ${open ? 'open' : ''}`}>
      <button className="accordion-trigger" onClick={onToggle}>
        <span>{title}</span>
        <span className="accordion-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="accordion-body">{children}</div>}
    </section>
  );
}
