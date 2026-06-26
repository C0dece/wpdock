import React, { useState, useCallback } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface Props {
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

const LOCALES = [
  { value: 'ru_RU', label: '🇷🇺 Русский' },
  { value: 'en_US', label: '🇺🇸 English' },
  { value: 'uk', label: '🇺🇦 Українська' },
  { value: 'de_DE', label: '🇩🇪 Deutsch' },
  { value: 'fr_FR', label: '🇫🇷 Français' },
  { value: 'es_ES', label: '🇪🇸 Español' },
  { value: 'pl_PL', label: '🇵🇱 Polski' },
];

function generatePassword(): string {
  const alpha = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const sym = '!@#$%&*';
  const pool = alpha + digits + sym;
  const arr = Array.from({ length: 12 }, () => pool[Math.floor(Math.random() * pool.length)]);
  arr[0] = digits[Math.floor(Math.random() * digits.length)];
  arr[1] = sym[Math.floor(Math.random() * sym.length)];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr.join('');
}

export default function CreateSitePage({ navigate, onToast }: Props) {
  const [loading, setLoading] = useState(false);
  const [progressMsg, setProgressMsg] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [domainTouched, setDomainTouched] = useState(false);
  const [form, setForm] = useState(() => ({
    name: '',
    phpVersion: '8.2',
    adminUser: 'Admin',
    adminPassword: 'Admin',
    adminEmail: '',
    locale: 'ru_RU',
    domain: '',
    ssl: true,
    webServer: 'nginx' as 'php' | 'nginx' | 'apache',
    wpDebug: false,
    wpDebugLog: false,
    wpScriptDebug: false,
  }));

  const transliterate = (s: string) => {
    const map: Record<string, string> = {
      а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y',
      к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f',
      х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
    };
    return s.split('').map((ch) => {
      const lower = ch.toLowerCase();
      return Object.prototype.hasOwnProperty.call(map, lower) ? map[lower] : ch;
    }).join('');
  };

  const slugify = (s: string) =>
    transliterate(s).toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');

  const previewSlug = slugify(form.name.trim());
  const previewDomain = form.domain.trim() || (previewSlug ? `${previewSlug}.local` : '');
  const previewUrl = previewDomain ? `${form.ssl ? 'https' : 'http'}://${previewDomain}` : '';

  const handleNameChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const name = e.target.value;
    const slug = slugify(name.trim());
    setForm((prev) => ({
      ...prev,
      name,
      domain: !domainTouched ? (slug ? `${slug}.local` : '') : prev.domain,
      adminEmail: prev.adminEmail === '' || prev.adminEmail.endsWith('.local')
        ? (slug ? `admin@${slug}.local` : '')
        : prev.adminEmail,
    }));
  }, [domainTouched]);

  const set = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  const toggle = (key: string) => () =>
    setForm((prev) => ({ ...prev, [key]: !(prev as any)[key] }));

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return onToast('Введите имя сайта', 'error');
    if (!form.adminPassword) return onToast('Введите пароль админа', 'error');
    if (!form.adminEmail.includes('@')) return onToast('Введите корректный email', 'error');

    setLoading(true);
    setProgressMsg('Запуск установки...');
    vscode.postMessage({ type: 'createSite', payload: form });

    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'progress') setProgressMsg(msg.message);
      if (msg.type === 'siteCreated' || msg.type === 'error') {
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
          <h1 className="page-title">Новый сайт</h1>
          <div className="page-subtitle">{previewUrl || 'WordPress site setup'}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className="badge badge-green">new</span>
          <span className="site-card-chip">PHP {form.phpVersion}</span>
          <span className="site-card-chip">{form.webServer}</span>
          <span className="site-card-chip">{form.locale}</span>
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{form.ssl ? 'https' : 'http'}</span><span className="overview-stat-label">protocol</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{form.adminUser || 'Admin'}</span><span className="overview-stat-label">admin</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{previewSlug || 'site'}</span><span className="overview-stat-label">slug</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{form.ssl ? 'on' : 'off'}</span><span className="overview-stat-label">ssl</span></div>
        </div>
        <div className="section-copy">
          Быстрый сценарий: имя сайта → admin email → создать. Остальное можно поменять позже.
        </div>
      </div>

      <form onSubmit={handleSubmit} className="stack-sm">
        <div className="card">
          <div className="card-header"><span className="card-title">Основное</span></div>
          <div className="form-group">
            <label className="form-label">Имя сайта</label>
            <input className="input" placeholder="My Blog" value={form.name} onChange={handleNameChange} autoFocus />
            {previewUrl && <div className="form-hint" style={{ color: 'var(--accent)' }}>🌐 {previewUrl}</div>}
          </div>
          <div className="form-group">
            <label className="form-label">URL сайта</label>
            <input
              className="input"
              placeholder="my-blog.local"
              value={form.domain}
              onChange={(e) => {
                setDomainTouched(true);
                setForm((prev) => ({ ...prev, domain: e.target.value }));
              }}
            />
            <div className="form-hint">Можно вводить домен или полный URL.</div>
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Логин администратора</label>
              <input className="input" value={form.adminUser} onChange={set('adminUser')} />
            </div>
            <div className="form-group">
              <label className="form-label">Email администратора</label>
              <input className="input" type="email" placeholder="admin@mysite.local" value={form.adminEmail} onChange={set('adminEmail')} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Пароль админа</label>
            <div className="inline-form">
              <input className="input" type={showPassword ? 'text' : 'password'} value={form.adminPassword} onChange={set('adminPassword')} />
              <div className="toolbar-wrap">
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowPassword((v) => !v)}>{showPassword ? 'Скрыть' : 'Показать'}</button>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => setForm((p) => ({ ...p, adminPassword: generatePassword() }))}>Сгенерировать</button>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-header"><span className="card-title">Платформа</span></div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Язык WordPress</label>
              <select className="select" value={form.locale} onChange={set('locale')}>
                {LOCALES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Версия PHP</label>
              <select className="select" value={form.phpVersion} onChange={set('phpVersion')}>
                <option value="7.4">PHP 7.4</option>
                <option value="8.0">PHP 8.0</option>
                <option value="8.1">PHP 8.1</option>
                <option value="8.2">PHP 8.2</option>
                <option value="8.3">PHP 8.3</option>
              </select>
            </div>
          </div>
        </div>

        <div className="stack-sm">
          <div className="card">
            <div className="card-header"><span className="card-title">Дополнительные настройки</span></div>
            <div className="form-group">
              <label className="form-label">Веб-сервер</label>
              <select className="select" value={form.webServer} onChange={(e) => setForm((p) => ({ ...p, webServer: e.target.value as any }))}>
                <option value="nginx">Nginx</option>
                <option value="apache">Apache</option>
                <option value="php">PHP Built-in</option>
              </select>
            </div>
            <label className="checkbox-row"><input type="checkbox" checked={form.ssl} onChange={toggle('ssl')} /> HTTPS / SSL</label>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">WordPress debug</span></div>
            <div className="stack-sm">
              <label className="checkbox-row"><input type="checkbox" checked={form.wpDebug} onChange={toggle('wpDebug')} /> WP_DEBUG</label>
              <label className="checkbox-row"><input type="checkbox" checked={form.wpDebugLog} onChange={toggle('wpDebugLog')} /> WP_DEBUG_LOG</label>
              <label className="checkbox-row"><input type="checkbox" checked={form.wpScriptDebug} onChange={toggle('wpScriptDebug')} /> SCRIPT_DEBUG</label>
            </div>
          </div>
        </div>

        {loading && (
          <div className="card">
            <div className="section-copy">{progressMsg || 'Установка WordPress...'}</div>
            <div className="progress-bar" style={{ marginTop: 8 }}>
              <div className="progress-fill" style={{ width: '60%' }} />
            </div>
            <div className="form-hint" style={{ marginTop: 6 }}>Первый запуск может занять 2–5 мин</div>
          </div>
        )}

        <div className="sticky-bottom-bar form-action-bar">
          <button type="button" className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
          <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? 'Создание...' : 'Создать'}</button>
        </div>
      </form>
    </div>
  );
}
