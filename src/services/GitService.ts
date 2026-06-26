import * as path from 'path';
import * as fs from 'fs';
import * as https from 'https';
import simpleGit, { SimpleGit } from 'simple-git';
import { GitHubRepoInfo, GitHubUser } from '../types';

const WP_GITIGNORE = `# WordPress
wp-config.php
wp-content/uploads/
wp-content/cache/
wp-content/backup-db/
wp-content/advanced-cache.php
wp-content/wp-cache-config.php
*.log

# WPDock
docker-compose.yml
database.sql
.wpdock/

# General
.DS_Store
Thumbs.db
node_modules/
.env
`;

type RepoInfo = { repoInitialized: boolean; remoteUrl?: string; defaultBranch?: string; githubRepo?: string };

export class GitService {
  /**
   * Short-lived cache for getRepoInfo. The dashboard polls full state every few
   * seconds and getRepoInfo runs `git status` over the entire (large) WordPress
   * tree, so without this the UI refresh hammers `git` and starves the event loop.
   */
  private readonly repoInfoCache = new Map<string, { at: number; value: RepoInfo }>();
  private static readonly REPO_INFO_TTL_MS = 5_000;

  private getGit(repoPath: string): SimpleGit {
    return simpleGit(repoPath);
  }

  /** Drop cached repo info for a path (call after mutating the repo). */
  private invalidateRepoInfo(repoPath: string): void {
    this.repoInfoCache.delete(repoPath);
  }

  async initRepo(repoPath: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.init();

    const gitignorePath = path.join(repoPath, '.gitignore');
    if (!fs.existsSync(gitignorePath)) {
      fs.writeFileSync(gitignorePath, WP_GITIGNORE);
    }

    await git.add('.gitignore');
    await git.commit('Initial commit - WPDock project');
    this.invalidateRepoInfo(repoPath);
  }

  async isRepo(repoPath: string): Promise<boolean> {
    try {
      const git = this.getGit(repoPath);
      return await git.checkIsRepo();
    } catch {
      return false;
    }
  }

  async getStatus(repoPath: string): Promise<{
    branch: string;
    ahead: number;
    behind: number;
    modified: string[];
    staged: string[];
    untracked: string[];
  }> {
    const git = this.getGit(repoPath);
    const status = await git.status();
    return {
      branch: status.current ?? 'main',
      ahead: status.ahead,
      behind: status.behind,
      modified: status.modified,
      staged: status.staged,
      untracked: status.not_added,
    };
  }

  async stageAll(repoPath: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.add('.');
  }

  async commit(repoPath: string, message: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.commit(message);
  }

  async push(repoPath: string, remote = 'origin', branch?: string): Promise<void> {
    const git = this.getGit(repoPath);
    const status = await git.status();
    const b = branch ?? status.current ?? 'main';
    await git.push(remote, b);
  }

  async pull(repoPath: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.pull();
  }

  async addRemote(repoPath: string, name: string, url: string): Promise<void> {
    const git = this.getGit(repoPath);
    const remotes = await git.getRemotes();
    if (remotes.find((r) => r.name === name)) {
      await git.removeRemote(name);
    }
    await git.addRemote(name, url);
    this.invalidateRepoInfo(repoPath);
  }

  async getBranches(repoPath: string): Promise<string[]> {
    const git = this.getGit(repoPath);
    const result = await git.branchLocal();
    return result.all;
  }

  async createBranch(repoPath: string, name: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.checkoutLocalBranch(name);
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    const git = this.getGit(repoPath);
    await git.checkout(branch);
  }

  async getLogs(
    repoPath: string,
    limit = 10
  ): Promise<Array<{ hash: string; date: string; message: string; author: string }>> {
    const git = this.getGit(repoPath);
    const log = await git.log({ maxCount: limit });
    return log.all.map((l) => ({
      hash: l.hash.slice(0, 7),
      date: l.date,
      message: l.message,
      author: l.author_name,
    }));
  }


  async getRemoteUrl(repoPath: string, name = 'origin'): Promise<string | undefined> {
    const git = this.getGit(repoPath);
    try {
      const remotes = await git.getRemotes(true);
      const remote = remotes.find((item) => item.name === name);
      return remote?.refs?.push || remote?.refs?.fetch || undefined;
    } catch {
      return undefined;
    }
  }

  async getRepoInfo(repoPath: string): Promise<RepoInfo> {
    const cached = this.repoInfoCache.get(repoPath);
    if (cached && Date.now() - cached.at < GitService.REPO_INFO_TTL_MS) {
      return cached.value;
    }

    const value = await this.computeRepoInfo(repoPath);
    this.repoInfoCache.set(repoPath, { at: Date.now(), value });
    return value;
  }

  private async computeRepoInfo(repoPath: string): Promise<RepoInfo> {
    const repoInitialized = await this.isRepo(repoPath);
    if (!repoInitialized) {
      return { repoInitialized: false };
    }

    // Only the current branch is needed here — use a cheap rev-parse instead of
    // a full `git status`, which would scan the entire WordPress working tree.
    let defaultBranch = 'main';
    try {
      defaultBranch = (await this.getGit(repoPath).revparse(['--abbrev-ref', 'HEAD'])).trim() || 'main';
    } catch { /* detached/empty repo — keep default */ }

    const remoteUrl = await this.getRemoteUrl(repoPath);
    let githubRepo: string | undefined;
    if (remoteUrl) {
      const match = remoteUrl.match(/github\.com[:/](.+?)(?:\.git)?$/i);
      githubRepo = match?.[1];
    }
    return {
      repoInitialized: true,
      remoteUrl,
      defaultBranch,
      githubRepo,
    };
  }

  async createRepoAndLink(
    repoPath: string,
    token: string,
    name: string,
    description: string,
    isPrivate: boolean
  ): Promise<GitHubRepoInfo> {
    const repo = await this.createGitHubRepo(token, name, description, isPrivate);
    const isRepo = await this.isRepo(repoPath);
    if (!isRepo) {
      await this.initRepo(repoPath);
    }
    await this.addRemote(repoPath, 'origin', repo.cloneUrl);
    return repo;
  }

  async createGitHubActionsWorkflow(repoPath: string, deployConfig: {
    host: string;
    username: string;
    remotePath: string;
  }): Promise<void> {
    const workflowDir = path.join(repoPath, '.github', 'workflows');
    fs.mkdirSync(workflowDir, { recursive: true });

    const workflow = `name: Deploy to Production

on:
  push:
    branches: [main]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - name: Deploy via SFTP
        uses: burnett01/rsync-deployments@6.0.0
        with:
          switches: -avzr --delete --exclude='.git' --exclude='wp-config.php' --exclude='wp-content/uploads'
          path: ./
          remote_path: ${deployConfig.remotePath}
          remote_host: ${deployConfig.host}
          remote_user: ${deployConfig.username}
          remote_key: \${{ secrets.SSH_PRIVATE_KEY }}
`;
    fs.writeFileSync(path.join(workflowDir, 'deploy.yml'), workflow);
  }

  // ── GitHub API ────────────────────────────────────────────────────────────

  async getGitHubUser(token: string): Promise<GitHubUser> {
    const data = await this.githubRequest('GET', '/user', null, token);
    return {
      login: data.login,
      name: data.name ?? data.login,
      avatarUrl: data.avatar_url,
      publicRepos: data.public_repos,
    };
  }

  async listGitHubRepos(token: string): Promise<GitHubRepoInfo[]> {
    const data = await this.githubRequest('GET', '/user/repos?per_page=100&sort=updated', null, token);
    return (data as any[]).map((r) => ({
      id: r.id,
      name: r.name,
      fullName: r.full_name,
      url: r.html_url,
      cloneUrl: r.clone_url,
      sshUrl: r.ssh_url,
      isPrivate: r.private,
      description: r.description ?? '',
      defaultBranch: r.default_branch,
      stars: r.stargazers_count,
      updatedAt: r.updated_at,
    }));
  }

  async createGitHubRepo(
    token: string,
    name: string,
    description: string,
    isPrivate: boolean
  ): Promise<GitHubRepoInfo> {
    const data = await this.githubRequest(
      'POST',
      '/user/repos',
      { name, description, private: isPrivate, auto_init: false },
      token
    );
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      url: data.html_url,
      cloneUrl: data.clone_url,
      sshUrl: data.ssh_url,
      isPrivate: data.private,
      description: data.description ?? '',
      defaultBranch: data.default_branch,
      stars: data.stargazers_count,
      updatedAt: data.updated_at,
    };
  }

  async deleteGitHubRepo(token: string, owner: string, repo: string): Promise<void> {
    await this.githubRequest('DELETE', `/repos/${owner}/${repo}`, null, token);
  }

  async cloneGitHubRepo(cloneUrl: string, localPath: string, token?: string): Promise<void> {
    const git = simpleGit();
    // Inject token into HTTPS URL if provided
    let repoUrl = cloneUrl;
    if (token && cloneUrl.startsWith('https://')) {
      repoUrl = cloneUrl.replace('https://', `https://${token}@`);
    }
    fs.mkdirSync(localPath, { recursive: true });
    await git.clone(repoUrl, localPath);
  }

  async getGitHubRepoInfo(token: string, owner: string, repo: string): Promise<GitHubRepoInfo> {
    const data = await this.githubRequest('GET', `/repos/${owner}/${repo}`, null, token);
    return {
      id: data.id,
      name: data.name,
      fullName: data.full_name,
      url: data.html_url,
      cloneUrl: data.clone_url,
      sshUrl: data.ssh_url,
      isPrivate: data.private,
      description: data.description ?? '',
      defaultBranch: data.default_branch,
      stars: data.stargazers_count,
      updatedAt: data.updated_at,
    };
  }

  private githubRequest(
    method: string,
    apiPath: string,
    body: object | null,
    token: string
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const bodyStr = body ? JSON.stringify(body) : undefined;
      const options: https.RequestOptions = {
        hostname: 'api.github.com',
        path: apiPath,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'User-Agent': 'WPDock-Extension/1.0',
          Accept: 'application/vnd.github.v3+json',
          'Content-Type': 'application/json',
          ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (d) => (data += d));
        res.on('end', () => {
          if (res.statusCode === 204) {
            resolve(null); // no content (e.g. DELETE)
            return;
          }
          try {
            const json = JSON.parse(data);
            if (res.statusCode && res.statusCode >= 400) {
              reject(new Error(json.message ?? `GitHub API error ${res.statusCode}`));
            } else {
              resolve(json);
            }
          } catch {
            reject(new Error(`Invalid GitHub response: ${data}`));
          }
        });
      });

      req.on('error', reject);
      if (bodyStr) {req.write(bodyStr);}
      req.end();
    });
  }
}
