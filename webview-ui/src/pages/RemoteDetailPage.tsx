import React, { useEffect, useMemo, useState } from 'react';
import { RemoteSite, WPSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

type SectionKey = 'overview' | 'links' | 'history';

interface Props {
  remoteId: string;
  remotes: RemoteSite[];
  sites: WPSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function RemoteDetailPage({ remoteId, remotes, sites, navigate, onToast }: Props) {
  const remote = useMemo(() => remotes.find((item) => item.id === remoteId), [remotes, remoteId]);
  const linkedSites = useMemo(() => sites.filter((site) => (remote?.linkedSiteIds ?? []).includes(site.id)), [sites, remote?.linkedSiteIds]);
  const availableSites = useMemo(() => sites.filter((site) => !(remote?.linkedSiteIds ?? []).includes(site.id)), [sites, remote?.linkedSiteIds]);
  const [selectedSiteId, setSelectedSiteId] = useState('');
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [openSections, setOpenSections] = useState<Record<SectionKey, boolean>>({
    overview: true,
    links: true,
    history: false,
  });

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'remoteLinked' && msg.remoteId === remoteId) onToast('Локальный сайт привязан', 'success');
      if (msg.type === 'remoteUnlinked' && msg.remoteId === remoteId) onToast('Связь снята', 'info');
      if (msg.type === 'remoteRemoved' && msg.remoteId === remoteId) navigate({ name: 'home' });
      if (msg.type === 'remoteWpReset' && msg.remoteId === remoteId) {
        setResetting(false);
        onToast('WordPress сброшен до заводских настроек', 'success');
      }
      if (msg.type === 'error') setResetting(false);
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [navigate, onToast, remoteId]);

  if (!remote) return <div className="page"><div className="empty-state"><h3>Remote не найден</h3></div></div>;

  const syncHistory = remote.syncHistory ?? [];
  const visibleHistory = historyExpanded ? syncHistory : syncHistory.slice(0, 8);
  const primaryLinkedSite = linkedSites[0];
  const hostname = (() => {
    try { return new URL(remote.url).hostname; } catch { return remote.url; }
  })();

  const toggleSection = (key: SectionKey) => {
    setOpenSections((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">{remote.name}</h1>
          <div className="page-subtitle">{hostname}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className={`badge ${remote.agentInstalled ? 'badge-green' : 'badge-yellow'}`}>
            {remote.agentInstalled ? 'agent ok' : 'agent missing'}
          </span>
          {remote.agentVersion && <span className="site-card-chip">v{remote.agentVersion}</span>}
          <span className="site-card-chip">{remote.username}</span>
          {remote.lastSyncDirection && <span className="site-card-chip">{remote.lastSyncDirection}</span>}
          {remote.preferCreateSiteOnPull && <span className="site-card-chip">create on pull</span>}
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{linkedSites.length}</span><span className="overview-stat-label">linked</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{syncHistory.length}</span><span className="overview-stat-label">syncs</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{remote.lastSyncStatus ?? '—'}</span><span className="overview-stat-label">last status</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{remote.agentInstalled ? 'yes' : 'no'}</span><span className="overview-stat-label">agent</span></div>
        </div>
        <div className="action-cluster">
          <button className="btn btn-secondary" onClick={() => navigate({ name: 'sync', remoteId, direction: 'pull', localSiteId: primaryLinkedSite?.id, quickPull: Boolean(primaryLinkedSite?.id) })}>↓ Pull</button>
          <button className="btn btn-secondary" onClick={() => navigate({ name: 'sync', remoteId, direction: 'push', localSiteId: primaryLinkedSite?.id })}>↑ Push</button>
          <button className="btn btn-secondary" onClick={() => navigate({ name: 'edit-remote', remoteId })}>✏ Редактировать</button>
          <button className="btn btn-secondary" onClick={() => navigate({ name: 'manual-agent', remoteId })}>🧩 Агент</button>
          <button
            className="btn btn-danger"
            disabled={resetting}
            title="Сбросить WordPress до заводских: удалит БД, плагины, темы и uploads (админ, пароль, агент и одна тема сохранятся)"
            onClick={() => { setResetting(true); vscode.postMessage({ type: 'resetRemoteWp', payload: { remoteId } }); }}
          >
            {resetting ? '♻ Сброс...' : '♻ Сбросить WP'}
          </button>
          <button className="btn btn-danger" onClick={() => vscode.postMessage({ type: 'removeRemote', payload: { remoteId } })}>🗑 Удалить</button>
        </div>
      </div>

      <AccordionSection title="Обзор" open={openSections.overview} onToggle={() => toggleSection('overview')}>
        <div className="detail-grid">
          <div className="card">
            <div className="card-header"><span className="card-title">Информация</span></div>
            <div className="detail-info-row"><span className="detail-info-label">URL</span><span className="detail-info-value">{remote.url}</span></div>
            <div className="detail-info-row"><span className="detail-info-label">Логин</span><span className="detail-info-value">{remote.username}</span></div>
            <div className="detail-info-row"><span className="detail-info-label">Агент</span><span className="detail-info-value">{remote.agentInstalled ? `установлен${remote.agentVersion ? ` · v${remote.agentVersion}` : ''}` : 'не подтверждён'}</span></div>
            <div className="detail-info-row"><span className="detail-info-label">Связанные сайты</span><span className="detail-info-value">{linkedSites.length > 0 ? linkedSites.map((site) => site.name).join(', ') : 'нет'}</span></div>
            <div className="detail-info-row"><span className="detail-info-label">Последний sync</span><span className="detail-info-value">{remote.lastSyncAt ? new Date(remote.lastSyncAt).toLocaleString('ru-RU') : '—'}</span></div>
          </div>

          <div className="card">
            <div className="card-header"><span className="card-title">Быстрые действия</span></div>
            <div className="sidebar-preview-actions">
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId, direction: 'pull', localSiteId: primaryLinkedSite?.id, quickPull: Boolean(primaryLinkedSite?.id) })}>Pull</button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId, direction: 'push', localSiteId: primaryLinkedSite?.id })}>Push</button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'edit-remote', remoteId })}>Редактировать</button>
              <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'manual-agent', remoteId })}>Агент</button>
            </div>
          </div>
        </div>
      </AccordionSection>

      <AccordionSection title="Связанные локальные сайты" open={openSections.links} onToggle={() => toggleSection('links')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Привязка</span></div>
          {availableSites.length > 0 && (
            <div className="inline-form" style={{ marginBottom: 12 }}>
              <select className="select" value={selectedSiteId} onChange={(e) => setSelectedSiteId(e.target.value)}>
                <option value="">Выберите локальный сайт</option>
                {availableSites.map((site) => <option key={site.id} value={site.id}>{site.name}</option>)}
              </select>
              <button className="btn btn-secondary btn-sm" disabled={!selectedSiteId} onClick={() => vscode.postMessage({ type: 'linkRemoteToSite', payload: { siteId: selectedSiteId, remoteId } })}>Привязать</button>
            </div>
          )}
          {linkedSites.length === 0 ? (
            <div className="section-copy">Пока нет связанных локальных сайтов.</div>
          ) : (
            <div className="stack-sm">
              {linkedSites.map((site) => (
                <div key={site.id} className="mini-item-card">
                  <div>
                    <div className="mini-item-title">{site.name}</div>
                    <div className="mini-item-subtitle">{site.siteUrl ?? site.domain ?? site.path}</div>
                  </div>
                  <div className="toolbar-wrap">
                    <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'site-detail', siteId: site.id })}>Открыть</button>
                    <button className="btn btn-danger btn-sm" onClick={() => vscode.postMessage({ type: 'unlinkRemoteFromSite', payload: { siteId: site.id, remoteId } })}>Отвязать</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </AccordionSection>

      <AccordionSection title="История синхронизации" open={openSections.history} onToggle={() => toggleSection('history')}>
        <div className="card">
          <div className="card-header"><span className="card-title">Sync history</span></div>
          {syncHistory.length === 0 ? <div className="section-copy">История пока пуста.</div> : (
            <>
              <div className="stack-sm remote-history-list">
                {visibleHistory.map((item) => {
                  const historySite = item.localSiteId ? sites.find((site) => site.id === item.localSiteId) : undefined;
                  return (
                    <div key={item.id} className="mini-item-card">
                      <div className="toolbar-wrap" style={{ justifyContent: 'space-between' }}>
                        <strong style={{ fontSize: 12 }}>{item.direction.toUpperCase()} · {item.status === 'success' ? 'успех' : 'ошибка'}</strong>
                        <span style={{ fontSize: 11, color: 'var(--fg2)' }}>{new Date(item.at).toLocaleString('ru-RU')}</span>
                      </div>
                      {historySite && <div className="mini-item-subtitle">Локальный сайт: {historySite.name}</div>}
                      <div className="section-copy">{item.message}</div>
                    </div>
                  );
                })}
              </div>
              {syncHistory.length > 8 && (
                <button className="btn btn-secondary btn-sm" style={{ marginTop: 12 }} onClick={() => setHistoryExpanded((prev) => !prev)}>
                  {historyExpanded ? 'Свернуть' : 'Показать ещё'}
                </button>
              )}
            </>
          )}
        </div>
      </AccordionSection>

      <div className="sticky-bottom-bar">
        <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId, direction: 'pull', localSiteId: primaryLinkedSite?.id, quickPull: Boolean(primaryLinkedSite?.id) })}>↓ Pull</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'sync', remoteId, direction: 'push', localSiteId: primaryLinkedSite?.id })}>↑ Push</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'edit-remote', remoteId })}>✏ Edit</button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'manual-agent', remoteId })}>🧩 Agent</button>
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
