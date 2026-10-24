import { basename } from 'node:path';
import * as vscode from 'vscode';
import { errorText, type GitActions, type ViewHooks } from '../actions';
import { GitError } from '../git/exec';
import { isCommitHash } from '../git/parsers';
import type { Repository } from '../git/repository';
import type { RepoManager } from '../repoManager';
import { emptyUri, revisionUri, workingUri } from '../revisionContent';
import type { ChangeRef, CommitTab, CommitToExtension, CommitToWebview } from '../shared/protocol';
import type { LocalChange, StashEntry } from '../shared/types';
import { renderWebviewHtml, webviewOptions } from './webviewHtml';

function isStash(stash: StashEntry | undefined): boolean {
  return (
    !!stash && /^stash@\{\d+\}$/.test(stash.ref) && isCommitHash(stash.hash) && (stash.base === '' || isCommitHash(stash.base))
  );
}

/** The current changes matching the rows the user selected (kind + path). */
function pick(changes: LocalChange[], refs: ChangeRef[]): LocalChange[] {
  const wanted = new Set(refs.map((r) => `${r.kind}\0${r.path}`));
  return changes.filter((c) => wanted.has(`${c.kind}\0${c.path}`));
}

/** PyCharm's Commit tool window: changes with checkboxes, message, Commit / Commit and Push. */
export class CommitView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'gitcharm.commit';

  private view?: vscode.WebviewView;
  private ready = false;
  private stale = false;
  private focusOnReady = false;
  private tabOnReady?: CommitTab;
  private refreshSeq = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepoManager,
    private readonly actions: GitActions,
    private readonly hooks: ViewHooks,
  ) {
    this.disposables.push(
      manager.onDidChangeRepositories(() => void this.refresh()),
      manager.onDidChangeState((repo) => {
        if (repo === manager.current) {
          void this.refresh();
        }
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.ready = false;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = renderWebviewHtml(view.webview, this.extensionUri, 'commit');
    view.webview.onDidReceiveMessage((message: CommitToExtension) => {
      this.onMessage(message).catch((e) => vscode.window.showErrorMessage(errorText(e)));
    });
    view.onDidChangeVisibility(() => {
      if (view.visible && this.stale) {
        void this.refresh();
      }
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.ready = false;
    });
  }

  /** Reveals the view; without `tab`, the Commit tab with the message focused. */
  async focus(tab?: CommitTab): Promise<void> {
    await vscode.commands.executeCommand(`${CommitView.viewId}.focus`);
    if (!this.ready) {
      this.focusOnReady = !tab;
      this.tabOnReady = tab;
    } else if (tab) {
      this.post({ type: 'showTab', tab });
    } else {
      this.post({ type: 'focusMessage' });
    }
  }

  async refresh(): Promise<void> {
    if (!this.view || !this.ready) {
      return;
    }
    if (!this.view.visible) {
      this.stale = true;
      return;
    }
    this.stale = false;
    // Only the latest refresh may update the view (an older, slower one could
    // otherwise show another repository's files).
    const seq = ++this.refreshSeq;
    const repo = this.manager.current;
    if (!repo) {
      this.post({ type: 'state', changes: [], hasCommits: false, stashes: [] });
      return;
    }
    const [changes, operation, head, stashes] = await Promise.all([
      repo.status(),
      repo.operation(),
      repo.head(),
      repo.stashes(),
    ]);
    const preparedMessage = operation && operation !== 'rebase' ? await repo.preparedMessage() : undefined;
    if (seq !== this.refreshSeq || repo !== this.manager.current) {
      return;
    }
    this.post({
      type: 'state',
      repo: this.manager.summaries.find((s) => s.root === repo.root),
      branch: head.branch,
      hasCommits: !!head.hash,
      changes,
      operation,
      preparedMessage,
      stashes,
    });
  }

  private post(message: CommitToWebview): void {
    if (this.view && this.ready) {
      void this.view.webview.postMessage(message);
    }
  }

  private async onMessage(message: CommitToExtension): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        await this.refresh();
        if (this.tabOnReady) {
          this.post({ type: 'showTab', tab: this.tabOnReady });
          this.tabOnReady = undefined;
        }
        if (this.focusOnReady) {
          this.focusOnReady = false;
          this.post({ type: 'focusMessage' });
        }
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(message.text);
        return;
      case 'refresh':
        if (this.manager.current) {
          this.manager.notifyChanged(this.manager.current);
        }
        return;
      case 'requestLastMessage':
        if (this.manager.current) {
          this.post({ type: 'lastMessage', message: await this.manager.current.lastCommitMessage() });
        }
        return;
    }
    // Act on the repository the user was looking at, not whichever is current now.
    const repo = this.manager.get(message.root);
    if (!repo) {
      void vscode.window.showWarningMessage('That repository is no longer open.');
      return;
    }
    switch (message.type) {
      case 'commit':
        return this.commit(repo, message.message, message.amend, message.changes, message.push);
      case 'open':
        return this.open(repo, message.path, message.mode);
      case 'rollback':
        return this.rollback(repo, message.changes);
      case 'addToVcs':
        await this.guard(repo, 'Add to VCS', () => repo.exec(['add', '--', ...message.paths]));
        return;
      case 'delete':
        return this.deleteUnversioned(repo, message.paths);
      case 'history':
        this.manager.setCurrent(repo.root);
        return this.hooks.showLog({ paths: [message.path] });
      case 'resolve':
        return this.resolve(repo, message.path, message.how);
      case 'operation':
        return this.operation(repo, message.action, message.changes ?? []);
      case 'stash':
        return this.actions.stashChanges(repo, pick(await repo.status(), message.changes), message.onlyThese);
      // Stash hashes and refs are passed to git as revisions, so they must be exactly that.
      case 'stashFiles':
        return isCommitHash(message.hash) ? this.sendStashFiles(repo, message.hash) : undefined;
      case 'stashAction':
        return isStash(message.stash) ? this.actions.stashAction(repo, message.action, message.stash) : undefined;
      case 'stashOpen':
        return isStash(message.stash) ? this.actions.openStashFile(repo, message.stash, message.file) : undefined;
      case 'clearStashes':
        return this.actions.clearStashes(repo);
    }
  }

  private async sendStashFiles(repo: Repository, hash: string): Promise<void> {
    const stash = (await repo.stashes()).find((s) => s.hash === hash);
    if (!stash) {
      this.post({ type: 'stashFiles', hash, files: [], error: 'This stash no longer exists.' });
      return;
    }
    try {
      this.post({ type: 'stashFiles', hash, files: await repo.stashFiles(stash) });
    } catch (e) {
      this.post({ type: 'stashFiles', hash, files: [], error: errorText(e) });
    }
  }

  private async guard(repo: Repository, title: string, task: () => Promise<unknown>): Promise<boolean> {
    try {
      await task();
      return true;
    } catch (e) {
      void vscode.window.showErrorMessage(`${title} failed: ${errorText(e)}`);
      return false;
    } finally {
      this.manager.notifyChanged(repo);
    }
  }

  private async commit(repo: Repository, message: string, amend: boolean, refs: ChangeRef[], push: boolean) {
    this.post({ type: 'busy', busy: true });
    try {
      // Match the selection against a fresh status so a stale view cannot commit the wrong files.
      const ok = await this.guard(repo, 'Commit', async () =>
        repo.commit({ message, amend, changes: pick(await repo.status(), refs) }),
      );
      if (!ok) {
        return;
      }
      this.post({ type: 'committed' });
      if (push) {
        await this.actions.push(repo);
      }
    } finally {
      this.post({ type: 'busy', busy: false });
    }
  }

  private async open(repo: Repository, path: string, mode: 'diff' | 'file'): Promise<void> {
    const change = (await repo.status()).find((c) => c.path === path);
    const root = repo.root;
    if (mode === 'file' || !change) {
      if (change?.kind === 'deleted') {
        void vscode.window.showWarningMessage(`'${path}' was deleted.`);
        return;
      }
      await vscode.window.showTextDocument(workingUri(root, path));
      return;
    }
    if (change.kind === 'conflict') {
      await this.resolve(repo, path, 'merge');
      return;
    }
    const left =
      change.kind === 'added' || change.kind === 'unversioned'
        ? emptyUri(root, path)
        : revisionUri(root, change.oldPath ?? path, 'HEAD');
    const right = change.kind === 'deleted' ? emptyUri(root, path) : workingUri(root, path);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(path)} (HEAD ↔ Local)`, {
      preview: true,
    });
  }

  private async rollback(repo: Repository, refs: ChangeRef[]): Promise<void> {
    const revertible = pick(await repo.status(), refs).filter((c) => c.kind !== 'unversioned' && c.kind !== 'conflict');
    if (!revertible.length) {
      void vscode.window.showInformationMessage('Select changed files to roll back (unversioned files cannot be rolled back).');
      return;
    }
    const names = revertible.map((c) => c.path);
    const ok = await vscode.window.showWarningMessage(
      `Rollback ${names.length === 1 ? `'${names[0]}'` : `${names.length} files`}?`,
      {
        modal: true,
        detail:
          'Local changes will be discarded. Added files are removed from version control but kept on disk.\n\n' +
          names.slice(0, 15).join('\n') +
          (names.length > 15 ? '\n…' : ''),
      },
      'Rollback',
    );
    if (ok) {
      await this.guard(repo, 'Rollback', () => repo.rollback(revertible));
    }
  }

  private async deleteUnversioned(repo: Repository, paths: string[]): Promise<void> {
    const ok = await vscode.window.showWarningMessage(
      `Delete ${paths.length === 1 ? `'${paths[0]}'` : `${paths.length} unversioned files`}?`,
      { modal: true, detail: 'Files are moved to the trash.' },
      'Delete',
    );
    if (ok) {
      await this.guard(repo, 'Delete', async () => {
        for (const path of paths) {
          await vscode.workspace.fs.delete(workingUri(repo.root, path), { useTrash: true });
        }
      });
    }
  }

  private async resolve(repo: Repository, path: string, how: 'yours' | 'theirs' | 'merge'): Promise<void> {
    if (how === 'merge') {
      const uri = workingUri(repo.root, path);
      try {
        await vscode.commands.executeCommand('git.openMergeEditor', uri);
      } catch {
        await vscode.window.showTextDocument(uri);
      }
      return;
    }
    // During a rebase, "ours" is the branch being rebased onto, so swap.
    const rebasing = (await repo.operation()) === 'rebase';
    const side = (how === 'yours') !== rebasing ? '--ours' : '--theirs';
    await this.guard(repo, 'Resolve conflict', async () => {
      try {
        await repo.exec(['checkout', side, '--', path]);
        await repo.exec(['add', '--', path]);
      } catch (e) {
        // Delete/modify conflict: the chosen side deleted the file.
        if (e instanceof GitError && /does not have (our|their) version/.test(e.stderr)) {
          await repo.exec(['rm', '--quiet', '--', path]);
        } else {
          throw e;
        }
      }
    });
  }

  private async operation(repo: Repository, action: 'continue' | 'skip' | 'abort', refs: ChangeRef[]): Promise<void> {
    const operation = await repo.operation();
    if (!operation) {
      return;
    }
    if (action === 'abort') {
      const ok = await vscode.window.showWarningMessage(
        `Abort the ${operation}?`,
        { modal: true, detail: 'The branch returns to its state before the operation started.' },
        'Abort',
      );
      if (!ok) {
        return;
      }
    }
    await this.guard(repo, `${action} ${operation}`, async () => {
      if (action === 'continue') {
        // Include the selected changes, but never auto-resolve conflicts.
        await repo.stage(pick(await repo.status(), refs).filter((c) => c.kind !== 'conflict'));
      }
      await repo.sequencer(operation, action);
    });
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
