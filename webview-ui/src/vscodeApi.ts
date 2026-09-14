// VS Code webview API bridge
declare const acquireVsCodeApi: (() => {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}) | undefined;

type VscodeBridge = NonNullable<typeof acquireVsCodeApi> extends () => infer T ? T : never;

const browserPreviewBridge: VscodeBridge = {
  postMessage(message: unknown) {
    console.debug('[WPDock preview]', message);
    handlePreviewMessage(message);
  },
  getState: () => {
    try { return JSON.parse(localStorage.getItem('wpdock-webview-state') ?? 'null'); }
    catch { return undefined; }
  },
  setState: (state: unknown) => localStorage.setItem('wpdock-webview-state', JSON.stringify(state)),
};

class VscodeApi {
  private api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : browserPreviewBridge;
  postMessage(msg: unknown) { this.api.postMessage(msg); }
  getState<T>(): T | undefined { return this.api.getState() as T | undefined; }
  setState(state: unknown) { this.api.setState(state); }
}

export const vscode = new VscodeApi();
import { handlePreviewMessage } from './previewMock';
