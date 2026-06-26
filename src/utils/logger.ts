/**
 * WPDock Logger — wraps VS Code OutputChannel for persistent, visible logs.
 * Call Logger.init() once in extension.ts activate().
 * All services import and use Logger.log() / Logger.error().
 */
import * as vscode from 'vscode';

let _channel: vscode.OutputChannel | null = null;

export const Logger = {
  /** Call once from extension.ts activate(). */
  init(context: vscode.ExtensionContext): void {
    _channel = vscode.window.createOutputChannel('WPDock');
    context.subscriptions.push(_channel);
    Logger.log('WPDock output channel initialised.');
  },

  /** Info-level message. */
  log(msg: string): void {
    const ts   = new Date().toISOString().slice(11, 22);
    const line = `[${ts}] ${msg}`;
    console.log(`[WPDock] ${msg}`);
    _channel?.appendLine(line);
  },

  /** Error-level message. Opens the output panel automatically. */
  error(msg: string, err?: unknown): void {
    const detail = err instanceof Error ? `: ${err.message}` : (err ? `: ${String(err)}` : '');
    const ts     = new Date().toISOString().slice(11, 22);
    const line   = `[${ts}] ✕ ${msg}${detail}`;
    console.error(`[WPDock] ERROR: ${msg}${detail}`);
    _channel?.appendLine(line);
    _channel?.show(true /* preserveFocus */);
  },

  /** Debug-level message — not printed to the output channel, only to console. */
  debug(msg: string): void {
    console.debug(`[WPDock] ${msg}`);
  },

  /** Show the output panel without focusing it. */
  show(): void {
    _channel?.show(true);
  },
};
