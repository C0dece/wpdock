import * as vscode from 'vscode';
import { SiteManager } from '../services/SiteManager';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private runtimeStatus: 'ready' | 'not-ready' | 'checking' = 'checking';

  constructor(context: vscode.ExtensionContext, private siteManager?: SiteManager) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      100
    );
    this.item.command = 'wpdock.openDashboard';
    this.item.text = '$(loading~spin) WPDock';
    this.item.tooltip = 'WPDock — checking runtime...';
    this.item.show();
    context.subscriptions.push(this.item);
  }

  setRuntimeStatus(status: 'ready' | 'not-ready' | 'checking'): void {
    this.runtimeStatus = status;
    this.refresh();
  }

  /** @deprecated Use setRuntimeStatus */
  setDockerStatus(status: 'running' | 'missing' | 'checking'): void {
    const map: Record<string, Parameters<StatusBarManager['setRuntimeStatus']>[0]> = {
      running: 'ready',
      missing: 'not-ready',
      checking: 'checking',
    };
    this.setRuntimeStatus(map[status] ?? 'checking');
  }

  refresh(): void {
    const sites = this.siteManager?.getAllSites() ?? [];
    const startingSites = sites.filter((s) => s.status === 'starting');
    const runningCount = sites.filter((s) => s.status === 'running').length;

    if (startingSites.length > 0) {
      this.item.text = `$(loading~spin) WPDock: запускается ${startingSites.length}`;
      this.item.tooltip = `WPDock — запускается: ${startingSites.map((s) => s.name).join(', ')}`;
      this.item.backgroundColor = undefined;
      return;
    }

    switch (this.runtimeStatus) {
      case 'ready':
        this.item.text = runningCount > 0
          ? `$(vm-running) WPDock: ${runningCount} запущено`
          : '$(vm-running) WPDock';
        this.item.tooltip = runningCount > 0
          ? `WPDock — runtime ready. Запущено сайтов: ${runningCount}. Click to open dashboard.`
          : 'WPDock — runtime ready. Click to open dashboard.';
        this.item.backgroundColor = undefined;
        break;
      case 'not-ready':
        this.item.text = '$(warning) WPDock: setup needed';
        this.item.tooltip = 'WPDock — runtime not set up. Click to open dashboard.';
        this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        break;
      case 'checking':
        this.item.text = '$(loading~spin) WPDock';
        this.item.tooltip = 'WPDock — checking runtime...';
        this.item.backgroundColor = undefined;
        break;
    }
  }
}
