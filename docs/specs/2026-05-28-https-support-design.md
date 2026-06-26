# HTTPS Support — Design Spec

**Date:** 2026-05-28  
**Status:** Approved

## Goal

All local WordPress sites are automatically accessible via `https://test.local` (no port, no browser warnings) in addition to `http://test.local`. No per-site SSL checkbox required — HTTPS is always-on for every site.

## Architecture

```
Browser → https://test.local
  → (hosts) 127.0.0.1:443
  → (portproxy, kernel) → 127.0.0.1:8443
  → (TLS SNI proxy, ProxyRouterService)
     picks cert by domain (SNICallback)
  → 127.0.0.1:<php-port> → WordPress

Browser → http://test.local  (still works)
  → (hosts) 127.0.0.1:80
  → (portproxy) → 127.0.0.1:8080
  → (HTTP proxy, ProxyRouterService) → WordPress
```

One UAC prompt sets up both portproxy rules (80 and 443). mkcert installs its CA once at extension start (its own UAC dialog). After that, no more elevation prompts.

## Certificates

- Tool: **mkcert** (already implemented in `SslService`)
- CA install: `sslService.installCA()` called once at extension activation (non-blocking; mkcert shows its own UAC dialog)
- Per-site cert: `sslService.generateSiteCert(domain)` called in `SiteManager.startSite()`, produces `test_local.pem` + `test_local-key.pem` in extension global storage
- Browser trust: mkcert installs its root CA into the Windows system certificate store → Chrome/Edge trust all generated certs without warnings

## Changes by File

### `ProxyRouterService.ts`

- Add `httpsServer: tls.Server | null` + `_httpsPort = 8443`
- Add `sniCerts: Map<string, tls.SecureContext>` — domain → SecureContext
- `start()`: after binding HTTP server, also bind `tls.createServer` with `SNICallback` on `_httpsPort` (127.0.0.1)
- `setupPortProxy()`: one bat file with both rules:
  - `netsh ... listenaddress=0.0.0.0 listenport=80 connectport=<httpPort>`
  - `netsh ... listenaddress=0.0.0.0 listenport=443 connectport=<httpsPort>`
- `runPortProxyUpdate()`: updates both 80 and 443 rules
- `getPortProxyTarget()`: detects existing portproxy by checking for port 80 rule (unchanged logic)
- New `registerSni(domain, certPath, keyPath)`: creates `tls.createSecureContext`, stores in `sniCerts`
- New `unregisterSni(domain)`: removes from `sniCerts`
- `getPublicUrl(site)`: returns `https://<domain>` when portProxyActive (was http://)
- `stop()`: close `httpsServer` + clear `sniCerts`

### `SiteManager.ts`

- Constructor: accept `SslService` as new optional parameter
- `startSite()`: after `proxyRouter.register(site)`, call `sslService.generateSiteCert(domain)` → `proxyRouter.registerSni(domain, cert.certPath, cert.keyPath)`
- `stopSite()`: call `proxyRouter.unregisterSni(domain)`
- `deleteSite()`: call `proxyRouter.unregisterSni(domain)`
- `activatePortlessUrls()`: WP_HOME updated to `https://` (since `getPublicUrl` now returns https)

### `SiteProcessManager.ts`

- Remove `startHttpsProxy()` private method (replaced by ProxyRouterService)
- Remove `httpsProxies` map and related cleanup in `stopSite()` / `stopAll()`
- `startSite()`: remove `if (site.ssl && this.ssl) { await this.startHttpsProxy(site); }`
- `getSiteUrl()`: unchanged — still delegates to `proxyRouter.getPublicUrl()` which now returns https when portless

### `extension.ts`

- After `proxyRouter.start()`, call `sslService.installCA()` in a non-blocking fire-and-forget (catch and log errors, do not block extension activation)

### `wp-config.php` generation

- `buildDebugBlock()` / `getSiteUrl()` will automatically produce `https://` URLs when portproxy is active (via `getPublicUrl()`)
- No explicit change needed beyond the `getPublicUrl()` fix above

## Data Flow: First Site Start

1. Extension activates → `proxyRouter.start()` → portproxy setup (UAC, one-time)
2. `sslService.installCA()` fires (UAC via mkcert, one-time)
3. User starts site → `siteManager.startSite()`
4. `sslService.generateSiteCert('test.local')` → cert files written
5. `proxyRouter.registerSni('test.local', certPath, keyPath)` → SecureContext stored
6. `activatePortlessUrls()` → `wp-config.php` updated with `https://test.local`
7. Browser opens `https://test.local` → TLS handshake → SNI picks test.local cert → proxy to PHP

## Constraints

- `sni.certs` key = hostname only (no port). Matches `servername` from TLS ClientHello.
- If mkcert is unavailable (download failed), HTTPS proxy starts but SNI has no certs → TLS handshake fails gracefully for that domain. HTTP still works.
- `site.ssl` field on WPSite is no longer used for controlling HTTPS behavior but kept on the type for backward compatibility.
- The HTTPS server `listen()` binds to `127.0.0.1` (same as HTTP), so portproxy routes to it correctly.
