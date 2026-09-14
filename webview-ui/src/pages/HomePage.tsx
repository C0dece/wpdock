import React from 'react';
import { WPSite, RemoteSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface Props {
  sites: WPSite[];
  remotes: RemoteSite[];
  localAccess: { proxyRunning: boolean; portProxyActive: boolean } | null;
  navigate: (r: AppRoute) => void;
}

type SidebarFilter = 'all' | 'sites' | 'remotes';
type SelectedItem =
  | { type: 'site'; id: string }
  | { type: 'remote'; id: string }
  | null;

export default function HomePage({ sites, remotes, localAccess, navigate }: Props) {
  const runningSites = sites.filter((s) => s.status === 'running').length;
  const accessReady = Boolean(localAccess?.proxyRunning && localAccess?.portProxyActive);
  const accessLabel = accessReady
    ? 'Локальный доступ готов'
    : localAccess
      ? 'Локальный доступ настраивается'
      : 'Локальный доступ запускается';

  const remembered = vscode.getState<{ lastSelected?: Exclude<SelectedItem, null> }>();
  const [filter, setFilter] = React.useState<SidebarFilter>('sites');
  const [query, setQuery] = React.useState('');
  const [selected, setSelected] = React.useState<SelectedItem>(remembered?.lastSelected ?? null);

  const entries = React.useMemo(() => {
    const normalized = query.trim().toLowerCase();
    const siteEntries = [...sites].sort((a, b) => {
      if (remembered?.lastSelected?.type === 'site') {
        if (a.id === remembered.lastSelected.id) return -1;
        if (b.id === remembered.lastSelected.id) return 1;
      }
      return a.name.localeCompare(b.name, 'ru');
    }).map((site) => ({
      kind: 'site' as const,
      id: site.id,
      title: site.name,
      subtitle: getDisplaySiteUrl(site),
      search: `${site.name} ${site.domain ?? ''} ${site.phpVersion} ${site.webServer ?? ''}`.toLowerCase(),
      data: site,
    }));
    const remoteEntries = remotes.map((remote) => ({
      kind: 'remote' as const,
      id: remote.id,
      title: remote.name,
      subtitle: safeHostname(remote.url),
      search: `${remote.name} ${remote.url} ${remote.username}`.toLowerCase(),
      data: remote,
    }));

    const combined = [
      ...(filter !== 'remotes' ? siteEntries : []),
      ...(filter !== 'sites' ? remoteEntries : []),
    ];

    return normalized
      ? combined.filter((entry) => entry.search.includes(normalized))
      : combined;
  }, [filter, query, remotes, sites, remembered?.lastSelected?.id, remembered?.lastSelected?.type]);

  const selectItem = (item: Exclude<SelectedItem, null>) => {
    setSelected(item);
    vscode.setState({ ...(vscode.getState<Record<string, unknown>>() ?? {}), lastSelected: item });
  };

  React.useEffect(() => {
    if (!selected) {
      if (entries[0]) {
        selectItem({ type: entries[0].kind, id: entries[0].id });
      }
      return;
    }

    const exists = entries.some((entry) => entry.kind === selected.type && entry.id === selected.id);
    if (!exists) {
      if (entries[0]) selectItem({ type: entries[0].kind, id: entries[0].id });
      else setSelected(null);
    }
  }, [entries, selected]);

  const selectedSite = selected?.type === 'site' ? sites.find((site) => site.id === selected.id) ?? null : null;
  const selectedRemote = selected?.type === 'remote' ? remotes.find((remote) => remote.id === selected.id) ?? null : null;

  return (
    <div className="page sidebar-home">
      <div className="sidebar-status-row">
        <span className={`badge ${accessReady ? 'badge-green' : 'badge-yellow'}`} title="hosts, portproxy и SSL доверие">
          <span className={`dot ${accessReady ? 'dot-green' : 'dot-yellow'}`} />
          {accessLabel}
        </span>
        {runningSites > 0 && (
          <span className="badge badge-green">
            <span className="dot dot-green" />
            {runningSites} работает
          </span>
        )}
      </div>

      <div className="sidebar-toolbar">
        <div className="sidebar-filter-group">
          <button className={`tab-btn ${filter === 'all' ? 'active' : ''}`} onClick={() => setFilter('all')}>Все</button>
          <button className={`tab-btn ${filter === 'sites' ? 'active' : ''}`} onClick={() => setFilter('sites')}>Сайты</button>
          <button className={`tab-btn ${filter === 'remotes' ? 'active' : ''}`} onClick={() => setFilter('remotes')}>Удалённые</button>
        </div>
        <input
          className="input sidebar-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск сайта или подключения..."
        />
      </div>

      <div className="sidebar-list">
        {entries.length === 0 ? (
          <div className="empty-state sidebar-empty">
            <div className="icon">{filter === 'remotes' ? '☁' : '⬡'}</div>
            <h3>{query ? 'Ничего не найдено' : filter === 'remotes' ? 'Нет удалённых подключений' : filter === 'sites' ? 'Нет локальных сайтов' : 'Пока нет сайтов'}</h3>
            <p>{query ? 'Измените поисковый запрос.' : 'Создайте новый сайт, импортируйте существующий или подключите удалённый.'}</p>
          </div>
        ) : (
          entries.map((entry) => (
            <button
              key={`${entry.kind}-${entry.id}`}
              className={`sidebar-list-item ${selected?.type === entry.kind && selected.id === entry.id ? 'active' : ''}`}
              onClick={() => selectItem({ type: entry.kind, id: entry.id })}
            >
              <div className="sidebar-list-main">
                <div className="sidebar-list-title-row">
                  <span className="sidebar-list-icon">{entry.kind === 'site' ? '⬡' : '☁'}</span>
                  <span className="sidebar-list-title">{entry.title}</span>
                  {remembered?.lastSelected?.type === entry.kind && remembered.lastSelected.id === entry.id && <span className="site-card-chip last-used-chip" title="Последний выбранный сайт">последний</span>}
                  <span className={`badge ${entry.kind === 'site' ? getSiteBadgeClass(entry.data.status) : entry.data.agentInstalled ? 'badge-green' : 'badge-yellow'}`}>
                    {entry.kind === 'site'
                      ? getStatusLabel(entry.data.status)
                      : entry.data.agentInstalled ? 'агент готов' : 'без агента'}
                  </span>
                </div>
                <div className="sidebar-list-subtitle">{entry.subtitle}</div>
              </div>
            </button>
          ))
        )}
      </div>

      {selectedSite && (
        <SitePreview site={selectedSite} navigate={navigate} />
      )}

      {selectedRemote && (
        <RemotePreview remote={selectedRemote} sites={sites} navigate={navigate} />
      )}
    </div>
  );
}

function getSiteBaseUrl(site: WPSite): string {
  return site.siteUrl ?? `http://${site.domain ?? 'localhost'}:${site.port}`;
}

function getDisplaySiteUrl(site: WPSite): string {
  const base = getSiteBaseUrl(site);
  try {
    const parsed = new URL(base);
    return `${parsed.protocol}//${parsed.hostname}`;
  } catch {
    return base.replace(/:\d+$/, '');
  }
}

function safeHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function getStatusLabel(status: WPSite['status']): string {
  switch (status) {
    case 'starting':
      return 'старт';
    case 'running':
      return 'работает';
    case 'error':
      return 'ошибка';
    case 'stopped':
    default:
      return 'остановлен';
  }
}

function getSiteBadgeClass(status: WPSite['status']) {
  if (status === 'running') return 'badge-green';
  if (status === 'starting') return 'badge-yellow';
  if (status === 'error') return 'badge-red';
  return 'badge-gray';
}

function SitePreview({ site, navigate }: { site: WPSite; navigate: (r: AppRoute) => void }) {
  const isRunning = site.status === 'running';
  const siteUrl = getSiteBaseUrl(site);

  return (
    <div className="sidebar-preview card">
      <div className="card-header">
        <span className="card-title">Быстрые действия</span>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'site-detail', siteId: site.id })}>Управление →</button>
      </div>
      <div className="sidebar-preview-title">{site.name}</div>
      <div className="sidebar-preview-subtitle">{getDisplaySiteUrl(site)}</div>
      <div className="site-card-meta-row">
        <span className={`badge ${getSiteBadgeClass(site.status)}`}>{getStatusLabel(site.status)}</span>
        <span className="site-card-chip">PHP {site.phpVersion}</span>
        <span className="site-card-chip">{site.webServer ?? 'php'}</span>
      </div>
      <div className="sidebar-preview-actions">
        {isRunning ? (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: siteUrl } })}>↗ Открыть сайт</button>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'autoLoginAdmin', payload: { siteId: site.id } })}>🔑 Админка</button>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openInExplorer', payload: { siteId: site.id } })}>📁 Файлы</button>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'forceRestartSite', payload: { siteId: site.id } })}>🔁 Перезапуск</button>
            <button className={`btn btn-sm ${site.livePreviewRunning ? 'btn-primary' : 'btn-secondary'}`} onClick={() => vscode.postMessage({ type: 'toggleLivePreview', payload: { siteId: site.id } })}>{site.livePreviewRunning ? '🔴 Live Preview' : '👁 Live Preview'}</button>
            <button className="btn btn-ghost btn-sm" onClick={() => vscode.postMessage({ type: 'stopSite', payload: { siteId: site.id } })}>⏹ Остановить</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary btn-sm" onClick={() => vscode.postMessage({ type: 'startSite', payload: { siteId: site.id } })}>▶ Запуск</button>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openInExplorer', payload: { siteId: site.id } })}>📁 Файлы</button>
          </>
        )}
      </div>
    </div>
  );
}

function RemotePreview({ remote, sites, navigate }: { remote: RemoteSite; sites: WPSite[]; navigate: (r: AppRoute) => void }) {
  const linkedSite = sites.find((site) => (remote.linkedSiteIds ?? []).includes(site.id));

  return (
    <div className="sidebar-preview card">
      <div className="card-header">
        <span className="card-title">Выбранный remote</span>
        <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'remote-detail', remoteId: remote.id })}>Открыть</button>
      </div>
      <div className="sidebar-preview-title">{remote.name}</div>
      <div className="sidebar-preview-subtitle">{safeHostname(remote.url)}</div>
      <div className="site-card-meta-row">
        <span className={`badge ${remote.agentInstalled ? 'badge-green' : 'badge-yellow'}`}>
          {remote.agentInstalled ? 'агент готов' : 'без агента'}
        </span>
        {linkedSite && <span className="site-card-chip">{linkedSite.name}</span>}
      </div>
      <div className="sidebar-preview-actions">
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => navigate({ name: 'sync', remoteId: remote.id, direction: 'pull', localSiteId: linkedSite?.id, quickPull: Boolean(linkedSite?.id) })}
        >
          ↓ Pull
        </button>
        <button
          className="btn btn-secondary btn-sm"
          onClick={() => navigate({ name: 'sync', remoteId: remote.id, direction: 'push', localSiteId: linkedSite?.id })}
        >
          ↑ Push
        </button>
        <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'edit-remote', remoteId: remote.id })}>✏ Изменить</button>
        {!remote.agentInstalled && (
          <button className="btn btn-secondary btn-sm" onClick={() => navigate({ name: 'manual-agent', remoteId: remote.id })}>Agent</button>
        )}
        <button className="btn btn-ghost btn-sm" onClick={() => navigate({ name: 'remote-detail', remoteId: remote.id })}>Подробнее →</button>
      </div>
    </div>
  );
}
