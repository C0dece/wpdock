import React, { useEffect, useState } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface Props {
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

interface PluginSettings {
  sitesDirectory: string;
  defaultPhpVersion: string;
  directUploadLimitMb: number;
  chunkSizeMb: number;
  uploadConcurrency: number;
  autoBackup: boolean;
  backupIntervalHours: number;
  backupKeepCount: number;
}

const PHP_VERSIONS = ['7.4', '8.0', '8.1', '8.2', '8.3'];
const BACKUP_INTERVALS = [
  { value: 6, label: 'Каждые 6 часов' },
  { value: 12, label: 'Каждые 12 часов' },
  { value: 24, label: 'Ежедневно' },
  { value: 48, label: 'Каждые 2 дня' },
  { value: 168, label: 'Еженедельно' },
];

const DEFAULTS: PluginSettings = {
  sitesDirectory: '',
  defaultPhpVersion: '8.2',
  directUploadLimitMb: 1,
  chunkSizeMb: 0.75,
  uploadConcurrency: 8,
  autoBackup: false,
  backupIntervalHours: 24,
  backupKeepCount: 5,
};

export default function SettingsPage({ navigate, onToast }: Props) {
  const [settings, setSettings] = useState<PluginSettings>(DEFAULTS);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'settingsLoaded') {
        setSettings({ ...DEFAULTS, ...msg.settings });
        setLoaded(true);
      }
    };
    window.addEventListener('message', handler);
    vscode.postMessage({ type: 'getSettings' });
    return () => window.removeEventListener('message', handler);
  }, []);

  const set = <K extends keyof PluginSettings>(key: K, value: PluginSettings[K]) =>
    setSettings((prev) => ({ ...prev, [key]: value }));

  const handleSave = () => {
    setSaving(true);
    vscode.postMessage({ type: 'saveSettings', payload: settings });
    setTimeout(() => setSaving(false), 1000);
    onToast('Настройки сохранены', 'success');
  };

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Настройки WPDock</h1>
          <div className="page-subtitle">default runtime · uploads · backups</div>
        </div>
      </div>

      {!loaded ? (
        <div className="empty-state">Загрузка настроек…</div>
      ) : (
        <>
          <div className="detail-hero card">
            <div className="site-card-meta-row">
              <span className="badge badge-green">global</span>
              <span className="site-card-chip">PHP {settings.defaultPhpVersion}</span>
            </div>
            <div className="detail-summary-grid">
              <div className="overview-stat"><span className="overview-stat-value">{settings.defaultPhpVersion}</span><span className="overview-stat-label">php</span></div>
              <div className="overview-stat"><span className="overview-stat-value">{settings.autoBackup ? 'on' : 'off'}</span><span className="overview-stat-label">backup</span></div>
              <div className="overview-stat"><span className="overview-stat-value">{settings.directUploadLimitMb}mb</span><span className="overview-stat-label">upload</span></div>
            </div>
            <div className="section-copy">
              Здесь задаются глобальные значения по умолчанию для новых сайтов, загрузки на сервер и push/backup поведения.
            </div>
          </div>

          <div className="stack-sm">
            <section className="card">
              <div className="card-header"><span className="card-title">Общие</span></div>
              <div className="form-group">
                <label className="form-label">Папка для сайтов</label>
                <input className="form-input" type="text" value={settings.sitesDirectory} placeholder="По умолчанию: ~/WPDock" onChange={(e) => set('sitesDirectory', e.target.value)} />
                <span className="form-hint">Где хранятся локальные WordPress-сайты.</span>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Версия PHP по умолчанию</label>
                  <select className="form-input" value={settings.defaultPhpVersion} onChange={(e) => set('defaultPhpVersion', e.target.value)}>
                    {PHP_VERSIONS.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
            </section>

            <section className="card">
              <div className="card-header"><span className="card-title">Загрузка на сервер</span></div>
              <div className="section-copy">
                Если архив меньше лимита — идёт одним запросом. Если больше — включается батчинг по чанкам.
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label className="form-label">Лимит прямой загрузки, МБ</label>
                  <input className="form-input" type="number" min={0.5} max={1024} step={0.5} value={settings.directUploadLimitMb} onChange={(e) => set('directUploadLimitMb', Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Размер чанка, МБ</label>
                  <input className="form-input" type="number" min={0.25} max={32} step={0.25} value={settings.chunkSizeMb} onChange={(e) => set('chunkSizeMb', Number(e.target.value))} />
                </div>
                <div className="form-group">
                  <label className="form-label">Параллельные чанки</label>
                  <input className="form-input" type="number" min={1} max={16} step={1} value={settings.uploadConcurrency} onChange={(e) => set('uploadConcurrency', Number(e.target.value))} />
                </div>
              </div>
              <span className="form-hint">При ошибках 413/timeout/квоты уменьшайте размер чанка и параллелизм. Для слабого shared-хостинга обычно достаточно 1–3 потока.</span>
            </section>

            <section className="card">
              <div className="card-header"><span className="card-title">Автобэкапы</span></div>
              <div className="stack-sm">
                <label className="checkbox-row"><input type="checkbox" checked={settings.autoBackup} onChange={(e) => set('autoBackup', e.target.checked)} /> Включить автоматические бэкапы</label>
                {settings.autoBackup && (
                  <>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Интервал</label>
                        <select className="form-input" value={settings.backupIntervalHours} onChange={(e) => set('backupIntervalHours', Number(e.target.value))}>
                          {BACKUP_INTERVALS.map((b) => <option key={b.value} value={b.value}>{b.label}</option>)}
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Хранить бэкапов</label>
                        <input className="form-input" type="number" min={1} max={50} value={settings.backupKeepCount} onChange={(e) => set('backupKeepCount', Number(e.target.value))} />
                      </div>
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>

          <div className="sticky-bottom-bar form-action-bar">
            <button className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
            <button className="btn btn-secondary" onClick={() => setSettings(DEFAULTS)}>Сбросить</button>
            <button className="btn btn-primary" disabled={saving} onClick={handleSave}>{saving ? 'Сохранение…' : 'Сохранить'}</button>
          </div>
        </>
      )}
    </div>
  );
}
