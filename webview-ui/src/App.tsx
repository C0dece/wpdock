import React, { useEffect, useState, useCallback, useRef } from 'react';
import { WPSite, RemoteSite } from './types';
import { vscode } from './vscodeApi';
import HomePage from './pages/HomePage';
import CreateSitePage from './pages/CreateSitePage';
import SiteDetailPage from './pages/SiteDetailPage';
import ConnectRemotePage from './pages/ConnectRemotePage';
import EditRemotePage from './pages/EditRemotePage';
import RemoteDetailPage from './pages/RemoteDetailPage';
import ManualAgentPage from './pages/ManualAgentPage';
import SyncPage from './pages/SyncPage';
import BackupPage from './pages/BackupPage';
import ImportSitePage from './pages/ImportSitePage';
import GitHubPage from './pages/GitHubPage';
import SettingsPage from './pages/SettingsPage';
import ToastContainer, { Toast } from './components/ToastContainer';
import './App.css';

export type AppRoute =
  | { name: 'home' }
  | { name: 'create-site' }
  | { name: 'site-detail'; siteId: string }
  | { name: 'connect-remote'; siteId?: string }
  | { name: 'edit-remote'; remoteId: string }
  | { name: 'remote-detail'; remoteId: string }
  | { name: 'manual-agent'; remoteId: string }
  | { name: 'sync'; remoteId: string; direction: 'pull' | 'push'; localSiteId?: string; quickPull?: boolean }
  | { name: 'backup'; siteId?: string; tab?: 'backups' | 'cloud' | 'settings' }
  | { name: 'import-site' }
  | { name: 'github-manager'; siteId?: string }
  | { name: 'settings' };

export default function App() {
  const [route, setRoute] = useState<AppRoute>({ name: 'home' });
  const [sites, setSites] = useState<WPSite[]>([]);
  const [remotes, setRemotes] = useState<RemoteSite[]>([]);
  const [viewContext, setViewContext] = useState<{ mode: 'dashboard' | 'project'; siteId?: string; workspacePath?: string }>({ mode: 'dashboard' });
  const [localAccess, setLocalAccess] = useState<{ proxyRunning: boolean; portProxyActive: boolean } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [agentInstallDiagnostics, setAgentInstallDiagnostics] = useState<Record<string, any>>({});
  const [pendingManualAgentRemoteId, setPendingManualAgentRemoteId] = useState<string | null>(null);
  const [globalProgress, setGlobalProgress] = useState<{ visible: boolean; message: string; startedAt: number; operationId?: string; cancellable?: boolean; cancelling?: boolean }>({
    visible: false,
    message: '',
    startedAt: 0,
  });
  const [progressElapsed, setProgressElapsed] = useState(0);
  const toastId = useRef(0);
  const progressHideTimerRef = useRef<number | null>(null);
  // Latest route, readable from the long-lived message handler without
  // re-subscribing it on every navigation.
  const routeRef = useRef(route);
  routeRef.current = route;

  const addToast = useCallback((msg: string, type: 'success' | 'error' | 'info' = 'info') => {
    const id = ++toastId.current;
    setToasts((prev) => [...prev, { id, message: msg, type }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4000);
  }, []);

  const navigate = useCallback((r: AppRoute) => setRoute(r), []);

  const showGlobalProgress = useCallback((message: string, operationId?: string, cancellable?: boolean) => {
    // Прогресс остаётся видимым на всё время операции. Фаза (message) обновляется
    // по мере поступления сообщений, а тикающий таймер показывает, что процесс жив.
    // Скрываем только по терминальному событию (hideGlobalProgress) или по жёсткому
    // предохранителю в 5 минут — чтобы баннер не завис навсегда при сбое бэкенда.
    setGlobalProgress((prev) => {
      const sameOp = !operationId || operationId === prev.operationId;
      return {
        visible: true,
        message: message || prev.message || 'Выполняется операция...',
        startedAt: prev.visible && prev.startedAt && sameOp ? prev.startedAt : Date.now(),
        operationId: operationId ?? prev.operationId,
        cancellable: cancellable ?? prev.cancellable,
        // Reset the "cancelling" spinner only when a brand-new operation starts.
        cancelling: sameOp ? prev.cancelling : false,
      };
    });
    if (progressHideTimerRef.current) {
      window.clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
    progressHideTimerRef.current = window.setTimeout(() => {
      setGlobalProgress((prev) => ({ ...prev, visible: false }));
      progressHideTimerRef.current = null;
    }, 5 * 60 * 1000);
  }, []);

  const hideGlobalProgress = useCallback(() => {
    if (progressHideTimerRef.current) {
      window.clearTimeout(progressHideTimerRef.current);
      progressHideTimerRef.current = null;
    }
    setGlobalProgress({ visible: false, message: '', startedAt: 0 });
  }, []);

  const cancelGlobalOperation = useCallback(() => {
    setGlobalProgress((prev) => {
      if (!prev.visible || !prev.operationId) return prev;
      vscode.postMessage({ type: 'cancelOperation', payload: { operationId: prev.operationId } });
      return { ...prev, cancelling: true, message: 'Отмена операции...' };
    });
  }, []);

  // Тикающий таймер «прошло N сек» — даёт пользователю видимый признак того,
  // что операция выполняется, даже когда бэкенд молча работает над одной фазой.
  useEffect(() => {
    if (!globalProgress.visible || !globalProgress.startedAt) {
      setProgressElapsed(0);
      return;
    }
    const tick = () => setProgressElapsed(Math.floor((Date.now() - globalProgress.startedAt) / 1000));
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [globalProgress.visible, globalProgress.startedAt]);

  useEffect(() => {
    // Listen to messages from extension
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      switch (msg.type) {
        case 'state':
          setSites(msg.sites);
          setRemotes(msg.remotes);
          if (msg.viewContext) {
            setViewContext(msg.viewContext);
            if (msg.viewContext.mode === 'project') {
              // Snap to the project dashboard only on first load (route still
              // 'home'); a periodic state refresh must not yank the user out of
              // a sub-page like sync/github/backup.
              if (msg.viewContext.siteId) {
                if (routeRef.current.name === 'home') {
                  navigate({ name: 'site-detail', siteId: msg.viewContext.siteId });
                }
              } else {
                navigate({ name: 'home' });
              }
            }
          }
          break;
        case 'localAccessStatus':
          setLocalAccess(msg.status ?? null);
          break;
        case 'localAccessReady':
          hideGlobalProgress();
          setLocalAccess(msg.status ?? null);
          addToast('Локальный доступ подготовлен', 'success');
          break;
        case 'siteStatusUpdate': {
          setSites((prev) => prev.map((site) => (
            site.id === msg.siteId
              ? { ...site, status: msg.status }
              : site
          )));
          if (msg.status === 'starting') {
            addToast('Сайт запускается...', 'info');
          }
          if (msg.status === 'running') {
            hideGlobalProgress();
            addToast('Сайт запущен', 'success');
          }
          if (msg.status === 'error') {
            hideGlobalProgress();
            addToast('Сайт недоступен или запущен с ошибкой', 'error');
          }
          if (msg.status === 'stopped') {
            hideGlobalProgress();
            addToast('Сайт остановлен', 'info');
          }
          break;
        }
        case 'livePreviewState':
          setSites((prev) => prev.map((site) => (
            site.id === msg.siteId
              ? { ...site, livePreviewRunning: Boolean(msg.running) }
              : site
          )));
          addToast(msg.running ? 'Live Preview включён' : 'Live Preview выключен', msg.running ? 'success' : 'info');
          break;
        case 'navigate':
          if (msg.route === 'create-site') navigate({ name: 'create-site' });
          else if (msg.route === 'connect-remote') navigate({ name: 'connect-remote', siteId: msg.param });
          else if (msg.route === 'edit-remote' && msg.param) navigate({ name: 'edit-remote', remoteId: msg.param });
          else if (msg.route === 'remote-detail' && msg.param) navigate({ name: 'remote-detail', remoteId: msg.param });
          else if (msg.route === 'import-site') navigate({ name: 'import-site' });
          else if (msg.route === 'backup') navigate({ name: 'backup', siteId: msg.param });
          else if (msg.route === 'github-manager') navigate({ name: 'github-manager', siteId: msg.param });
          else if (msg.route === 'pull-remote' && msg.param) {
            const linkedSiteId = remotes.find((r) => r.id === msg.param)?.linkedSiteIds?.[0];
            navigate({ name: 'sync', remoteId: msg.param, direction: 'pull', localSiteId: linkedSiteId, quickPull: Boolean(linkedSiteId) });
          } else if (msg.route === 'push-remote' && msg.param) {
            const linkedSiteId = remotes.find((r) => r.id === msg.param)?.linkedSiteIds?.[0];
            navigate({ name: 'sync', remoteId: msg.param, direction: 'push', localSiteId: linkedSiteId });
          }
          break;
        case 'progress':
          showGlobalProgress(msg.message ?? 'Выполняется операция...', msg.operationId, msg.cancellable);
          break;
        case 'syncProgress':
          showGlobalProgress(msg.message ?? 'Синхронизация...', msg.operationId, msg.cancellable);
          break;
        case 'operationCancelled':
          hideGlobalProgress();
          addToast(msg.message || 'Операция отменена', 'info');
          break;
        case 'error':
          hideGlobalProgress();
          addToast(msg.message, 'error');
          break;
        case 'siteCreated':
          hideGlobalProgress();
          addToast(`Сайт "${msg.site.name}" создан!`, 'success');
          navigate({ name: 'site-detail', siteId: msg.site.id });
          break;
        case 'siteImported':
          hideGlobalProgress();
          break;
        case 'remoteConnected':
          hideGlobalProgress();
          addToast(`Удалённый сайт "${msg.remote.name}" подключён!`, 'success');
          if (pendingManualAgentRemoteId && pendingManualAgentRemoteId === msg.remote.id) {
            navigate({ name: 'manual-agent', remoteId: msg.remote.id });
            setPendingManualAgentRemoteId(null);
          } else {
            navigate({ name: 'home' });
          }
          break;
        case 'remoteUpdated':
          hideGlobalProgress();
          addToast(`Удалённый сайт "${msg.remote.name}" обновлён!`, 'success');
          navigate({ name: 'home' });
          break;
        case 'remoteRemoved':
          hideGlobalProgress();
          addToast('Удалённый сайт удалён', 'success');
          navigate({ name: 'home' });
          break;
        case 'remoteInstallFailed':
          hideGlobalProgress();
          addToast(`Сайт подключён, но автоустановка агента не удалась: ${msg.message}`, 'error');
          setAgentInstallDiagnostics((prev) => ({ ...prev, [msg.remoteId]: msg.diagnostic ?? null }));
          setPendingManualAgentRemoteId(msg.remoteId);
          navigate({ name: 'manual-agent', remoteId: msg.remoteId });
          break;
        case 'agentInstallFailed':
          hideGlobalProgress();
          setAgentInstallDiagnostics((prev) => ({ ...prev, [msg.remoteId]: msg.diagnostic ?? null }));
          break;
        // Terminal results of remote operations that stream `progress` messages.
        // Without these, the elapsed-seconds banner would hang until the 5-min failsafe.
        case 'agentCheckResult':
          hideGlobalProgress();
          break;
        case 'remoteTokenDiagnostic':
          hideGlobalProgress();
          break;
        case 'agentUpdated':
          hideGlobalProgress();
          addToast(
            msg.version ? `WPDock агент обновлён до версии ${msg.version}.` : 'WPDock агент обновлён.',
            'success'
          );
          setAgentInstallDiagnostics((prev) => {
            const next = { ...prev };
            delete next[msg.remoteId];
            return next;
          });
          break;
        case 'agentUpdateFailed':
          hideGlobalProgress();
          setAgentInstallDiagnostics((prev) => ({ ...prev, [msg.remoteId]: msg.diagnostic ?? null }));
          break;
        case 'agentInstalled':
          hideGlobalProgress();
          addToast('WPDock агент установлен на удалённом сайте.', 'success');
          setAgentInstallDiagnostics((prev) => {
            const next = { ...prev };
            delete next[msg.remoteId];
            return next;
          });
          if (pendingManualAgentRemoteId === msg.remoteId) {
            setPendingManualAgentRemoteId(null);
          }
          break;
        case 'syncDone':
          hideGlobalProgress();
          addToast(
            msg.direction === 'pull' ? 'Скачивание с сервера завершено!' : 'Загрузка на сервер завершена!',
            'success'
          );
          break;
        case 'pullDiagnostic':
          if (msg?.diagnostic?.summary) {
            addToast(`Диагностика pull: ${msg.diagnostic.summary}`, 'info');
          }
          break;
        case 'settingsLoaded':
          // forwarded to SettingsPage via its own window listener
          break;
        case 'siteUpdated':
          hideGlobalProgress();
          addToast(`Сайт "${msg.site.name}" обновлён!`, 'success');
          navigate({ name: 'site-detail', siteId: msg.site.id });
          break;
        case 'siteRestarted':
          addToast('Веб-сервер/порт изменён: сайт автоматически перезапущен.', 'info');
          break;
        case 'gitPushed':
          hideGlobalProgress();
          addToast('Изменения сохранены и отправлены на GitHub', 'success');
          break;
        case 'workflowCreated':
          hideGlobalProgress();
          addToast('GitHub Actions workflow создан!', 'success');
          break;
        // Терминальные события бэкапа/облака — скрываем глобальный баннер прогресса,
        // чтобы фраза вроде «Uploaded to Google Drive ✓» не висела до фейл-сейфа.
        case 'cloudUploadDone':
          hideGlobalProgress();
          break;
        case 'backupCreated':
          hideGlobalProgress();
          break;
        case 'backupRestored':
          hideGlobalProgress();
          break;
        case 'siteExported':
          hideGlobalProgress();
          break;
        case 'cloudFileDeleted':
          hideGlobalProgress();
          break;
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [addToast, hideGlobalProgress, navigate, pendingManualAgentRemoteId, remotes, showGlobalProgress]);

  // Tell the extension we're ready — once on mount only.
  // Keeping this in the message-handler effect re-fired it on every `remotes`
  // change, and since each `sendFullState` returns a fresh `remotes` array the
  // dependency "changed" every round-trip → an infinite ready→state→ready loop
  // that spawned `git` for every site continuously and starved the proxy.
  useEffect(() => {
    vscode.postMessage({ type: 'ready' });
  }, []);

  useEffect(() => {
    const onVisibilityChange = () => {
      if (!document.hidden) {
        vscode.postMessage({ type: 'ready' });
      }
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  const renderRoute = () => {
    if (viewContext.mode === 'project') {
      if (!viewContext.siteId) {
        return (
          <div className="page project-empty-page">
            <div className="empty-state">
              <h3>WPDock-сайт не найден</h3>
              <p>
                Откройте папку конкретного сайта WPDock или файл внутри неё —
                здесь появятся настройки только этого проекта.
              </p>
              {viewContext.workspacePath && <p className="section-copy">{viewContext.workspacePath}</p>}
            </div>
          </div>
        );
      }

      // The project sidebar has no top nav: home/site-detail both mean "this
      // site's dashboard". Every other route (sync/github/backup/remotes) falls
      // through to the shared switch below so Pull/Push and the GitHub manager
      // work right here in the project panel too.
      if (route.name === 'home' || route.name === 'site-detail') {
        return (
          <SiteDetailPage
            siteId={viewContext.siteId}
            sites={sites}
            remotes={remotes}
            navigate={navigate}
            onToast={addToast}
            projectMode
          />
        );
      }
    }

    switch (route.name) {
      case 'home':
        return (
          <HomePage
            sites={sites}
            remotes={remotes}
            localAccess={localAccess}
            navigate={navigate}
          />
        );
      case 'create-site':
        return <CreateSitePage navigate={navigate} onToast={addToast} />;
      case 'site-detail':
        return (
          <SiteDetailPage
            siteId={route.siteId}
            sites={sites}
            remotes={remotes}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'connect-remote':
        return <ConnectRemotePage navigate={navigate} onToast={addToast} siteId={route.siteId} sites={sites} />;
      case 'edit-remote':
        return (
          <EditRemotePage
            remoteId={route.remoteId}
            remotes={remotes}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'remote-detail':
        return (
          <RemoteDetailPage
            remoteId={route.remoteId}
            remotes={remotes}
            sites={sites}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'manual-agent':
        return (
          <ManualAgentPage
            remoteId={route.remoteId}
            remotes={remotes}
            diagnostic={agentInstallDiagnostics[route.remoteId]}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'sync':
        return (
          <SyncPage
            remoteId={route.remoteId}
            direction={route.direction}
            localSiteId={route.localSiteId}
            quickPull={route.quickPull}
            sites={sites}
            remotes={remotes}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'backup':
        return (
          <BackupPage
            siteId={route.siteId}
            initialTab={route.tab}
            sites={sites}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'import-site':
        return <ImportSitePage navigate={navigate} onToast={addToast} />;
      case 'github-manager':
        return (
          <GitHubPage
            siteId={route.siteId}
            sites={sites}
            navigate={navigate}
            onToast={addToast}
          />
        );
      case 'settings':
        return <SettingsPage navigate={navigate} onToast={addToast} />;
    }
  };

  const topNavItems: Array<{
    key: string;
    label: string;
    icon: string;
    route: AppRoute;
    isActive: boolean;
    className?: string;
  }> = [
    { key: 'home', label: 'Сайты', icon: '⬡', route: { name: 'home' }, isActive: route.name === 'home' },
    { key: 'import', label: 'Импорт', icon: '↙', route: { name: 'import-site' }, isActive: route.name === 'import-site' },
    { key: 'backup', label: 'Бэкапы', icon: '💾', route: { name: 'backup' }, isActive: route.name === 'backup' },
    { key: 'github', label: 'GitHub', icon: '⎇', route: { name: 'github-manager' }, isActive: route.name === 'github-manager' },
    { key: 'remote', label: 'Remote', icon: '☁', route: { name: 'connect-remote' }, isActive: route.name === 'connect-remote' },
    { key: 'create', label: 'Новый', icon: '+', route: { name: 'create-site' }, isActive: route.name === 'create-site', className: 'nav-btn-accent' },
    { key: 'settings', label: 'Настройки', icon: '⚙', route: { name: 'settings' }, isActive: route.name === 'settings' },
  ];
  const isProjectMode = viewContext.mode === 'project';

  return (
    <div className={`app ${isProjectMode ? 'app-project-mode' : ''}`}>
      {!isProjectMode && (
        <header className="app-header">
          <div className="app-topbar">
            <nav className="app-nav" aria-label="Основная навигация">
              {topNavItems.map((item) => (
                <button
                  key={item.key}
                  className={`nav-btn nav-btn-icon ${item.className ?? ''} ${item.isActive ? 'active' : ''}`}
                  onClick={() => navigate(item.route)}
                  title={item.label}
                  aria-label={item.label}
                >
                  <span className="nav-btn-glyph">{item.icon}</span>
                  <span className="nav-btn-label">{item.label}</span>
                </button>
              ))}
            </nav>
          </div>
        </header>
      )}

      {globalProgress.visible && (
        <div className="global-progress-banner" aria-live="polite">
          <span className="global-progress-spinner" />
          <span className="global-progress-message">{globalProgress.message}</span>
          <span className="global-progress-elapsed">{progressElapsed}s</span>
          {globalProgress.cancellable && globalProgress.operationId && (
            <button
              className="global-progress-cancel"
              onClick={cancelGlobalOperation}
              disabled={globalProgress.cancelling}
              title="Отменить текущую операцию"
            >
              {globalProgress.cancelling ? 'Отмена...' : 'Отменить'}
            </button>
          )}
        </div>
      )}

      <main className="app-content">{renderRoute()}</main>

      <ToastContainer toasts={toasts} />
    </div>
  );
}
