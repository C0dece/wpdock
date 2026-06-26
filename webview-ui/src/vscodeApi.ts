// VS Code webview API bridge
declare const acquireVsCodeApi: () => {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

class VscodeApi {
  private api = acquireVsCodeApi();
  postMessage(msg: unknown) { this.api.postMessage(msg); }
}

export const vscode = new VscodeApi();
