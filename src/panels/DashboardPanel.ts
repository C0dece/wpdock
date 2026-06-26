import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { isSiteStartCancelledError, SiteManager } from '../services/SiteManager';
import { RemoteService } from '../services/RemoteService';
import { GitService } from '../services/GitService';
import { BackupService } from '../services/BackupService';
import { CloudBackupService } from '../services/CloudBackupService';
import { LivePreviewService } from '../services/LivePreviewService';
import { DashboardRoute, WPSite } from '../types';
import { Logger } from '../utils/logger';
import { OperationRegistry, isCancelledError } from '../utils/cancellation';

export class DashboardPanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'wpdock.launcher';
  public static readonly projectViewType = 'wpdock.project';
  private view: vscode.WebviewView | undefined;
  private disposables: vscode.Disposable[] = [];
  private refreshTimer: NodeJS.Timeout | undefined;
  private pendingStateRefresh: NodeJS.Timeout | undefined;
  private readyLogged = false;
  private autoLocalAccessRequested = false;
  private pendingRoute: { route?: DashboardRoute; param?: string } | undefined;
  /** In-flight cancellable operations (pull/push/create); cancelled from the webview. */
  private readonly operations = new OperationRegistry();

  constructor(
    private context: vscode.ExtensionContext,
    private siteManager: SiteManager,
    private remoteService: RemoteService,
    private gitService: GitService,
    private backupService: BackupService,
    private cloudBackup: CloudBackupService,
    private livePreview: LivePreviewService,
    private setupLocalAccess: (onProgress?: (msg: string) => void) => Promise<void>,
    private getLocalAccessStatus: () => { proxyRunning: boolean; portProxyActive: boolean },
    private readonly options: {
      mode?: 'dashboard' | 'project';
      viewContainerCommand?: string;
    } = {},
  ) {
    this.refreshTimer = setInterval(() => {
      if (!this.isVisible()) {return;}
      void this.sendFullState();
    }, 3000);
    this.context.subscriptions.push(
      this.siteManager.onDidChangeSites(() => this.queueFullState()),
      this.siteManager.onDidChangeSiteStatus(() => this.queueFullState()),
      this.remoteService.onDidChangeRemotes(() => this.queueFullState())
    );
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.title = this.isProjectMode() ? 'Текущий сайт' : '';
    webviewView.description = this.isProjectMode() ? 'Настройки проекта' : '';
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'resources'),
      ],
    };

    webviewView.webview.html = this.getHtml();
    webviewView.webview.onDidReceiveMessage(
      (msg) => this.handleMessage(msg),
      null,
      this.disposables
    );
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.sendFullState();
        this.flushPendingNavigation();
      }
    }, null, this.disposables);
    webviewView.onDidDispose(() => {
      if (this.view === webviewView) {
        this.view = undefined;
      }
    }, null, this.disposables);

    void this.sendFullState();
    setTimeout(() => this.flushPendingNavigation(), 250);
  }

  async show(route?: DashboardRoute, param?: string): Promise<void> {
    this.pendingRoute = { route, param };
    try {
      await vscode.commands.executeCommand(this.options.viewContainerCommand ?? 'workbench.view.extension.wpdock');
    } catch (err) {
      if (!this.isProjectMode()) {throw err;}
      await vscode.commands.executeCommand(DashboardPanel.projectViewType + '.focus');
    }
    this.flushPendingNavigation();
  }

  getCurrentProjectSite(): WPSite | undefined {
    return this.findCurrentProjectSite();
  }

  refresh(): void {
    this.queueFullState();
  }

  private async handleMessage(message: any): Promise<void> {
    const { type, payload } = message;

    // 'ready' fires on every load/visibility change — log only once, suppress the rest
    if (type === 'ready') {
      if (!this.readyLogged) {
        Logger.log('[Dashboard] webview ready');
        this.readyLogged = true;
      } else {
        Logger.debug('[Dashboard] message: ready (suppressed)');
      }
    } else {
      Logger.log(`[Dashboard] message: ${type}`);
    }

    switch (type) {
      case 'ready':
        await this.sendFullState();
        void this.maybeAutoSetupLocalAccess();
        break;

      case 'cancelOperation':
        // Webview cancel button: abort a specific operation, or all if no id given.
        this.operations.cancel(payload?.operationId);
        break;

      case 'setupLocalAccess':
        try {
          this.autoLocalAccessRequested = true;
          this.postMessage({ type: 'progress', message: 'Подготовка локального доступа...' });
          await this.setupLocalAccess((msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          await this.sendFullState();
          this.postMessage({ type: 'localAccessReady', status: this.getLocalAccessStatus() });
        } catch (err: any) {
          Logger.error('[Dashboard] setupLocalAccess failed', err);
          this.postMessage({ type: 'error', message: err.message });
        } finally {
          this.autoLocalAccessRequested = false;
        }
        break;

      case 'createSite': {
        const op = this.operations.begin();
        try {
          this.postMessage({ type: 'progress', message: 'Запуск настройки сайта...', operationId: op.token.id, cancellable: true });
          const site = await this.siteManager.createSite(payload, (msg) => {
            op.token.throwIfCancelled();
            this.postMessage({ type: 'progress', message: msg, operationId: op.token.id, cancellable: true });
          });
          this.postMessage({ type: 'siteCreated', site });
          await this.sendFullState();
        } catch (err: any) {
          if (isCancelledError(err)) {
            this.postMessage({ type: 'operationCancelled', operationId: op.token.id, message: 'Создание сайта отменено' });
            await this.sendFullState();
            break;
          }
          Logger.error(`[Dashboard] createSite failed`, err);
          this.postMessage({ type: 'error', message: err.message });
        } finally {
          op.dispose();
        }
        break;
      }

      case 'startSite':
        try {
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'starting' });
          this.postMessage({ type: 'progress', message: 'Сайт запускается...' });
          await this.siteManager.startSite(payload.siteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'running' });
          await this.sendFullState();
        } catch (err: any) {
          if (isSiteStartCancelledError(err)) {
            await this.sendFullState();
            break;
          }
          Logger.error(`[Dashboard] startSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'error' });
          await this.sendFullState();
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'stopSite':
        try {
          this.postMessage({ type: 'progress', message: 'Остановка сайта...' });
          await this.livePreview.stop(payload.siteId);
          await this.siteManager.stopSite(payload.siteId);
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'stopped' });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] stopSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'forceStopSite':
        try {
          this.postMessage({ type: 'progress', message: 'Принудительная остановка сайта...' });
          await this.livePreview.stop(payload.siteId);
          await this.siteManager.forceStopSite(payload.siteId);
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'stopped' });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] forceStopSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'forceRestartSite':
        try {
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'starting' });
          this.postMessage({ type: 'progress', message: 'Убиваю зависшие процессы и перезапускаю сайт...' });
          await this.livePreview.stop(payload.siteId);
          await this.siteManager.forceRestartSite(payload.siteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'running' });
          await this.sendFullState();
        } catch (err: any) {
          if (isSiteStartCancelledError(err)) {
            await this.sendFullState();
            break;
          }
          Logger.error(`[Dashboard] forceRestartSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'siteStatusUpdate', siteId: payload.siteId, status: 'error' });
          await this.sendFullState();
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'deleteSite':
        try {
          await this.livePreview.stop(payload.siteId);
          let deleteFiles = payload.deleteFiles;
          // When the UI doesn't pre-decide, ask via a native modal dialog
          // (window.confirm is blocked inside VS Code webviews).
          if (deleteFiles === undefined) {
            const site = this.siteManager.getSite(payload.siteId);
            const confirm = await vscode.window.showWarningMessage(
              `Удалить сайт "${site?.name ?? ''}"? Можно удалить только запись или запись вместе с файлами.`,
              { modal: true },
              'Удалить только запись',
              'Удалить всё'
            );
            if (!confirm) {break;}
            deleteFiles = confirm === 'Удалить всё';
          }
          await this.siteManager.deleteSite(payload.siteId, deleteFiles);
          this.postMessage({ type: 'siteDeleted', siteId: payload.siteId });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] deleteSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'resetSite':
        try {
          await this.livePreview.stop(payload.siteId);
          const site = this.siteManager.getSite(payload.siteId);
          const confirm = await vscode.window.showWarningMessage(
            `Полностью сбросить сайт "${site?.name ?? ''}" до чистой установки WordPress? Все файлы сайта и база данных будут пересозданы.`,
            { modal: true },
            'Сбросить и сохранить Git',
            'Сбросить с удалением Git'
          );
          if (!confirm) {break;}
          this.postMessage({ type: 'progress', message: 'Полный сброс сайта...' });
          await this.siteManager.resetSite(
            payload.siteId,
            confirm === 'Сбросить и сохранить Git',
            (msg) => {
              this.postMessage({ type: 'progress', message: msg });
            }
          );
          this.postMessage({ type: 'siteReset', siteId: payload.siteId });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] resetSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'resetSiteDatabase':
        try {
          await this.livePreview.stop(payload.siteId);
          const site = this.siteManager.getSite(payload.siteId);
          const confirm = await vscode.window.showWarningMessage(
            `Сбросить только базу данных сайта "${site?.name ?? ''}"? Файлы и wp-content останутся на месте, но БД будет пересоздана заново.`,
            { modal: true },
            'Сбросить БД'
          );
          if (confirm !== 'Сбросить БД') {break;}
          this.postMessage({ type: 'progress', message: 'Сброс базы данных...' });
          await this.siteManager.resetSiteDatabase(payload.siteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'siteDbReset', siteId: payload.siteId });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] resetSiteDatabase failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'reinstallSiteKeepContent':
        try {
          await this.livePreview.stop(payload.siteId);
          const site = this.siteManager.getSite(payload.siteId);
          const confirm = await vscode.window.showWarningMessage(
            `Переустановить WordPress для сайта "${site?.name ?? ''}" без удаления wp-content? База данных будет пересоздана.`,
            { modal: true },
            'Переустановить и сохранить Git',
            'Переустановить с удалением Git'
          );
          if (!confirm) {break;}
          this.postMessage({ type: 'progress', message: 'Переустановка WordPress...' });
          await this.siteManager.reinstallSiteKeepContent(
            payload.siteId,
            confirm === 'Переустановить и сохранить Git',
            (msg) => {
              this.postMessage({ type: 'progress', message: msg });
            }
          );
          this.postMessage({ type: 'siteReinstalled', siteId: payload.siteId });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] reinstallSiteKeepContent failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'updateSite':
        try {
          const current = this.siteManager.getSite(payload.siteId);
          const requestedServer = payload?.updates?.webServer as ('php' | 'nginx' | 'apache' | undefined);
          const requestedPort = payload?.updates?.port as (number | undefined);
          const restartExpected = !!current && current.status === 'running' && (
            (requestedServer !== undefined && requestedServer !== (current.webServer ?? 'php')) ||
            (requestedPort !== undefined && requestedPort > 0 && requestedPort !== current.port)
          );

          const updated = await this.siteManager.updateSite(payload.siteId, payload.updates);
          this.postMessage({ type: 'siteUpdated', site: updated });
          if (restartExpected) {
            this.postMessage({
              type: 'siteRestarted',
              siteId: updated.id,
              webServer: updated.webServer ?? 'php',
            });
          }
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] updateSite failed siteId=${payload.siteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'openBrowser':
        await this.openTrustedExternal(payload.url);
        break;

      case 'openFolder':
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(payload.path));
        break;

      case 'revealAgentZip':
        vscode.commands.executeCommand(
          'revealFileInOS',
          vscode.Uri.file(path.join(this.context.extensionPath, 'resources', 'wpdock-agent.zip'))
        );
        break;

      case 'openInExplorer': {
        const site = this.siteManager.getSite(payload.siteId);
        if (site) {
          vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(site.path),
            { forceNewWindow: true }
          );
        }
        break;
      }

      case 'openSiteLogs':
        try {
          this.siteManager.openSiteLogs(payload.siteId);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'openLocalMailFolder':
        try {
          this.siteManager.openLocalMailFolder(payload.siteId);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'connectRemote':
        try {
          this.postMessage({ type: 'progress', message: 'Проверка подключения к WordPress...' });
          let remote = await this.remoteService.addRemote(payload);
          if (payload.linkSiteId) {
            const targetSite = this.siteManager.getSite(payload.linkSiteId);
            if (targetSite) {
              this.siteManager.addRemoteLink(targetSite.id, remote.id);
              remote = this.remoteService.addLinkedSite(remote.id, targetSite.id);
            }
          }
          if (remote.autoInstallAgent) {
            try {
              this.postMessage({ type: 'progress', message: 'Автоустановка агента...' });
              await this.remoteService.installAgent(remote.id, (msg) => {
                this.postMessage({ type: 'progress', message: msg });
              });
              remote = this.remoteService.getRemote(remote.id) ?? remote;
            } catch (installErr: any) {
              remote = this.remoteService.getRemote(remote.id) ?? remote;
              const diagnostic = this.remoteService.getAgentInstallDiagnostic(installErr);
              this.postMessage({
                type: 'remoteInstallFailed',
                remoteId: remote.id,
                message: installErr.message,
                diagnostic,
              });
            }
          }
          this.postMessage({ type: 'remoteConnected', remote });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'linkRemoteToSite':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          const remote = this.remoteService.getRemote(payload.remoteId);
          if (!site) {throw new Error('Site not found');}
          if (!remote) {throw new Error('Remote not found');}

          this.siteManager.addRemoteLink(site.id, remote.id);
          this.remoteService.addLinkedSite(remote.id, site.id);
          this.postMessage({ type: 'remoteLinked', siteId: site.id, remoteId: remote.id });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'unlinkRemoteFromSite':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          const remoteId = payload.remoteId;
          if (!remoteId) {throw new Error('Remote not found');}
          this.siteManager.removeRemoteLink(site.id, remoteId);
          this.remoteService.removeLinkedSite(remoteId, site.id);
          this.postMessage({ type: 'remoteUnlinked', siteId: site.id, remoteId });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'updateRemote':
        try {
          this.postMessage({ type: 'progress', message: 'Сохранение удалённого сайта...' });
          const remote = await this.remoteService.updateRemoteSettings(payload.remoteId, payload.updates ?? {});
          this.postMessage({ type: 'remoteUpdated', remote });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'installAgent':
        try {
          await this.remoteService.installAgent(payload.remoteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'agentInstalled', remoteId: payload.remoteId });
          await this.sendFullState();
        } catch (err: any) {
          const diagnostic = this.remoteService.getAgentInstallDiagnostic(err);
          this.postMessage({ type: 'agentInstallFailed', remoteId: payload.remoteId, message: err.message, diagnostic });
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'checkRemoteAgent':
        try {
          const status = await this.remoteService.checkAgent(payload.remoteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'agentCheckResult', remoteId: payload.remoteId, status });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'diagnoseRemoteTokenAuth':
        try {
          const diagnostic = await this.remoteService.diagnoseRemoteTokenAuth(payload.remoteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'remoteTokenDiagnostic', remoteId: payload.remoteId, diagnostic });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'updateAgent':
        try {
          const result = await this.remoteService.updateAgent(payload.remoteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'agentUpdated', remoteId: payload.remoteId, version: result.version, previousVersion: result.previousVersion });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] updateAgent failed remoteId=${payload?.remoteId}`, err);
          const diagnostic = this.remoteService.getAgentInstallDiagnostic(err);
          this.postMessage({ type: 'agentUpdateFailed', remoteId: payload?.remoteId, message: err.message, diagnostic });
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'resetRemoteWp':
        try {
          const remote = this.remoteService.getRemote(payload.remoteId);
          if (payload.skipConfirm !== true) {
            const confirm = await vscode.window.showWarningMessage(
              `Сбросить WordPress на "${remote?.name ?? ''}" до заводских настроек?`,
              {
                modal: true,
                detail:
                  'Все записи, страницы, комментарии, настройки и данные из базы будут удалены без возможности восстановления — сайт станет как сразу после установки.\n\n' +
                  'Будут удалены и файлы: все плагины (кроме WPDock Agent), все темы (кроме одной стандартной) и содержимое папки uploads.\n\n' +
                  'Сохранятся: учётная запись администратора и её пароль, Application Password, плагин WPDock Agent и одна стандартная тема (связь с VS Code не прервётся).',
              },
              'Сбросить WordPress'
            );
            if (confirm !== 'Сбросить WordPress') { break; }
          }
          this.postMessage({ type: 'progress', message: 'Сброс WordPress...' });
          const result = await this.remoteService.resetRemoteWp(payload.remoteId, (msg) => {
            this.postMessage({ type: 'progress', message: msg });
          });
          this.postMessage({ type: 'remoteWpReset', remoteId: payload.remoteId, result });
          await this.sendFullState();
        } catch (err: any) {
          Logger.error(`[Dashboard] resetRemoteWp failed remoteId=${payload?.remoteId}`, err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'pullRemote': {
        const op = this.operations.begin();
        try {
          let site = this.siteManager.getSite(payload.localSiteId);
          if (payload.createSite) {
            this.postMessage({ type: 'syncProgress', phase: 'creating', message: 'Подготовка нового локального сайта...', percent: 5, operationId: op.token.id, cancellable: true });
            site = await this.siteManager.createSite(
              {
                name: payload.createSite.name,
                phpVersion: payload.createSite.phpVersion,
                adminUser: payload.createSite.adminUser,
                adminPassword: payload.createSite.adminPassword,
                adminEmail: payload.createSite.adminEmail,
                locale: payload.createSite.locale,
                ssl: payload.createSite.ssl,
                webServer: payload.createSite.webServer,
              },
              (msg) => {
                op.token.throwIfCancelled();
                this.postMessage({ type: 'syncProgress', phase: 'creating', message: msg, percent: 10, operationId: op.token.id, cancellable: true });
              }
            );
          }
          if (!site) {throw new Error('Local site not found');}
          const wpRoot = this.siteManager.getSiteWpRoot(site);
          Logger.log(`[Dashboard] pullRemote site=${site.name} site.path=${site.path} wpRoot=${wpRoot} includeDb=${payload.includeDb}`);
          await this.remoteService.pullSite(
            payload.remoteId,
            wpRoot,
            payload.includeDb,
            (phase, msg, pct) => {
              op.token.throwIfCancelled();
              this.postMessage({ type: 'syncProgress', phase, message: msg, percent: pct, operationId: op.token.id, cancellable: true });
            },
            site.path,  // dbOutPath: write database.sql / database.meta.json to site root, not public/
            payload.skipUploads === true
          );
          this.siteManager.normalizeSiteLayout(site);
          let pullDiagnosticSummary = '';
          if (payload.includeDb) {
            const sqlPath = path.join(site.path, 'database.sql');
            const sqlSize = fs.existsSync(sqlPath) ? fs.statSync(sqlPath).size : 0;
            Logger.log(`[Dashboard] pullRemote applyPulledDatabase sqlPath=${sqlPath} sqlSize=${sqlSize}`);
            const diagnostic = await this.siteManager.applyPulledDatabase(site.id, sqlPath, (msg) => {
              this.postMessage({ type: 'syncProgress', phase: 'db-import', message: msg, percent: 92, operationId: op.token.id, cancellable: true });
            }, payload.preserveCredentials ?? true);
            Logger.log(`[Dashboard] pullRemote applyPulledDatabase result: wpInstalled=${diagnostic.wpInstalled} expectedTables=${diagnostic.expectedTableCount} warnings=${diagnostic.warnings.join(' | ')} summary=${diagnostic.summary}`);
            pullDiagnosticSummary = diagnostic.summary;
            this.postMessage({ type: 'pullDiagnostic', diagnostic });
          }
          this.remoteService.addLinkedSite(payload.remoteId, site.id);
          this.siteManager.addRemoteLink(site.id, payload.remoteId);
          await this.remoteService.recordSyncEvent(payload.remoteId, {
            direction: 'pull',
            status: 'success',
            message: pullDiagnosticSummary
              ? `Pull выполнен: ${site.name}. ${pullDiagnosticSummary}`
              : `Pull выполнен: ${site.name}`,
            localSiteId: site.id,
          });
          this.postMessage({ type: 'syncDone', direction: 'pull', localSiteId: site.id });
          await this.sendFullState();
        } catch (err: any) {
          const cancelled = isCancelledError(err);
          try {
            await this.remoteService.recordSyncEvent(payload.remoteId, {
              direction: 'pull',
              status: 'error',
              message: cancelled ? 'Pull отменён пользователем' : String(err?.message ?? err ?? 'Ошибка Pull'),
              localSiteId: payload.localSiteId,
            });
          } catch {
            // ignore sync history write errors
          }
          if (cancelled) {
            this.postMessage({ type: 'operationCancelled', operationId: op.token.id, message: 'Pull отменён' });
            await this.sendFullState();
          } else {
            this.postMessage({ type: 'error', message: err.message });
          }
        } finally {
          op.dispose();
        }
        break;
      }

      case 'pushRemote': {
        const op = this.operations.begin();
        try {
          const site = this.siteManager.getSite(payload.localSiteId);
          if (!site) {throw new Error('Local site not found');}
          const wpRoot = this.siteManager.getSiteWpRoot(site);
          const sqlPath = path.join(site.path, 'database.sql');
          Logger.log(`[Dashboard] pushRemote site=${site.name} site.path=${site.path} wpRoot=${wpRoot} sqlPath=${sqlPath} includeDb=${payload.includeDb}`);
          if (payload.includeDb) {
            this.postMessage({
              type: 'syncProgress',
              phase: 'db',
              message: 'Создаю свежий дамп локальной БД перед Push...',
              percent: 5,
              operationId: op.token.id,
              cancellable: true,
            });
            await this.siteManager.exportSiteDatabase(site.id, sqlPath);
            op.token.throwIfCancelled();
            const sqlSize = fs.existsSync(sqlPath) ? fs.statSync(sqlPath).size : 0;
            Logger.log(`[Dashboard] pushRemote fresh database.sql prepared site=${site.name} size=${sqlSize}`);
          }
          await this.remoteService.pushSite(
            payload.remoteId,
            wpRoot,
            payload.includeDb,
            payload.devMode ?? false,
            (phase, msg, pct) => {
              op.token.throwIfCancelled();
              this.postMessage({ type: 'syncProgress', phase, message: msg, percent: pct, operationId: op.token.id, cancellable: true });
            },
            sqlPath,  // dbFilePath: database.sql lives in site root, not in wpRoot (public/)
            payload.preserveCredentials ?? true
          );
          this.remoteService.addLinkedSite(payload.remoteId, site.id);
          this.siteManager.addRemoteLink(site.id, payload.remoteId);
          await this.remoteService.recordSyncEvent(payload.remoteId, {
            direction: 'push',
            status: 'success',
            message: `Push выполнен: ${site.name}`,
            localSiteId: site.id,
          });
          this.postMessage({ type: 'syncDone', direction: 'push', localSiteId: site.id });
          await this.sendFullState();
        } catch (err: any) {
          const cancelled = isCancelledError(err);
          try {
            await this.remoteService.recordSyncEvent(payload.remoteId, {
              direction: 'push',
              status: 'error',
              message: cancelled ? 'Push отменён пользователем' : String(err?.message ?? err ?? 'Ошибка Push'),
              localSiteId: payload.localSiteId,
            });
          } catch {
            // ignore sync history write errors
          }
          if (cancelled) {
            this.postMessage({ type: 'operationCancelled', operationId: op.token.id, message: 'Push отменён' });
            await this.sendFullState();
          } else {
            this.postMessage({ type: 'error', message: err.message });
          }
        } finally {
          op.dispose();
        }
        break;
      }

      case 'initGit':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          await this.gitService.initRepo(site.path);
          this.postMessage({ type: 'gitInit', siteId: payload.siteId });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'gitStatus':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          const status = await this.gitService.getStatus(site.path);
          this.postMessage({ type: 'gitStatusResult', ...status });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'gitPull':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          await this.gitService.pull(site.path);
          this.postMessage({ type: 'gitPushed' });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'gitCommitPush':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          await this.gitService.stageAll(site.path);
          await this.gitService.commit(site.path, payload.message);
          await this.gitService.push(site.path);
          this.postMessage({ type: 'gitPushed' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'addGitRemote':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          await this.gitService.addRemote(site.path, 'origin', payload.githubUrl);
          this.postMessage({ type: 'gitRemoteAdded' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'createGHAWorkflow':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          await this.gitService.createGitHubActionsWorkflow(site.path, payload.deployConfig);
          this.postMessage({ type: 'workflowCreated' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'removeRemote':
        try {
          const remote = this.remoteService.getRemote(payload.remoteId);
          if (payload.skipConfirm !== true) {
            const confirm = await vscode.window.showWarningMessage(
              `Удалить удалённый сайт "${remote?.name ?? ''}"?`,
              { modal: true },
              'Удалить'
            );
            if (confirm !== 'Удалить') {break;}
          }
          for (const siteId of remote?.linkedSiteIds ?? []) {
            this.siteManager.removeRemoteLink(siteId, payload.remoteId);
          }
          await this.remoteService.removeRemote(payload.remoteId);
          this.postMessage({ type: 'remoteRemoved', remoteId: payload.remoteId });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      // ── Backup & Export ─────────────────────────────────────────────────

      case 'getBackups':
        try {
          const backups = this.backupService.getBackups(payload?.siteId);
          const config = this.backupService.getBackupConfig();
          this.postMessage({ type: 'backupsData', backups, config });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'createBackup':
        try {
          if (payload.askTargetPath) {
            const exportPath = await this.backupService.exportSite(
              payload.siteId,
              undefined,
              (msg) => this.postMessage({ type: 'progress', message: msg })
            );
            this.postMessage({ type: 'backupCreated', path: exportPath, exported: true });
            break;
          }

          const entry = await this.backupService.backupSite(
            payload.siteId,
            payload.includeDb ?? true,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'backupCreated', backup: entry });
        } catch (err: any) {
          if (err.message !== 'Export cancelled') {
            this.postMessage({ type: 'error', message: err.message });
          }
        }
        break;

      case 'exportSite':
        try {
          const exportPath = await this.backupService.exportSite(
            payload.siteId,
            undefined,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'siteExported', path: exportPath });
        } catch (err: any) {
          if (err.message !== 'Export cancelled') {
            this.postMessage({ type: 'error', message: err.message });
          }
        }
        break;

      case 'analyzeImportZip':
        try {
          const zipUri = await vscode.window.showOpenDialog({
            canSelectMany: false,
            filters: { 'ZIP Archive': ['zip'] },
            openLabel: 'Выбрать ZIP для импорта',
          });
          if (!zipUri || zipUri.length === 0) {
            this.postMessage({ type: 'importCancelled' });
            break;
          }
          const analysis = await this.backupService.analyzeZip(
            zipUri[0].fsPath,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'zipAnalyzed', ...analysis });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'importSite':
        try {
          // zipPath comes from payload (set during analyzeImportZip step)
          const zipPath: string = payload.zipPath;
          if (!zipPath) {
            this.postMessage({ type: 'error', message: 'ZIP path is missing' });
            break;
          }
          const newSite = await this.backupService.importFromZip(
            zipPath,
            payload.options,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          await this.sendFullState();
          this.postMessage({ type: 'siteImported', site: newSite });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cancelImport':
        this.backupService.clearAnalyzeCache();
        this.postMessage({ type: 'importCancelled' });
        break;

      case 'restoreBackup':
        try {
          await this.backupService.restoreBackup(
            payload.backupId,
            payload.siteId,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'backupRestored', siteId: payload.siteId });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'deleteBackup':
        try {
          this.backupService.deleteBackup(payload.backupId);
          const remaining = this.backupService.getBackups(payload.siteId);
          this.postMessage({ type: 'backupsData', backups: remaining, config: this.backupService.getBackupConfig() });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'saveBackupConfig':
        try {
          this.backupService.saveBackupConfig(payload.config);
          this.postMessage({ type: 'backupConfigSaved' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'deleteCloudFile':
        // Удаляет одну облачную копию (с Yandex или Google) и отвязывает её от
        // записи бэкапа, не трогая локальный файл.
        try {
          await this.cloudBackup.deleteFile(payload.provider, payload.remotePath);
          if (payload.backupId) {
            this.backupService.removeCloudUpload(payload.backupId, payload.provider, payload.remotePath);
          }
          this.postMessage({ type: 'cloudFileDeleted' });
          const backups = this.backupService.getBackups(payload.siteId || undefined);
          this.postMessage({ type: 'backupsData', backups, config: this.backupService.getBackupConfig() });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'deleteBackupEverywhere':
        // Удаляет бэкап целиком: все облачные копии + локальный файл + запись.
        try {
          const entry = this.backupService.getBackup(payload.backupId);
          if (entry) {
            for (const up of entry.cloudUploads ?? []) {
              try { await this.cloudBackup.deleteFile(up.provider, up.remotePath); } catch { /* ignore */ }
            }
            this.backupService.deleteBackup(payload.backupId);
          }
          const backups = this.backupService.getBackups(payload.siteId || undefined);
          this.postMessage({ type: 'backupsData', backups, config: this.backupService.getBackupConfig() });
          this.postMessage({ type: 'cloudFileDeleted' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      // ── Cloud Backup ────────────────────────────────────────────────────

      case 'cloudGetStatus':
        try {
          const providers = await this.cloudBackup.getConfiguredProviders();
          this.postMessage({
            type: 'cloudStatus',
            providers,
            available: this.cloudBackup.getAvailability(),
            defaults: this.cloudBackup.getDefaultCloudConfig(),
          });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cloudStartYandexAuth':
        try {
          this.postMessage({ type: 'progress', message: 'Открываем браузер для входа в Yandex...' });
          await this.cloudBackup.startYandexBrowserAuth();
          this.postMessage({ type: 'cloudConfigSaved', provider: 'yandex' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cloudStartGoogleAuth':
        try {
          this.postMessage({ type: 'progress', message: 'Открываем браузер для входа в Google...' });
          await this.cloudBackup.startGoogleBrowserAuth();
          this.postMessage({ type: 'cloudConfigSaved', provider: 'google' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cloudDisconnect':
        try {
          await this.cloudBackup.clearCredentials(payload.provider);
          const ps = await this.cloudBackup.getConfiguredProviders();
          this.postMessage({
            type: 'cloudStatus',
            providers: ps,
            available: this.cloudBackup.getAvailability(),
            defaults: this.cloudBackup.getDefaultCloudConfig(),
          });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'createCloudBackup':
        try {
          if (!payload.siteId) {throw new Error('Site not found');}
          const providers = payload.providers?.length
            ? payload.providers
            : await this.cloudBackup.getConfiguredProviders();
          if (providers.length === 0) {throw new Error('Облако не настроено');}
          let backup = await this.backupService.backupSite(
            payload.siteId,
            true,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          backup = await this.cloudBackup.uploadBackup(
            backup,
            providers,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'cloudUploadDone', backup });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cloudUploadBackup':
        try {
          const backupList = this.backupService.getBackups(payload.siteId);
          const target = backupList.find((b) => b.id === payload.backupId);
          if (!target) {throw new Error('Backup not found');}
          const updated = await this.cloudBackup.uploadBackup(
            target,
            payload.providers,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          this.postMessage({ type: 'cloudUploadDone', backup: updated });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'cloudListFiles':
        try {
          const files = await this.cloudBackup.listFiles(payload.provider);
          this.postMessage({ type: 'cloudFilesList', files });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'importFromCloud':
        try {
          const tmpPath = path.join(os.tmpdir(), `wpdock-cloud-${Date.now()}.zip`);
          this.postMessage({ type: 'progress', message: 'Скачивание из облака...' });
          await this.cloudBackup.downloadFile(payload.provider, payload.remotePath, tmpPath);
          const newSite = await this.backupService.importFromZip(
            tmpPath,
            payload.options,
            (msg) => this.postMessage({ type: 'progress', message: msg })
          );
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
          await this.sendFullState();
          this.postMessage({ type: 'siteImported', site: newSite });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      // ── GitHub API ──────────────────────────────────────────────────────

      case 'githubGetUser': {
        try {
          const token = await this.context.secrets.get('github-token');
          if (!token) {
            this.postMessage({ type: 'githubNotConnected' });
            break;
          }
          const user = await this.gitService.getGitHubUser(token);
          this.postMessage({ type: 'githubUser', user });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubSetToken': {
        try {
          await this.context.secrets.store('github-token', payload.token);
          const user = await this.gitService.getGitHubUser(payload.token);
          this.postMessage({ type: 'githubUser', user });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: `Invalid token: ${err.message}` });
        }
        break;
      }

      case 'githubDisconnect': {
        try {
          await this.context.secrets.delete('github-token');
          this.postMessage({ type: 'githubNotConnected' });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubListRepos': {
        try {
          const token = await this.context.secrets.get('github-token');
          if (!token) { this.postMessage({ type: 'githubNotConnected' }); break; }
          const repos = await this.gitService.listGitHubRepos(token);
          this.postMessage({ type: 'githubRepos', repos });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubCreateRepo': {
        try {
          const token = await this.context.secrets.get('github-token');
          if (!token) { this.postMessage({ type: 'githubNotConnected' }); break; }
          let repo;
          if (payload.siteId) {
            const site = this.siteManager.getSite(payload.siteId);
            if (!site) {throw new Error('Site not found');}
            repo = await this.gitService.createRepoAndLink(
              site.path,
              token,
              payload.name,
              payload.description ?? '',
              payload.private ?? true
            );
            this.postMessage({ type: 'githubLinked', siteId: payload.siteId, repoUrl: repo.cloneUrl });
          } else {
            repo = await this.gitService.createGitHubRepo(
              token,
              payload.name,
              payload.description ?? '',
              payload.private ?? true
            );
          }
          this.postMessage({ type: 'githubRepoCreated', repo });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubDeleteRepo': {
        try {
          const token = await this.context.secrets.get('github-token');
          if (!token) { this.postMessage({ type: 'githubNotConnected' }); break; }
          await this.gitService.deleteGitHubRepo(token, payload.owner, payload.repo);
          this.postMessage({ type: 'githubRepoDeleted', fullName: `${payload.owner}/${payload.repo}` });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubCloneRepo': {
        try {
          const token = await this.context.secrets.get('github-token');
          const targetDir = payload.localPath ?? path.join(
            this.siteManager['storage']?.getSitesDirectory?.() ?? '',
            payload.name
          );
          await this.gitService.cloneGitHubRepo(payload.cloneUrl, targetDir, token ?? undefined);
          this.postMessage({ type: 'githubRepoCloned', localPath: targetDir });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'githubLinkToSite': {
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          const isRepo = await this.gitService.isRepo(site.path);
          if (!isRepo) {await this.gitService.initRepo(site.path);}
          await this.gitService.addRemote(site.path, 'origin', payload.repoUrl);
          this.postMessage({ type: 'githubLinked', siteId: payload.siteId, repoUrl: payload.repoUrl });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      // ── Site Settings ────────────────────────────────────────────────────

      case 'updateDebug':
        try {
          const updated = await this.siteManager.updateDebugSettings(payload.siteId, {
            wpDebug: payload.wpDebug,
            wpDebugLog: payload.wpDebugLog,
            wpScriptDebug: payload.wpScriptDebug,
          });
          this.postMessage({ type: 'siteUpdated', site: updated });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'updateDomain':
        try {
          const updated = await this.siteManager.updateDomain(
            payload.siteId,
            payload.domain,
            payload.ssl ?? false
          );
          this.postMessage({ type: 'siteUpdated', site: updated });
          await this.sendFullState();
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'openDatabase':
        try {
          await this.siteManager.openAdminer(payload.siteId);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'openWpCliTerminal':
        try {
          this.siteManager.openWpCliTerminal(payload.siteId);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'toggleLivePreview':
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          if (this.livePreview.isRunning(site.id)) {
            await this.livePreview.stop(site.id);
            this.postMessage({ type: 'livePreviewState', siteId: site.id, running: false });
          } else {
            const previewUrl = await this.livePreview.start(site, this.siteManager.getSiteUrl(site));
            await this.openTrustedExternal(previewUrl);
            this.postMessage({ type: 'livePreviewState', siteId: site.id, running: true, url: previewUrl });
          }
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;

      case 'runWpCli':
        try {
          const output = await this.siteManager.runWpCliCommand(payload.siteId, payload.command);
          this.postMessage({ type: 'wpCliOutput', output });
        } catch (err: any) {
          this.postMessage({ type: 'wpCliOutput', output: `Ошибка: ${err.message}` });
        }
        break;

      case 'installLocalAgent': {
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Сайт не найден');}
          const srcDir = path.join(this.context.extensionPath, 'resources', 'agent-plugin');
          const srcPhp = path.join(srcDir, 'wpdock-agent.php');
          if (!fs.existsSync(srcPhp)) {throw new Error('Файл агента wpdock-agent.php не найден в ресурсах расширения');}
          let version = '';
          try {
            version = fs.readFileSync(srcPhp, 'utf8').match(/Version:\s*([0-9.]+)/i)?.[1] ?? '';
          } catch { /* версия не обязательна */ }
          const pluginsDir = path.join(this.siteManager.getSiteContentDir(site), 'plugins');
          const destDir = path.join(pluginsDir, 'wpdock-agent');
          fs.mkdirSync(pluginsDir, { recursive: true });
          fs.rmSync(destDir, { recursive: true, force: true });
          fs.cpSync(srcDir, destDir, { recursive: true, force: true });
          let activated = false;
          if (site.status === 'running') {
            try {
              await this.siteManager.runWpCliCommand(site.id, 'plugin activate wpdock-agent');
              activated = true;
            } catch (err: any) {
              Logger.error('[DashboardPanel] failed to activate wpdock-agent locally', err);
            }
          }
          Logger.log(`[DashboardPanel] installed local wpdock-agent v${version || '?'} into "${site.name}" (activated=${activated})`);
          this.postMessage({ type: 'localAgentInstalled', siteId: site.id, version, activated });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'openAdminUrl': {
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          const base = this.siteManager.getSiteUrl(site);
          const url = `${base}/wp-admin/`;
          await this.openTrustedExternal(url);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'autoLoginAdmin': {
        // Variant B: generate WP transient token → magic link via mu-plugin
        try {
          const magicUrl = await this.siteManager.getAutoLoginUrl(payload.siteId);
          await this.openTrustedExternal(magicUrl);
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'getSiteCredentials': {
        try {
          const site = this.siteManager.getSite(payload.siteId);
          if (!site) {throw new Error('Site not found');}
          const adminPass = await this.siteManager.getAdminPassword(payload.siteId);
          const dbPass = await this.siteManager.getDbPassword(payload.siteId);
          this.postMessage({
            type: 'siteCredentials',
            siteId: payload.siteId,
            adminUser: site.adminUser,
            adminPass,
            dbName: site.dbName,
            dbUser: site.dbUser,
            dbPass,
            dbPort: 33061,
          });
        } catch (err: any) {
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }

      case 'getSettings': {
        const cfg = vscode.workspace.getConfiguration('wpdock');
        const upload = vscode.workspace.getConfiguration('wpdock.remoteUpload');
        const backup = vscode.workspace.getConfiguration('wpdock.backup');
        this.postMessage({
          type: 'settingsLoaded',
          settings: {
            sitesDirectory:       cfg.get<string>('sitesDirectory') ?? '',
            defaultPhpVersion:    cfg.get<string>('defaultPhpVersion') ?? '8.2',
            livePreviewPort:      cfg.get<number>('livePreviewPort') ?? 3000,
            directUploadLimitMb:  upload.get<number>('directUploadLimitMb') ?? 1,
            chunkSizeMb:          upload.get<number>('chunkSizeMb') ?? 0.75,
            autoBackup:           backup.get<boolean>('autoBackup') ?? false,
            backupIntervalHours:  backup.get<number>('intervalHours') ?? 24,
            backupKeepCount:      backup.get<number>('keepCount') ?? 5,
          },
        });
        break;
      }

      case 'saveSettings': {
        try {
          const s = payload as {
            sitesDirectory: string;
            defaultPhpVersion: string;
            livePreviewPort: number;
            directUploadLimitMb: number;
            chunkSizeMb: number;
            autoBackup: boolean;
            backupIntervalHours: number;
            backupKeepCount: number;
          };
          const t = vscode.ConfigurationTarget.Global;
          const cfg = vscode.workspace.getConfiguration('wpdock');
          const upload = vscode.workspace.getConfiguration('wpdock.remoteUpload');
          const backup = vscode.workspace.getConfiguration('wpdock.backup');
          await cfg.update('sitesDirectory',    s.sitesDirectory,    t);
          await cfg.update('defaultPhpVersion', s.defaultPhpVersion, t);
          await cfg.update('livePreviewPort',   s.livePreviewPort,   t);
          await upload.update('directUploadLimitMb', s.directUploadLimitMb, t);
          await upload.update('chunkSizeMb',         s.chunkSizeMb,         t);
          await backup.update('autoBackup',       s.autoBackup,           t);
          await backup.update('intervalHours',    s.backupIntervalHours,  t);
          await backup.update('keepCount',        s.backupKeepCount,      t);
          // reload upload settings in RemoteService
          this.remoteService.reloadUploadSettings();
        } catch (err: any) {
          Logger.error('[Dashboard] saveSettings failed', err);
          this.postMessage({ type: 'error', message: err.message });
        }
        break;
      }
    }
  }

  private async sendFullState(): Promise<void> {
    await this.siteManager.syncRunningSites();
    const currentProjectSite = this.isProjectMode() ? this.findCurrentProjectSite() : undefined;
    const sourceSites = this.isProjectMode()
      ? (currentProjectSite ? [currentProjectSite] : [])
      : this.siteManager.getAllSites();
    const sites = await Promise.all(sourceSites.map((s) => this.withSiteUrl(s)));
    const allRemotes = this.remoteService.getAllRemotes();
    const remotes = this.isProjectMode() && currentProjectSite
      ? allRemotes.filter((remote) =>
          (remote.linkedSiteIds ?? []).includes(currentProjectSite.id) ||
          (currentProjectSite.remoteIds ?? []).includes(remote.id)
        )
      : this.isProjectMode()
        ? []
        : allRemotes;

    this.postMessage({
      type: 'state',
      sites,
      remotes,
      viewContext: this.isProjectMode()
        ? {
            mode: 'project',
            siteId: currentProjectSite?.id,
            workspacePath: currentProjectSite?.path ?? this.getCurrentProjectPath(),
          }
        : { mode: 'dashboard' },
    });
    this.postMessage({ type: 'localAccessStatus', status: this.getLocalAccessStatus() });
  }

  private async maybeAutoSetupLocalAccess(): Promise<void> {
    if (this.autoLocalAccessRequested) {return;}
    if (!this.hasSitesRequiringLocalAccess()) {return;}
    if (this.isLocalAccessReady()) {return;}

    this.autoLocalAccessRequested = true;

    try {
      this.postMessage({ type: 'progress', message: 'Автоматическая подготовка локального доступа...' });
      await this.setupLocalAccess((msg) => {
        this.postMessage({ type: 'progress', message: msg });
      });
      await this.sendFullState();
      this.postMessage({ type: 'localAccessReady', status: this.getLocalAccessStatus() });
    } catch (err: any) {
      Logger.error('[Dashboard] auto setupLocalAccess failed', err);
      this.postMessage({ type: 'error', message: err.message });
    } finally {
      this.autoLocalAccessRequested = false;
    }
  }

  private hasSitesRequiringLocalAccess(): boolean {
    if (!this.isProjectMode()) {
      return this.siteManager.getAllSites().some((site) => Boolean(site.domain || site.ssl));
    }
    const site = this.findCurrentProjectSite();
    return Boolean(site?.domain || site?.ssl);
  }

  private isLocalAccessReady(): boolean {
    const status = this.getLocalAccessStatus();
    return Boolean(status.proxyRunning && status.portProxyActive);
  }

  private getWebview(): vscode.Webview {
    if (!this.view) {
      throw new Error('WPDock sidebar is not ready yet');
    }
    return this.view.webview;
  }

  private postMessage(message: any): void {
    void this.view?.webview.postMessage(message);
  }

  private queueFullState(): void {
    if (!this.view || !this.isVisible()) {return;}
    if (this.pendingStateRefresh) {return;}

    this.pendingStateRefresh = setTimeout(() => {
      this.pendingStateRefresh = undefined;
      if (this.isVisible()) {
        void this.sendFullState();
      }
    }, 100);
  }

  private isVisible(): boolean {
    return Boolean(this.view?.visible);
  }

  private flushPendingNavigation(): void {
    if (!this.view || !this.pendingRoute?.route) {return;}
    this.postMessage({
      type: 'navigate',
      route: this.pendingRoute.route,
      param: this.pendingRoute.param,
    });
    this.pendingRoute = undefined;
  }

  /** Augments a WPSite with its computed public URL and git info before sending to the webview. */
  private async withSiteUrl(site: WPSite): Promise<WPSite & { siteUrl: string; livePreviewRunning: boolean }> {
    return {
      ...site,
      git: await this.gitService.getRepoInfo(site.path),
      siteUrl: this.siteManager.getSiteUrl(site),
      livePreviewRunning: this.livePreview.isRunning(site.id),
    };
  }

  private isProjectMode(): boolean {
    return this.options.mode === 'project';
  }

  private getCurrentProjectPath(): string | undefined {
    const active = vscode.window.activeTextEditor?.document?.uri;
    if (active?.scheme === 'file') {
      return active.fsPath;
    }

    const folders = vscode.workspace.workspaceFolders;
    return folders && folders.length > 0 ? folders[0].uri.fsPath : undefined;
  }

  private findCurrentProjectSite(): WPSite | undefined {
    const sites = this.siteManager.getAllSites();
    if (sites.length === 0) {return undefined;}

    const matchCandidate = (candidatePath: string | undefined): WPSite | undefined => {
      if (!candidatePath) {return undefined;}
      const normalizedCandidate = this.normalizeFsPath(candidatePath);
      if (!normalizedCandidate) {return undefined;}

      return sites
        .map((site) => ({ site, normalizedSitePath: this.normalizeFsPath(site.path) }))
        .filter(({ normalizedSitePath }) => (
          Boolean(normalizedSitePath) &&
          this.isSameOrInside(normalizedCandidate, normalizedSitePath!)
        ))
        .sort((a, b) => b.normalizedSitePath.length - a.normalizedSitePath.length)[0]?.site;
    };

    const activeUri = vscode.window.activeTextEditor?.document?.uri;
    const activeMatch = activeUri?.scheme === 'file' ? matchCandidate(activeUri.fsPath) : undefined;
    if (activeMatch) {return activeMatch;}

    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      const workspaceMatch = matchCandidate(folder.uri.fsPath);
      if (workspaceMatch) {return workspaceMatch;}
    }

    return undefined;
  }

  private normalizeFsPath(value: string): string {
    let resolved = path.resolve(value);
    try {
      resolved = fs.realpathSync.native(resolved);
    } catch {
      // The path may not exist yet; path.resolve is still good enough.
    }
    resolved = resolved.replace(/[\\/]+$/, '');
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  }

  private isSameOrInside(candidatePath: string, parentPath: string): boolean {
    if (candidatePath === parentPath) {return true;}
    const relative = path.relative(parentPath, candidatePath);
    return Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
  }

  private async openTrustedExternal(url: string): Promise<void> {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    await vscode.env.openExternal(uri);
  }

  private getHtml(): string {
    const webview = this.getWebview();
    const distPath = vscode.Uri.joinPath(this.context.extensionUri, 'webview-ui', 'dist');

    // In production, serve the built React app
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.js')
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(distPath, 'assets', 'index.css')
    );
    const nonce = this.getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} https: data:; font-src ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}" />
  <title>WPDock</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  private getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private dispose(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.pendingStateRefresh) {
      clearTimeout(this.pendingStateRefresh);
      this.pendingStateRefresh = undefined;
    }
    for (const d of this.disposables) {d.dispose();}
    this.disposables = [];
  }
}

