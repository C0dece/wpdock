import * as vscode from 'vscode';
import { DashboardPanel } from './panels/DashboardPanel';
import { LocalRuntimeManager } from './services/LocalRuntimeManager';
import { SiteProcessManager } from './services/SiteProcessManager';
import { isSiteStartCancelledError, SiteManager } from './services/SiteManager';
import { ProxyRouterService } from './services/ProxyRouterService';
import { LivePreviewService } from './services/LivePreviewService';
import { GitService } from './services/GitService';
import { RemoteService } from './services/RemoteService';
import { BackupService } from './services/BackupService';
import { CloudBackupService } from './services/CloudBackupService';
import { SslService } from './services/SslService';
import { StatusBarManager } from './ui/StatusBarManager';
import { StorageService } from './services/StorageService';
import { Logger } from './utils/logger';

export async function activate(context: vscode.ExtensionContext) {
  // Initialise output channel first — everything else logs to it
  Logger.init(context);
  Logger.log('WPDock activating...');

  // Core services — no Docker required
  const storage        = new StorageService(context);
  context.subscriptions.push(storage);
  const runtime        = new LocalRuntimeManager(context);
  const sslService     = new SslService(context);
  const proxyRouter    = new ProxyRouterService();
  const processes      = new SiteProcessManager(runtime, proxyRouter);
  const siteManager    = new SiteManager(context, storage, runtime, processes, proxyRouter, sslService);
  const livePreview    = new LivePreviewService();
  const gitService     = new GitService();
  const remoteService  = new RemoteService(context, storage);
  const backupService  = new BackupService(context, storage, runtime, siteManager);
  const cloudBackup    = new CloudBackupService(context, storage);

  const statusBar = new StatusBarManager(context, siteManager);

  const openTrustedExternal = async (url: string): Promise<void> => {
    const uri = await vscode.env.asExternalUri(vscode.Uri.parse(url));
    await vscode.env.openExternal(uri);
  };

  // Wire up portproxy activation — when user agrees to the one-time setup,
  // refresh all hosts entries and WordPress siteurl/home options.
  proxyRouter.onPortProxyActivated = (hostsIp) => {
    siteManager.activatePortlessUrls(hostsIp).catch((err) =>
      Logger.error('activatePortlessUrls error', err)
    );
  };

  let localAccessPromise: Promise<void> | undefined;
  const setupLocalAccess = async (onProgress?: (msg: string) => void): Promise<void> => {
    if (!localAccessPromise) {
      localAccessPromise = (async () => {
        statusBar.setRuntimeStatus('checking');
        onProgress?.('Проверка локального runtime...');
        const status = await runtime.getStatus();
        if (status.available) {
          statusBar.setRuntimeStatus('ready');
          await siteManager.syncRunningSites();
        } else {
          statusBar.setRuntimeStatus('not-ready');
        }

        onProgress?.('Запуск локального proxy...');
        await proxyRouter.start({ allowElevation: false }).catch((err) => {
          Logger.error('Proxy router error', err);
        });

        onProgress?.('Настройка hosts и portproxy...');
        const hostsIp = proxyRouter.getHostsIp();
        const hostsEntries = siteManager.getAllSites()
          .map((site) => site.domain)
          .filter((domain): domain is string => Boolean(domain))
          .map((domain) => ({ domain, ip: hostsIp }));
        const setupOk = await proxyRouter.setupPortProxyAndHosts(hostsEntries);
        if (!setupOk) {
          throw new Error('Не удалось настроить hosts и portproxy. Разрешение Windows могло быть отклонено.');
        }

        if (siteManager.getAllSites().some((site) => site.ssl)) {
          onProgress?.('Настройка SSL доверия...');
          try {
            await sslService.installCA();
          } catch (err) {
            Logger.error('SSL CA install error', err);
            throw err;
          }

          // Eagerly bind the HTTPS server on the portproxy 443 target using cached
          // certs, so HTTPS works immediately and any bind conflict surfaces now —
          // instead of lazily on first site start, which could leave the 443 target
          // with no listener ("connection refused" over https while http works).
          for (const site of siteManager.getAllSites()) {
            if (!site.ssl || !site.domain) {continue;}
            const cached = sslService.getCachedCert(site.domain);
            if (!cached) {continue;}
            try {
              await proxyRouter.registerSni(site.domain, cached.certPath, cached.keyPath);
            } catch (err) {
              Logger.error(`[WPDock] eager HTTPS bind failed for ${site.domain}`, err);
            }
          }
        }
      })()
        .catch((err) => {
          statusBar.setRuntimeStatus('not-ready');
          throw err;
        })
        .finally(() => {
          localAccessPromise = undefined;
        });
    }

    await localAccessPromise;
  };

  siteManager.setLocalAccessSetupHook(setupLocalAccess);

  const maybeAutoPrepareLocalAccess = async (reason: 'activate' | 'dashboard'): Promise<void> => {
    const requiresLocalAccess = siteManager.getAllSites().some((site) => Boolean(site.domain || site.ssl));
    if (!requiresLocalAccess) {return;}

    const status = getLocalAccessStatus();
    if (status.proxyRunning && status.portProxyActive) {return;}

    try {
      Logger.log(`[WPDock] ${reason}-triggered local access setup started`);
      await setupLocalAccess();
      Logger.log(`[WPDock] ${reason}-triggered local access setup completed`);
    } catch (err) {
      Logger.error(`[WPDock] ${reason}-triggered local access setup failed`, err);
    }
  };

  const getLocalAccessStatus = () => {
    return {
      proxyRunning: proxyRouter.isRunning(),
      portProxyActive: proxyRouter.portProxyActive,
    };
  };

  const dashboardProvider = new DashboardPanel(
    context,
    siteManager,
    remoteService,
    gitService,
    backupService,
    cloudBackup,
    livePreview,
    setupLocalAccess,
    getLocalAccessStatus
  );
  const projectProvider = new DashboardPanel(
    context,
    siteManager,
    remoteService,
    gitService,
    backupService,
    cloudBackup,
    livePreview,
    setupLocalAccess,
    getLocalAccessStatus,
    {
      mode: 'project',
      viewContainerCommand: 'workbench.view.extension.wpdockProject',
    }
  );

  const refreshInterval = setInterval(() => {
    void siteManager.syncRunningSites();
    statusBar.refresh();
  }, 3000);

  context.subscriptions.push(
    siteManager.onDidChangeSites(() => {
      statusBar.refresh();
    }),
    siteManager.onDidChangeSiteStatus(() => {
      statusBar.refresh();
    })
  );

  // Намеренно НЕ готовим локальный доступ при активации расширения.
  // Настройка hosts/portproxy требует прав администратора (UAC), поэтому
  // запрашиваем их только когда пользователь реально открывает панель плагина
  // (триггерится из dashboard по сообщению 'ready' → maybeAutoSetupLocalAccess).

  // Stop all PHP servers on deactivate
  context.subscriptions.push({
    dispose: () => {
      clearInterval(refreshInterval);
      processes.stopAll();
      runtime.dispose();
      proxyRouter.stop();
    },
  });

  // Register all commands
  const showDashboard = async (route?: any, param?: string) => {
    const status = await runtime.getStatus();
    statusBar.setRuntimeStatus(status.available ? 'ready' : 'not-ready');
    await dashboardProvider.show(route, param);
    void maybeAutoPrepareLocalAccess('dashboard');
  };
  const getCommandSite = (item: any) => {
    const siteId = typeof item === 'string' ? item : item?.siteId ?? item?.id;
    return siteManager.getSite(siteId);
  };

  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: async (uri: vscode.Uri) => {
        const handled = await cloudBackup.handleUri(uri);
        if (!handled) {
          Logger.debug(`[WPDock] unhandled uri callback: ${uri.toString()}`);
        }
      },
    }),

    vscode.window.registerWebviewViewProvider(
      DashboardPanel.viewType,
      dashboardProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.window.registerWebviewViewProvider(
      DashboardPanel.projectViewType,
      projectProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      projectProvider.refresh();
    }),
    vscode.window.onDidChangeActiveTextEditor(() => {
      projectProvider.refresh();
    })
  );

  // Auto-backup scheduler
  const scheduleAutoBackup = () => {
    const cfg = storage.getBackupConfig();
    if (!cfg.autoBackup || cfg.intervalHours <= 0) {return;}
    const ms = cfg.intervalHours * 60 * 60 * 1000;
    const timer = setInterval(async () => {
      for (const site of siteManager.getAllSites()) {
        try {
          const backup = await backupService.backupSite(site.id, cfg.includeDb);
          if (cfg.cloudProviders.length > 0) {
            await cloudBackup.uploadBackup(backup, cfg.cloudProviders as any);
          }
        } catch (e: any) {
          console.error(`Auto-backup failed for ${site.name}:`, e.message);
        }
      }
    }, ms);
    context.subscriptions.push({ dispose: () => clearInterval(timer) });
  };
  scheduleAutoBackup();

  context.subscriptions.push(
    vscode.commands.registerCommand('wpdock.showLogs', () => Logger.show()),

    vscode.commands.registerCommand('wpdock.openDashboard', async () => showDashboard()),

    vscode.commands.registerCommand('wpdock.openProjectSite', async () => {
      await projectProvider.show();
      if (!projectProvider.getCurrentProjectSite()) {
        vscode.window.showWarningMessage(
          'WPDock не нашёл сайт для открытой папки. Откройте папку конкретного WPDock-сайта или файл внутри него.'
        );
      }
    }),

    vscode.commands.registerCommand('wpdock.configureUploadSize', async () => {
      const sizeStr = await vscode.window.showInputBox({
        prompt: 'Размер чанка для batched upload (в МБ)',
        value: (remoteService.getChunkUploadSize() / 1024 / 1024).toFixed(2).replace(/\.00$/, ''),
        validateInput: (v) => {
          const n = Number.parseFloat(v);
          if (Number.isNaN(n) || n < 0.25 || n > 32) {
            return 'Введите число от 0.25 до 32 МБ';
          }
          return '';
        },
      });

      if (sizeStr) {
        const sizeInMB = Number.parseFloat(sizeStr);
        const sizeInBytes = Math.round(sizeInMB * 1024 * 1024);
        await remoteService.setChunkUploadSize(sizeInBytes);
        vscode.window.showInformationMessage(`Размер чанка WPDock установлен на ${sizeStr} МБ`);
      }
    }),

    vscode.commands.registerCommand('wpdock.configureDirectUploadLimit', async () => {
      const sizeStr = await vscode.window.showInputBox({
        prompt: 'Максимальный размер одиночной загрузки без чанков (в МБ)',
        value: (remoteService.getDirectUploadLimit() / 1024 / 1024).toFixed(2).replace(/\.00$/, ''),
        validateInput: (v) => {
          const n = Number.parseFloat(v);
          if (Number.isNaN(n) || n < 0.5 || n > 1024) {
            return 'Введите число от 0.5 до 1024 МБ';
          }
          return '';
        },
      });

      if (sizeStr) {
        const sizeInMB = Number.parseFloat(sizeStr);
        const sizeInBytes = Math.round(sizeInMB * 1024 * 1024);
        await remoteService.setDirectUploadLimit(sizeInBytes);
        vscode.window.showInformationMessage(`Лимит прямой загрузки WPDock установлен на ${sizeStr} МБ`);
      }
    }),

    vscode.commands.registerCommand('wpdock.createSite', async () => showDashboard('create-site')),

    vscode.commands.registerCommand('wpdock.importSite', async () => showDashboard('import-site')),

    vscode.commands.registerCommand('wpdock.startSite', async (item) => {
      const site = getCommandSite(item);
      if (!site) { vscode.window.showWarningMessage('Не удалось определить сайт для запуска'); return; }
      try {
        await siteManager.startSite(site.id);
        vscode.window.showInformationMessage(`Сайт "${site.name}" запущен`);
      } catch (err: any) {
        if (isSiteStartCancelledError(err)) {return;}
        vscode.window.showErrorMessage(`Не удалось запустить "${site.name}": ${err.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('wpdock.stopSite', async (item) => {
      const site = getCommandSite(item);
      if (!site) { vscode.window.showWarningMessage('Не удалось определить сайт для остановки'); return; }
      try {
        await livePreview.stop(site.id);
        await siteManager.stopSite(site.id);
        vscode.window.showInformationMessage(`Сайт "${site.name}" остановлен`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Не удалось остановить "${site.name}": ${err.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('wpdock.forceStopSite', async (item) => {
      const site = getCommandSite(item);
      if (!site) { vscode.window.showWarningMessage('Не удалось определить сайт для принудительной остановки'); return; }
      try {
        await livePreview.stop(site.id);
        await siteManager.forceStopSite(site.id);
        vscode.window.showInformationMessage(`Процессы сайта "${site.name}" остановлены`);
      } catch (err: any) {
        vscode.window.showErrorMessage(`Не удалось принудительно остановить "${site.name}": ${err.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('wpdock.forceRestartSite', async (item) => {
      const site = getCommandSite(item);
      if (!site) { vscode.window.showWarningMessage('Не удалось определить сайт для перезапуска'); return; }
      try {
        await livePreview.stop(site.id);
        await siteManager.forceRestartSite(site.id);
        vscode.window.showInformationMessage(`Сайт "${site.name}" принудительно перезапущен`);
      } catch (err: any) {
        if (isSiteStartCancelledError(err)) {return;}
        vscode.window.showErrorMessage(`Не удалось перезапустить "${site.name}": ${err.message ?? err}`);
      }
    }),

    vscode.commands.registerCommand('wpdock.backupSite', async (item) => {
      const siteId = item?.siteId;
      if (!siteId) {return showDashboard('backup');}
      showDashboard('backup', siteId);
    }),

    vscode.commands.registerCommand('wpdock.deleteSite', async (item) => {
      const siteId = item?.siteId;
      if (!siteId) { vscode.window.showWarningMessage('Не удалось определить сайт для удаления'); return; }
      const confirm = await vscode.window.showWarningMessage(
        `Удалить сайт "${item.label}"? Можно удалить только запись или запись вместе с файлами.`,
        { modal: true },
        'Удалить только запись',
        'Удалить всё'
      );
      if (!confirm) {return;}
      const deleteFiles = confirm === 'Удалить всё';
      await livePreview.stop(siteId);
      await siteManager.deleteSite(siteId, deleteFiles);
    }),

    vscode.commands.registerCommand('wpdock.openAdminSite', async (item) => {
      const site = siteManager.getSite(item?.siteId);
      if (!site) {return;}
      await openTrustedExternal(`${siteManager.getSiteUrl(site)}/wp-admin/`);
    }),

    vscode.commands.registerCommand('wpdock.openSite', async (item) => {
      const site = siteManager.getSite(item?.siteId);
      if (!site) {return;}
      await openTrustedExternal(siteManager.getSiteUrl(site));
    }),

    vscode.commands.registerCommand('wpdock.livePreview', async (item) => {
      const site = siteManager.getSite(item?.siteId);
      if (!site) {return;}
      if (livePreview.isRunning(site.id)) {
        await livePreview.stop(site.id);
        vscode.window.showInformationMessage(`Live Preview остановлен для ${site.name}`);
      } else {
        const url = await livePreview.start(site, siteManager.getSiteUrl(site));
        vscode.window.showInformationMessage(`Live Preview: ${url}`, 'Открыть').then((v) => {
          if (v) {
            void openTrustedExternal(url);
          }
        });
      }
      statusBar.refresh();
    }),

    vscode.commands.registerCommand('wpdock.connectRemote', () => showDashboard('connect-remote')),

    vscode.commands.registerCommand('wpdock.openRemote', async (item) => {
      const remoteId = item?.remoteId;
      if (!remoteId) {
        vscode.window.showWarningMessage('Не удалось определить удалённый сайт');
        return;
      }
      showDashboard('remote-detail', remoteId);
    }),

    vscode.commands.registerCommand('wpdock.editRemote', async (item) => {
      const remoteId = item?.remoteId;
      if (!remoteId) {
        vscode.window.showWarningMessage('Не удалось определить удалённый сайт для редактирования');
        return;
      }
      showDashboard('edit-remote', remoteId);
    }),

    vscode.commands.registerCommand('wpdock.deleteRemote', async (item) => {
      const remoteId = item?.remoteId;
      if (!remoteId) {
        vscode.window.showWarningMessage('Не удалось определить удалённый сайт для удаления');
        return;
      }

      const remote = remoteService.getRemote(remoteId);
      if (!remote) {
        vscode.window.showWarningMessage('Удалённый сайт не найден');
        return;
      }

      const confirm = await vscode.window.showWarningMessage(
        `Удалить удалённый сайт "${remote.name}"?`,
        { modal: true },
        'Удалить'
      );
      if (confirm !== 'Удалить') {return;}

      for (const siteId of remote.linkedSiteIds ?? []) {
        siteManager.removeRemoteLink(siteId, remoteId);
      }

      await remoteService.removeRemote(remoteId);
      vscode.window.showInformationMessage(`Удалённый сайт "${remote.name}" удалён`);
    }),

    vscode.commands.registerCommand('wpdock.pullRemote', async (item) => showDashboard('pull-remote', item?.remoteId)),

    vscode.commands.registerCommand('wpdock.pushRemote', async (item) => showDashboard('push-remote', item?.remoteId)),

    vscode.commands.registerCommand('wpdock.deployGit', async (item) => showDashboard('deploy', item?.siteId)),

    vscode.commands.registerCommand('wpdock.initGit', async (item) => {
      const site = siteManager.getSite(item?.siteId);
      if (!site) {return;}
      await gitService.initRepo(site.path);
      vscode.window.showInformationMessage(`Git initialized for ${site.name}`);
    }),
  );

  console.log('WPDock activated.');
}

export function deactivate() {}
