import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { WPSite } from '../types';
import { Logger } from '../utils/logger';

/**
 * LivePreviewService — same-origin live reload for local WordPress sites.
 *
 * Strategy (works for both http://site.local and https://site.local):
 *   1. A tiny mu-plugin injects <script src="/__wpdock-livereload__/client.js">
 *      into every WordPress page (front, admin, login).
 *   2. The shared {@link ProxyRouterService} intercepts that path and delegates
 *      to this service — so the client script and its SSE stream ride the SAME
 *      origin as the site. No extra port, no mixed-content, no CORS, and it
 *      survives navigation across WordPress' absolute URLs.
 *   3. A chokidar watcher on wp-content broadcasts over Server-Sent Events:
 *        .css                 → hot stylesheet swap (no reload)
 *        .js/.php/.html/.twig  → full page reload
 *
 * Replaces the previous browser-sync proxy, which only worked on the first
 * proxied page because WordPress' absolute URLs navigated away from the proxy.
 */

/** URL prefix the proxy hands off to this service. Kept obscure to avoid clashing with WP routes. */
export const LIVE_RELOAD_PATH_PREFIX = '/__wpdock-livereload__/';

const MU_PLUGIN_FILE = 'wpdock-livereload.php';

/** Extensions that trigger a full page reload. */
const RELOAD_EXTENSIONS = new Set(['.js', '.mjs', '.php', '.html', '.htm', '.twig']);

interface LiveInstance {
  host: string;          // normalized domain, e.g. "test.local"
  url: string;           // public site URL (for opening in a browser)
  contentDir: string;    // resolved wp-content directory
  watcher: { close(): Promise<void> | void };
  debounce?: NodeJS.Timeout;
  pendingReload: boolean;
}

/** Structural contract used by {@link ProxyRouterService} (avoids an import cycle). */
export interface LivePreviewProxyHandler {
  isLivePreviewPath(url: string | undefined): boolean;
  handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse, host: string): void;
}

export class LivePreviewService implements LivePreviewProxyHandler {
  private instances = new Map<string, LiveInstance>();              // siteId → instance
  private subscribers = new Map<string, Set<http.ServerResponse>>(); // host → open SSE responses

  // ── ProxyRouter integration ────────────────────────────────────────────────

  isLivePreviewPath(url: string | undefined): boolean {
    return typeof url === 'string' && url.startsWith(LIVE_RELOAD_PATH_PREFIX);
  }

  /** Serves the live-reload client + SSE stream through the shared proxy (same origin as the site). */
  handleProxyRequest(req: http.IncomingMessage, res: http.ServerResponse, host: string): void {
    const normalizedHost = this.normalizeHost(host);
    const active = [...this.instances.values()].some((inst) => inst.host === normalizedHost);
    if (!active) { res.writeHead(404).end(); return; }

    const route = (req.url ?? '').slice(LIVE_RELOAD_PATH_PREFIX.length).split('?')[0];
    if (route === 'client.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(CLIENT_JS);
      return;
    }
    if (route === 'stream') {
      this.openStream(req, res, normalizedHost);
      return;
    }
    res.writeHead(404).end();
  }

  private openStream(req: http.IncomingMessage, res: http.ServerResponse, host: string): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': wpdock live-reload connected\n\n');

    // Heartbeat keeps intermediaries from closing an idle SSE connection.
    const ping = setInterval(() => {
      try { res.write(': ping\n\n'); } catch { /* socket gone */ }
    }, 25_000);

    let set = this.subscribers.get(host);
    if (!set) { set = new Set(); this.subscribers.set(host, set); }
    set.add(res);

    const cleanup = () => {
      clearInterval(ping);
      this.subscribers.get(host)?.delete(res);
    };
    req.on('close', cleanup);
    res.on('close', cleanup);
    res.on('error', cleanup);
  }

  private broadcast(host: string, payload: Record<string, unknown>): void {
    const set = this.subscribers.get(host);
    if (!set || set.size === 0) { return; }
    const frame = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of set) {
      try { res.write(frame); } catch { /* socket gone */ }
    }
  }

  // ── Lifecycle ───────────────────────────────────────────────────────────────

  async start(site: WPSite, siteUrl?: string): Promise<string> {
    const host = this.normalizeHost(site.domain);
    if (!host) {
      throw new Error(
        'Live Preview требует домен сайта (например test.local). ' +
        'Включите локальный доступ и задайте домен в настройках сайта.'
      );
    }

    if (this.instances.has(site.id)) {
      await this.stop(site.id);
    }

    const contentDir = this.resolveContentDir(site);
    if (!fs.existsSync(contentDir)) {
      throw new Error(`Каталог wp-content не найден: ${contentDir}`);
    }

    this.writeMuPlugin(contentDir);

    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar');
    const watcher = chokidar.watch(contentDir, {
      ignored: [
        /(^|[/\\])\../,            // dotfiles / dot-folders
        /[/\\]node_modules[/\\]/,
        /[/\\]cache[/\\]/,
        /[/\\]uploads[/\\]/,       // media uploads are not code changes
        new RegExp(`[/\\\\]mu-plugins[/\\\\]${MU_PLUGIN_FILE.replace('.', '\\.')}$`),
      ],
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    });

    const url = siteUrl || `${site.ssl ? 'https' : 'http'}://${host}`;
    const instance: LiveInstance = { host, url, contentDir, watcher, pendingReload: false };
    this.instances.set(site.id, instance);

    watcher.on('change', (filePath: string) => this.onFileEvent(instance, filePath));
    watcher.on('add',    (filePath: string) => this.onFileEvent(instance, filePath));
    watcher.on('unlink', (filePath: string) => this.onFileEvent(instance, filePath));
    watcher.on('error',  (err: unknown) => Logger.error(`[LivePreview] watcher error for "${site.name}"`, err));

    Logger.log(`[LivePreview] started: "${site.name}" → ${url} (watching ${contentDir})`);
    return url;
  }

  private onFileEvent(instance: LiveInstance, filePath: string): void {
    const ext = path.extname(filePath).toLowerCase();
    const isCss = ext === '.css';
    if (!isCss && !RELOAD_EXTENSIONS.has(ext)) { return; }

    if (!isCss) { instance.pendingReload = true; }

    // Debounce bursts (editor save, build tool output) into a single broadcast.
    if (instance.debounce) { return; }
    instance.debounce = setTimeout(() => {
      const reload = instance.pendingReload;
      instance.pendingReload = false;
      instance.debounce = undefined;
      this.broadcast(instance.host, { type: reload ? 'reload' : 'css' });
    }, 120);
  }

  async stop(siteId: string): Promise<void> {
    const instance = this.instances.get(siteId);
    if (!instance) { return; }
    this.instances.delete(siteId);

    if (instance.debounce) { clearTimeout(instance.debounce); }

    // Tell connected pages to stop reconnecting, then close their streams.
    this.broadcast(instance.host, { type: 'disabled' });
    const set = this.subscribers.get(instance.host);
    if (set) {
      for (const res of set) { try { res.end(); } catch { /* ignore */ } }
      this.subscribers.delete(instance.host);
    }

    try {
      await Promise.resolve(instance.watcher.close());
    } catch (err) {
      Logger.error(`[LivePreview] watcher close failed for siteId=${siteId}`, err);
    }

    this.removeMuPlugin(instance.contentDir);
    Logger.log(`[LivePreview] stopped siteId=${siteId}`);
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id);
    }
  }

  isRunning(siteId: string): boolean {
    return this.instances.has(siteId);
  }

  getUrl(siteId: string): string | undefined {
    return this.instances.get(siteId)?.url;
  }

  // ── mu-plugin management ─────────────────────────────────────────────────────

  private writeMuPlugin(contentDir: string): void {
    const muDir = path.join(contentDir, 'mu-plugins');
    fs.mkdirSync(muDir, { recursive: true });
    fs.writeFileSync(path.join(muDir, MU_PLUGIN_FILE), MU_PLUGIN_PHP, 'utf-8');
  }

  private removeMuPlugin(contentDir: string): void {
    try {
      fs.rmSync(path.join(contentDir, 'mu-plugins', MU_PLUGIN_FILE), { force: true });
    } catch (err) {
      Logger.error('[LivePreview] failed to remove mu-plugin', err);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────────

  private resolveContentDir(site: WPSite): string {
    const publicContent = path.join(site.path, 'public', 'wp-content');
    return fs.existsSync(publicContent) ? publicContent : path.join(site.path, 'wp-content');
  }

  /** Mirror of ProxyRouterService.normalizeHost so routing keys match exactly. */
  private normalizeHost(value: string | undefined): string {
    if (!value) { return ''; }
    return value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  }
}

// ── Injected assets ────────────────────────────────────────────────────────────

const CLIENT_JS = `(function () {
  if (window.__wpdockLiveReload) { return; }
  window.__wpdockLiveReload = true;
  var base = '${LIVE_RELOAD_PATH_PREFIX}';
  function swapCss() {
    var links = document.querySelectorAll('link[rel="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
      var link = links[i];
      var href = link.href.replace(/[?&]wpdock_lr=\\d+/, '');
      href += (href.indexOf('?') === -1 ? '?' : '&') + 'wpdock_lr=' + Date.now();
      var clone = link.cloneNode();
      clone.href = href;
      (function (oldLink) {
        clone.addEventListener('load', function () {
          if (oldLink.parentNode) { oldLink.parentNode.removeChild(oldLink); }
        });
      })(link);
      link.parentNode.insertBefore(clone, link.nextSibling);
    }
  }
  function connect() {
    var es = new EventSource(base + 'stream');
    es.addEventListener('message', function (e) {
      var msg;
      try { msg = JSON.parse(e.data); } catch (_) { return; }
      if (!msg || !msg.type) { return; }
      if (msg.type === 'reload') { location.reload(); }
      else if (msg.type === 'css') { swapCss(); }
      else if (msg.type === 'disabled') { es.close(); }
    });
    // EventSource auto-reconnects on transient errors; nothing to do here.
  }
  connect();
})();
`;

const MU_PLUGIN_PHP = `<?php
/**
 * Plugin Name: WPDock Live Reload
 * Description: Injects the WPDock live-reload client. Auto-managed by WPDock — present only while Live Preview is active. Do not edit.
 */
if ( ! defined( 'ABSPATH' ) ) { exit; }

function wpdock_livereload_inject() {
    echo "\\n<script src=\\"${LIVE_RELOAD_PATH_PREFIX}client.js\\" defer></script>\\n";
}
add_action( 'wp_footer',    'wpdock_livereload_inject', 99999 );
add_action( 'admin_footer', 'wpdock_livereload_inject', 99999 );
add_action( 'login_footer', 'wpdock_livereload_inject', 99999 );
`;
