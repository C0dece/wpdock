import * as vscode from 'vscode';
import { RemoteService } from '../services/RemoteService';
import { RemoteSite } from '../types';

export class RemotesProvider implements vscode.TreeDataProvider<RemoteTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<RemoteTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private remoteService: RemoteService) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: RemoteTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: RemoteTreeItem): RemoteTreeItem[] {
    if (element) {return [];}
    return this.remoteService.getAllRemotes().map((r) => new RemoteTreeItem(r));
  }
}

export class RemoteTreeItem extends vscode.TreeItem {
  public readonly remoteId: string;

  constructor(remote: RemoteSite) {
    super(remote.name, vscode.TreeItemCollapsibleState.None);
    this.remoteId = remote.id;
    this.contextValue = 'remote-site';
    this.description = new URL(remote.url).hostname;
    this.tooltip = `${remote.name}\n${remote.url}\nАгент: ${remote.agentInstalled ? 'установлен' : 'не установлен'}`;
    this.iconPath = new vscode.ThemeIcon('cloud');
  }
}
