import * as fs from 'fs';
import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as url from 'url';
import * as crypto from 'crypto';
import * as net from 'net';
import * as vscode from 'vscode';
import { StorageService } from './StorageService';
import { BackupEntry, CloudUploadInfo } from '../types';
import { CLOUD_AUTH_CONFIG } from '../config/cloudAuth';
import { Logger } from '../utils/logger';

/** Idle-таймаут для сетевых операций (нет данных N мс → обрыв вместо вечного ожидания). */
const NET_IDLE_TIMEOUT_MS = 60_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface YandexCredentials {
  token?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  folder: string; // e.g. /WPDock
}

export interface GoogleCredentials {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  folderId?: string; // Google Drive folder ID (root if empty)
}

export type CloudProvider = 'yandex' | 'google';

export interface CloudFileInfo {
  name: string;
  path: string;       // remotePath for Yandex, fileId for Google
  size: number;
  modifiedAt: string; // ISO string
  provider: CloudProvider;
}

export interface CloudAuthCapability {
  browserReady: boolean;
  managed: boolean;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class CloudBackupService {
  constructor(
    private context: vscode.ExtensionContext,
    private storage: StorageService
  ) {}

  // ── Credentials management ────────────────────────────────────────────────

  async saveYandexCredentials(creds: YandexCredentials): Promise<void> {
    await this.storage.saveSecret('cloud-yandex', JSON.stringify(creds));
  }

  async getYandexCredentials(): Promise<YandexCredentials | null> {
    const raw = await this.storage.getSecret('cloud-yandex');
    if (!raw) {return null;}
    try {
      return JSON.parse(raw) as YandexCredentials;
    } catch {
      return null;
    }
  }

  async saveGoogleCredentials(creds: GoogleCredentials): Promise<void> {
    await this.storage.saveSecret('cloud-google', JSON.stringify(creds));
  }

  async getGoogleCredentials(): Promise<GoogleCredentials | null> {
    const raw = await this.storage.getSecret('cloud-google');
    if (!raw) {return null;}
    try {
      return JSON.parse(raw) as GoogleCredentials;
    } catch {
      return null;
    }
  }

  async clearCredentials(provider: CloudProvider): Promise<void> {
    await this.storage.deleteSecret(`cloud-${provider}`);
  }

  async getConfiguredProviders(): Promise<CloudProvider[]> {
    const result: CloudProvider[] = [];
    if (await this.getYandexCredentials()) {result.push('yandex');}
    if (await this.getGoogleCredentials()) {result.push('google');}
    return result;
  }

  /** @deprecated используй getAvailability() */
  getAuthCapabilities(): Record<CloudProvider, CloudAuthCapability> {
    const yandexManaged = this.getManagedYandexCredentials();
    const googleManaged = this.getManagedGoogleCredentials();

    return {
      yandex: {
        browserReady: Boolean(yandexManaged),
        managed: Boolean(yandexManaged),
      },
      google: {
        browserReady: Boolean(googleManaged),
        managed: Boolean(googleManaged),
      },
    };
  }

  /** Возвращает, настроены ли OAuth-крeды в cloudAuth.ts */
  getAvailability(): { yandex: boolean; google: boolean } {
    return {
      yandex: Boolean(this.getManagedYandexCredentials()),
      google: Boolean(this.getManagedGoogleCredentials()),
    };
  }

  getDefaultCloudConfig(): {
    yandexFolder: string;
    googleFolderId: string;
  } {
    return {
      yandexFolder: CLOUD_AUTH_CONFIG.yandex.folder || '/WPDock',
      googleFolderId: CLOUD_AUTH_CONFIG.google.folderId || '',
    };
  }

  private getManagedYandexCredentials(): { clientId: string; clientSecret: string; folder: string } | null {
    const clientId = (CLOUD_AUTH_CONFIG.yandex.clientId || '').trim();
    const clientSecret = (CLOUD_AUTH_CONFIG.yandex.clientSecret || '').trim();
    const folder = (CLOUD_AUTH_CONFIG.yandex.folder || '/WPDock').trim() || '/WPDock';
    if (!clientId || !clientSecret) {return null;}
    return { clientId, clientSecret, folder };
  }

  private getManagedGoogleCredentials(): { clientId: string; clientSecret: string; folderId?: string } | null {
    const clientId = (CLOUD_AUTH_CONFIG.google.clientId || '').trim();
    const clientSecret = (CLOUD_AUTH_CONFIG.google.clientSecret || '').trim();
    const folderId = (CLOUD_AUTH_CONFIG.google.folderId || '').trim() || undefined;
    if (!clientId || !clientSecret) {return null;}
    return { clientId, clientSecret, folderId };
  }

  // ── PKCE helpers ──────────────────────────────────────────────────────────

  /** base64url без padding */
  private base64url(buf: Buffer): string {
    return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
  }

  /** Генерирует { verifier, challenge } для PKCE S256 */
  private generatePkce(): { verifier: string; challenge: string } {
    const verifier = this.base64url(crypto.randomBytes(32));
    const challenge = this.base64url(
      crypto.createHash('sha256').update(verifier).digest()
    );
    return { verifier, challenge };
  }

  // ── Loopback server ───────────────────────────────────────────────────────

  /** Проверяет, занят ли порт */
  private isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const srv = net.createServer();
      srv.once('error', () => resolve(false));
      srv.once('listening', () => { srv.close(); resolve(true); });
      srv.listen(port, '127.0.0.1');
    });
  }

  /**
   * Запускает временный HTTP-сервер на loopback, открывает auth URL в браузере
   * и ждёт редиректа с ?code=&state=.
   *
   * @returns { code, redirectUri } — код авторизации и использованный redirectUri
   */
  private async runLoopbackAuth(opts: {
    buildAuthUrl: (redirectUri: string, state: string, codeChallenge: string) => string;
    state: string;
  }): Promise<{ code: string; redirectUri: string; codeVerifier: string }> {
    const { verifier, challenge } = this.generatePkce();

    // Найти свободный порт
    const ports = CLOUD_AUTH_CONFIG.redirectPorts as number[];
    let chosenPort: number | null = null;
    for (const p of ports) {
      if (await this.isPortFree(p)) { chosenPort = p; break; }
    }
    if (chosenPort === null) {
      throw new Error(
        `Не удалось запустить OAuth-сервер: все порты (${ports.join(', ')}) заняты. ` +
        'Закройте другие приложения, занимающие эти порты, и попробуйте снова.'
      );
    }

    const redirectUri = `http://localhost:${chosenPort}/callback`;
    const authUrl = opts.buildAuthUrl(redirectUri, opts.state, challenge);

    const successHtml = `<!DOCTYPE html>
<html lang="ru">
<head><meta charset="UTF-8"><title>WPDock — авторизация</title>
<style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f4f4f5}
.card{background:#fff;border-radius:12px;padding:40px 48px;box-shadow:0 4px 24px #0002;text-align:center;max-width:420px}
h1{color:#16a34a;margin-bottom:8px;font-size:1.5rem}p{color:#555;margin:0}</style>
</head>
<body><div class="card">
  <h1>Авторизация завершена</h1>
  <p>Можно закрыть эту вкладку и вернуться в VS Code.</p>
</div></body></html>`;

    const errorHtml = (msg: string) => `<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8"><title>Ошибка</title></head>
<body><h2>Ошибка авторизации</h2><p>${msg}</p><p>Закройте вкладку и попробуйте снова.</p></body></html>`;

    return new Promise<{ code: string; redirectUri: string; codeVerifier: string }>((resolve, reject) => {
      let settled = false;

      const server = http.createServer((req, res) => {
        try {
          const parsed = new url.URL(req.url ?? '/', `http://localhost:${chosenPort}`);
          if (parsed.pathname !== '/callback') {
            res.writeHead(404); res.end('Not found'); return;
          }

          const returnedState = parsed.searchParams.get('state');
          const code = parsed.searchParams.get('code');
          const authError = parsed.searchParams.get('error');

          if (authError) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(errorHtml(`OAuth error: ${authError}`));
            closeAndSettle(() => reject(new Error(`OAuth error: ${authError}`)));
            return;
          }

          if (returnedState !== opts.state) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(errorHtml('Неверный state — возможна CSRF-атака.'));
            closeAndSettle(() => reject(new Error('OAuth state mismatch')));
            return;
          }

          if (!code) {
            res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(errorHtml('Код авторизации не получен.'));
            closeAndSettle(() => reject(new Error('OAuth code missing')));
            return;
          }

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(successHtml);
          closeAndSettle(() => resolve({ code, redirectUri, codeVerifier: verifier }));
        } catch (e: any) {
          res.writeHead(500); res.end('Internal error');
          closeAndSettle(() => reject(e));
        }
      });

      const closeAndSettle = (fn: () => void) => {
        if (settled) {return;}
        settled = true;
        server.close();
        clearTimeout(timer);
        fn();
      };

      const timer = setTimeout(() => {
        closeAndSettle(() => reject(new Error(
          'Время ожидания авторизации истекло (5 минут). Попробуйте ещё раз.'
        )));
      }, 5 * 60 * 1000);

      server.listen(chosenPort!, '127.0.0.1', async () => {
        try {
          await vscode.env.openExternal(vscode.Uri.parse(authUrl));
        } catch (e: any) {
          closeAndSettle(() => reject(
            new Error(e?.message || 'Не удалось открыть браузер для авторизации')
          ));
        }
      });

      server.on('error', (e) => {
        closeAndSettle(() => reject(new Error(`Loopback-сервер: ${e.message}`)));
      });
    });
  }

  // ── Browser auth ───────────────────────────────────────────────────────────

  /**
   * Запускает OAuth-авторизацию Yandex через loopback + PKCE.
   * clientId/clientSecret берутся из cloudAuth.ts.
   */
  async startYandexBrowserAuth(): Promise<YandexCredentials> {
    const managed = this.getManagedYandexCredentials();
    if (!managed) {
      throw new Error(
        'OAuth для Yandex не настроен в расширении (cloudAuth.ts). ' +
        'Вставьте clientId и clientSecret и пересоберите расширение.'
      );
    }

    const state = crypto.randomUUID();

    const { code, redirectUri, codeVerifier } = await this.runLoopbackAuth({
      buildAuthUrl: (ru, st, cc) => this.buildYandexAuthUrl(managed.clientId, ru, st, cc),
      state,
    });

    const tokenData = await this.yandexExchangeCode({
      clientId: managed.clientId,
      clientSecret: managed.clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });

    if (!tokenData.access_token) {
      throw new Error('Yandex не вернул access token');
    }

    const creds: YandexCredentials = {
      folder: managed.folder,
      token: tokenData.access_token,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token,
      clientId: managed.clientId,
      clientSecret: managed.clientSecret,
      expiresAt: tokenData.expires_in
        ? new Date(Date.now() + tokenData.expires_in * 1000).toISOString()
        : undefined,
    };

    await this.saveYandexCredentials(creds);
    return creds;
  }

  /**
   * Запускает OAuth-авторизацию Google через loopback + PKCE.
   * clientId/clientSecret берутся из cloudAuth.ts.
   */
  async startGoogleBrowserAuth(): Promise<GoogleCredentials> {
    const managed = this.getManagedGoogleCredentials();
    if (!managed) {
      throw new Error(
        'OAuth для Google не настроен в расширении (cloudAuth.ts). ' +
        'Вставьте clientId и clientSecret и пересоберите расширение.'
      );
    }

    const state = crypto.randomUUID();

    const { code, redirectUri, codeVerifier } = await this.runLoopbackAuth({
      buildAuthUrl: (ru, st, cc) => this.buildGoogleAuthUrl(managed.clientId, ru, st, cc),
      state,
    });

    const tokenData = await this.googleExchangeCode({
      clientId: managed.clientId,
      clientSecret: managed.clientSecret,
      redirectUri,
      code,
      codeVerifier,
    });

    if (!tokenData.refresh_token) {
      throw new Error('Google не вернул refresh token. Убедитесь что prompt=consent и access_type=offline. Попробуйте заново.');
    }

    const creds: GoogleCredentials = {
      clientId: managed.clientId,
      clientSecret: managed.clientSecret,
      refreshToken: tokenData.refresh_token,
      folderId: managed.folderId,
    };

    await this.saveGoogleCredentials(creds);
    return creds;
  }

  /**
   * Старый vscode:// URI handler — теперь loopback, оставлен для совместимости.
   * Всегда возвращает false.
   */
  async handleUri(_uri: vscode.Uri): Promise<boolean> {
    return false;
  }

  // ── Auth URL builders ─────────────────────────────────────────────────────

  private buildGoogleAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
    codeChallenge: string
  ): string {
    const params = new url.URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      access_type: 'offline',
      prompt: 'consent',
      scope: 'https://www.googleapis.com/auth/drive',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
  }

  private buildYandexAuthUrl(
    clientId: string,
    redirectUri: string,
    state: string,
    codeChallenge: string
  ): string {
    const params = new url.URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      force_confirm: 'yes',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    });

    return `https://oauth.yandex.com/authorize?${params.toString()}`;
  }

  // ── Token exchange ────────────────────────────────────────────────────────

  private googleExchangeCode(input: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  }): Promise<{ access_token?: string; refresh_token?: string; error?: string; error_description?: string }> {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        client_id: input.clientId,
        client_secret: input.clientSecret,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString();

      const options: https.RequestOptions = {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error_description ?? json.error));
              return;
            }
            resolve(json);
          } catch {
            reject(new Error('Invalid Google OAuth response'));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private yandexExchangeCode(input: {
    clientId: string;
    clientSecret: string;
    code: string;
    redirectUri: string;
    codeVerifier: string;
  }): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        grant_type: 'authorization_code',
        code: input.code,
        redirect_uri: input.redirectUri,
        code_verifier: input.codeVerifier,
      }).toString();

      const auth = Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64');
      const options: https.RequestOptions = {
        hostname: 'oauth.yandex.com',
        path: '/token',
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error_description ?? json.error));
              return;
            }
            resolve(json);
          } catch {
            reject(new Error('Invalid Yandex OAuth response'));
          }
        });
      });

      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  // ── Upload ────────────────────────────────────────────────────────────────

  async uploadBackup(
    backup: BackupEntry,
    providers: CloudProvider[],
    onProgress?: (msg: string) => void
  ): Promise<BackupEntry> {
    // Папка в облаке именуется по проекту (WPDock/<имя-сайта>/файл.zip), а не по
    // случайному siteId — так бэкапы видно сразу.
    const siteFolder = this.slugify(backup.siteName) || backup.siteId;
    for (const provider of providers) {
      try {
        onProgress?.(`Uploading to ${provider === 'yandex' ? 'Yandex Disk' : 'Google Drive'}...`);
        const uploadInfo = await this.upload(provider, backup.localPath, siteFolder, onProgress);
        backup.cloudUploads.push(uploadInfo);
        this.storage.saveBackup(backup);
        onProgress?.(`Uploaded to ${provider === 'yandex' ? 'Yandex Disk' : 'Google Drive'} ✓`);
      } catch (err: any) {
        onProgress?.(`Warning: Upload to ${provider} failed: ${err.message}`);
      }
    }
    return backup;
  }

  /** Слаг имени сайта для папок в облаке (совпадает с BackupService.slugify). */
  private slugify(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  private async upload(
    provider: CloudProvider,
    localPath: string,
    siteFolder: string,
    onProgress?: (msg: string) => void
  ): Promise<CloudUploadInfo> {
    if (provider === 'yandex') {
      return this.uploadToYandex(localPath, siteFolder);
    } else {
      return this.uploadToGoogle(localPath, siteFolder, onProgress);
    }
  }

  // ── Yandex Disk ───────────────────────────────────────────────────────────

  private async uploadToYandex(localPath: string, siteFolder: string): Promise<CloudUploadInfo> {
    const creds = await this.getYandexCredentials();
    if (!creds) {throw new Error('Yandex Disk is not configured. Add your OAuth token first.');}
    const token = await this.getValidYandexAccessToken(creds);

    const base = creds.folder.replace(/\/$/, '');
    const fileName = path.basename(localPath);
    const remotePath = `${base}/${siteFolder}/${fileName}`;

    // Ensure folder exists
    await this.yandexEnsureFolder(token, `${base}/${siteFolder}`);

    // Get upload URL
    const uploadUrl = await this.yandexGetUploadUrl(token, remotePath);

    // Upload file
    await this.httpPutFile(uploadUrl, localPath);

    return {
      provider: 'yandex',
      remotePath,
      uploadedAt: new Date().toISOString(),
    };
  }

  private yandexGetUploadUrl(token: string, remotePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const encodedPath = encodeURIComponent(remotePath);
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources/upload?path=${encodedPath}&overwrite=true`,
        method: 'GET',
        headers: { Authorization: `OAuth ${token}` },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`Yandex API error ${res.statusCode}: ${body}`));
            return;
          }
          try {
            const json = JSON.parse(body);
            resolve(json.href);
          } catch {
            reject(new Error('Invalid Yandex API response'));
          }
        });
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Yandex upload-URL запрос завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async yandexEnsureFolder(token: string, folderPath: string): Promise<void> {
    // Create each segment of the path
    const segments = folderPath.split('/').filter(Boolean);
    let currentPath = '';

    for (const seg of segments) {
      currentPath += `/${seg}`;
      await this.yandexCreateFolder(token, currentPath).catch(() => {
        // Ignore errors (folder may already exist)
      });
    }
  }

  private yandexCreateFolder(token: string, folderPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const encodedPath = encodeURIComponent(folderPath);
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources?path=${encodedPath}`,
        method: 'PUT',
        headers: { Authorization: `OAuth ${token}` },
      };

      const req = https.request(options, (res) => {
        res.resume(); // consume response
        if (res.statusCode === 201 || res.statusCode === 409) {
          resolve(); // 201 = created, 409 = already exists
        } else {
          reject(new Error(`Cannot create folder: ${res.statusCode}`));
        }
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Yandex create-folder завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── Google Drive ──────────────────────────────────────────────────────────

  private async uploadToGoogle(
    localPath: string,
    siteFolder: string,
    onProgress?: (msg: string) => void
  ): Promise<CloudUploadInfo> {
    const creds = await this.getGoogleCredentials();
    if (!creds) {throw new Error('Google Drive is not configured. Add your credentials first.');}

    onProgress?.('Refreshing Google token...');
    const accessToken = await this.googleRefreshToken(creds);

    // Ensure folder exists
    const folderId = await this.googleEnsureFolder(accessToken, creds.folderId, siteFolder);

    // Upload file
    const fileName = path.basename(localPath);
    const fileId = await this.googleUploadFile(accessToken, localPath, fileName, folderId);

    return {
      provider: 'google',
      remotePath: fileId,
      uploadedAt: new Date().toISOString(),
    };
  }

  private googleRefreshToken(creds: GoogleCredentials): Promise<string> {
    return new Promise((resolve, reject) => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
        client_id: creds.clientId,
        client_secret: creds.clientSecret,
      }).toString();

      const options: https.RequestOptions = {
        hostname: 'oauth2.googleapis.com',
        path: '/token',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.access_token) {
              resolve(json.access_token);
            } else {
              reject(new Error(`Google token refresh failed: ${json.error_description ?? data}`));
            }
          } catch {
            reject(new Error('Invalid Google OAuth response'));
          }
        });
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Google token refresh завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async googleEnsureFolder(
    accessToken: string,
    parentId: string | undefined,
    siteFolder: string
  ): Promise<string> {
    // Find or create "WPDock" folder
    const wpdockFolderId = await this.googleFindOrCreateFolder(
      accessToken,
      'WPDock',
      parentId ?? 'root'
    );
    // Find or create site subfolder (по имени проекта)
    return this.googleFindOrCreateFolder(accessToken, siteFolder, wpdockFolderId);
  }

  private async googleFindOrCreateFolder(
    accessToken: string,
    name: string,
    parentId: string
  ): Promise<string> {
    // Search for existing folder
    const searchResp = await this.googleApiRequest(
      accessToken,
      'GET',
      `/drive/v3/files?q=${encodeURIComponent(
        `name='${name}' and mimeType='application/vnd.google-apps.folder' and '${parentId}' in parents and trashed=false`
      )}&fields=files(id,name)`
    );

    if (searchResp.files && searchResp.files.length > 0) {
      return searchResp.files[0].id;
    }

    // Create folder
    const createResp = await this.googleApiRequest(accessToken, 'POST', '/drive/v3/files', {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    });

    return createResp.id;
  }

  private googleUploadFile(
    accessToken: string,
    localPath: string,
    fileName: string,
    folderId: string
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const fileContent = fs.readFileSync(localPath);
      const meta = JSON.stringify({ name: fileName, parents: [folderId] });
      const boundary = '-------WPDockBoundary';
      const delimiter = `\r\n--${boundary}\r\n`;
      const closeDelimiter = `\r\n--${boundary}--`;

      const body = Buffer.concat([
        Buffer.from(
          `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${meta}${delimiter}Content-Type: application/zip\r\n\r\n`
        ),
        fileContent,
        Buffer.from(closeDelimiter),
      ]);

      const options: https.RequestOptions = {
        hostname: 'www.googleapis.com',
        path: '/upload/drive/v3/files?uploadType=multipart&fields=id',
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': `multipart/related; boundary="${boundary}"`,
          'Content-Length': body.length,
        },
      };

      Logger.log(`[CloudBackup] googleUploadFile START size=${body.length} bytes`);
      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.id) {
              Logger.log('[CloudBackup] googleUploadFile DONE');
              resolve(json.id);
            } else {
              reject(new Error(`Google Drive upload failed: ${data}`));
            }
          } catch {
            reject(new Error('Invalid Google Drive response'));
          }
        });
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Google upload timed out (нет ответа ${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private googleApiRequest(
    accessToken: string,
    method: string,
    apiPath: string,
    body?: object
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const options: https.RequestOptions = {
        hostname: 'www.googleapis.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data));
          } catch {
            resolve({});
          }
        });
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Google API запрос завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      if (bodyStr) {req.write(bodyStr);}
      req.end();
    });
  }

  // ── List & Download ───────────────────────────────────────────────────────

  async listFiles(provider: CloudProvider, siteFolder?: string): Promise<CloudFileInfo[]> {
    if (provider === 'yandex') {
      return this.listYandexFiles(siteFolder);
    } else {
      return this.listGoogleFiles(siteFolder);
    }
  }

  async downloadFile(provider: CloudProvider, remotePath: string, destPath: string): Promise<void> {
    if (provider === 'yandex') {
      return this.downloadYandexFile(remotePath, destPath);
    } else {
      return this.downloadGoogleFile(remotePath, destPath);
    }
  }

  /** Удаляет файл в облаке (remotePath = путь для Yandex, fileId для Google). */
  async deleteFile(provider: CloudProvider, remotePath: string): Promise<void> {
    if (provider === 'yandex') {
      return this.deleteYandexFile(remotePath);
    } else {
      return this.deleteGoogleFile(remotePath);
    }
  }

  private async deleteYandexFile(remotePath: string): Promise<void> {
    const creds = await this.getYandexCredentials();
    if (!creds) {throw new Error('Yandex Disk не настроен');}
    const token = await this.getValidYandexAccessToken(creds);

    return new Promise((resolve, reject) => {
      const encodedPath = encodeURIComponent(remotePath);
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources?path=${encodedPath}&permanently=true`,
        method: 'DELETE',
        headers: { Authorization: `OAuth ${token}` },
      };
      const req = https.request(options, (res) => {
        res.resume();
        // 204 = удалён сразу, 202 = поставлен в очередь, 404 = уже нет.
        if (res.statusCode === 204 || res.statusCode === 202 || res.statusCode === 404) {
          resolve();
        } else {
          reject(new Error(`Yandex delete error ${res.statusCode}`));
        }
      });
      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Yandex delete завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async deleteGoogleFile(fileId: string): Promise<void> {
    const creds = await this.getGoogleCredentials();
    if (!creds) {throw new Error('Google Drive не настроен');}
    const accessToken = await this.googleRefreshToken(creds);

    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'www.googleapis.com',
        path: `/drive/v3/files/${encodeURIComponent(fileId)}`,
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
      };
      const req = https.request(options, (res) => {
        res.resume();
        if ((res.statusCode && res.statusCode >= 200 && res.statusCode < 300) || res.statusCode === 404) {
          resolve();
        } else {
          reject(new Error(`Google delete error ${res.statusCode}`));
        }
      });
      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Google delete завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async listYandexFiles(siteFolder?: string): Promise<CloudFileInfo[]> {
    const creds = await this.getYandexCredentials();
    if (!creds) {throw new Error('Yandex Disk не настроен');}
    const token = await this.getValidYandexAccessToken(creds);

    const base = creds.folder.replace(/\/$/, '');
    // Если задан сайт — листим его папку; иначе используем плоский список всех
    // файлов на Диске (фильтруя по базовой папке).
    if (siteFolder) {
      return this.yandexListFolder(token, `${base}/${siteFolder}`);
    }
    return this.yandexListAllUnder(token, base);
  }

  /** Листит ZIP-файлы в одной папке Yandex.Disk (без рекурсии). */
  private yandexListFolder(token: string, folder: string): Promise<CloudFileInfo[]> {
    return new Promise((resolve, reject) => {
      const encodedPath = encodeURIComponent(folder);
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources?path=${encodedPath}&fields=_embedded.items(path,name,size,modified,type)&limit=200`,
        method: 'GET',
        headers: { Authorization: `OAuth ${token}` },
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 404) { resolve([]); return; }
          if (res.statusCode !== 200) { reject(new Error(`Yandex API ${res.statusCode}: ${body}`)); return; }
          try {
            const json = JSON.parse(body);
            const items: CloudFileInfo[] = [];
            const recurse = (list: any[]) => {
              for (const item of list ?? []) {
                if (item.type === 'file' && item.name.endsWith('.zip')) {
                  items.push({
                    name: item.name,
                    path: item.path,
                    size: item.size ?? 0,
                    modifiedAt: item.modified ?? new Date().toISOString(),
                    provider: 'yandex',
                  });
                }
              }
            };
            recurse(json._embedded?.items);
            resolve(items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
          } catch {
            reject(new Error('Invalid Yandex API response'));
          }
        });
      });

      req.on('error', reject);
      req.end();
    });
  }

  /** Плоский список всех ZIP внутри базовой папки WPDock (по всем сайтам). */
  private yandexListAllUnder(token: string, base: string): Promise<CloudFileInfo[]> {
    const prefix = `disk:${base}/`;
    return new Promise((resolve, reject) => {
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources/files?fields=items(path,name,size,modified,type,media_type)&limit=1000`,
        method: 'GET',
        headers: { Authorization: `OAuth ${token}` },
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode === 404) { resolve([]); return; }
          if (res.statusCode !== 200) { reject(new Error(`Yandex API ${res.statusCode}: ${body}`)); return; }
          try {
            const json = JSON.parse(body);
            const items: CloudFileInfo[] = (json.items ?? [])
              .filter((it: any) => it.type === 'file' && it.name?.endsWith('.zip') && (it.path ?? '').startsWith(prefix))
              .map((it: any): CloudFileInfo => ({
                name: it.name,
                path: it.path,
                size: it.size ?? 0,
                modifiedAt: it.modified ?? new Date().toISOString(),
                provider: 'yandex',
              }));
            resolve(items.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt)));
          } catch {
            reject(new Error('Invalid Yandex API response'));
          }
        });
      });
      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Yandex list завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.end();
    });
  }

  private async downloadYandexFile(remotePath: string, destPath: string): Promise<void> {
    const creds = await this.getYandexCredentials();
    if (!creds) {throw new Error('Yandex Disk не настроен');}
    const token = await this.getValidYandexAccessToken(creds);

    // Step 1: get download URL
    const downloadHref: string = await new Promise((resolve, reject) => {
      const encodedPath = encodeURIComponent(remotePath);
      const options: https.RequestOptions = {
        hostname: 'cloud-api.yandex.net',
        path: `/v1/disk/resources/download?path=${encodedPath}`,
        method: 'GET',
        headers: { Authorization: `OAuth ${token}` },
      };
      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', (d) => (body += d));
        res.on('end', () => {
          if (res.statusCode !== 200) { reject(new Error(`Yandex download URL error ${res.statusCode}`)); return; }
          try { resolve(JSON.parse(body).href); } catch { reject(new Error('Invalid Yandex response')); }
        });
      });
      req.on('error', reject);
      req.end();
    });

    // Step 2: stream file
    await this.streamUrlToFile(downloadHref, destPath);
  }

  private async getValidYandexAccessToken(creds: YandexCredentials): Promise<string> {
    if (creds.refreshToken && creds.clientId && creds.clientSecret) {
      const refreshed = await this.yandexRefreshToken(creds);
      const next: YandexCredentials = {
        ...creds,
        token: refreshed.access_token,
        accessToken: refreshed.access_token,
        refreshToken: refreshed.refresh_token ?? creds.refreshToken,
        expiresAt: refreshed.expires_in
          ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
          : creds.expiresAt,
      };
      await this.saveYandexCredentials(next);
      return next.accessToken ?? next.token ?? '';
    }

    const tokenValue = creds.accessToken ?? creds.token ?? '';
    if (!tokenValue) {throw new Error('Yandex OAuth token не найден');}
    return tokenValue;
  }

  private yandexRefreshToken(creds: YandexCredentials): Promise<{ access_token?: string; refresh_token?: string; expires_in?: number; error?: string; error_description?: string }> {
    return new Promise((resolve, reject) => {
      if (!creds.refreshToken || !creds.clientId || !creds.clientSecret) {
        reject(new Error('Yandex refresh token не настроен'));
        return;
      }

      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: creds.refreshToken,
      }).toString();

      const auth = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
      const options: https.RequestOptions = {
        hostname: 'oauth.yandex.com',
        path: '/token',
        method: 'POST',
        headers: {
          Authorization: `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) {
              reject(new Error(json.error_description ?? json.error));
              return;
            }
            resolve(json);
          } catch {
            reject(new Error('Invalid Yandex refresh response'));
          }
        });
      });

      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        req.destroy(new Error(`Yandex token refresh завис (${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  private async listGoogleFiles(siteFolder?: string): Promise<CloudFileInfo[]> {
    const creds = await this.getGoogleCredentials();
    if (!creds) {throw new Error('Google Drive не настроен');}

    const accessToken = await this.googleRefreshToken(creds);

    // Find WPDock folder
    const wpdockSearch = await this.googleApiRequest(
      accessToken,
      'GET',
      `/drive/v3/files?q=${encodeURIComponent(
        `name='WPDock' and mimeType='application/vnd.google-apps.folder' and trashed=false`
      )}&fields=files(id)`
    );

    if (!wpdockSearch.files || wpdockSearch.files.length === 0) {return [];}
    const wpdockId = wpdockSearch.files[0].id;

    // Папка, внутри которой ищем ZIP: либо подпапка сайта, либо весь WPDock.
    let parentId = wpdockId;
    if (siteFolder) {
      const siteSearch = await this.googleApiRequest(
        accessToken,
        'GET',
        `/drive/v3/files?q=${encodeURIComponent(
          `name='${siteFolder}' and mimeType='application/vnd.google-apps.folder' and '${wpdockId}' in parents and trashed=false`
        )}&fields=files(id)`
      );
      if (!siteSearch.files || siteSearch.files.length === 0) {return [];}
      parentId = siteSearch.files[0].id;
    }

    // List ZIP files under the chosen folder
    const resp = await this.googleApiRequest(
      accessToken,
      'GET',
      `/drive/v3/files?q=${encodeURIComponent(
        `'${parentId}' in parents and name contains '.zip' and trashed=false`
      )}&fields=files(id,name,size,modifiedTime)&orderBy=modifiedTime desc&pageSize=100`
    );

    return (resp.files ?? []).map((f: any): CloudFileInfo => ({
      name: f.name,
      path: f.id,
      size: parseInt(f.size ?? '0', 10),
      modifiedAt: f.modifiedTime ?? new Date().toISOString(),
      provider: 'google',
    }));
  }

  private async downloadGoogleFile(fileId: string, destPath: string): Promise<void> {
    const creds = await this.getGoogleCredentials();
    if (!creds) {throw new Error('Google Drive не настроен');}

    const accessToken = await this.googleRefreshToken(creds);
    const downloadUrl = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`;

    await this.streamUrlToFile(downloadUrl, destPath, {
      Authorization: `Bearer ${accessToken}`,
    });
  }

  private streamUrlToFile(
    fileUrl: string,
    destPath: string,
    extraHeaders?: Record<string, string>
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new url.URL(fileUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { ...(extraHeaders ?? {}) },
      };

      const req = lib.request(options, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          // Follow redirect
          this.streamUrlToFile(res.headers.location, destPath, extraHeaders).then(resolve, reject);
          return;
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`Download failed with status ${res.statusCode}`));
          return;
        }
        const out = fs.createWriteStream(destPath);
        res.pipe(out);
        out.on('finish', () => { out.close(); resolve(); });
        out.on('error', reject);
      });

      req.on('error', reject);
      req.end();
    });
  }

  // ── Generic HTTP PUT for file upload ─────────────────────────────────────

  private httpPutFile(uploadUrl: string, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new url.URL(uploadUrl);
      const isHttps = parsed.protocol === 'https:';
      const lib = isHttps ? https : http;
      const fileSize = fs.statSync(filePath).size;
      Logger.log(`[CloudBackup] httpPutFile START host=${parsed.hostname} size=${fileSize} bytes`);

      const options: https.RequestOptions = {
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: parsed.pathname + parsed.search,
        method: 'PUT',
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': fileSize,
        },
      };

      let settled = false;
      let readStream: fs.ReadStream | null = null;
      const finish = (err?: Error) => {
        if (settled) {return;}
        settled = true;
        try { readStream?.destroy(); } catch {}
        if (err) {
          Logger.log(`[CloudBackup] httpPutFile ERROR: ${err.message}`);
          try { req.destroy(); } catch {}
          reject(err);
        } else {
          Logger.log('[CloudBackup] httpPutFile DONE');
          resolve();
        }
      };

      const req = lib.request(options, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.on('end', () => finish());
        } else {
          finish(new Error(`Upload failed with status ${res.statusCode}`));
        }
      });

      // Idle-таймаут: если соединение зависло без передачи данных — рвём.
      req.setTimeout(NET_IDLE_TIMEOUT_MS, () => {
        finish(new Error(`Upload timed out (нет ответа ${NET_IDLE_TIMEOUT_MS / 1000}s)`));
      });
      req.on('error', (err) => finish(err));

      // Прогресс выгрузки, чтобы большой ZIP не выглядел как зависание.
      let uploaded = 0;
      let lastLog = Date.now();
      readStream = fs.createReadStream(filePath);
      readStream.on('error', (err) => finish(err));
      readStream.on('data', (chunk) => {
        uploaded += chunk.length;
        if (Date.now() - lastLog > 2000) {
          lastLog = Date.now();
          Logger.log(
            `[CloudBackup] upload progress ${Math.round((uploaded / fileSize) * 100)}% ` +
            `(${Math.round(uploaded / 1048576)}/${Math.round(fileSize / 1048576)} MB)`
          );
        }
      });
      readStream.pipe(req);
    });
  }
}
