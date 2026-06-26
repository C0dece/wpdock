import React, { useEffect, useState, useCallback } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';
import { WPSite } from '../types';

interface BackupEntry {
  id: string;
  siteId: string;
  siteName: string;
  createdAt: string;
  size: number;
  localPath: string;
  includesDb: boolean;
  source?: 'local' | 'cloud' | 'export';
  backupKind?: 'site-backup' | 'zip-export';
  cloudUploads: { provider: string; remotePath: string; uploadedAt: string }[];
}

interface BackupConfig {
  autoBackup: boolean;
  intervalHours: number;
  keepCount: number;
  includeDb: boolean;
  cloudProviders: string[];
}

interface Props {
  siteId?: string;
  initialTab?: 'backups' | 'cloud' | 'settings';
  sites: WPSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

type CloudProvider = 'yandex' | 'google';

export default function BackupPage({ siteId, initialTab = 'backups', sites, navigate, onToast }: Props) {
  const [tab, setTab] = useState<'backups' | 'cloud' | 'settings'>(initialTab);
  const [backups, setBackups] = useState<BackupEntry[]>([]);
  const [config, setConfig] = useState<BackupConfig | null>(null);
  const [configuredProviders, setConfiguredProviders] = useState<CloudProvider[]>([]);
  const [selectedCloudProviders, setSelectedCloudProviders] = useState<CloudProvider[]>([]);
  const [available, setAvailable] = useState<{ yandex: boolean; google: boolean }>({ yandex: false, google: false });
  const [selectedSiteId, setSelectedSiteId] = useState(siteId ?? sites[0]?.id ?? '');
  const [progressMsg, setProgressMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [openMenu, setOpenMenu] = useState<string | null>(null);

  useEffect(() => {
    if (siteId) setSelectedSiteId(siteId);
  }, [siteId]);

  useEffect(() => {
    setTab(initialTab);
  }, [initialTab]);

  const loadData = useCallback(() => {
    vscode.postMessage({ type: 'getBackups', payload: { siteId: selectedSiteId || undefined } });
    vscode.postMessage({ type: 'cloudGetStatus', payload: {} });
  }, [selectedSiteId]);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case 'backupsData':
          setBackups(msg.backups ?? []);
          setConfig(msg.config ?? null);
          break;
        case 'cloudStatus':
          setConfiguredProviders(msg.providers ?? []);
          // По умолчанию выбираем все подключённые провайдеры
          setSelectedCloudProviders(msg.providers ?? []);
          setAvailable(msg.available ?? { yandex: false, google: false });
          break;
        case 'cloudConfigSaved':
          setBusy(false);
          setProgressMsg('');
          onToast(`${msg.provider === 'yandex' ? 'Yandex Disk' : 'Google Drive'} подключён`, 'success');
          loadData();
          break;
        case 'backupCreated':
          setBusy(false);
          setProgressMsg('');
          onToast('Локальный бэкап создан', 'success');
          loadData();
          break;
        case 'backupRestored':
          setBusy(false);
          setProgressMsg('');
          onToast('Восстановление завершено', 'success');
          break;
        case 'siteExported':
          setBusy(false);
          setProgressMsg('');
          onToast('ZIP экспорт готов', 'success');
          loadData();
          break;
        case 'cloudUploadDone':
          setBusy(false);
          setProgressMsg('');
          onToast('Бэкап загружен в облако', 'success');
          loadData();
          break;
        case 'cloudFileDeleted':
          setOpenMenu(null);
          onToast('Облачная копия удалена', 'info');
          break;
        case 'backupConfigSaved':
          onToast('Настройки бэкапов сохранены', 'success');
          break;
        case 'progress':
          setProgressMsg(msg.message ?? '');
          break;
        case 'error':
          setBusy(false);
          setProgressMsg('');
          break;
      }
    };
    window.addEventListener('message', handler);
    loadData();
    return () => window.removeEventListener('message', handler);
  }, [loadData, onToast]);

  const selectedSite = sites.find((s) => s.id === selectedSiteId);

  const handleCreateBackup = () => {
    if (!selectedSiteId) return onToast('Выберите сайт', 'error');
    setBusy(true);
    vscode.postMessage({ type: 'createBackup', payload: { siteId: selectedSiteId, includeDb: config?.includeDb ?? true, askTargetPath: true } });
  };

  const toggleCloudProvider = (p: CloudProvider) => {
    setSelectedCloudProviders((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);
  };

  const handleCreateCloudBackup = () => {
    if (!selectedSiteId) return onToast('Выберите сайт', 'error');
    if (configuredProviders.length === 0) {
      setTab('cloud');
      return onToast('Сначала настройте облако', 'info');
    }
    const targets = selectedCloudProviders.filter((p) => configuredProviders.includes(p));
    if (targets.length === 0) return onToast('Выберите хотя бы одно облако', 'error');
    setBusy(true);
    vscode.postMessage({ type: 'createCloudBackup', payload: { siteId: selectedSiteId, providers: targets } });
  };

  const handleExport = () => {
    if (!selectedSiteId) return onToast('Выберите сайт', 'error');
    setBusy(true);
    vscode.postMessage({ type: 'exportSite', payload: { siteId: selectedSiteId } });
  };

  const handleRestore = (backup: BackupEntry) => {
    if (!selectedSiteId) return onToast('Выберите сайт назначения', 'error');
    setBusy(true);
    vscode.postMessage({ type: 'restoreBackup', payload: { backupId: backup.id, siteId: selectedSiteId } });
  };

  const handleDelete = (backup: BackupEntry) => {
    vscode.postMessage({ type: 'deleteBackup', payload: { backupId: backup.id, siteId: selectedSiteId || undefined } });
    setBackups((prev) => prev.filter((item) => item.id !== backup.id));
    setOpenMenu(null);
  };

  const handleDeleteCloudCopy = (backup: BackupEntry, provider: CloudProvider) => {
    const upload = backup.cloudUploads.find((u) => u.provider === provider);
    if (!upload) return;
    vscode.postMessage({ type: 'deleteCloudFile', payload: { backupId: backup.id, siteId: selectedSiteId || undefined, provider, remotePath: upload.remotePath } });
    setOpenMenu(null);
  };

  const handleDeleteEverywhere = (backup: BackupEntry) => {
    vscode.postMessage({ type: 'deleteBackupEverywhere', payload: { backupId: backup.id, siteId: selectedSiteId || undefined } });
    setBackups((prev) => prev.filter((item) => item.id !== backup.id));
    setOpenMenu(null);
  };

  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  const handleYandexBrowserAuth = () => {
    if (!available.yandex) return onToast('Вход в Yandex недоступен: OAuth не настроен в расширении', 'error');
    setBusy(true);
    setProgressMsg('Ожидание входа через браузер...');
    vscode.postMessage({ type: 'cloudStartYandexAuth', payload: {} });
  };

  const handleGoogleBrowserAuth = () => {
    if (!available.google) return onToast('Вход в Google недоступен: OAuth не настроен в расширении', 'error');
    setBusy(true);
    setProgressMsg('Ожидание входа через браузер...');
    vscode.postMessage({ type: 'cloudStartGoogleAuth', payload: {} });
  };

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Бэкапы</h1>
          <div className="page-subtitle">{selectedSite ? selectedSite.name : 'Все сайты'}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className="badge badge-green">backup</span>
          <span className="site-card-chip">{selectedSite ? selectedSite.name : 'all sites'}</span>
          <span className="site-card-chip">{configuredProviders.length > 0 ? configuredProviders.join(', ') : 'no cloud'}</span>
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{backups.length}</span><span className="overview-stat-label">архивов</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{configuredProviders.length}</span><span className="overview-stat-label">cloud</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{config?.autoBackup ? 'on' : 'off'}</span><span className="overview-stat-label">auto</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{config?.includeDb ? 'db' : 'files'}</span><span className="overview-stat-label">scope</span></div>
        </div>
        <div className="form-group" style={{ marginBottom: 0 }}>
          <label className="form-label">Сайт</label>
          <select className="form-input" value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
            <option value="">— Все сайты —</option>
            {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {configuredProviders.length > 0 && (
          <div className="form-group" style={{ marginBottom: 0 }}>
            <label className="form-label">Куда грузить в облако</label>
            <div className="toolbar-wrap">
              {configuredProviders.map((p) => (
                <label key={p} className="checkbox-row" style={{ marginRight: 12 }}>
                  <input
                    type="checkbox"
                    checked={selectedCloudProviders.includes(p)}
                    onChange={() => toggleCloudProvider(p)}
                  />{' '}
                  {p === 'yandex' ? 'Yandex Disk' : 'Google Drive'}
                </label>
              ))}
            </div>
          </div>
        )}
        <div className="action-cluster">
          <button className="btn btn-primary" onClick={handleCreateBackup} disabled={busy || !selectedSiteId}>Локальный бэкап</button>
          <button className="btn btn-secondary" onClick={handleCreateCloudBackup} disabled={busy || !selectedSiteId}>В облако</button>
          <button className="btn btn-secondary" onClick={handleExport} disabled={busy || !selectedSiteId}>Экспорт ZIP</button>
          <button className="btn btn-secondary" onClick={() => navigate({ name: 'import-site' })}>Импорт ZIP</button>
        </div>
      </div>

      {progressMsg && (
        <div className="card">
          <div className="section-copy">⏳ {progressMsg}</div>
          <div className="progress-bar" style={{ marginTop: 8 }}>
            <div className="progress-fill" style={{ width: '60%' }} />
          </div>
        </div>
      )}

      <div className="tabs tabs-compact">
        {(['backups', 'cloud', 'settings'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`tab-btn ${tab === t ? 'active' : ''}`}>
            {t === 'backups' ? `Архивы (${backups.length})` : t === 'cloud' ? 'Облако' : 'Авто-бэкап'}
          </button>
        ))}
      </div>

      {tab === 'backups' && (
        backups.length === 0 ? <div className="empty-state"><p>Бэкапов пока нет</p></div> : (
          <div className="stack-sm">
            {backups.map((backup) => (
              <div key={backup.id} className="mini-item-card">
                <div>
                  <div className="mini-item-title">{backup.siteName}</div>
                  <div className="mini-item-subtitle">
                    {new Date(backup.createdAt).toLocaleString()} · {formatSize(backup.size)} · {backup.includesDb ? 'с БД' : 'без БД'}
                  </div>
                  <div className="section-copy">
                    {backup.cloudUploads.length > 0 ? `Облако: ${backup.cloudUploads.map((c) => c.provider).join(', ')}` : 'Локальный файл'}
                  </div>
                </div>
                <div className="toolbar-wrap" style={{ position: 'relative' }}>
                  <button className="btn btn-secondary btn-sm" onClick={() => handleRestore(backup)} disabled={busy}>Восстановить</button>
                  <button className="btn btn-danger btn-sm" onClick={() => setOpenMenu(openMenu === backup.id ? null : backup.id)} disabled={busy}>Удалить ▾</button>
                  {openMenu === backup.id && (
                    <div className="card" style={{ position: 'absolute', top: '100%', right: 0, zIndex: 10, marginTop: 4, padding: 6, minWidth: 190 }}>
                      <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => handleDelete(backup)}>Только локально</button>
                      {backup.cloudUploads.some((u) => u.provider === 'yandex') && (
                        <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => handleDeleteCloudCopy(backup, 'yandex')}>С Yandex Disk</button>
                      )}
                      {backup.cloudUploads.some((u) => u.provider === 'google') && (
                        <button className="btn btn-secondary btn-sm" style={{ width: '100%', marginBottom: 4 }} onClick={() => handleDeleteCloudCopy(backup, 'google')}>С Google Drive</button>
                      )}
                      <button className="btn btn-danger btn-sm" style={{ width: '100%' }} onClick={() => handleDeleteEverywhere(backup)}>Удалить везде</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )
      )}

      {tab === 'cloud' && (
        <div className="stack-sm">
          <div className="card">
            <div className="card-header">
              <span className="card-title">Yandex Disk</span>
              {configuredProviders.includes('yandex') && <span className="badge badge-green">Подключён</span>}
            </div>
            <div className="section-copy" style={{ marginBottom: 10 }}>
              {configuredProviders.includes('yandex')
                ? 'Аккаунт подключён.'
                : available.yandex
                  ? 'Нажмите «Войти» — откроется браузер для авторизации.'
                  : 'OAuth не настроен в расширении (заполните cloudAuth.ts).'}
            </div>
            <div className="toolbar-wrap">
              {!configuredProviders.includes('yandex') && (
                <button
                  className="btn btn-primary"
                  onClick={handleYandexBrowserAuth}
                  disabled={busy || !available.yandex}
                >
                  Войти
                </button>
              )}
              {configuredProviders.includes('yandex') && (
                <button
                  className="btn btn-danger"
                  onClick={() => vscode.postMessage({ type: 'cloudDisconnect', payload: { provider: 'yandex' } })}
                >
                  Отключить
                </button>
              )}
            </div>
          </div>

          <div className="card">
            <div className="card-header">
              <span className="card-title">Google Drive</span>
              {configuredProviders.includes('google') && <span className="badge badge-green">Подключён</span>}
            </div>
            <div className="section-copy" style={{ marginBottom: 10 }}>
              {configuredProviders.includes('google')
                ? 'Аккаунт подключён.'
                : available.google
                  ? 'Нажмите «Войти» — откроется браузер для авторизации.'
                  : 'OAuth не настроен в расширении (заполните cloudAuth.ts).'}
            </div>
            <div className="toolbar-wrap">
              {!configuredProviders.includes('google') && (
                <button
                  className="btn btn-primary"
                  onClick={handleGoogleBrowserAuth}
                  disabled={busy || !available.google}
                >
                  Войти
                </button>
              )}
              {configuredProviders.includes('google') && (
                <button
                  className="btn btn-danger"
                  onClick={() => vscode.postMessage({ type: 'cloudDisconnect', payload: { provider: 'google' } })}
                >
                  Отключить
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {tab === 'settings' && config && (
        <div className="card">
          <div className="card-header"><span className="card-title">Авто-бэкап</span></div>
          <div className="stack-sm">
            <label className="checkbox-row"><input type="checkbox" checked={config.autoBackup} onChange={(e) => setConfig({ ...config, autoBackup: e.target.checked })} /> Включить авто-бэкап</label>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Интервал</label>
                <select className="form-input" value={config.intervalHours} onChange={(e) => setConfig({ ...config, intervalHours: Number(e.target.value) })}>
                  <option value={6}>6 часов</option><option value={12}>12 часов</option><option value={24}>1 день</option><option value={168}>1 неделя</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Хранить</label>
                <select className="form-input" value={config.keepCount} onChange={(e) => setConfig({ ...config, keepCount: Number(e.target.value) })}>
                  <option value={3}>3</option><option value={5}>5</option><option value={10}>10</option><option value={20}>20</option>
                </select>
              </div>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={config.includeDb} onChange={(e) => setConfig({ ...config, includeDb: e.target.checked })} /> Включать БД</label>
            <div className="form-group">
              <label className="form-label">Облако для авто-бэкапа</label>
              {configuredProviders.length === 0 ? (
                <div className="section-copy">Облако не подключено — авто-бэкап будет только локальным. Подключите облако во вкладке «Облако».</div>
              ) : (
                <div className="stack-sm">
                  {configuredProviders.map((p) => (
                    <label key={p} className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={config.cloudProviders.includes(p)}
                        onChange={(e) => setConfig({
                          ...config,
                          cloudProviders: e.target.checked
                            ? [...config.cloudProviders, p]
                            : config.cloudProviders.filter((x) => x !== p),
                        })}
                      />{' '}
                      {p === 'yandex' ? 'Yandex Disk' : 'Google Drive'}
                    </label>
                  ))}
                </div>
              )}
            </div>
            <button className="btn btn-primary" onClick={() => vscode.postMessage({ type: 'saveBackupConfig', payload: { config } })}>Сохранить</button>
          </div>
        </div>
      )}
    </div>
  );
}
