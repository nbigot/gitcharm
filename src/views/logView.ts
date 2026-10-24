import * as vscode from 'vscode';
import { errorText, type GitActions } from '../actions';
import { isCommitHash } from '../git/parsers';
import type { Repository } from '../git/repository';
import type { RepoManager } from '../repoManager';
import type { LogToExtension, LogToWebview } from '../shared/protocol';
import type { HeadInfo, LogFilter, Ref } from '../shared/types';
import { renderWebviewHtml, webviewOptions } from './webviewHtml';

/** Hashes from the webview are passed to git as revisions, so they must be hashes, never options. */
function hashesAreValid(message: LogToExtension): boolean {
  switch (message.type) {
    case 'select':
    case 'commitAction':
      return isCommitHash(message.hash);
    case 'open':
      return isCommitHash(message.hash) && (message.range?.base === undefined || isCommitHash(message.range.base));
    case 'selectMany':
    case 'commitsAction':
      return Array.isArray(message.hashes) && message.hashes.every(isCommitHash);
    default:
      return true;
  }
}

function signature(root: string, head: HeadInfo, refs: Ref[]): string {
  return JSON.stringify([root, head, refs.map((r) => [r.fullName, r.hash, r.ahead, r.behind, r.upstream])]);
}

/** The "Log" tab of the Git tool window: branches, commit graph, commit details. */
export class LogView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitcharm.log';

  private view?: vscode.WebviewView;
  private ready = false;
  private pendingFilter?: { filter: LogFilter; select?: string };
  private lastSignature?: string;
  private stale = false;
  private readonly userNames = new Map<string, string | undefined>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly actions: GitActions,
  ) {
    this.disposables.push(
      manager.onDidChangeRepositories(() => this.postRepos()),
      manager.onDidChangeState((repo) => {
        if (repo === manager.current) {
          void this.checkForChanges(repo);
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitcharm.log')) {
          this.postRepos();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'log');
    view.webview.onDidReceiveMessage((message: LogToExtension) => {
      this.onMessage(message).catch((e) => vscode.window.showErrorMessage(errorText(e)));
    });
    view.onDidChangeVisibility(() => {
      if (view.visible && this.stale) {
        this.stale = false;
        this.post({ type: 'reload' });
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  /** Reveals the Log, optionally applying a filter and selecting a commit. */
  async show(filter?: LogFilter, select?: string): Promise<void> {
    if (filter) {
      if (this.ready) {
        this.post({ type: 'setFilter', filter, select });
      } else {
        this.pendingFilter = { filter, select };
      }
    }
    await vscode.commands.executeCommand(`${LogView.viewId}.focus`);
  }

  reload(): void {
    this.post({ type: 'reload' });
  }

  private post(message: LogToWebview): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  private postRepos(): void {
    const pageSize = vscode.workspace.getConfiguration('gitcharm').get<number>('log.pageSize', 2000);
    this.post({ type: 'repos', repos: this.manager.summaries, current: this.manager.current?.root, pageSize });
  }

  private async checkForChanges(repo: Repository): Promise<void> {
    if (!this.view || !this.ready) {
      return;
    }
    if (!this.view.visible) {
      this.stale = true;
      return;
    }
    const head = await repo.head();
    const refs = await repo.refs();
    if (signature(repo.root, head, refs) !== this.lastSignature) {
      this.post({ type: 'reload' });
    }
  }

  private async me(repo: Repository): Promise<string | undefined> {
    if (!this.userNames.has(repo.root)) {
      this.userNames.set(repo.root, await repo.userName());
    }
    return this.userNames.get(repo.root);
  }

  private async onMessage(message: LogToExtension): Promise<void> {
    // `load` defines what is shown (the current repository); everything else
    // acts on the repository the data was loaded from.
    const repo =
      message.type === 'load' || !('root' in message) ? this.manager.current : this.manager.get(message.root);
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.postRepos();
        if (this.pendingFilter) {
          this.post({ type: 'setFilter', ...this.pendingFilter });
          this.pendingFilter = undefined;
        }
        return;
      case 'selectRepo':
        this.manager.setCurrent(message.root);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        return;
    }
    if (!repo) {
      if (message.type === 'load') {
        this.post({ type: 'log', requestId: message.requestId, commits: [], refs: [], head: {}, hasMore: false });
      }
      return;
    }
    if (!hashesAreValid(message)) {
      return;
    }
    switch (message.type) {
      case 'load': {
        try {
          const head = await repo.head();
          const [refs, log, me] = await Promise.all([
            repo.refs(),
            repo.log(message.filter, message.maxCount, !!head.hash),
            this.me(repo),
          ]);
          this.lastSignature = signature(repo.root, head, refs);
          this.post({ type: 'log', requestId: message.requestId, root: repo.root, head, refs, me, ...log });
        } catch (e) {
          this.post({
            type: 'log',
            requestId: message.requestId,
            root: repo.root,
            commits: [],
            refs: await repo.refs().catch(() => []),
            head: await repo.head().catch(() => ({})),
            hasMore: false,
            error: errorText(e),
          });
        }
        return;
      }
      case 'select': {
        const { hash } = message;
        try {
          this.post({ type: 'details', hash, details: await repo.commitDetails(hash) });
        } catch (e) {
          this.post({ type: 'details', hash, error: errorText(e) });
          return;
        }
        repo
          .containingBranches(hash)
          .then((branches) => this.post({ type: 'contains', hash, branches }))
          .catch(() => undefined);
        return;
      }
      case 'selectMany': {
        const { hashes } = message;
        try {
          this.post({ type: 'multiDetails', hashes, files: await repo.combinedChanges([...hashes].reverse()) });
        } catch (e) {
          this.post({ type: 'multiDetails', hashes, files: [], error: errorText(e) });
        }
        return;
      }
      case 'open':
        return this.actions.openCommitFile(repo, message.hash, message.file, message.mode, message.range);
      case 'commitAction':
        return this.actions.commitAction(repo, message.action, message.hash);
      case 'commitsAction':
        return this.actions.commitsAction(repo, message.action, message.hashes);
      case 'refAction':
        return this.actions.refAction(repo, message.action, message.ref);
      case 'fetch':
        return this.actions.fetch(repo);
      case 'pickPaths': {
        const paths = await this.actions.pickPaths(repo, message.paths);
        if (paths) {
          this.post({ type: 'pickedPaths', root: repo.root, paths });
        }
        return;
      }
    }
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
