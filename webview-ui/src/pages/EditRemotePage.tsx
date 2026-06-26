import React, { useEffect, useMemo, useRef, useState } from 'react';
import { RemoteSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

const EyeIcon = ({ open }: { open: boolean }) =>
  open ? (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  ) : (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  );

interface Props {
  remoteId: string;
  remotes: RemoteSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function EditRemotePage({ remoteId, remotes, navigate, onToast }: Props) {
  const remote = useMemo(() => remotes.find((r) => r.id === remoteId), [remotes, remoteId]);
  const [loading, setLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState({
    name: '',
    url: '',
    username: '',
    appPassword: '',
    autoInstallAgent: true,
  });

  // Initialise the form ONCE per remote. Without this guard every full-state
  // push from the extension (status polling, etc.) re-ran this effect and
  // overwrote whatever the user had just typed into Название/URL/логин — the
  // "оно само вставляет старое имя и перезаписывает ввод" bug.
  const initializedFor = useRef<string | null>(null);
  useEffect(() => {
    if (initializedFor.current === remoteId) return;
    const r = remotes.find((x) => x.id === remoteId);
    if (!r) return;
    initializedFor.current = remoteId;
    setForm({ name: r.name, url: r.url, username: r.username, appPassword: '', autoInstallAgent: r.autoInstallAgent ?? true });
  }, [remoteId, remotes]);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

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

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!remote) return;
    const normalizedUrl = normalizeRemoteUrlInput(form.url);
    if (!normalizedUrl.startsWith('http')) return onToast('Введите корректный URL WordPress', 'error');
    if (!form.name.trim()) return onToast('Укажите название удалённого сайта', 'error');
    if (!form.username.trim()) return onToast('Укажите логин администратора WordPress', 'error');

    setLoading(true);
    setProgressMsg('Сохранение настроек удалённого сайта...');
    vscode.postMessage({
      type: 'updateRemote',
      payload: {
        remoteId,
        updates: {
          ...form,
          url: normalizedUrl,
          name: form.name.trim(),
          username: form.username.trim(),
          appPassword: form.appPassword.trim(),
        },
      },
    });

    const handler = (event: MessageEvent) => {
      if (event.data.type === 'progress') setProgressMsg(event.data.message ?? 'Сохранение...');
      if (event.data.type === 'remoteUpdated' || event.data.type === 'error') {
        setLoading(false);
        window.removeEventListener('message', handler);
      }
    };
    window.addEventListener('message', handler);
  };

  if (!remote) return <div className="page"><div className="empty-state"><h3>Удалённый сайт не найден</h3></div></div>;

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Редактировать remote</h1>
          <div className="page-subtitle">{form.url || remote.url}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className="badge badge-green">remote</span>
          <span className="site-card-chip">{form.name || remote.name}</span>
          <span className="site-card-chip">{form.autoInstallAgent ? 'auto-agent' : 'manual-agent'}</span>
        </div>
        <div className="section-copy">
          Измените параметры подключения. Поле <strong style={{ color: 'var(--fg)' }}>Application Password</strong> можно оставить пустым, чтобы сохранить текущий пароль.
        </div>
      </div>

      <div className="card">
        <form onSubmit={handleSubmit} className="stack-sm">
          <div className="form-group">
            <label className="form-label">Название</label>
            <input className="input" value={form.name} onChange={set('name')} autoFocus />
          </div>
          <div className="form-group">
            <label className="form-label">URL WordPress сайта</label>
            <input
              className="input"
              value={form.url}
              onChange={(e) => setForm((prev) => ({ ...prev, url: e.target.value }))}
              onBlur={(e) => {
                const normalized = normalizeRemoteUrlInput(e.target.value);
                if (!normalized || normalized === form.url) return;
                setForm((prev) => ({ ...prev, url: normalized }));
              }}
              type="url"
            />
          </div>
          <div className="form-group">
            <label className="form-label">Логин администратора WP</label>
            <input className="input" value={form.username} onChange={set('username')} autoComplete="username" />
          </div>
          <div className="form-group">
            <label className="form-label">Новый Application Password</label>
            <div className="password-field-wrap">
              <input
                className="input password-field-input"
                type={showPassword ? 'text' : 'password'}
                placeholder="Оставьте пустым, чтобы не менять"
                value={form.appPassword}
                onChange={set('appPassword')}
                autoComplete="new-password"
              />
              <button type="button" onClick={() => setShowPassword((v) => !v)} title={showPassword ? 'Скрыть пароль' : 'Показать пароль'} className="password-toggle-btn">
                <EyeIcon open={showPassword} />
              </button>
            </div>
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={form.autoInstallAgent} onChange={() => setForm((prev) => ({ ...prev, autoInstallAgent: !prev.autoInstallAgent }))} /> Автоустановка WPDock Agent</label>
          <div className="sticky-bottom-bar form-action-bar">
            <button type="button" className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
            <button type="button" className="btn btn-secondary" onClick={() => setShowPassword((v) => !v)}>{showPassword ? 'Скрыть' : 'Показать'}</button>
            <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Сохранение...' : 'Сохранить'}</button>
          </div>
        </form>
      </div>

      {loading && (
        <div className="card">
          <div className="section-copy">{progressMsg || 'Сохранение...'}</div>
          <div className="progress-bar" style={{ marginTop: 8 }}>
            <div className="progress-fill progress-fill-animated" style={{ width: '60%' }} />
          </div>
        </div>
      )}
    </div>
  );
}
