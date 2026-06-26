/**
 * SslService — manages SSL certificates for local WordPress sites via mkcert.
 * mkcert creates locally-trusted development certificates without self-signed warnings.
 */
import * as cp from 'child_process';
import * as fs from 'fs';
import * as https from 'https';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';

export interface SiteCert {
  certPath: string;
  keyPath:  string;
}

export class SslService {
  private readonly certsDir: string;
  private readonly binDir: string;
  private static readonly CA_INSTALLED_KEY = 'wpdock.ssl.caInstalled';

  constructor(private context: vscode.ExtensionContext) {
    this.certsDir = path.join(context.globalStorageUri.fsPath, 'certs');
    this.binDir   = path.join(context.globalStorageUri.fsPath, 'bin');
    fs.mkdirSync(this.certsDir, { recursive: true });
    fs.mkdirSync(this.binDir,   { recursive: true });
  }

  // ── mkcert availability ───────────────────────────────────────────────────

  /** Path to the locally downloaded mkcert binary (Windows only). */
  private get localMkcertPath(): string {
    return path.join(this.binDir, 'mkcert.exe');
  }

  /**
   * Returns the mkcert executable to use:
   * - 'mkcert' if available in PATH
   * - full path to downloaded binary if it exists
   * - null if not available
   */
  private async getMkcertExe(): Promise<string | null> {
    const inPath = await new Promise<boolean>((resolve) => {
      cp.exec('mkcert --version', (err) => resolve(!err));
    });
    if (inPath) {return 'mkcert';}

    if (os.platform() === 'win32' && fs.existsSync(this.localMkcertPath)) {
      return `"${this.localMkcertPath}"`;
    }
    return null;
  }

  /** Returns true if mkcert is available (in PATH or locally downloaded). */
  async isMkcertAvailable(): Promise<boolean> {
    return (await this.getMkcertExe()) !== null;
  }

  /**
   * Ensures mkcert is installed.
   * Windows: tries winget → falls back to direct GitHub download.
   * macOS: brew install mkcert.
   * Linux: shows manual install instructions.
   */
  async ensureMkcert(): Promise<void> {
    if (await this.isMkcertAvailable()) {return;}

    const platform = os.platform();

    const choice = await vscode.window.showInformationMessage(
      'Для SSL необходим mkcert. Установить автоматически?',
      'Установить',
      'Отмена'
    );
    if (choice !== 'Установить') {
      throw new Error('Установка mkcert отменена пользователем.');
    }

    if (platform === 'win32') {
      await this.installMkcertWindows();
    } else if (platform === 'darwin') {
      await this.exec('brew install mkcert');
    } else {
      throw new Error(
        'mkcert не найден. Установите его вручную: https://github.com/FiloSottile/mkcert#installation'
      );
    }

    if (!(await this.isMkcertAvailable())) {
      throw new Error('mkcert установлен, но не найден. Перезапустите VS Code и попробуйте снова.');
    }
  }

  /**
   * Windows: tries winget first; on failure downloads the binary directly
   * from GitHub Releases into the extension's bin directory.
   */
  private async installMkcertWindows(): Promise<void> {
    // Try winget
    try {
      await this.exec(
        'winget install FiloSottile.mkcert --silent --accept-source-agreements --accept-package-agreements',
        undefined,
        30_000
      );
      // winget succeeded — mkcert should now be in PATH
      return;
    } catch {
      // winget failed (not available, UAC blocked, etc.) — fall through
    }

    // Fallback: download mkcert.exe from GitHub Releases
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Загрузка mkcert…', cancellable: false },
      async (progress) => {
        progress.report({ message: 'Получение последней версии…' });
        const downloadUrl = await this.getMkcertDownloadUrl();
        progress.report({ message: 'Загрузка бинарника…' });
        await this.downloadFile(downloadUrl, this.localMkcertPath);
      }
    );
  }

  /** Resolves the mkcert Windows amd64 download URL via GitHub API. */
  private getMkcertDownloadUrl(): Promise<string> {
    return new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.github.com',
        path: '/repos/FiloSottile/mkcert/releases/latest',
        headers: { 'User-Agent': 'wpdock-vscode-extension' },
      };
      https.get(options, (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            const asset = (json.assets as Array<{ name: string; browser_download_url: string }>)
              ?.find((a) => a.name.includes('windows-amd64'));
            if (!asset) {
              reject(new Error('Не удалось найти mkcert для Windows в релизах GitHub.'));
            } else {
              resolve(asset.browser_download_url);
            }
          } catch (e) {
            reject(new Error('Не удалось разобрать ответ GitHub API.'));
          }
        });
        res.on('error', reject);
      }).on('error', reject);
    });
  }

  /** Downloads a URL to a local file, following redirects. */
  private downloadFile(url: string, dest: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const doGet = (currentUrl: string) => {
        const parsedUrl = new URL(currentUrl);
        https.get({ hostname: parsedUrl.hostname, path: parsedUrl.pathname + parsedUrl.search, headers: { 'User-Agent': 'wpdock-vscode-extension' } }, (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            doGet(res.headers.location!);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`Ошибка загрузки mkcert: HTTP ${res.statusCode}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(() => resolve()));
          file.on('error', (e) => { fs.unlink(dest, () => {}); reject(e); });
        }).on('error', reject);
      };
      doGet(url);
    });
  }

  /**
   * Installs the mkcert local CA into the system trust store.
   * Requires admin/sudo — VS Code will prompt for elevation.
   */
  async installCA(force = false): Promise<void> {
    if (!force && this.context.globalState.get<boolean>(SslService.CA_INSTALLED_KEY)) {
      return;
    }

    await this.ensureMkcert();
    const exe = await this.getMkcertExe();
    // Unset JAVA_HOME so mkcert skips the Java keystore (cacerts), which
    // lives in Program Files and requires admin rights on Windows.
    const env = { ...process.env, JAVA_HOME: '' };
    await this.exec(`${exe} -install`, undefined, 60_000, env);
    await this.context.globalState.update(SslService.CA_INSTALLED_KEY, true);
  }

  /**
   * Generates a certificate for the given domain (and localhost / 127.0.0.1).
   * Returns {certPath, keyPath}.
   */
  async generateSiteCert(domain: string): Promise<SiteCert> {
    await this.ensureMkcert();
    await this.installCA();

    const exe      = await this.getMkcertExe();
    const safe     = domain.replace(/[^a-z0-9.-]/gi, '_');
    const certPath = path.join(this.certsDir, `${safe}.pem`);
    const keyPath  = path.join(this.certsDir, `${safe}-key.pem`);

    // Always regenerate to ensure cert is up to date
    const args = `${exe} -cert-file "${certPath}" -key-file "${keyPath}" "${domain}" localhost 127.0.0.1`;
    await this.exec(args, this.certsDir);

    return { certPath, keyPath };
  }

  /** Returns cert paths if they already exist for the given domain. */
  getCachedCert(domain: string): SiteCert | null {
    const safe     = domain.replace(/[^a-z0-9.-]/gi, '_');
    const certPath = path.join(this.certsDir, `${safe}.pem`);
    const keyPath  = path.join(this.certsDir, `${safe}-key.pem`);
    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      return { certPath, keyPath };
    }
    return null;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private exec(command: string, cwd?: string, timeout = 60_000, env?: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(command, { cwd, timeout, env }, (err, stdout, stderr) => {
        if (err) {reject(new Error(stderr || err.message));}
        else {resolve(stdout);}
      });
    });
  }
}
