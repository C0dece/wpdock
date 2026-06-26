import * as vscode from 'vscode';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DockerStatus } from '../types';

const DOCKER_DESKTOP_WIN_URL =
  'https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe';

export class DockerManager {
  private _dockerPath: string | null = null;

  constructor(private context: vscode.ExtensionContext) {}

  // ── Public API ────────────────────────────────────────────────────────────

  async ensureDockerAvailable(): Promise<boolean> {
    const status = await this.getStatus();
    if (status.available) {return true;}

    const choice = await vscode.window.showErrorMessage(
      'WPDock requires Docker Desktop to run local WordPress sites.',
      'Install Docker Desktop',
      'Learn More',
      'Cancel'
    );

    if (choice === 'Install Docker Desktop') {
      await this.installDocker();
    } else if (choice === 'Learn More') {
      vscode.env.openExternal(vscode.Uri.parse('https://docs.docker.com/desktop/'));
    }
    return false;
  }

  async getStatus(): Promise<DockerStatus> {
    const dockerPath = await this.findDockerPath();
    if (!dockerPath) {
      return { available: false, installRequired: true };
    }

    try {
      const version = await this.exec(dockerPath, ['version', '--format', '{{.Server.Version}}']);
      return { available: true, version: version.trim(), installRequired: false };
    } catch {
      // Docker is installed but daemon is not running
      return { available: false, installRequired: false };
    }
  }

  async runCompose(composeFile: string, args: string[]): Promise<string> {
    const dockerPath = await this.requireDocker();
    return this.exec(dockerPath, ['compose', '-f', composeFile, ...args]);
  }

  async getContainerStatus(containerName: string): Promise<'running' | 'stopped' | 'missing'> {
    try {
      const dockerPath = await this.requireDocker();
      const out = await this.exec(dockerPath, [
        'inspect',
        '--format',
        '{{.State.Status}}',
        containerName,
      ]);
      const status = out.trim();
      if (status === 'running') {return 'running';}
      return 'stopped';
    } catch {
      return 'missing';
    }
  }

  async startContainer(containerName: string): Promise<void> {
    const dockerPath = await this.requireDocker();
    await this.exec(dockerPath, ['start', containerName]);
  }

  async stopContainer(containerName: string): Promise<void> {
    const dockerPath = await this.requireDocker();
    await this.exec(dockerPath, ['stop', containerName]);
  }

  async removeContainer(containerName: string, force = false): Promise<void> {
    const dockerPath = await this.requireDocker();
    const args = ['rm', force ? '-f' : '', containerName].filter(Boolean);
    await this.exec(dockerPath, args);
  }

  // ── Docker installation ───────────────────────────────────────────────────

  private async installDocker(): Promise<void> {
    const platform = os.platform();

    if (platform === 'win32') {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: 'Downloading Docker Desktop...',
          cancellable: false,
        },
        async (progress) => {
          const installerPath = path.join(os.tmpdir(), 'DockerDesktopInstaller.exe');

          progress.report({ message: 'Downloading installer...' });
          await this.downloadFile(DOCKER_DESKTOP_WIN_URL, installerPath);

          progress.report({ message: 'Running installer (follow the prompts)...' });
          await this.execShell(`"${installerPath}" install --quiet`);

          vscode.window.showInformationMessage(
            'Docker Desktop installed! Please restart VS Code after Docker starts.',
            'OK'
          );
        }
      );
    } else if (platform === 'darwin') {
      vscode.env.openExternal(
        vscode.Uri.parse('https://docs.docker.com/desktop/install/mac-install/')
      );
    } else {
      vscode.env.openExternal(
        vscode.Uri.parse('https://docs.docker.com/desktop/install/linux-install/')
      );
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private async findDockerPath(): Promise<string | null> {
    if (this._dockerPath) {return this._dockerPath;}

    const config = vscode.workspace.getConfiguration('wpdock');
    const configured = config.get<string>('dockerPath');
    if (configured && configured !== 'auto' && fs.existsSync(configured)) {
      this._dockerPath = configured;
      return configured;
    }

    // Common paths
    const candidates =
      os.platform() === 'win32'
        ? [
            'C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe',
            'C:\\ProgramData\\DockerDesktop\\version-bin\\docker.exe',
            'docker',
          ]
        : ['/usr/local/bin/docker', '/usr/bin/docker', 'docker'];

    for (const candidate of candidates) {
      try {
        await this.exec(candidate, ['--version']);
        this._dockerPath = candidate;
        return candidate;
      } catch {
        continue;
      }
    }
    return null;
  }

  private async requireDocker(): Promise<string> {
    const p = await this.findDockerPath();
    if (!p) {throw new Error('Docker not found. Please install Docker Desktop.');}
    return p;
  }

  exec(cmd: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => {
        if (err) {reject(new Error(stderr || err.message));}
        else {resolve(stdout);}
      });
    });
  }

  private execShell(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      cp.exec(command, { timeout: 300000 }, (err, stdout, stderr) => {
        if (err) {reject(new Error(stderr || err.message));}
        else {resolve(stdout);}
      });
    });
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    // Use PowerShell's Invoke-WebRequest for reliable Windows download
    await this.execShell(
      `powershell -Command "Invoke-WebRequest -Uri '${url}' -OutFile '${dest}'"`
    );
  }
}
