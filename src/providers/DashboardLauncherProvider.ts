import * as vscode from 'vscode';

export class DashboardLauncherProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'wpdock.launcher';

  private view?: vscode.WebviewView;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly openDashboard: () => Thenable<void> | void,
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
    };

    webviewView.webview.html = this.getHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message?.type === 'openDashboard') {
        void this.openDashboard();
      }
    });

    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void this.openDashboard();
      }
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = Date.now().toString(36);

    return `<!DOCTYPE html>
<html lang="ru">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <style>
      body {
        font-family: var(--vscode-font-family);
        color: var(--vscode-foreground);
        background: var(--vscode-sideBar-background);
        padding: 16px;
      }
      .wrap {
        display: flex;
        flex-direction: column;
        gap: 12px;
      }
      .title {
        font-size: 16px;
        font-weight: 600;
      }
      .desc {
        font-size: 12px;
        line-height: 1.5;
        color: var(--vscode-descriptionForeground);
      }
      button {
        border: none;
        border-radius: 6px;
        padding: 10px 12px;
        cursor: pointer;
        background: var(--vscode-button-background);
        color: var(--vscode-button-foreground);
      }
      button:hover {
        background: var(--vscode-button-hoverBackground);
      }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="title">WPDock</div>
      <div class="desc">Главная панель WPDock открывается автоматически. Если она не появилась — нажмите кнопку ниже.</div>
      <button id="open">Открыть WPDock</button>
    </div>
    <script nonce="${nonce}">
      const vscode = acquireVsCodeApi();
      document.getElementById('open')?.addEventListener('click', () => {
        vscode.postMessage({ type: 'openDashboard' });
      });
    </script>
  </body>
</html>`;
  }
}
