import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { WPSite } from '../types';
import { Logger } from '../utils/logger';

interface LiveInstance {
  bs: any;
  watcher: any;
  url: string;
}

export class LivePreviewService {
  private instances: Map<string, LiveInstance> = new Map();

  private ensureBrowserSyncTemplateCompat(): void {
    const outDir = path.resolve(__dirname, '..');
    const templatesDir = path.resolve(__dirname, '..', 'templates');
    const requiredFiles = [
      'sync-options.html',
      'script-tags.html',
      'script-tags-simple.html',
      'cli-template.js',
      'connector.tmpl',
      'config.item.tmpl',
      'config.tmpl',
      'inline.template.tmpl',
      'plugin.item.tmpl',
      'plugin.tmpl',
    ];

    try {
      if (!fs.existsSync(templatesDir)) {
        return;
      }

      for (const fileName of requiredFiles) {
        const source = path.join(templatesDir, fileName);
        const target = path.join(outDir, fileName);
        if (fs.existsSync(source) && !fs.existsSync(target)) {
          fs.copyFileSync(source, target);
        }
      }

      const sourceDirectives = path.join(templatesDir, 'directives');
      const targetDirectives = path.join(outDir, 'directives');
      if (fs.existsSync(sourceDirectives) && !fs.existsSync(targetDirectives)) {
        fs.mkdirSync(targetDirectives, { recursive: true });
        for (const entry of fs.readdirSync(sourceDirectives)) {
          const source = path.join(sourceDirectives, entry);
          const target = path.join(targetDirectives, entry);
          if (fs.statSync(source).isFile()) {
            fs.copyFileSync(source, target);
          }
        }
      }
    } catch (err) {
      Logger.error('[LivePreview] template compatibility copy failed', err);
    }
  }

  private createBrowserSyncInstance(): any {
    // Ленивая загрузка тяжёлого browser-sync только при старте Live Preview.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const browserSyncModule = require('browser-sync');
    const createFn = browserSyncModule?.create ?? browserSyncModule?.default?.create;

    if (typeof createFn === 'function') {
      return createFn();
    }

    const directInstance = browserSyncModule?.init ? browserSyncModule : browserSyncModule?.default;
    if (directInstance?.init && directInstance?.reload) {
      return directInstance;
    }

    throw new Error('browser-sync export is incompatible: create/init not found');
  }

  async start(site: WPSite, siteUrl?: string): Promise<string> {
    const proxyTarget = siteUrl ?? `http://localhost:${site.port}`;
    Logger.log(`[LivePreview] start: "${site.name}" proxying ${proxyTarget}`);
    if (this.instances.has(site.id)) {
      this.stop(site.id);
    }

    this.ensureBrowserSyncTemplateCompat();
    const bs = this.createBrowserSyncInstance();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const chokidar = require('chokidar');

    return new Promise((resolve, reject) => {
      bs.init(
        {
          proxy: proxyTarget,
          port: this.getPreviewPort(),
          open: false,
          notify: true,
          ui: false,
          logLevel: 'silent',
          ghostMode: false,
          injectChanges: true,
          files: false, // we control watching manually
        },
        (err: any, bsInstance: any) => {
          if (err) {
            Logger.error(`[LivePreview] browser-sync init failed for "${site.name}"`, err);
            reject(err);
            return;
          }

          const url = bsInstance.getOption('urls').get('local');

          // Watch wp-content files
          const publicContentPath = path.join(site.path, 'public', 'wp-content');
          const rootContentPath = path.join(site.path, 'wp-content');
          const wpContentPath = fs.existsSync(publicContentPath) ? publicContentPath : rootContentPath;
          const watcher = chokidar.watch(wpContentPath, {
            ignored: /(^|[/\\])\..|node_modules|cache/,
            persistent: true,
            ignoreInitial: true,
            usePolling: false,
            awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
          });

          watcher.on('change', (filePath: string) => {
            const ext = path.extname(filePath).toLowerCase();
            if (ext === '.css') {
              // CSS: inject without reload
              bs.reload('*.css');
            } else if (['.js'].includes(ext)) {
              bs.reload();
            } else if (['.php', '.html', '.twig'].includes(ext)) {
              bs.reload();
            }
          });

          Logger.log(`[LivePreview] started: "${site.name}" → ${url}`);
          this.instances.set(site.id, { bs, watcher, url });
          resolve(url);
        }
      );
    });
  }

  async stop(siteId: string): Promise<void> {
    const instance = this.instances.get(siteId);
    if (!instance) {return;}
    try {
      await Promise.resolve(instance.watcher.close());
      try { instance.bs.exit(); } catch { /* ignore */ }
      // Give BrowserSync sockets a short tick to release Windows handles.
      await new Promise((resolve) => setTimeout(resolve, 250));
    } catch (err) {
      Logger.error(`[LivePreview] stop failed for siteId=${siteId}`, err);
    }
    Logger.log(`[LivePreview] stopped siteId=${siteId}`);
    this.instances.delete(siteId);
  }

  isRunning(siteId: string): boolean {
    return this.instances.has(siteId);
  }

  getUrl(siteId: string): string | undefined {
    return this.instances.get(siteId)?.url;
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.instances.keys()]) {
      await this.stop(id);
    }
  }

  private getPreviewPort(): number {
    const val = vscode.workspace.getConfiguration('wpdock').get('livePreviewPort');
    return typeof val === 'number' ? val : 3000;
  }
}
