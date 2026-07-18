import React, { useEffect, useMemo, useState } from 'react';
import { RemoteSite } from '../types';
import { vscode } from '../vscodeApi';
import { AppRoute } from '../App';

interface AgentInstallDiagnostic {
  code: string;
  title: string;
  details: string;
  recommendations: string[];
}

interface RemoteTokenDiagnostic {
  restAuthOk: boolean;
  restAuthDetails: string;
  tokenRegisterOk: boolean;
  tokenRegisterDetails: string;
  pingOk: boolean;
  pingDetails: string;
  success: boolean;
  recommendations: string[];
}

interface Props {
  remoteId: string;
  remotes: RemoteSite[];
  diagnostic?: AgentInstallDiagnostic;
  navigate: (r: AppRoute) => void;
  onToast: (msg: string, type?: 'success' | 'error' | 'info') => void;
}

export default function ManualAgentPage({ remoteId, remotes, diagnostic, navigate, onToast }: Props) {
  const remote = remotes.find((item) => item.id === remoteId);
  const [checking, setChecking] = useState(false);
  const [diagnosingToken, setDiagnosingToken] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [updating, setUpdating] = useState(false);
  const [cleaningUploads, setCleaningUploads] = useState(false);
  const [lastStatus, setLastStatus] = useState<{ installed: boolean; active: boolean; responsive: boolean } | null>(null);
  const [installDiagnostic, setInstallDiagnostic] = useState<AgentInstallDiagnostic | null>(diagnostic ?? null);
  const [tokenDiagnostic, setTokenDiagnostic] = useState<RemoteTokenDiagnostic | null>(null);

  useEffect(() => { setInstallDiagnostic(diagnostic ?? null); }, [diagnostic]);

  const uploadUrl = useMemo(() => remote ? `${remote.adminUrl}/plugin-install.php?tab=upload` : '', [remote]);
  const pluginsUrl = useMemo(() => remote ? `${remote.adminUrl}/plugins.php` : '', [remote]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      const msg = event.data;
      if (msg.type === 'agentCheckResult' && msg.remoteId === remoteId) {
        setChecking(false);
        setLastStatus(msg.status);
        if (msg.status.responsive) onToast('Агент найден и готов к работе.', 'success');
        else if (msg.status.installed) onToast('Плагин найден, но агент ещё не отвечает.', 'info');
        else onToast('Плагин WPDock Agent пока не найден на удалённом сайте.', 'error');
      }
      if (msg.type === 'remoteTokenDiagnostic' && msg.remoteId === remoteId) {
        setDiagnosingToken(false);
        setTokenDiagnostic(msg.diagnostic ?? null);
        if (msg.diagnostic?.success) onToast('Диагностика токена: REST и register-token работают.', 'success');
        else onToast('Диагностика токена завершена: найдены проблемы.', 'error');
      }
      if (msg.type === 'agentInstalled') {
        // Toast is shown once by the global handler in App.tsx; here we only reset local UI state.
        setChecking(false);
        setDiagnosingToken(false);
        setInstalling(false);
        setInstallDiagnostic(null);
      }
      if (msg.type === 'agentInstallFailed' && msg.remoteId === remoteId) {
        setChecking(false);
        setDiagnosingToken(false);
        setInstalling(false);
        setInstallDiagnostic(msg.diagnostic ?? null);
      }
      if (msg.type === 'agentUpdated' && msg.remoteId === remoteId) {
        // Toast is shown once by the global handler in App.tsx; here we only reset local UI state.
        setUpdating(false);
        setInstallDiagnostic(null);
      }
      if (msg.type === 'agentUpdateFailed' && msg.remoteId === remoteId) {
        setUpdating(false);
        setInstallDiagnostic(msg.diagnostic ?? null);
      }
      if (msg.type === 'remoteUploadResidueCleaned' && msg.remoteId === remoteId) {
        setCleaningUploads(false);
      }
      if (msg.type === 'error') {
        setChecking(false);
        setDiagnosingToken(false);
        setInstalling(false);
        setUpdating(false);
        setCleaningUploads(false);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }, [onToast, remoteId]);

  if (!remote) return <div className="page"><div className="empty-state"><h3>Удалённый сайт не найден</h3></div></div>;

  return (
    <div className="page sidebar-detail-page">
      <div className="page-header">
        <button className="page-back" onClick={() => navigate({ name: 'home' })}>←</button>
        <div className="page-title-wrap">
          <h1 className="page-title">Ручная установка агента</h1>
          <div className="page-subtitle">{remote.url}</div>
        </div>
      </div>

      <div className="detail-hero card">
        <div className="site-card-meta-row">
          <span className={`badge ${remote.agentInstalled ? 'badge-green' : 'badge-yellow'}`}>{remote.agentInstalled ? 'agent active' : 'agent missing'}</span>
          {remote.agentVersion && <span className="site-card-chip">v{remote.agentVersion}</span>}
          <span className="site-card-chip">{remote.name}</span>
        </div>
        <div className="section-copy">
          Если автоустановка не сработала из-за ограничений хостинга, загрузите ZIP вручную через WordPress Admin и затем выполните проверку.
        </div>
      </div>

      {!remote.agentInstalled && (
        <div className="card warning-card">
          <div className="toolbar-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="mini-item-title warning-text">WPDock Agent не установлен</div>
              <div className="section-copy">Нажмите автоустановку или выполните шаги ручной установки ниже.</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { setInstalling(true); vscode.postMessage({ type: 'installAgent', payload: { remoteId } }); }} disabled={installing}>
              {installing ? 'Установка...' : 'Установить автоматически'}
            </button>
          </div>
        </div>
      )}

      {remote.agentInstalled && (
        <div className="card">
          <div className="toolbar-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="mini-item-title">Обновление WPDock Agent{remote.agentVersion ? ` · текущая версия v${remote.agentVersion}` : ''}</div>
              <div className="section-copy">Загрузит актуальную версию агента из расширения и заменит установленную на сервере. Токен и настройки сохранятся.</div>
            </div>
            <button className="btn btn-primary btn-sm" onClick={() => { setUpdating(true); vscode.postMessage({ type: 'updateAgent', payload: { remoteId } }); }} disabled={updating}>
              {updating ? 'Обновление...' : 'Обновить WP Agent'}
            </button>
          </div>
        </div>
      )}

      {remote.agentInstalled && (
        <div className="card">
          <div className="toolbar-wrap" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div className="mini-item-title">Очистка остатков Push</div>
              <div className="section-copy">Удалит незавершённые resumable chunks и временные ZIP/SQL на сервере, если вы передумали продолжать прерванную загрузку.</div>
            </div>
            <button className="btn btn-danger btn-sm" onClick={() => { setCleaningUploads(true); vscode.postMessage({ type: 'cleanupRemoteUploads', payload: { remoteId } }); }} disabled={cleaningUploads}>
              {cleaningUploads ? 'Очистка...' : 'Очистить остатки'}
            </button>
          </div>
        </div>
      )}

      {installDiagnostic && (
        <div className="card error-card">
          <div className="mini-item-title error-text">Диагностика автоустановки: {installDiagnostic.title}</div>
          <div className="section-copy" style={{ marginTop: 8 }}>{installDiagnostic.details}</div>
          {installDiagnostic.recommendations?.length > 0 && (
            <div className="stack-sm" style={{ marginTop: 10 }}>
              {installDiagnostic.recommendations.map((item, idx) => (
                <div key={`${installDiagnostic.code}-${idx}`} className="section-copy">{idx + 1}. {item}</div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-header"><span className="card-title">Шаги</span></div>
        <div className="stack-sm">
          <div className="mini-item-card">
            <div className="mini-item-title">1. Откройте страницу загрузки плагина</div>
            <div className="section-copy">WordPress Admin → Plugins → Add Plugin → Upload Plugin</div>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: uploadUrl } })}>Открыть Upload Plugin</button>
          </div>
          <div className="mini-item-card">
            <div className="mini-item-title">2. Выберите ZIP WPDock Agent</div>
            <div className="section-copy">Расширение уже содержит готовый файл wpdock-agent.zip.</div>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'revealAgentZip' })}>Показать ZIP агента</button>
          </div>
          <div className="mini-item-card">
            <div className="mini-item-title">3. Установите и активируйте плагин</div>
            <div className="section-copy">После установки убедитесь, что плагин WPDock Agent активен в списке плагинов.</div>
            <button className="btn btn-secondary btn-sm" onClick={() => vscode.postMessage({ type: 'openBrowser', payload: { url: pluginsUrl } })}>Открыть список плагинов</button>
          </div>
          <div className="mini-item-card">
            <div className="mini-item-title">4. Подтвердите установку</div>
            <div className="section-copy">WPDock проверит наличие плагина, при необходимости активирует его и зарегистрирует токен.</div>
            <div className="toolbar-wrap">
              <button className="btn btn-primary btn-sm" onClick={() => { setChecking(true); vscode.postMessage({ type: 'checkRemoteAgent', payload: { remoteId } }); }} disabled={checking}>{checking ? 'Проверка...' : 'Проверить агент'}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => { setDiagnosingToken(true); vscode.postMessage({ type: 'diagnoseRemoteTokenAuth', payload: { remoteId } }); }} disabled={diagnosingToken}>{diagnosingToken ? 'Диагностика...' : 'Диагностика токена'}</button>
            </div>
          </div>
        </div>
      </div>

      {lastStatus && (
        <div className="card">
          <div className="card-header"><span className="card-title">Результат проверки</span></div>
          <div className="stack-sm">
            <div className="section-copy">Плагин найден: {lastStatus.installed ? 'да' : 'нет'}</div>
            <div className="section-copy">Плагин активен: {lastStatus.active ? 'да' : 'нет'}</div>
            <div className="section-copy">Агент отвечает: {lastStatus.responsive ? 'да' : 'нет'}</div>
          </div>
        </div>
      )}

      {tokenDiagnostic && (
        <div className="card">
          <div className="card-header"><span className="card-title">Диагностика токена</span></div>
          <div className="stack-sm">
            <div className="section-copy">REST авторизация: {tokenDiagnostic.restAuthOk ? 'OK' : 'ошибка'}</div>
            <div className="mini-item-subtitle">{tokenDiagnostic.restAuthDetails}</div>
            <div className="section-copy">Register token: {tokenDiagnostic.tokenRegisterOk ? 'OK' : 'ошибка'}</div>
            <div className="mini-item-subtitle">{tokenDiagnostic.tokenRegisterDetails}</div>
            <div className="section-copy">Ping агента: не проверяется</div>
            <div className="mini-item-subtitle">{tokenDiagnostic.pingDetails}</div>
            {tokenDiagnostic.recommendations?.length > 0 && (
              <div className="stack-sm" style={{ marginTop: 6 }}>
                {tokenDiagnostic.recommendations.map((item, idx) => (
                  <div key={`remote-token-rec-${idx}`} className="section-copy">{idx + 1}. {item}</div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="sticky-bottom-bar form-action-bar">
        <button className="btn btn-secondary" onClick={() => navigate({ name: 'remote-detail', remoteId })}>Remote</button>
        <button className="btn btn-secondary" onClick={() => navigate({ name: 'sync', remoteId, direction: 'pull' })}>Sync</button>
        <button className="btn btn-primary" onClick={() => vscode.postMessage({ type: 'revealAgentZip' })}>ZIP агента</button>
      </div>
    </div>
  );
}
