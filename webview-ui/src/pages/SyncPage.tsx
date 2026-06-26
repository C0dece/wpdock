import React, { useState, useEffect } from 'react';
import { WPSite, RemoteSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface SyncStep {
  phase: string;
  message: string;
  percent?: number;
  done?: boolean;
}

interface PullDiagnostic {
  wpInstalled: boolean;
  expectedTableCount: number;
  actualTableCount?: number;
  siteurl?: string;
  home?: string;
  stylesheet?: string;
  template?: string;
  missingThemes: string[];
  warnings: string[];
  notes: string[];
  summary: string;
}

interface Props {
  remoteId: string;
  direction: 'pull' | 'push';
  localSiteId?: string;
  quickPull?: boolean;
  sites: WPSite[];
  remotes: RemoteSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function SyncPage({ remoteId, direction, localSiteId: routeLocalSiteId, quickPull, sites, remotes, navigate, onToast }: Props) {
  const remote = remotes.find((r) => r.id === remoteId);
  const boundLocalSiteId = routeLocalSiteId ?? remote?.linkedSiteIds?.[0];
  const [localSiteId, setLocalSiteId] = useState(boundLocalSiteId ?? '');
  const [includeDb, setIncludeDb] = useState(true);
  const [skipUploads, setSkipUploads] = useState(false);
  const [devMode, setDevMode] = useState(false);
  const [preserveCredentials, setPreserveCredentials] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [steps, setSteps] = useState<SyncStep[]>([]);
  const [done, setDone] = useState(false);
  const [pullDiagnostic, setPullDiagnostic] = useState<PullDiagnostic | null>(null);
  const [quickConfirm, setQuickConfirm] = useState(false);
  const forceExistingTarget = Boolean(boundLocalSiteId);
  const [targetMode, setTargetMode] = useState<'existing' | 'new'>(() => (
    direction === 'pull' && !forceExistingTarget && (remote?.preferCreateSiteOnPull || sites.length === 0) ? 'new' : 'existing'
  ));
  const [newSite, setNewSite] = useState(() => ({
    name: remote?.defaultLocalSiteName || `${remote?.name || 'remote'} local`,
    phpVersion: remote?.defaultPhpVersion || '8.2',
    locale: remote?.defaultLocale || 'ru_RU',
    webServer: remote?.defaultWebServer || 'nginx',
    ssl: remote?.defaultSsl ?? true,
    adminUser: 'Admin',
    adminPassword: 'Admin',
    adminEmail: `admin@${(remote?.defaultLocalSiteName || remote?.name || 'local').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'local'}.local`,
  }));

  useEffect(() => {
    if (boundLocalSiteId && boundLocalSiteId !== localSiteId) setLocalSiteId(boundLocalSiteId);
  }, [boundLocalSiteId, localSiteId]);

  useEffect(() => {
    if (forceExistingTarget && targetMode !== 'existing') setTargetMode('existing');
  }, [forceExistingTarget, targetMode]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'syncProgress') {
        setSteps((prev) => {
          const exists = prev.findIndex((s) => s.phase === msg.phase);
          const newStep: SyncStep = { phase: msg.phase, message: msg.message, percent: msg.percent };
          if (exists >= 0) {
            const updated = [...prev];
            updated[exists] = newStep;
            return updated;
          }
          return [...prev, newStep];
        });
      }
      if (msg.type === 'syncDone') {
        setSyncing(false);
        setDone(true);
        onToast(direction === 'pull' ? 'Pull завершён!' : 'Push завершён!', 'success');
      }
      if (msg.type === 'pullDiagnostic') setPullDiagnostic(msg.diagnostic ?? null);
      if (msg.type === 'error') {
        setSyncing(false);
        onToast(msg.message, 'error');
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [direction, onToast]);

  if (!remote) {
    return <div className="page"><div className="empty-state"><h3>Удалённый сайт не найден</h3></div></div>;
  }

  const handleSync = () => {
    const selectedLocalSiteId = boundLocalSiteId ?? localSiteId;
    if (isPull && targetMode === 'new') {
      if (!newSite.name.trim()) return onToast('Введите имя нового локального сайта', 'error');
      if (!newSite.adminEmail.includes('@')) return onToast('Укажите корректный email администратора', 'error');
    } else if (!selectedLocalSiteId) {
      return onToast('Выберите локальный сайт', 'error');
    }

    setSyncing(true);
    setSteps([]);
    setDone(false);
    setPullDiagnostic(null);

    const msgType = direction === 'pull' ? 'pullRemote' : 'pushRemote';
    vscode.postMessage({
      type: msgType,
      payload: {
        remoteId,
        localSiteId: selectedLocalSiteId,
        includeDb,
        skipUploads: isPull ? skipUploads : undefined,
        devMode: direction === 'push' ? devMode : undefined,
        preserveCredentials,
        createSite: isPull && targetMode === 'new' ? newSite : undefined,
      },
    });
  };

  const isPull = direction === 'pull';
  const isQuickPull = Boolean(isPull && quickPull && boundLocalSiteId);
  const quickTargetSite = boundLocalSiteId ? sites.find((site) => site.id === boundLocalSiteId) : undefined;
  const currentPercent = steps.length > 0 ? steps[steps.length - 1].percent ?? 0 : 0;

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">{isPull ? 'Pull sync' : 'Push sync'}</h1>
          <div className="page-subtitle">{remote.name}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className={`badge ${isPull ? 'badge-green' : 'badge-yellow'}`}>{isPull ? 'pull' : 'push'}</span>
          <span className="site-card-chip">{remote.name}</span>
          <span className="site-card-chip">{includeDb ? 'with db' : 'files only'}</span>
          {isQuickPull && <span className="site-card-chip">quick</span>}
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{isPull ? '↓' : '↑'}</span><span className="overview-stat-label">mode</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{boundLocalSiteId ?? localSiteId ? 'bound' : targetMode}</span><span className="overview-stat-label">target</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{preserveCredentials ? 'keep' : 'replace'}</span><span className="overview-stat-label">creds</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{remote.agentInstalled ? 'agent' : 'no agent'}</span><span className="overview-stat-label">remote</span></div>
        </div>
        {!remote.agentInstalled && (
          <div className="card" style={{ borderColor: 'var(--yellow)' }}>
            <div className="section-copy">⚠ WPDock Agent не установлен. Для установки откройте страницу агента.</div>
            <div className="toolbar-wrap" style={{ marginTop: 10 }}>
              <button className="btn btn-primary btn-sm" onClick={() => navigate({ name: 'manual-agent', remoteId })}>Открыть страницу агента</button>
            </div>
          </div>
        )}
      </div>

      {!syncing && !done && (
        <div className="stack-sm">
          <div className="card">
            <div className="card-header"><span className="card-title">Параметры sync</span></div>
            {isQuickPull ? (
              <>
                <div className="section-copy">
                  Pull будет выполнен в локальный сайт <strong style={{ color: 'var(--fg)' }}>{quickTargetSite?.name ?? 'выбранный сайт'}</strong>.
                </div>
                <label className="checkbox-row"><input type="checkbox" checked={includeDb} onChange={() => setIncludeDb(!includeDb)} /> Включить базу данных</label>
                <label className="checkbox-row"><input type="checkbox" checked={skipUploads} onChange={() => setSkipUploads(!skipUploads)} /> Не загружать медиа (wp-content/uploads)</label>
              </>
            ) : (
              <>
                <div className="form-group">
                  <label className="form-label">Локальный сайт</label>
                  {forceExistingTarget && quickTargetSite && (
                    <div className="section-copy" style={{ marginBottom: 10 }}>Синхронизация привязана к сайту: <strong style={{ color: 'var(--fg)' }}>{quickTargetSite.name}</strong></div>
                  )}
                  {isPull && !forceExistingTarget && (
                    <div className="toolbar-wrap" style={{ marginBottom: 10 }}>
                      <button type="button" className={`btn btn-sm ${targetMode === 'existing' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTargetMode('existing')} disabled={sites.length === 0}>Существующий</button>
                      <button type="button" className={`btn btn-sm ${targetMode === 'new' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setTargetMode('new')}>Новый сайт</button>
                    </div>
                  )}
                  {(!isPull || targetMode === 'existing') && (
                    <select className="select" value={localSiteId} onChange={(e) => setLocalSiteId(e.target.value)} disabled={forceExistingTarget}>
                      {sites.length === 0 && <option value="">Нет локальных сайтов</option>}
                      {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  )}
                </div>

                {isPull && targetMode === 'new' && (
                  <div className="card" style={{ background: 'var(--bg2)' }}>
                    <div className="card-header"><span className="card-title">Новый локальный сайт</span></div>
                    <div className="form-group">
                      <label className="form-label">Имя</label>
                      <input className="input" value={newSite.name} onChange={(e) => setNewSite((prev) => ({ ...prev, name: e.target.value }))} />
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">PHP</label>
                        <select className="select" value={newSite.phpVersion} onChange={(e) => setNewSite((prev) => ({ ...prev, phpVersion: e.target.value }))}>
                          <option value="7.4">PHP 7.4</option><option value="8.0">PHP 8.0</option><option value="8.1">PHP 8.1</option><option value="8.2">PHP 8.2</option><option value="8.3">PHP 8.3</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="form-label">Язык WP</label>
                        <select className="select" value={newSite.locale} onChange={(e) => setNewSite((prev) => ({ ...prev, locale: e.target.value }))}>
                          <option value="ru_RU">Русский</option><option value="en_US">English</option><option value="uk">Українська</option><option value="de_DE">Deutsch</option>
                        </select>
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Веб-сервер</label>
                        <select className="select" value={newSite.webServer} onChange={(e) => setNewSite((prev) => ({ ...prev, webServer: e.target.value as 'php' | 'nginx' | 'apache' }))}>
                          <option value="nginx">Nginx</option><option value="apache">Apache</option><option value="php">PHP Built-in</option>
                        </select>
                      </div>
                      <div className="form-group">
                        <label className="checkbox-row" style={{ marginTop: 28 }}><input type="checkbox" checked={newSite.ssl} onChange={() => setNewSite((prev) => ({ ...prev, ssl: !prev.ssl }))} /> HTTPS</label>
                      </div>
                    </div>
                    <div className="form-row">
                      <div className="form-group">
                        <label className="form-label">Админ</label>
                        <input className="input" value={newSite.adminUser} onChange={(e) => setNewSite((prev) => ({ ...prev, adminUser: e.target.value }))} />
                      </div>
                      <div className="form-group">
                        <label className="form-label">Email</label>
                        <input className="input" value={newSite.adminEmail} onChange={(e) => setNewSite((prev) => ({ ...prev, adminEmail: e.target.value }))} />
                      </div>
                    </div>
                  </div>
                )}

                <div className="stack-sm">
                  <label className="checkbox-row"><input type="checkbox" checked={includeDb} onChange={() => setIncludeDb(!includeDb)} /> Включить базу данных</label>
                  {isPull && <label className="checkbox-row"><input type="checkbox" checked={skipUploads} onChange={() => setSkipUploads(!skipUploads)} /> Не загружать медиа (wp-content/uploads)</label>}
                  {!isPull && <label className="checkbox-row"><input type="checkbox" checked={devMode} onChange={() => setDevMode(!devMode)} /> Быстрый режим разработки</label>}
                  {includeDb && <label className="checkbox-row"><input type="checkbox" checked={preserveCredentials} onChange={() => setPreserveCredentials(!preserveCredentials)} /> Сохранить учётные данные</label>}
                </div>
              </>
            )}

            {isPull && <div className="card" style={{ background: 'rgba(241,76,76,0.05)', borderColor: 'var(--red)', marginTop: 12 }}><div className="section-copy" style={{ color: 'var(--red)' }}>⚠ Pull перезапишет локальные файлы{includeDb ? ' и базу данных' : ''}</div></div>}
          </div>

          <div className="sticky-bottom-bar form-action-bar">
            {isQuickPull && !quickConfirm ? (
              <>
                <button className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
                <button className="btn btn-secondary" onClick={() => setIncludeDb(!includeDb)}>{includeDb ? 'DB on' : 'DB off'}</button>
                <button className="btn btn-primary" onClick={() => setQuickConfirm(true)}>Подтвердить Pull</button>
              </>
            ) : (
              <>
                <button className="btn btn-secondary" onClick={() => navigate({ name: 'home' })}>Отмена</button>
                <button className="btn btn-secondary" onClick={() => { setSyncing(false); setDone(false); setSteps([]); }}>Сбросить</button>
                <button className="btn btn-primary" onClick={handleSync} disabled={!remote.agentInstalled || ((!isPull || targetMode === 'existing') && !(boundLocalSiteId ?? localSiteId))}>
                  {isPull ? (targetMode === 'new' ? 'Создать и Pull' : 'Начать Pull') : 'Начать Push'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {(syncing || done) && (
        <div className="stack-sm">
          <div className="card">
            <div className="card-header"><span className="card-title">{done ? 'Sync завершён' : 'Идёт синхронизация'}</span></div>
            {steps.length > 0 && (
              <>
                <div className="progress-bar" style={{ marginBottom: 16 }}>
                  <div className="progress-fill" style={{ width: `${done ? 100 : currentPercent}%` }} />
                </div>
                <div className="sync-steps">
                  {steps.map((step, i) => (
                    <div key={step.phase} className="sync-step">
                      <div className={`sync-step-icon ${i === steps.length - 1 && !done ? 'sync-step-active' : 'sync-step-done'}`}>
                        {i === steps.length - 1 && !done ? '⟳' : '✓'}
                      </div>
                      <span>{step.message}</span>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>

          {done && pullDiagnostic && (
            <div className="card">
              <div className="card-header"><span className="card-title">Диагностика после Pull</span></div>
              <div className="section-copy">
                <div>WP установлен: {pullDiagnostic.wpInstalled ? 'да' : 'нет'}</div>
                <div>Таблицы: {pullDiagnostic.actualTableCount ?? '?'} / ожидалось {pullDiagnostic.expectedTableCount}</div>
                <div>siteurl: {pullDiagnostic.siteurl || '-'}</div>
                <div>home: {pullDiagnostic.home || '-'}</div>
                <div>Тема: {pullDiagnostic.stylesheet || '-'} / {pullDiagnostic.template || '-'}</div>
                {pullDiagnostic.warnings.length > 0 && <div style={{ marginTop: 8, color: 'var(--yellow)' }}>⚠ {pullDiagnostic.warnings.join(' | ')}</div>}
              </div>
            </div>
          )}

          {done && (
            <div className="sticky-bottom-bar form-action-bar">
              <button className="btn btn-primary" onClick={() => navigate({ name: 'home' })}>К сайтам</button>
              <button className="btn btn-secondary" onClick={() => { setSyncing(false); setDone(false); setSteps([]); setPullDiagnostic(null); }}>Повторить</button>
              <button className="btn btn-secondary" onClick={() => navigate({ name: 'remote-detail', remoteId })}>Remote</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
