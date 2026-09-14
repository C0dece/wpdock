import React, { useMemo, useState } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';
import { WPSite } from '../types';

interface Props {
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
  siteId?: string;
  sites: WPSite[];
}

export default function ConnectRemotePage({ navigate, onToast, siteId, sites }: Props) {
  const [loading, setLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const selectedSite = useMemo(() => sites.find((s) => s.id === siteId), [siteId, sites]);
  const isSiteContext = Boolean(selectedSite);
  const [form, setForm] = useState({
    name: '',
    url: '',
    username: '',
    appPassword: '',
    fileTransferMode: 'agent' as 'agent' | 'ftp',
    ftpHost: '',
    ftpPort: '21',
    ftpUsername: '',
    ftpPassword: '',
    ftpRootPath: '/public_html',
    ftpSecure: false,
    autoInstallAgent: true,
    preferCreateSiteOnPull: !isSiteContext,
    defaultLocalSiteName: selectedSite?.name ?? '',
    defaultPhpVersion: '8.2',
    defaultLocale: 'ru_RU',
    defaultWebServer: 'nginx' as 'php' | 'nginx' | 'apache',
    defaultSsl: true,
  });

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const setSelect = (key: string) => (e: React.ChangeEvent<HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const toggle = (key: string) => () =>
    setForm((prev) => ({ ...prev, [key]: !(prev as any)[key] }));

  const deriveNameFromUrl = (value: string) => {
    try {
      const host = new URL(value).hostname.replace(/^www\./, '');
      return host.split('.')[0] || host;
    } catch {
      return '';
    }
  };

  const normalizeRemoteUrlInput = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return '';
    try {
      const parsed = new URL(trimmed);
      let pathname = (parsed.pathname || '/').replace(/\/{2,}/g, '/');
      pathname = pathname.replace(/\/(?:wp-admin|wp-login\.php)(?:\/.*)?$/i, '');
      parsed.pathname = pathname || '/';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    } catch {
      return trimmed;
    }
  };

  const previewUrl = normalizeRemoteUrlInput(form.url);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const normalizedUrl = normalizeRemoteUrlInput(form.url);
    if (!normalizedUrl.startsWith('http')) return onToast('Введите корректный URL WordPress', 'error');
    if (form.fileTransferMode === 'agent' && (!form.username || !form.appPassword)) {
      return onToast('Для передачи через агент укажите логин администратора и Application Password', 'error');
    }
    if (form.fileTransferMode === 'ftp' && (!form.ftpHost || !form.ftpUsername || !form.ftpPassword || !form.ftpRootPath)) {
      return onToast('Укажите FTP host, логин, пароль и корневую папку WordPress', 'error');
    }

    const payload = {
      ...form,
      url: normalizedUrl,
      name: form.name || deriveNameFromUrl(normalizedUrl),
      autoInstallAgent: form.fileTransferMode === 'agent',
      ftp: form.fileTransferMode === 'ftp' ? {
        host: form.ftpHost.trim(),
        port: Number(form.ftpPort || 21),
        username: form.ftpUsername.trim(),
        password: form.ftpPassword,
        rootPath: form.ftpRootPath.trim() || '/',
        secure: form.ftpSecure,
      } : undefined,
      preferCreateSiteOnPull: isSiteContext ? false : form.preferCreateSiteOnPull,
      defaultLocalSiteName: isSiteContext ? selectedSite?.name || deriveNameFromUrl(normalizedUrl) : (form.defaultLocalSiteName || deriveNameFromUrl(normalizedUrl)),
      defaultPhpVersion: isSiteContext ? selectedSite?.phpVersion || form.defaultPhpVersion : form.defaultPhpVersion,
      defaultLocale: isSiteContext ? selectedSite?.locale || form.defaultLocale : form.defaultLocale,
      defaultWebServer: isSiteContext ? selectedSite?.webServer || form.defaultWebServer : form.defaultWebServer,
      defaultSsl: isSiteContext ? selectedSite?.ssl ?? form.defaultSsl : form.defaultSsl,
      linkSiteId: selectedSite?.id,
    };

    setLoading(true);
    setProgressMsg(form.fileTransferMode === 'agent' ? 'Проверка WordPress и настройка агента...' : 'Проверка FTP-подключения...');
    vscode.postMessage({ type: 'connectRemote', payload });

    const handler = (event: MessageEvent) => {
      if (event.data.type === 'progress') setProgressMsg(event.data.message ?? 'Подключение...');
      if (event.data.type === 'remoteConnected' || event.data.type === 'error') {
        setLoading(false);
        window.removeEventListener('message', handler);
      }
    };
    window.addEventListener('message', handler);
  };

  return (
    <div className="page sidebar-form-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Подключить удалённый сайт</h1>
          <div className="page-subtitle">{previewUrl || 'Подключение к WordPress'}</div>
        </div>
      </div>

      <div className="card compact-notice">
        <div className="mini-item-title">Автоматическое подключение</div>
        <div className="section-copy">WPDock проверит доступ, найдёт или активирует агент и зарегистрирует токен. Если WordPress запретит первичную загрузку плагина, останется один короткий ручной шаг.</div>
        {selectedSite && <div className="section-copy">Подключение будет связано с сайтом <strong>{selectedSite.name}</strong>.</div>}
      </div>

      <form onSubmit={handleSubmit} className="stack-sm">
        <div className="card">
          <div className="card-header"><span className="card-title">Основное</span></div>
          <div className="form-group">
            <label className="form-label">URL WordPress сайта</label>
            <input
              className="input"
              placeholder="https://example.com"
              value={form.url}
              onChange={(e) => {
                const value = e.target.value;
                setForm((prev) => ({
                  ...prev,
                  url: value,
                  name: prev.name || deriveNameFromUrl(value),
                  defaultLocalSiteName: prev.defaultLocalSiteName || deriveNameFromUrl(value),
                }));
              }}
              onBlur={(e) => {
                const normalized = normalizeRemoteUrlInput(e.target.value);
                if (!normalized || normalized === form.url) return;
                setForm((prev) => ({
                  ...prev,
                  url: normalized,
                  name: prev.name || deriveNameFromUrl(normalized),
                  defaultLocalSiteName: prev.defaultLocalSiteName || deriveNameFromUrl(normalized),
                }));
              }}
              type="url"
              autoFocus
            />
            <div className="form-hint">Можно вставить адрес из браузера: `/wp-admin` удалится автоматически.</div>
          </div>
          {form.fileTransferMode === 'agent' && <><div className="form-row">
            <div className="form-group">
              <label className="form-label">Логин администратора WP</label>
              <input className="input" placeholder="admin" value={form.username} onChange={set('username')} />
            </div>
            <div className="form-group">
              <label className="form-label">Application Password</label>
              <input className="input" type="password" placeholder="xxxx xxxx xxxx xxxx" value={form.appPassword} onChange={set('appPassword')} />
            </div>
          </div>
          <div className="form-hint">Используйте Application Password пользователя с правами администратора, не обычный пароль.</div></>}
        </div>

        <button type="button" className="btn btn-ghost advanced-toggle" onClick={() => setShowAdvanced((prev) => !prev)}>
          {showAdvanced ? 'Скрыть дополнительные настройки ▴' : 'Дополнительные настройки и FTP ▾'}
        </button>

        {showAdvanced && <div className="stack-sm">
          <div className="card">
            <div className="card-header"><span className="card-title">Способ передачи файлов</span></div>
            <div className="toolbar-wrap" style={{ marginBottom: 10 }}>
              <button type="button" className={`btn btn-sm ${form.fileTransferMode === 'agent' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setForm((prev) => ({ ...prev, fileTransferMode: 'agent', autoInstallAgent: true }))}>WPDock Agent</button>
              <button type="button" className={`btn btn-sm ${form.fileTransferMode === 'ftp' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setForm((prev) => ({ ...prev, fileTransferMode: 'ftp', autoInstallAgent: false }))}>FTP / FTPS</button>
            </div>
            {form.fileTransferMode === 'agent' ? (
              <div className="section-copy">Агент проверяется и настраивается автоматически при подключении.</div>
            ) : (
              <div className="stack-sm">
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">FTP host</label>
                    <input className="input" placeholder="ftp.example.com" value={form.ftpHost} onChange={set('ftpHost')} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">Порт</label>
                    <input className="input" placeholder="21" value={form.ftpPort} onChange={set('ftpPort')} />
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">FTP логин</label>
                    <input className="input" value={form.ftpUsername} onChange={set('ftpUsername')} />
                  </div>
                  <div className="form-group">
                    <label className="form-label">FTP пароль</label>
                    <input className="input" type="password" value={form.ftpPassword} onChange={set('ftpPassword')} />
                  </div>
                </div>
                <div className="form-group">
                  <label className="form-label">Папка WordPress на FTP</label>
                  <input className="input" placeholder="/public_html" value={form.ftpRootPath} onChange={set('ftpRootPath')} />
                  <div className="form-hint">Укажите корень WordPress (wp-content/wp-admin/wp-load.php). Для БД WPDock временно загрузит сюда одноразовый DB bridge.</div>
                </div>
                <label className="checkbox-row"><input type="checkbox" checked={form.ftpSecure} onChange={toggle('ftpSecure')} /> Использовать FTPS (TLS)</label>
              </div>
            )}
          </div>

          {!isSiteContext && (
            <>
              <div className="card">
                <div className="card-header"><span className="card-title">Поведение при скачивании</span></div>
                <label className="checkbox-row"><input type="checkbox" checked={form.preferCreateSiteOnPull} onChange={toggle('preferCreateSiteOnPull')} /> Создавать новый локальный сайт при Pull</label>
                <div className="form-group" style={{ marginTop: 10 }}>
                  <label className="form-label">Имя локального сайта по умолчанию</label>
                  <input className="input" placeholder="example-local" value={form.defaultLocalSiteName} onChange={set('defaultLocalSiteName')} />
                </div>
              </div>

              <div className="card">
                <div className="card-header"><span className="card-title">Локальная среда по умолчанию</span></div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">PHP</label>
                    <select className="select" value={form.defaultPhpVersion} onChange={setSelect('defaultPhpVersion')}>
                      <option value="7.4">PHP 7.4</option>
                      <option value="8.0">PHP 8.0</option>
                      <option value="8.1">PHP 8.1</option>
                      <option value="8.2">PHP 8.2</option>
                      <option value="8.3">PHP 8.3</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Язык WP</label>
                    <select className="select" value={form.defaultLocale} onChange={setSelect('defaultLocale')}>
                      <option value="ru_RU">Русский</option>
                      <option value="en_US">English</option>
                      <option value="uk">Українська</option>
                      <option value="de_DE">Deutsch</option>
                    </select>
                  </div>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label className="form-label">Веб-сервер</label>
                    <select className="select" value={form.defaultWebServer} onChange={setSelect('defaultWebServer')}>
                      <option value="nginx">Nginx</option>
                      <option value="apache">Apache</option>
                      <option value="php">PHP Built-in</option>
                    </select>
                  </div>
                  <div className="form-group">
                    <label className="form-label">Протокол</label>
                    <label className="checkbox-row" style={{ marginTop: 8 }}>
                      <input type="checkbox" checked={form.defaultSsl} onChange={toggle('defaultSsl')} />
                      Создавать локальный сайт с HTTPS
                    </label>
                  </div>
                </div>
              </div>
            </>
          )}
        </div>}

        {loading && (
          <div className="card">
            <div className="section-copy">{progressMsg || 'Подключение...'}</div>
            <div className="progress-bar" style={{ marginTop: 8 }}>
              <div className="progress-fill" style={{ width: '60%' }} />
            </div>
          </div>
        )}

        <div className="sticky-bottom-bar form-action-bar">
          <button type="button" className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Подключение...' : 'Подключить'}</button>
        </div>
      </form>
    </div>
  );
}
