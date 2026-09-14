import * as vscode from 'vscode';
import { SiteManager } from '../services/SiteManager';
import { WPSite } from '../types';

export class SitesProvider implements vscode.TreeDataProvider<SiteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SiteTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private siteManager: SiteManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: SiteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: SiteTreeItem): SiteTreeItem[] {
    if (element) {return [];}
    return this.siteManager.getAllSites().map((site) => new SiteTreeItem(site, this.siteManager.getSiteUrl(site)));
  }
}

export class SiteTreeItem extends vscode.TreeItem {
  public readonly siteId: string;

  constructor(site: WPSite, siteUrl: string) {
    super(site.name, vscode.TreeItemCollapsibleState.None);
    this.siteId = site.id;

    const isStarting = site.status === 'starting';
    const isRunning = site.status === 'running';
    const isError = site.status === 'error';

    this.contextValue = isRunning ? 'site-running' : 'site-stopped';
    const displayUrl = siteUrl;
    let displayHost = displayUrl;
    try {
      const parsed = new URL(displayUrl);
      displayHost = `${parsed.protocol}//${parsed.hostname}`;
    } catch {
      displayHost = displayUrl.replace(/:\d+$/, '');
    }
    const statusLabel = getStatusLabel(site.status);
    this.tooltip = `${site.name}\nPHP ${site.phpVersion}\nURL: ${displayUrl}\nПорт: ${site.port}\nСтатус: ${statusLabel}`;

    this.description = isRunning
      ? displayHost
      : isStarting
        ? 'запускается...'
      : isError
        ? 'ошибка'
        : 'остановлен';

    this.iconPath = new vscode.ThemeIcon(
      isStarting ? 'loading~spin' : isRunning ? 'vm-running' : isError ? 'error' : 'vm',
      new vscode.ThemeColor(
        isStarting
          ? 'charts.yellow'
          : isRunning
          ? 'charts.green'
          : isError
            ? 'charts.red'
            : 'foreground'
      )
    );

    this.command = {
      command: 'wpdock.openDashboard',
      title: 'Открыть панель',
      arguments: [],
    };
  }
}

function getStatusLabel(status: WPSite['status']): string {
  switch (status) {
    case 'starting':
      return 'запускается...';
    case 'running':
      return 'запущен';
    case 'error':
      return 'ошибка';
    case 'stopped':
    default:
      return 'остановлен';
  }
}
