/**
 * ProxyRouterService — shared HTTP+HTTPS reverse proxy routing by Host header.
 *
 * Portless URL strategy (http://mysite.local + https://mysite.local) on Windows:
 *
 *  1. HTTP proxy binds to a non-privileged port (preferred: 8080).
 *  2. HTTPS proxy binds to a non-privileged port (preferred: 8443).
 *     Uses per-domain mkcert certificates with TLS SNI — one cert per site.
 *  3. A one-time elevated setup adds two kernel-level portproxy rules:
 *       0.0.0.0:80  → 127.0.0.1:<httpPort>
 *       0.0.0.0:443 → 127.0.0.1:<httpsPort>
 *  4. Hosts file entries use 127.0.0.1 for all .local domains.
 *
 * Note: wildcard *.local certs are rejected by Chromium (local is in PSL).
 *       Per-domain certs (test.local, mysite.local …) work correctly.
 *
 * Browser → http://mysite.local  → portproxy:80  → HTTP proxy  → PHP
 * Browser → https://mysite.local → portproxy:443 → HTTPS proxy → PHP
 *
 * Portproxy rules persist across reboots so the UAC prompt is shown once.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as os from 'os';
import * as tls from 'tls';
import * as vscode from 'vscode';
import { WPSite } from '../types';
import { Logger } from '../utils/logger';
import { runElevated, runElevatedPs } from '../utils/elevate';
import type { LivePreviewProxyHandler } from './LivePreviewService';

const PORTPROXY_HTTP_PORT  = 80;
const PORTPROXY_HTTPS_PORT = 443;
const PROXY_PREFERRED_HTTP  = 8080;
const PROXY_PREFERRED_HTTPS = 8443;

export class ProxyRouterService {
  private server:      http.Server  | null = null;
  private httpsServer: https.Server | null = null;

  private _port      = 0;
  private _httpsPort = 0;

  private readonly routes   = new Map<string, { port: number; ssl: boolean }>();
  private readonly sniCerts = new Map<string, tls.SecureContext>();

  private started = false;
  private _portProxyActive = false;
  /** True when bound directly to :80 (VS Code running as admin) — no portproxy needed. */
  private _directBind = false;

  /** Optional live-reload handler. Same-origin requests under its path prefix are served by it. */
  livePreview?: LivePreviewProxyHandler;

  private normalizeHost(value: string | undefined): string {
    if (!value) {return '';}
    return value.trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  }

  /** Called after portproxy is successfully activated so SiteManager can update WP siteurl. */
  onPortProxyActivated?: (hostsIp: string) => void;

  private activatePortlessUrls(): void {
    this._portProxyActive = true;
    this.onPortProxyActivated?.(this.getHostsIp());
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(options: { allowElevation?: boolean } = {}): Promise<void> {
    const allowElevation = options.allowElevation ?? false;
    if (this.started) {return;}
    this.started = true;

    // 1. Try binding :80 + :443 directly (works when VS Code runs elevated AND
    //    nothing else owns those ports). HTTPS direct-bind is only viable when :443
    //    is actually bindable: on many Windows boxes http.sys/SSTP (RAS) permanently
    //    holds :443, so a raw socket bind there fails with EACCES. If we entered
    //    direct mode anyway we'd set _httpsPort=443 and the lazy registerSni bind
    //    would throw EACCES — silently killing HTTPS and marking sites stopped.
    //    So only take this path when :443 is genuinely free; otherwise fall through
    //    to the portproxy path (portproxy coexists with http.sys and forwards :443).
    if (await this.isPortFree(PORTPROXY_HTTPS_PORT)) {
      try {
        await this.bindHttpPort(80, '0.0.0.0');
        this._port = 80;
        this._httpsPort = PORTPROXY_HTTPS_PORT; // 443 — HTTPS server starts lazily on registerSni
        this._directBind = true;
        Logger.log('[ProxyRouter] bound to ports 80+443 directly (admin mode) — portproxy skipped');
        this.activatePortlessUrls();
        return;
      } catch { /* :80 busy / not admin — continue */ }
    }

    // 2. Check existing portproxy rules.
    const targets = os.platform() === 'win32'
      ? await this.getPortProxyTargets()
      : { http: null, https: null };

    // 3. Determine HTTP proxy port.
    let httpPort: number;
    if (targets.http !== null && await this.isPortFree(targets.http)) {
      httpPort = targets.http;
    } else {
      httpPort = await this.findFreePort(PROXY_PREFERRED_HTTP);
    }

    // 4. Determine HTTPS proxy port (lazy — HTTPS server starts on first registerSni).
    let httpsPort: number;
    if (targets.https !== null && await this.isPortFree(targets.https)) {
      httpsPort = targets.https;
    } else {
      if (targets.https !== null) {
        Logger.log(`[ProxyRouter] WARN: portproxy 443→${targets.https} but port ${targets.https} is busy — HTTPS portless access degraded until local-access re-setup`);
      }
      httpsPort = await this.findFreePort(PROXY_PREFERRED_HTTPS);
    }
    this._httpsPort = httpsPort;

    // 5. Bind HTTP proxy.
    try {
      await this.bindHttpPort(httpPort, '127.0.0.1');
      this._port = httpPort;
      Logger.log(`[ProxyRouter] HTTP listening on port ${httpPort}`);
    } catch (err) {
      Logger.error('[ProxyRouter] failed to start HTTP proxy', err);
      this.started = false;
      return;
    }

    // 6. Portproxy management (Windows only).
    if (os.platform() !== 'win32') {return;}

    const bothExist  = targets.http !== null && targets.https !== null;
    const portsMatch = targets.http === httpPort && targets.https === httpsPort;

    if (bothExist && portsMatch) {
      this.activatePortlessUrls();
      Logger.log('[ProxyRouter] existing portproxy detected — portless URLs active');
    } else if (bothExist && !portsMatch && allowElevation) {
      await this.runPortProxyUpdate(httpPort, httpsPort);
    } else if (!bothExist && allowElevation) {
      Logger.log('[ProxyRouter] no portproxy found — auto-starting elevation setup');
      await this.setupPortProxy(httpPort, httpsPort);
    } else if (bothExist && !portsMatch) {
      Logger.log(`[ProxyRouter] WARN: portproxy drift — rule(80→${targets.http}, 443→${targets.https}) ≠ proxy(80→${httpPort}, 443→${httpsPort}); HTTPS unavailable until local-access re-setup`);
    } else {
      Logger.log('[ProxyRouter] portproxy setup skipped — waiting for explicit local-access setup');
    }
  }

  stop(): void {
    this.server?.close();
    this.httpsServer?.close();
    this.server      = null;
    this.httpsServer = null;
    this.routes.clear();
    this.sniCerts.clear();
    this.started = false;
    this._port      = 0;
    this._httpsPort = 0;
    this._directBind = false;
    this._portProxyActive = false;
  }

  // ── Route management ──────────────────────────────────────────────────────

  register(site: WPSite): void {
    const host = this.normalizeHost(site.domain);
    if (host) {
      this.routes.set(host, { port: site.port, ssl: Boolean(site.ssl) });
    }
  }

  unregister(site: WPSite): void {
    const host = this.normalizeHost(site.domain);
    if (host) {this.routes.delete(host);}
  }

  // ── SNI cert management ────────────────────────────────────────────────────

  /**
   * Registers a TLS certificate for a domain.
   * If the HTTPS server isn't running yet, starts it using this cert as the default.
   */
  async registerSni(domain: string, certPath: string, keyPath: string): Promise<void> {
    let certBuf: Buffer, keyBuf: Buffer;
    try {
      certBuf = fs.readFileSync(certPath);
      keyBuf  = fs.readFileSync(keyPath);
    } catch (err) {
      Logger.error(`[ProxyRouter] Cannot read cert for ${domain}`, err);
      return;
    }

    const ctx = tls.createSecureContext({ cert: certBuf, key: keyBuf });
    const host = this.normalizeHost(domain);
    if (!host) {
      Logger.error('[ProxyRouter] Cannot register SNI: empty domain');
      return;
    }

    this.sniCerts.set(host, ctx);
    Logger.debug(`[ProxyRouter] SNI registered for ${host}`);

    // Start HTTPS server lazily — only when first cert is registered.
    if (!this.httpsServer && this._httpsPort > 0) {
      await this.startHttpsServer(certBuf, keyBuf);
    }
  }

  unregisterSni(domain: string): void {
    const host = this.normalizeHost(domain);
    if (!host) {return;}
    this.sniCerts.delete(host);
    Logger.debug(`[ProxyRouter] SNI unregistered for ${host}`);
  }

  // ── URL / hosts helpers ────────────────────────────────────────────────────

  /** Always 127.0.0.1 — portproxy intercepts :80/:443 on loopback. */
  getHostsIp(): string {
    return '127.0.0.1';
  }

  /** Returns the public URL for the site. HTTPS when portproxy is active. */
  getPublicUrl(site: WPSite): string {
    if (!site.domain || !this._port) {return '';}
    if (this._portProxyActive) {
      return `${site.ssl ? 'https' : 'http'}://${site.domain}`;
    }
    if (site.ssl && this._httpsPort > 0) {
      return `https://${site.domain}:${this._httpsPort}`;
    }
    if (this._port === 80) {
      return `http://${site.domain}`;
    }
    return `http://${site.domain}:${this._port}`;
  }

  isRunning(): boolean {
    return this.server !== null && this._port > 0;
  }

  get port(): number      { return this._port; }
  get httpsPort(): number { return this._httpsPort; }
  get portProxyActive(): boolean { return this._portProxyActive; }

  async setupPortProxyAndHosts(hostsEntries: Array<{ domain: string; ip: string }>): Promise<boolean> {
    if (os.platform() !== 'win32') {return true;}

    if (!this.isRunning()) {
      await this.start({ allowElevation: false });
    }
    if (!this._port || !this._httpsPort) {return false;}

    const hostsPath = 'C:\\Windows\\System32\\drivers\\etc\\hosts';
    const psEntries = hostsEntries
      .filter((entry) => entry.domain)
      .map((entry) => {
        const domain = entry.domain.replace(/'/g, "''");
        const ip = entry.ip.replace(/'/g, "''");
        return `@{ domain = '${domain}'; ip = '${ip}' }`;
      })
      .join(', ');

    // In direct-bind (admin) mode :80/:443 are served by this process directly,
    // so no portproxy rules are added — only the hosts entries are written.
    const portProxyCmds = this._directBind ? [] : [
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTP_PORT} 2>$null`,
      `netsh interface portproxy delete v4tov4 listenaddress=169.254.192.1 listenport=${PORTPROXY_HTTP_PORT} 2>$null`,
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTPS_PORT} 2>$null`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTP_PORT} connectaddress=127.0.0.1 connectport=${this._port}`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTPS_PORT} connectaddress=127.0.0.1 connectport=${this._httpsPort}`,
    ];

    const script = [
      `$ErrorActionPreference = 'Stop'`,
      ...portProxyCmds,
      `$entries = @(${psEntries})`,
      `$hostsAccount = New-Object System.Security.Principal.NTAccount($env:USERDOMAIN, $env:USERNAME)`,
      `$hostsAcl = Get-Acl '${hostsPath}'`,
      `$hostsRule = New-Object System.Security.AccessControl.FileSystemAccessRule($hostsAccount, 'Modify', 'Allow')`,
      `$hostsAcl.SetAccessRule($hostsRule)`,
      `Set-Acl -Path '${hostsPath}' -AclObject $hostsAcl`,
      `if ($entries.Count -gt 0) {`,
      `  $h = '${hostsPath}'`,
      `  $content = ''`,
      `  $nl = [Environment]::NewLine`,
      `  if (Test-Path $h) { $content = [System.IO.File]::ReadAllText($h) }`,
      `  foreach ($entry in $entries) {`,
      `    $marker = '# WPDock:' + $entry.domain`,
      `    $line = $entry.ip + ' ' + $entry.domain + ' ' + $marker`,
      `    $pattern = '(?m)^.*' + [Regex]::Escape($marker) + '.*(?:\r?\n)?'`,
      `    $content = [Regex]::Replace($content, $pattern, '')`,
      `    if ($content.Length -gt 0 -and -not $content.EndsWith($nl)) { $content += $nl }`,
      `    $content += $line + $nl`,
      `  }`,
      `  [System.IO.File]::WriteAllText($h, $content, [System.Text.UTF8Encoding]::new($false))`,
      `}`,
    ].join('\r\n');

    Logger.log(`[ProxyRouter] UAC elevation: portproxy + ${hostsEntries.length} hosts entr${hostsEntries.length === 1 ? 'y' : 'ies'}`);
    const ok = await runElevatedPs(script);
    if (ok) {
      this.activatePortlessUrls();
      Logger.log('[ProxyRouter] portproxy + hosts setup OK');
    } else {
      Logger.error('[ProxyRouter] portproxy + hosts setup FAILED');
    }
    return ok;
  }

  // ── HTTP server ───────────────────────────────────────────────────────────

  private bindHttpPort(port: number, address: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => this.handleRequest(req, res));
      server.on('upgrade', (req, socket, head) =>
        this.handleUpgrade(req, socket as net.Socket, head)
      );
      server.once('error', reject);
      server.listen(port, address, () => {
        this.server = server;
        resolve();
      });
    });
  }

  // ── HTTPS server (lazy — started on first registerSni) ────────────────────

  private async startHttpsServer(defaultCert: Buffer, defaultKey: Buffer): Promise<void> {
    const server = https.createServer(
      {
        cert: defaultCert,
        key:  defaultKey,
        SNICallback: (serverName, cb) => {
          const ctx = this.sniCerts.get(this.normalizeHost(serverName));
          cb(null, ctx ?? tls.createSecureContext({ cert: defaultCert, key: defaultKey }));
        },
      },
      (req, res) => this.handleRequest(req, res)
    );
    server.on('upgrade', (req, socket, head) =>
      this.handleUpgrade(req, socket as net.Socket, head)
    );

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._httpsPort, '127.0.0.1', () => {
        this.httpsServer = server;
        Logger.log(`[ProxyRouter] HTTPS listening on port ${this._httpsPort}`);
        resolve();
      });
    });
  }

  // ── Request handling (shared by HTTP and HTTPS) ───────────────────────────

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const hostname    = this.normalizeHost(req.headers.host);

    // Live-reload client + SSE stream ride the site's own origin (handled before routing).
    if (this.livePreview?.isLivePreviewPath(req.url)) {
      this.livePreview.handleProxyRequest(req, res, hostname);
      return;
    }

    const route = this.routes.get(hostname);

    if (!route) {
      const list = Array.from(this.routes.entries());
      const items = list.length
        ? list
          .map(([host, value]) => `<li><a href="${value.ssl ? 'https' : 'http'}://${host}/">${host}</a></li>`)
          .join('')
        : '<li><i>нет запущенных сайтов</i></li>';
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><title>WPDock</title>` +
        `<style>body{font-family:sans-serif;max-width:480px;margin:80px auto;color:#333}` +
        `h2{color:#c00}a{color:#0066cc}</style></head><body>` +
        `<h2>Сайт не запущен</h2>` +
        `<p>Домен <b>${hostname}</b> не найден среди запущенных сайтов.</p>` +
        `<p>Запустите сайт из панели WPDock.</p>` +
        `<hr><p><b>Запущенные сайты:</b></p><ul>${items}</ul>` +
        `</body></html>`
      );
      return;
    }

    // Pass HTTPS context to the PHP backend so WordPress knows it's running over TLS.
    const isHttps = (req.socket as any).encrypted === true;
    if (isHttps && !route.ssl) {
      const location = `http://${hostname}${req.url ?? '/'}`;
      res.writeHead(307, { Location: location });
      res.end();
      return;
    }

    const backendPort = route.port;
    const forwardHeaders: http.OutgoingHttpHeaders = {
      ...req.headers,
      host: hostname,
      ...(isHttps ? {
        'x-forwarded-proto': 'https',
        'x-forwarded-host':  hostname,
        'x-forwarded-ssl':   'on',
        'x-forwarded-port':  '443',
      } : {}),
    };

    const proxyReq = http.request(
      {
        hostname: '127.0.0.1',
        port:     backendPort,
        path:     req.url ?? '/',
        method:   req.method,
        headers:  forwardHeaders,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 200, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
      }
    );
    proxyReq.setTimeout(30_000, () => {
      proxyReq.destroy(new Error(`upstream timeout after 30000ms (${hostname} -> 127.0.0.1:${backendPort})`));
    });
    proxyReq.on('error', (err) => {
      Logger.error(`[ProxyRouter] 502 for ${hostname} -> 127.0.0.1:${backendPort}`, err);
      if (!res.headersSent) { res.writeHead(502); res.end('WPDock: upstream not responding.'); }
    });
    req.pipe(proxyReq, { end: true });
  }

  private handleUpgrade(req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
    const hostname    = this.normalizeHost(req.headers.host);
    const route = this.routes.get(hostname);
    if (!route) { socket.destroy(); return; }
    const backendPort = route.port;

    const upstream = net.createConnection(backendPort, '127.0.0.1', () => {
      const headers = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(req.headers)) {
        headers.push(`${k}: ${Array.isArray(v) ? v.join(', ') : v}`);
      }
      upstream.write(headers.join('\r\n') + '\r\n\r\n');
      if (head?.length) {upstream.write(head);}
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error',   () => upstream.destroy());
  }

  // ── Windows portproxy helpers ─────────────────────────────────────────────

  private getPortProxyTargets(): Promise<{ http: number | null; https: number | null }> {
    return new Promise(resolve => {
      cp.exec('netsh interface portproxy show v4tov4', (err, stdout) => {
        if (err) { resolve({ http: null, https: null }); return; }
        const match = (port: number): number | null => {
          const re = new RegExp(`\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\s+${port}\\s+127\\.0\\.0\\.1\\s+(\\d+)`);
          const m = stdout.match(re);
          return m ? parseInt(m[1], 10) : null;
        };
        resolve({ http: match(80), https: match(443) });
      });
    });
  }

  private async setupPortProxy(httpPort: number, httpsPort: number): Promise<void> {
    const cmds = [
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTP_PORT}  connectaddress=127.0.0.1 connectport=${httpPort}`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTPS_PORT} connectaddress=127.0.0.1 connectport=${httpsPort}`,
    ].join(' && ');

    Logger.log(`[ProxyRouter] UAC elevation: portproxy HTTP:${httpPort} HTTPS:${httpsPort}`);
    const ok = await runElevated(cmds);
    if (ok) {
      this.activatePortlessUrls();
      Logger.log('[ProxyRouter] portproxy OK — http:// and https:// portless URLs active');
      vscode.window.showInformationMessage(
        'WPDock: Готово! Сайты доступны как https://mysite.local (без порта).'
      );
    } else {
      Logger.error('[ProxyRouter] portproxy setup FAILED (UAC denied or error)');
      vscode.window.showWarningMessage(
        'WPDock: UAC отклонён — сайты работают с портом (:8080), без HTTPS.'
      );
    }
  }

  private async runPortProxyUpdate(httpPort: number, httpsPort: number): Promise<void> {
    const cmds = [
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0       listenport=${PORTPROXY_HTTP_PORT}`,
      `netsh interface portproxy delete v4tov4 listenaddress=169.254.192.1 listenport=${PORTPROXY_HTTP_PORT}`,
      `netsh interface portproxy delete v4tov4 listenaddress=0.0.0.0       listenport=${PORTPROXY_HTTPS_PORT}`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTP_PORT}  connectaddress=127.0.0.1 connectport=${httpPort}`,
      `netsh interface portproxy add v4tov4 listenaddress=0.0.0.0 listenport=${PORTPROXY_HTTPS_PORT} connectaddress=127.0.0.1 connectport=${httpsPort}`,
    ].join(' && ');
    const ok = await runElevated(cmds);
    if (ok) {
      this.activatePortlessUrls();
      Logger.log(`[ProxyRouter] portproxy updated → HTTP:${httpPort} HTTPS:${httpsPort}`);
    }
  }

  // ── Port utilities ────────────────────────────────────────────────────────

  private findFreePort(from: number): Promise<number> {
    return new Promise(resolve => {
      const tryNext = (port: number) => {
        const s = net.createServer();
        s.once('error', () => tryNext(port + 1));
        s.once('listening', () => { s.close(); resolve(port); });
        s.listen(port, '127.0.0.1');
      };
      tryNext(from);
    });
  }

  private isPortFree(port: number): Promise<boolean> {
    return new Promise(resolve => {
      const s = net.createServer();
      s.once('error', () => resolve(false));
      s.once('listening', () => { s.close(); resolve(true); });
      s.listen(port, '127.0.0.1');
    });
  }
}
