import React, { useEffect, useState, useCallback } from 'react';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';
import { WPSite } from '../types';

interface GitHubUser {
  login: string;
  name: string;
  avatarUrl: string;
  publicRepos: number;
}

interface GitHubRepo {
  id: number;
  name: string;
  fullName: string;
  url: string;
  cloneUrl: string;
  sshUrl: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  stars: number;
  updatedAt: string;
}

interface Props {
  siteId?: string;
  sites: WPSite[];
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function GitHubPage({ siteId, sites, navigate, onToast }: Props) {
  const [tab, setTab] = useState<'repos' | 'create' | 'clone' | 'token'>('repos');
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [repos, setRepos] = useState<GitHubRepo[]>([]);
  const [tokenInput, setTokenInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [repoFilter, setRepoFilter] = useState('');
  const [repoName, setRepoName] = useState('');
  const [repoDesc, setRepoDesc] = useState('');
  const [repoPrivate, setRepoPrivate] = useState(true);
  const [linkSiteId, setLinkSiteId] = useState(siteId ?? '');
  const [cloneUrl, setCloneUrl] = useState('');
  const [cloneLocalPath, setCloneLocalPath] = useState('');

  const loadUser = useCallback(() => {
    vscode.postMessage({ type: 'githubGetUser', payload: {} });
  }, []);

  useEffect(() => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      switch (msg.type) {
        case 'githubUser':
          setUser(msg.user);
          break;
        case 'githubNotConnected':
          setUser(null);
          setTab('token');
          break;
        case 'githubRepos':
          setBusy(false);
          setRepos(msg.repos ?? []);
          break;
        case 'githubRepoCreated':
          setBusy(false);
          onToast(`Репозиторий "${msg.repo.fullName}" создан!`, 'success');
          setRepos((prev) => [msg.repo, ...prev]);
          setTab('repos');
          break;
        case 'githubRepoDeleted':
          setRepos((prev) => prev.filter((r) => r.fullName !== msg.fullName));
          onToast('Репозиторий удалён', 'info');
          break;
        case 'githubRepoCloned':
          setBusy(false);
          onToast(`Клонировано в ${msg.localPath}`, 'success');
          break;
        case 'githubLinked':
          setBusy(false);
          onToast('GitHub репозиторий привязан!', 'success');
          break;
      }
    };
    window.addEventListener('message', handler);
    loadUser();
    return () => window.removeEventListener('message', handler);
  }, [loadUser, onToast]);

  const handleConnect = () => {
    if (!tokenInput.trim()) return onToast('Введите Personal Access Token', 'error');
    vscode.postMessage({ type: 'githubSetToken', payload: { token: tokenInput } });
    setTokenInput('');
  };

  const handleDisconnect = () => {
    vscode.postMessage({ type: 'githubDisconnect', payload: {} });
    setUser(null);
    setRepos([]);
  };

  const handleLoadRepos = () => {
    setBusy(true);
    vscode.postMessage({ type: 'githubListRepos', payload: {} });
  };

  const handleCreateRepo = () => {
    if (!repoName.trim()) return onToast('Введите имя репозитория', 'error');
    setBusy(true);
    vscode.postMessage({
      type: 'githubCreateRepo',
      payload: {
        name: repoName,
        description: repoDesc,
        private: repoPrivate,
        siteId: linkSiteId || undefined,
      },
    });
  };

  const handleDeleteRepo = (repo: GitHubRepo) => {
    const [owner, name] = repo.fullName.split('/');
    vscode.postMessage({ type: 'githubDeleteRepo', payload: { owner, repo: name } });
  };

  const handleClone = () => {
    if (!cloneUrl.trim()) return onToast('Введите URL репозитория', 'error');
    setBusy(true);
    vscode.postMessage({
      type: 'githubCloneRepo',
      payload: { cloneUrl, name: cloneUrl.split('/').pop()?.replace('.git', '') ?? 'repo', localPath: cloneLocalPath || undefined },
    });
  };

  const handleLinkRepo = (repo: GitHubRepo) => {
    if (!siteId && !linkSiteId) return onToast('Выберите сайт для привязки', 'error');
    const targetSiteId = siteId || linkSiteId;
    vscode.postMessage({ type: 'githubLinkToSite', payload: { siteId: targetSiteId, repoUrl: repo.cloneUrl } });
  };

  const filteredRepos = repos.filter((r) =>
    r.fullName.toLowerCase().includes(repoFilter.toLowerCase()) ||
    r.description?.toLowerCase().includes(repoFilter.toLowerCase())
  );

  if (!user) {
    return (
      <div className="page sidebar-detail-page">
        <div className="page-header">
          <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
          <div className="page-title-wrap">
            <h1 className="page-title">GitHub</h1>
            <div className="page-subtitle">connect account</div>
          </div>
        </div>
        <div className="detail-hero card">
          <div className="site-card-meta-row">
            <span className="badge badge-yellow">auth required</span>
            <span className="site-card-chip">repo scope</span>
          </div>
          <div className="section-copy">
            Введите GitHub Personal Access Token с правами <code>repo</code>. При необходимости откройте генератор токенов.
          </div>
        </div>
        <div className="card">
          <div className="card-header"><span className="card-title">Подключить GitHub</span></div>
          <div className="form-group">
            <label className="form-label">Персональный токен</label>
            <input className="form-input" type="password" placeholder="ghp_..." value={tokenInput} onChange={(e) => setTokenInput(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleConnect()} />
          </div>
          <div className="toolbar-wrap">
            <button className="btn btn-secondary" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: 'https://github.com/settings/tokens/new?scopes=repo,delete_repo&description=WPDock' } })}>Сгенерировать ↗</button>
            <button className="btn btn-primary" onClick={handleConnect}>Подключить</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">GitHub</h1>
          <div className="page-subtitle">@{user.login}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <img src={user.avatarUrl} alt="" style={{ width: 40, height: 40, borderRadius: '50%' }} />
          <div style={{ minWidth: 0 }}>
            <div className="mini-item-title">{user.name || user.login}</div>
            <div className="mini-item-subtitle">@{user.login} · {user.publicRepos} public repos</div>
          </div>
          <button className="btn btn-danger btn-sm" style={{ marginLeft: 'auto' }} onClick={handleDisconnect}>Отключить</button>
        </div>
        <div className="detail-summary-grid">
          <div className="overview-stat"><span className="overview-stat-value">{repos.length}</span><span className="overview-stat-label">loaded</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{sites.length}</span><span className="overview-stat-label">sites</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{siteId || linkSiteId ? 'link' : 'free'}</span><span className="overview-stat-label">mode</span></div>
          <div className="overview-stat"><span className="overview-stat-value">{busy ? 'busy' : 'idle'}</span><span className="overview-stat-label">state</span></div>
        </div>
      </div>

      <div className="tabs tabs-compact">
        {(['repos', 'create', 'clone'] as const).map((t) => (
          <button
            key={t}
            className={`tab-btn ${tab === t ? 'active' : ''}`}
            onClick={() => { setTab(t); if (t === 'repos' && repos.length === 0) handleLoadRepos(); }}
          >
            {t === 'repos' ? 'Репозитории' : t === 'create' ? 'Создать' : 'Клонировать'}
          </button>
        ))}
      </div>

      {tab === 'repos' && (
        <div className="stack-sm">
          <div className="card">
            <div className="inline-form">
              <input className="form-input" placeholder="Поиск..." value={repoFilter} onChange={(e) => setRepoFilter(e.target.value)} />
              <button className="btn btn-secondary" onClick={handleLoadRepos} disabled={busy}>{busy ? '...' : '↻ Обновить'}</button>
            </div>
          </div>

          {repos.length === 0 && !busy ? (
            <div className="empty-state">
              <p>Репозитории не загружены</p>
              <button className="btn btn-secondary" onClick={handleLoadRepos}>Загрузить</button>
            </div>
          ) : (
            filteredRepos.map((repo) => (
              <div key={repo.id} className="mini-item-card">
                <div>
                  <div className="toolbar-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ minWidth: 0, flex: 1 }}>
                      <a href="#" className="mini-item-title" style={{ color: 'var(--accent)', textDecoration: 'none' }} onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: repo.url } })}>
                        {repo.fullName}
                      </a>
                      {repo.description && <div className="section-copy">{repo.description}</div>}
                      <div className="mini-item-subtitle">{repo.defaultBranch} · Обновлён {new Date(repo.updatedAt).toLocaleDateString()}</div>
                    </div>
                    <div className="site-card-meta-row" style={{ marginBottom: 0 }}>
                      <span className={`badge ${repo.isPrivate ? 'badge-gray' : 'badge-green'}`}>{repo.isPrivate ? 'private' : 'public'}</span>
                      {repo.stars > 0 && <span className="site-card-chip">⭐ {repo.stars}</span>}
                    </div>
                  </div>
                </div>
                <div className="toolbar-wrap">
                  {(siteId || linkSiteId) && <button className="btn btn-secondary btn-sm" onClick={() => handleLinkRepo(repo)}>Привязать</button>}
                  <button className="btn btn-secondary btn-sm" onClick={() => { setCloneUrl(repo.cloneUrl); setTab('clone'); }}>Клонировать</button>
                  <button className="btn btn-danger btn-sm" onClick={() => handleDeleteRepo(repo)}>Удалить</button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {tab === 'create' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Создать репозиторий</span></div>
          <div className="form-group">
            <label className="form-label">Имя репозитория *</label>
            <input className="form-input" placeholder="my-wordpress-site" value={repoName} onChange={(e) => setRepoName(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Описание</label>
            <input className="form-input" placeholder="Мой WP сайт" value={repoDesc} onChange={(e) => setRepoDesc(e.target.value)} />
          </div>
          <label className="checkbox-row"><input type="checkbox" checked={repoPrivate} onChange={(e) => setRepoPrivate(e.target.checked)} /> Приватный репозиторий</label>
          {sites.length > 0 && (
            <div className="form-group" style={{ marginTop: 10 }}>
              <label className="form-label">Привязать к сайту</label>
              <select className="form-input" value={linkSiteId} onChange={(e) => setLinkSiteId(e.target.value)}>
                <option value="">— Не привязывать —</option>
                {sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          )}
          <div className="toolbar-wrap" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleCreateRepo} disabled={busy}>{busy ? 'Создание...' : 'Создать'}</button>
          </div>
        </div>
      )}

      {tab === 'clone' && (
        <div className="card">
          <div className="card-header"><span className="card-title">Клонировать репозиторий</span></div>
          <div className="form-group">
            <label className="form-label">URL репозитория *</label>
            <input className="form-input" placeholder="https://github.com/user/repo.git" value={cloneUrl} onChange={(e) => setCloneUrl(e.target.value)} />
          </div>
          <div className="form-group">
            <label className="form-label">Локальный путь</label>
            <input className="form-input" placeholder="Оставьте пустым для папки сайтов" value={cloneLocalPath} onChange={(e) => setCloneLocalPath(e.target.value)} />
          </div>
          <div className="toolbar-wrap" style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={handleClone} disabled={busy}>{busy ? 'Клонирование...' : 'Клонировать'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
