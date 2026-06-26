import React, { useState } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface CloudFileInfo {
  name: string;
  path: string;
  size: number;
  modifiedAt: string;
  provider: 'yandex' | 'google';
}

interface ZipAnalysis {
  zipPath: string;
  detectedName: string;
  phpVersion: string;
  hasDb: boolean;
  dbFileName: string;
  tablePrefix: string;
  hasWpContent: boolean;
  wpContentPath: string;
  backupPlugin: string;
}

interface Props {
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

export default function ImportSitePage({ navigate, onToast }: Props) {
  const [tab, setTab] = useState<'zip' | 'cloud'>('zip');
  const [analyzing, setAnalyzing] = useState(false);
  const [zipAnalysis, setZipAnalysis] = useState<ZipAnalysis | null>(null);
  const [siteName, setSiteName] = useState('');
  const [phpVersion, setPhpVersion] = useState('8.2');
  const [webServer, setWebServer] = useState<'php' | 'nginx' | 'apache'>('nginx');
  const [adminUser, setAdminUser] = useState('admin');
  const [adminPassword, setAdminPassword] = useState('admin123');
  const [adminEmail, setAdminEmail] = useState('admin@example.com');
  const [busy, setBusy] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [progressPercent, setProgressPercent] = useState(0);
  const [cloudProviders, setCloudProviders] = useState<('yandex' | 'google')[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<'yandex' | 'google'>('yandex');
  const [cloudFiles, setCloudFiles] = useState<CloudFileInfo[]>([]);
  const [selectedFile, setSelectedFile] = useState<CloudFileInfo | null>(null);
  const [loadingFiles, setLoadingFiles] = useState(false);

  React.useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;

      if (msg.type === 'zipAnalyzed') {
        const a = msg as ZipAnalysis & { type: string };
        setZipAnalysis(a);
        if (a.detectedName) setSiteName(a.detectedName);
        if (a.phpVersion) setPhpVersion(a.phpVersion);
        setAnalyzing(false);
        setProgressMsg('');
        setProgressPercent(0);
      }
      if (msg.type === 'siteImported') {
        setProgressPercent(100);
        setProgressMsg('Готово!');
        setTimeout(() => {
          setBusy(false);
          setProgressMsg('');
          setProgressPercent(0);
          onToast(`Сайт "${msg.site.name}" импортирован!`, 'success');
          navigate({ name: 'site-detail', siteId: msg.site.id });
        }, 600);
      }
      if (msg.type === 'importCancelled') {
        setBusy(false);
        setAnalyzing(false);
        setProgressMsg('');
        setProgressPercent(0);
      }
      if (msg.type === 'progress') {
        setProgressMsg(msg.message);
        const m = msg.message as string;
        if (m.includes('Анализ архива') || m.includes('Analysing')) setProgressPercent(8);
        else if (m.includes('wp-content найден') || m.includes('База данных найдена') || m.includes('Анализ завершён')) setProgressPercent(15);
        else if (m.includes('Создание сайта') || m.includes('Creating site')) setProgressPercent(30);
        else if (m.includes('Восстановление файлов') || m.includes('Restoring wp-content')) setProgressPercent(60);
        else if (m.includes('Восстановление базы данных') || m.includes('Restoring database')) setProgressPercent(75);
        else if (m.includes('База данных восстановлена') || m.includes('Database restored')) setProgressPercent(85);
        else if (m.includes('Постоянные ссылки') || m.includes('URL обновлены') || m.includes('Updating URLs')) setProgressPercent(93);
        else if (m.includes('Скачивание') || m.includes('Downloading')) setProgressPercent(15);
      }
      if (msg.type === 'error') {
        setBusy(false);
        setAnalyzing(false);
        setProgressMsg('');
        setProgressPercent(0);
        setLoadingFiles(false);
      }
      if (msg.type === 'cloudStatus') {
        setCloudProviders(msg.providers ?? []);
        if (msg.providers?.length > 0 && !msg.providers.includes(selectedProvider)) setSelectedProvider(msg.providers[0]);
      }
      if (msg.type === 'cloudFilesList') {
        setCloudFiles(msg.files ?? []);
        setLoadingFiles(false);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'cloudGetStatus' });
    return () => window.removeEventListener('message', handler);
  }, [navigate, onToast, selectedProvider]);

  const handleSelectZip = () => {
    setZipAnalysis(null);
    setAnalyzing(true);
    setProgressPercent(5);
    setProgressMsg('Открытие диалога...');
    vscode.postMessage({ type: 'analyzeImportZip' });
  };

  const handleImportZip = () => {
    if (!zipAnalysis) return;
    if (!siteName.trim()) return onToast('Введите имя сайта', 'error');
    if (!adminEmail.includes('@')) return onToast('Введите корректный email', 'error');
    setBusy(true);
    setProgressPercent(5);
    setProgressMsg('Начало импорта...');
    vscode.postMessage({
      type: 'importSite',
      payload: {
        zipPath: zipAnalysis.zipPath,
        options: { name: siteName, phpVersion, webServer, adminUser, adminPassword, adminEmail },
      },
    });
  };

  const handleCancelZip = () => {
    vscode.postMessage({ type: 'cancelImport' });
    setZipAnalysis(null);
    setAnalyzing(false);
    setBusy(false);
    setProgressMsg('');
    setProgressPercent(0);
  };

  const handleLoadCloudFiles = () => {
    setLoadingFiles(true);
    setCloudFiles([]);
    setSelectedFile(null);
    vscode.postMessage({ type: 'cloudListFiles', payload: { provider: selectedProvider } });
  };

  const handleImportFromCloud = () => {
    if (!selectedFile) return onToast('Выберите файл для импорта', 'error');
    if (!siteName.trim()) return onToast('Введите имя сайта', 'error');
    if (!adminEmail.includes('@')) return onToast('Введите корректный email', 'error');
    setBusy(true);
    setProgressPercent(5);
    setProgressMsg('Скачивание из облака...');
    vscode.postMessage({
      type: 'importFromCloud',
      payload: {
        provider: selectedFile.provider,
        remotePath: selectedFile.path,
        options: { name: siteName, phpVersion, webServer, adminUser, adminPassword, adminEmail },
      },
    });
  };

  const progressBar = (busy || analyzing) ? (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--fg2)', marginBottom: 5 }}>
        <span>{progressMsg || 'Подготовка...'}</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>{progressPercent}%</span>
      </div>
      <div className="progress-bar">
        <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
      </div>
    </div>
  ) : null;

  const siteSettingsForm = (
    <div className="card">
      <div className="card-header"><span className="card-title">Новый локальный сайт</span></div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Имя сайта *</label>
          <input className="form-input" placeholder="Мой сайт" value={siteName} onChange={(e) => setSiteName(e.target.value)} disabled={busy} />
        </div>
        <div className="form-group">
          <label className="form-label">Версия PHP</label>
          <select className="form-input" value={phpVersion} onChange={(e) => setPhpVersion(e.target.value)} disabled={busy}>
            <option value="8.3">PHP 8.3</option><option value="8.2">PHP 8.2</option><option value="8.1">PHP 8.1</option><option value="8.0">PHP 8.0</option><option value="7.4">PHP 7.4</option>
          </select>
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Веб-сервер</label>
          <select className="form-input" value={webServer} onChange={(e) => setWebServer(e.target.value as 'php' | 'nginx' | 'apache')} disabled={busy}>
            <option value="nginx">Nginx</option><option value="apache">Apache</option><option value="php">PHP built-in</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label">Имя админа</label>
          <input className="form-input" placeholder="admin" value={adminUser} onChange={(e) => setAdminUser(e.target.value)} disabled={busy} />
        </div>
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">Пароль админа</label>
          <input className="form-input" type="password" placeholder="strong password" value={adminPassword} onChange={(e) => setAdminPassword(e.target.value)} disabled={busy} />
        </div>
        <div className="form-group">
          <label className="form-label">Email админа</label>
          <input className="form-input" type="email" placeholder="admin@example.com" value={adminEmail} onChange={(e) => setAdminEmail(e.target.value)} disabled={busy} />
        </div>
      </div>
    </div>
  );

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Импорт сайта</h1>
          <div className="page-subtitle">{tab === 'zip' ? (zipAnalysis?.zipPath.split(/[\\/]/).pop() || 'Локальный ZIP import') : 'Cloud backup import'}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className="badge badge-green">import</span>
          <span className="site-card-chip">{tab}</span>
          <span className="site-card-chip">PHP {phpVersion}</span>
          <span className="site-card-chip">{webServer}</span>
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{zipAnalysis ? 'zip' : tab}</span><span className="overview-stat-label">source</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{zipAnalysis?.hasDb ? 'db' : 'files'}</span><span className="overview-stat-label">payload</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{cloudProviders.length}</span><span className="overview-stat-label">cloud</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{busy || analyzing ? 'run' : 'idle'}</span><span className="overview-stat-label">state</span></div>
        </div>
        <div className="section-copy">
          Импортирует WPDock-экспорты, ZIP-бэкапы и облачные архивы. Сначала выбирается источник, потом создаётся новый локальный сайт.
        </div>
      </div>

      <div className="tabs tabs-compact">
        {(['zip', 'cloud'] as const).map((t) => (
          <button key={t} className={`tab-btn ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'zip' ? '↙ ZIP' : '☁ Облако'}
          </button>
        ))}
      </div>

      {tab === 'zip' && (
        <div className="stack-sm">
          {!zipAnalysis ? (
            <div className="card">
              <div className="empty-state" style={{ padding: '20px 8px' }}>
                <div className="icon">📦</div>
                <h3>Выберите ZIP-архив</h3>
                <p>Архив будет проанализирован: определятся имя, PHP и наличие базы данных.</p>
                <button className="btn btn-primary" onClick={handleSelectZip} disabled={analyzing}>
                  {analyzing ? '⏳ Анализ...' : '↙ Выбрать ZIP'}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="card-header"><span className="card-title">Результат анализа</span></div>
                <div className="site-card-meta-row">
                  <span className="site-card-chip">PHP {zipAnalysis.phpVersion}</span>
                  <span className="site-card-chip">{zipAnalysis.hasWpContent ? 'wp-content ok' : 'no wp-content'}</span>
                  <span className="site-card-chip">{zipAnalysis.hasDb ? zipAnalysis.dbFileName : 'no db'}</span>
                  {zipAnalysis.tablePrefix && zipAnalysis.tablePrefix !== 'wp_' && <span className="site-card-chip">{zipAnalysis.tablePrefix}</span>}
                </div>
                {zipAnalysis.backupPlugin && <div className="section-copy">Плагин: {zipAnalysis.backupPlugin}</div>}
                <div className="toolbar-wrap" style={{ marginTop: 10 }}>
                  <button className="btn btn-secondary btn-sm" onClick={handleSelectZip} disabled={busy}>Другой ZIP</button>
                </div>
              </div>
              {siteSettingsForm}
              {progressBar}
              <div className="sticky-bottom-bar form-action-bar">
                <button className="btn btn-secondary" onClick={handleCancelZip} disabled={busy}>Отмена</button>
                <button className="btn btn-secondary" onClick={handleSelectZip} disabled={busy}>Другой ZIP</button>
                <button className="btn btn-primary" onClick={handleImportZip} disabled={busy}>{busy ? 'Импорт...' : 'Импортировать'}</button>
              </div>
            </>
          )}
        </div>
      )}

      {tab === 'cloud' && (
        <div className="stack-sm">
          {cloudProviders.length === 0 ? (
            <div className="card">
              <div className="empty-state" style={{ padding: '20px 8px' }}>
                <div className="icon">☁</div>
                <h3>Облако не настроено</h3>
                <p>Настройте Yandex Disk или Google Drive в разделе бэкапов.</p>
              </div>
            </div>
          ) : (
            <>
              <div className="card">
                <div className="card-header"><span className="card-title">Источник</span></div>
                <div className="form-group">
                  <label className="form-label">Облачный провайдер</label>
                  <select className="form-input" value={selectedProvider} onChange={(e) => {
                    setSelectedProvider(e.target.value as 'yandex' | 'google');
                    setCloudFiles([]);
                    setSelectedFile(null);
                  }} disabled={busy}>
                    {cloudProviders.includes('yandex') && <option value="yandex">☁ Yandex Disk</option>}
                    {cloudProviders.includes('google') && <option value="google">☁ Google Drive</option>}
                  </select>
                </div>
                <button className="btn btn-secondary" onClick={handleLoadCloudFiles} disabled={busy || loadingFiles}>
                  {loadingFiles ? '⏳ Загрузка...' : '↻ Загрузить список'}
                </button>
              </div>

              {cloudFiles.length > 0 && (
                <div className="card">
                  <div className="card-header"><span className="card-title">Файлы ({cloudFiles.length})</span></div>
                  <div className="stack-sm remote-history-list">
                    {cloudFiles.map((f) => (
                      <button
                        key={f.path}
                        className={`sidebar-list-item ${selectedFile?.path === f.path ? 'active' : ''}`}
                        onClick={() => setSelectedFile(f)}
                      >
                        <div className="sidebar-list-main">
                          <div className="sidebar-list-title">{f.name}</div>
                          <div className="sidebar-list-subtitle">{formatBytes(f.size)} · {new Date(f.modifiedAt).toLocaleString()}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {selectedFile && (
                <>
                  {siteSettingsForm}
                  {progressBar}
                  <div className="sticky-bottom-bar form-action-bar">
                    <button className="btn btn-secondary" onClick={() => navigate({ name: 'home' })} disabled={busy}>Отмена</button>
                    <button className="btn btn-secondary" onClick={handleLoadCloudFiles} disabled={busy}>Обновить</button>
                    <button className="btn btn-primary" onClick={handleImportFromCloud} disabled={busy || !selectedFile}>{busy ? 'Импорт...' : 'Импортировать'}</button>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
