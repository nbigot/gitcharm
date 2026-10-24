import { basename } from 'node:path';
import * as vscode from 'vscode';
import { createGitRunner, type GitRunner } from './git/exec';
import { Repository } from './git/repository';
import type { GitApi, GitApiRepository, GitExtension } from './gitExtension';
import type { RepoSummary } from './shared/types';

/**
 * Tracks the git repositories of the workspace and which one is "current".
 * Uses the built-in git extension for discovery, change events and
 * authenticated network operations; falls back to plain CLI discovery.
 */
export class RepoManager implements vscode.Disposable {
  private readonly repos = new Map<string, Repository>();
  private readonly apiRepos = new Map<string, GitApiRepository>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingChanges = new Map<string, NodeJS.Timeout>();
  private run: GitRunner;
  private api?: GitApi;
  private currentRoot?: string;

  private readonly changedRepos = new vscode.EventEmitter<void>();
  /** The set of repositories or the current repository changed. */
  readonly onDidChangeRepositories = this.changedRepos.event;

  private readonly changedState = new vscode.EventEmitter<Repository>();
  /** Something in a repository changed (working tree, index, refs). Debounced. */
  readonly onDidChangeState = this.changedState.event;

  constructor(private readonly log?: (line: string) => void) {
    this.run = createGitRunner('git', log);
  }

  async initialize(): Promise<void> {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension) {
      try {
        const exports = extension.isActive ? extension.exports : await extension.activate();
        if (exports.enabled) {
          this.api = exports.getAPI(1);
        }
      } catch {
        // Built-in git disabled or broken: fall back to CLI discovery.
      }
    }

    if (this.api) {
      const api = this.api;
      this.run = createGitRunner(api.git.path || 'git', this.log);
      this.disposables.push(
        api.onDidOpenRepository((r) => this.addApiRepository(r)),
        api.onDidCloseRepository((r) => this.removeRepository(r.rootUri.fsPath)),
      );
      api.repositories.forEach((r) => this.addApiRepository(r));
    } else {
      await this.discoverWithCli();
      const watcher = vscode.workspace.createFileSystemWatcher('**/*');
      const changed = (uri: vscode.Uri) => {
        for (const root of this.repos.keys()) {
          if (uri.fsPath.startsWith(root)) {
            this.scheduleChange(root);
          }
        }
      };
      this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
    }

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const repo = editor && this.repositoryFor(editor.document.uri);
        if (repo && repo.root !== this.currentRoot) {
          this.setCurrent(repo.root);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!this.api) {
          void this.discoverWithCli();
        }
      }),
    );
  }

  get repositories(): Repository[] {
    return [...this.repos.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get summaries(): RepoSummary[] {
    return this.repositories.map((r) => ({ root: r.root, name: basename(r.root) }));
  }

  get current(): Repository | undefined {
    return this.currentRoot ? this.repos.get(this.currentRoot) : undefined;
  }

  setCurrent(root: string): void {
    if (this.repos.has(root) && root !== this.currentRoot) {
      this.currentRoot = root;
      this.changedRepos.fire();
    }
  }

  get(root: string): Repository | undefined {
    return this.repos.get(root);
  }

  /** Repository containing the given file, preferring the innermost one. */
  repositoryFor(uri: vscode.Uri): Repository | undefined {
    const path = uri.fsPath;
    return this.repositories
      .filter((r) => path === r.root || path.startsWith(r.root.endsWith('/') ? r.root : r.root + '/'))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  /** The built-in git extension's handle for a repository, if available. */
  apiRepository(repo: Repository): GitApiRepository | undefined {
    return this.apiRepos.get(repo.root);
  }

  /** Signals that GitCharm itself changed a repository. */
  notifyChanged(repo: Repository): void {
    this.scheduleChange(repo.root, 50);
  }

  private addApiRepository(apiRepo: GitApiRepository): void {
    const root = apiRepo.rootUri.fsPath;
    this.apiRepos.set(root, apiRepo);
    this.disposables.push(apiRepo.state.onDidChange(() => this.scheduleChange(root)));
    this.addRepository(root);
  }

  private addRepository(root: string): void {
    if (this.repos.has(root)) {
      return;
    }
    this.repos.set(root, new Repository(root, this.run));
    if (!this.currentRoot) {
      const active = vscode.window.activeTextEditor?.document.uri;
      this.currentRoot = active && this.repositoryFor(active) ? this.repositoryFor(active)!.root : root;
    }
    this.changedRepos.fire();
  }

  private removeRepository(root: string): void {
    this.repos.delete(root);
    this.apiRepos.delete(root);
    if (this.currentRoot === root) {
      this.currentRoot = this.repositories[0]?.root;
    }
    this.changedRepos.fire();
  }

  private async discoverWithCli(): Promise<void> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      try {
        const { stdout } = await this.run(folder.uri.fsPath, ['rev-parse', '--show-toplevel']);
        this.addRepository(vscode.Uri.file(stdout.trim()).fsPath);
      } catch {
        // Not a repository.
      }
    }
  }

  private scheduleChange(root: string, delay = 300): void {
    clearTimeout(this.pendingChanges.get(root));
    this.pendingChanges.set(
      root,
      setTimeout(() => {
        this.pendingChanges.delete(root);
        const repo = this.repos.get(root);
        if (repo) {
          this.changedState.fire(repo);
        }
      }, delay),
    );
  }

  dispose(): void {
    this.pendingChanges.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
    this.changedRepos.dispose();
    this.changedState.dispose();
  }
}
