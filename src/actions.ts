import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';
import { GitError } from './git/exec';
import type { Repository } from './git/repository';
import type { RepoManager } from './repoManager';
import { emptyUri, revisionUri, shortHash, workingUri } from './revisionContent';
import type { CommitAction, CommitsAction, CommitTab, OpenMode, RefAction, StashAction } from './shared/protocol';
import type {
  CommitDetails,
  FileChange,
  LocalChange,
  LogFilter,
  MultiFileChange,
  RebaseCommit,
  RebaseEntry,
  Ref,
  StashEntry,
  StashFile,
} from './shared/types';

/** What the interactive rebase dialog shows and runs. */
export interface RebasePlan {
  branch: string;
  /** The commit the rewritten commits are replayed onto; undefined for the root. */
  onto?: string;
  /** HEAD when the dialog opened: the rebase is refused if the branch moved meanwhile. */
  head: string;
  /** Oldest first. */
  commits: RebaseCommit[];
  entries: RebaseEntry[];
}

export interface ViewHooks {
  showLog(filter: LogFilter, select?: string): Promise<void>;
  focusCommit(tab?: CommitTab): Promise<void>;
  openInteractiveRebase(repo: Repository, plan: RebasePlan): Promise<void>;
}

type UpdateMode = 'merge' | 'rebase';

export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw
    .split('\n')
    .filter((line) => !line.startsWith('hint:'))
    .join('\n')
    .trim();
}

/**
 * Every git operation that needs user interaction lives here so the Log, the
 * Commit view and the branches popup behave the same.
 */
export class GitActions {
  constructor(
    private readonly manager: RepoManager,
    private readonly hooks: ViewHooks,
    private readonly state: vscode.Memento,
  ) {}

  // ---- plumbing ----

  private async run<T>(
    repo: Repository,
    title: string,
    task: () => Promise<T>,
    location = vscode.ProgressLocation.Window,
  ): Promise<T | undefined> {
    try {
      return await vscode.window.withProgress({ location, title }, task);
    } catch (e) {
      await this.reportFailure(repo, title, e);
      return undefined;
    } finally {
      this.manager.notifyChanged(repo);
    }
  }

  private async reportFailure(repo: Repository, title: string, e: unknown): Promise<void> {
    const operation = await repo.operation().catch(() => undefined);
    if (operation) {
      const choice = await vscode.window.showWarningMessage(
        `${title}: there are conflicts. Resolve them in the Commit view, then commit or continue.`,
        'Show Conflicts',
      );
      if (choice) {
        await this.hooks.focusCommit();
      }
      return;
    }
    void vscode.window.showErrorMessage(`${title} failed: ${errorText(e)}`);
  }

  private async currentBranch(repo: Repository): Promise<string | undefined> {
    return (await repo.head()).branch;
  }

  private async requireBranch(repo: Repository): Promise<string | undefined> {
    const branch = await this.currentBranch(repo);
    if (!branch) {
      void vscode.window.showErrorMessage('HEAD is detached. Check out a branch first.');
    }
    return branch;
  }

  private async askBranchName(repo: Repository, title: string, value = ''): Promise<string | undefined> {
    const existing = new Set((await repo.refs()).filter((r) => r.kind === 'branch').map((r) => r.name));
    const name = await vscode.window.showInputBox({
      title,
      prompt: 'New branch name',
      value,
      validateInput: async (v) => {
        if (!v.trim()) {
          return 'Enter a branch name';
        }
        if (existing.has(v.trim())) {
          return `Branch '${v.trim()}' already exists`;
        }
        try {
          await repo.exec(['check-ref-format', '--branch', v.trim()]);
          return undefined;
        } catch {
          return 'Not a valid branch name';
        }
      },
    });
    return name?.trim();
  }

  /** `git switch ...`, offering Smart/Force checkout when local changes are in the way. */
  private async switchTo(repo: Repository, args: string[], label: string): Promise<void> {
    try {
      await repo.exec(['switch', ...args]);
    } catch (e) {
      // Only tracked changes can be carried over. Untracked files in the way
      // ("untracked working tree files would be overwritten") are reported as is.
      if (
        !(e instanceof GitError) ||
        !/local changes to the following files would be overwritten by checkout/.test(e.stderr) ||
        /untracked working tree files would be overwritten/.test(e.stderr)
      ) {
        throw e;
      }
      const files = e.stderr
        .split('\n')
        .filter((l) => l.startsWith('\t'))
        .map((l) => l.trim());
      const choice = await vscode.window.showWarningMessage(
        `Your local changes would be overwritten by checkout of '${label}'.`,
        {
          modal: true,
          detail:
            'Smart Checkout stashes your local changes, checks out, and re-applies them.\n' +
            'Force Checkout discards ALL local changes in the working tree, not only these files.\n\n' +
            files.slice(0, 15).join('\n') +
            (files.length > 15 ? `\n… and ${files.length - 15} more` : ''),
        },
        'Smart Checkout',
        'Force Checkout',
      );
      if (choice === 'Smart Checkout') {
        await this.smartSwitch(repo, args, label);
      } else if (choice === 'Force Checkout') {
        await repo.exec(['switch', '--discard-changes', ...args]);
      }
    }
  }

  /** Stash, switch, re-apply. If the switch fails, the changes are put back first. */
  private async smartSwitch(repo: Repository, args: string[], label: string): Promise<void> {
    const stashTop = () => repo.exec(['rev-parse', '--verify', '--quiet', 'refs/stash']).then((s) => s.trim(), () => '');
    const before = await stashTop();
    await repo.exec(['stash', 'push', '-m', `GitCharm smart checkout of ${label}`]);
    const after = await stashTop();
    // `stash push` exits 0 without creating an entry when there is nothing to save.
    const stashed = after !== '' && after !== before;
    try {
      await repo.exec(['switch', ...args]);
    } catch (e) {
      if (stashed) {
        await repo.exec(['stash', 'pop', '--index']).catch(() => repo.exec(['stash', 'pop']));
      }
      throw e;
    }
    if (stashed) {
      try {
        await repo.exec(['stash', 'pop']);
      } catch {
        void vscode.window.showWarningMessage(
          'Checked out, but re-applying your local changes caused conflicts. They are kept in the stash list.',
        );
      }
    }
  }

  // ---- branches ----

  async refAction(repo: Repository, action: RefAction, ref: Ref): Promise<void> {
    switch (action) {
      case 'checkout':
        return this.checkout(repo, ref);
      case 'newBranchFrom':
        return this.newBranch(repo, ref.name);
      case 'checkoutAndRebase':
        return this.checkoutAndRebase(repo, ref);
      case 'compare':
        return this.compare(repo, ref);
      case 'rebaseOnto':
        return this.rebaseOnto(repo, ref);
      case 'merge':
        return this.merge(repo, ref);
      case 'push':
        await this.push(repo, ref.name);
        return;
      case 'rename':
        return this.rename(repo, ref);
      case 'delete':
        return this.deleteRef(repo, ref);
    }
  }

  async checkout(repo: Repository, ref: Ref): Promise<void> {
    if (ref.kind === 'branch') {
      await this.run(repo, `Checkout ${ref.name}`, () => this.switchTo(repo, [ref.name], ref.name));
      return;
    }
    if (ref.kind === 'tag') {
      await this.run(repo, `Checkout ${ref.name}`, () => this.switchTo(repo, ['--detach', ref.name], ref.name));
      return;
    }
    // Remote branch: check out the local branch tracking it, creating it if needed.
    const localName = ref.name.slice((ref.remote ?? '').length + 1);
    const local = (await repo.refs()).find((r) => r.kind === 'branch' && r.name === localName);
    if (local && local.upstream === ref.name) {
      await this.run(repo, `Checkout ${localName}`, () => this.switchTo(repo, [localName], localName));
      return;
    }
    let name = localName;
    if (local) {
      const chosen = await this.askBranchName(repo, `Checkout '${ref.name}' as a new local branch`, `${localName}-2`);
      if (!chosen) {
        return;
      }
      name = chosen;
    }
    await this.run(repo, `Checkout ${ref.name}`, () =>
      this.switchTo(repo, ['--create', name, '--track', ref.name], ref.name),
    );
  }

  async checkoutRevision(repo: Repository, revision?: string): Promise<void> {
    const rev =
      revision ??
      (await vscode.window.showInputBox({
        title: 'Checkout Tag or Revision',
        prompt: 'Tag, branch or commit hash',
      }));
    if (!rev?.trim()) {
      return;
    }
    await this.run(repo, `Checkout ${rev}`, () => this.switchTo(repo, ['--detach', rev.trim()], rev.trim()));
  }

  async newBranch(repo: Repository, from?: string): Promise<void> {
    const label = from ? shortHash(from) : await this.currentBranch(repo) ?? 'HEAD';
    const name = await this.askBranchName(repo, `New Branch from '${label}'`);
    if (!name) {
      return;
    }
    await this.run(repo, `New branch ${name}`, () =>
      this.switchTo(repo, ['--create', name, ...(from ? [from] : [])], name),
    );
  }

  async checkoutAndRebase(repo: Repository, ref: Ref): Promise<void> {
    const current = await this.requireBranch(repo);
    if (!current) {
      return;
    }
    await this.run(repo, `Rebase ${ref.name} onto ${current}`, () =>
      repo.exec(['rebase', '--autostash', current, ref.name]),
    );
  }

  async compare(repo: Repository, ref: Ref): Promise<void> {
    const current = (await this.currentBranch(repo)) ?? 'HEAD';
    await this.hooks.showLog({
      revision: `${current}..${ref.name}`,
      revisionLabel: `in ${ref.name}, not in ${current}`,
    });
  }

  async rebaseOnto(repo: Repository, ref: Ref): Promise<void> {
    const current = await this.requireBranch(repo);
    if (!current) {
      return;
    }
    await this.run(repo, `Rebase ${current} onto ${ref.name}`, () =>
      repo.exec(['rebase', '--autostash', ref.name]),
    );
  }

  async merge(repo: Repository, ref: Ref): Promise<void> {
    const current = await this.requireBranch(repo);
    if (!current) {
      return;
    }
    await this.run(repo, `Merge ${ref.name} into ${current}`, () =>
      repo.exec(['merge', '--no-edit', '--autostash', ref.name]),
    );
  }

  async rename(repo: Repository, ref: Ref): Promise<void> {
    const name = await this.askBranchName(repo, `Rename Branch '${ref.name}'`, ref.name);
    if (!name || name === ref.name) {
      return;
    }
    await this.run(repo, `Rename ${ref.name}`, () => repo.exec(['branch', '--move', ref.name, name]));
  }

  async deleteRef(repo: Repository, ref: Ref): Promise<void> {
    if (ref.kind === 'remote') {
      const branch = ref.name.slice((ref.remote ?? '').length + 1);
      const ok = await vscode.window.showWarningMessage(
        `Delete remote branch '${ref.name}'?`,
        { modal: true, detail: `This runs 'git push ${ref.remote} --delete ${branch}'.` },
        'Delete',
      );
      if (ok) {
        const apiRepo = this.manager.apiRepository(repo);
        await this.run(
          repo,
          `Delete ${ref.name}`,
          // Through the built-in git extension when possible, so its credential handling applies.
          async () => {
            await (apiRepo ? apiRepo.push(ref.remote!, `:${branch}`) : repo.exec(['push', ref.remote!, '--delete', branch]));
          },
          vscode.ProgressLocation.Notification,
        );
      }
      return;
    }
    if (ref.kind === 'tag') {
      const ok = await vscode.window.showWarningMessage(`Delete tag '${ref.name}'?`, { modal: true }, 'Delete');
      if (ok) {
        await this.run(repo, `Delete tag ${ref.name}`, () => repo.exec(['tag', '--delete', ref.name]));
      }
      return;
    }
    // Remember git's current values (the UI snapshot may be stale) so Restore is exact.
    const hash = (await repo.exec(['rev-parse', '--verify', `refs/heads/${ref.name}`])).trim();
    const upstream = (await repo.refs()).find((r) => r.kind === 'branch' && r.name === ref.name)?.upstream;
    const deleted = await this.run(repo, `Delete ${ref.name}`, async () => {
      try {
        await repo.exec(['branch', '--delete', ref.name]);
        return true;
      } catch (e) {
        if (!(e instanceof GitError) || !/not fully merged/.test(e.stderr)) {
          throw e;
        }
        const force = await vscode.window.showWarningMessage(
          `Branch '${ref.name}' is not fully merged. Delete it anyway?`,
          { modal: true, detail: 'Its unmerged commits can still be restored right after deletion.' },
          'Delete',
        );
        if (!force) {
          return false;
        }
        await repo.exec(['branch', '-D', ref.name]);
        return true;
      }
    });
    if (deleted) {
      const restore = await vscode.window.showInformationMessage(`Deleted branch '${ref.name}'.`, 'Restore');
      if (restore) {
        await this.run(repo, `Restore ${ref.name}`, async () => {
          await repo.exec(['branch', ref.name, hash]);
          if (upstream) {
            await repo.exec(['branch', `--set-upstream-to=${upstream}`, ref.name]).catch(() => undefined);
          }
        });
      }
    }
  }

  // ---- commits ----

  async commitAction(repo: Repository, action: CommitAction, hash: string): Promise<void> {
    switch (action) {
      case 'copyHash':
        await vscode.env.clipboard.writeText(hash);
        return;
      case 'createBranch':
        return this.newBranch(repo, hash);
      case 'createTag':
        return this.createTag(repo, hash);
      case 'checkout':
        return this.checkoutRevision(repo, hash);
      case 'cherryPick':
        return this.cherryPick(repo, hash);
      case 'revert':
        return this.revert(repo, hash);
      case 'reset':
        return this.reset(repo, hash);
      case 'undo':
        return this.undoCommit(repo, hash);
      case 'editMessage':
        return this.editMessage(repo, hash);
      case 'showChanges':
        return this.showCommitChanges(repo, await repo.commitDetails(hash));
      case 'interactiveRebase':
        return this.interactiveRebase(repo, hash);
    }
  }

  /** Actions on several commits selected in the Log; `hashes` in Log order (newest first). */
  async commitsAction(repo: Repository, action: CommitsAction, hashes: string[]): Promise<void> {
    const oldestFirst = [...hashes].reverse();
    switch (action) {
      case 'cherryPick':
        return this.cherryPickMany(repo, oldestFirst);
      case 'revert':
        return this.revertMany(repo, hashes);
      case 'squash':
        return this.squashCommits(repo, hashes);
      case 'drop':
        return this.dropCommits(repo, hashes);
      case 'showChanges':
        return this.showCombinedChanges(repo, oldestFirst);
      case 'compare':
        return this.compareCommits(repo, hashes[1], hashes[0]);
      case 'createPatch':
        return this.createPatch(repo, oldestFirst);
    }
  }

  /**
   * Create Patch…: the changes Show Changes displays (merged per file for
   * several commits), saved to a file or copied to the clipboard.
   */
  private async createPatch(repo: Repository, oldestFirst: string[]): Promise<void> {
    const n = oldestFirst.length;
    const targets: (vscode.QuickPickItem & { target: 'file' | 'clipboard' })[] = [
      { label: '$(save) Save Patch to File…', target: 'file' },
      { label: '$(copy) Copy Patch to Clipboard', target: 'clipboard' },
    ];
    const picked = await vscode.window.showQuickPick(targets, {
      title: n === 1 ? `Create Patch from ${shortHash(oldestFirst[0])}` : `Create Patch from ${n} Commits`,
      placeHolder: n === 1 ? 'The changes of the commit' : 'The changes of the commits, merged per file',
    });
    if (!picked) {
      return;
    }
    let patch: Buffer;
    try {
      patch = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Create patch' }, () =>
        repo.patch(oldestFirst),
      );
    } catch (e) {
      void vscode.window.showErrorMessage(`Create patch failed: ${errorText(e)}`);
      return;
    }
    if (!patch.length) {
      void vscode.window.showInformationMessage(
        n === 1 ? 'The commit changes no files.' : 'Together, the selected commits change no files.',
      );
      return;
    }
    if (picked.target === 'clipboard') {
      await vscode.env.clipboard.writeText(patch.toString('utf8'));
      void vscode.window.showInformationMessage('Patch copied to the clipboard.');
      return;
    }
    const folders = this.state.get<Record<string, string>>('gitcharm.patchFolders', {});
    const uri = await vscode.window.showSaveDialog({
      title: 'Save Patch',
      saveLabel: 'Save Patch',
      defaultUri: vscode.Uri.file(join(folders[repo.root] ?? repo.root, await this.patchName(repo, oldestFirst))),
      filters: { Patches: ['patch', 'diff'], 'All Files': ['*'] },
    });
    if (!uri) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(uri, patch);
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not save the patch: ${errorText(e)}`);
      return;
    }
    await this.state.update('gitcharm.patchFolders', { ...folders, [repo.root]: dirname(uri.fsPath) });
    const open = await vscode.window.showInformationMessage(`Patch saved to '${basename(uri.fsPath)}'.`, 'Open');
    if (open) {
      await vscode.window.showTextDocument(uri);
    }
  }

  /** Default file name: the subject of a single commit, else the range of hashes. */
  private async patchName(repo: Repository, oldestFirst: string[]): Promise<string> {
    const first = oldestFirst[0];
    const last = oldestFirst[oldestFirst.length - 1];
    if (first !== last) {
      return `${shortHash(first)}-${shortHash(last)}.patch`;
    }
    const subject = (await repo.exec(['show', '-s', '--format=%s', first])).trim();
    const name = subject.replace(/[^\p{L}\p{N}._-]+/gu, '_').replace(/^[_.]+|_+$/g, '').slice(0, 60);
    return `${name || shortHash(first)}.patch`;
  }

  private async anyMerge(repo: Repository, hashes: string[]): Promise<boolean> {
    return (await Promise.all(hashes.map((h) => this.isMerge(repo, h)))).some(Boolean);
  }

  private async cherryPickMany(repo: Repository, oldestFirst: string[]): Promise<void> {
    const mainline = (await this.anyMerge(repo, oldestFirst)) ? ['-m', '1'] : [];
    await this.run(repo, `Cherry-pick ${oldestFirst.length} commits`, () =>
      repo.exec(['cherry-pick', ...mainline, ...oldestFirst]),
    );
  }

  private async revertMany(repo: Repository, newestFirst: string[]): Promise<void> {
    const mainline = (await this.anyMerge(repo, newestFirst)) ? ['-m', '1'] : [];
    await this.run(repo, `Revert ${newestFirst.length} commits`, () =>
      repo.exec(['revert', '--no-edit', ...mainline, ...newestFirst]),
    );
  }

  // ---- interactive rebase ----

  /** Interactively Rebase from Here: checks the range, then opens the dialog. */
  async interactiveRebase(repo: Repository, hash: string): Promise<void> {
    const plan = await this.rebasePlan(repo, [hash], 'Interactive rebase');
    if (plan && (await this.confirmRewritingPushed(repo, hash, 'Rebase'))) {
      await this.hooks.openInteractiveRebase(repo, plan);
    }
  }

  /**
   * Squash Commits…: opens the dialog with the selection combined into the
   * oldest selected commit, keeping all their messages (editable there).
   */
  private async squashCommits(repo: Repository, hashes: string[]): Promise<void> {
    const plan = await this.rebasePlan(repo, hashes, 'Squash commits');
    if (!plan || !(await this.confirmRewritingPushed(repo, plan.commits[0].hash, 'Squash'))) {
      return;
    }
    const selected = new Set(hashes);
    const picked = plan.commits.filter((c) => selected.has(c.hash));
    const entries: RebaseEntry[] = [];
    for (const commit of plan.commits) {
      if (commit === picked[0]) {
        entries.push({ hash: commit.hash, action: 'reword', message: picked.map((c) => c.message).join('\n\n') });
        entries.push(...picked.slice(1).map((c): RebaseEntry => ({ hash: c.hash, action: 'fixup' })));
      } else if (!selected.has(commit.hash)) {
        entries.push({ hash: commit.hash, action: 'pick' });
      }
    }
    await this.hooks.openInteractiveRebase(repo, { ...plan, entries });
  }

  private async dropCommits(repo: Repository, hashes: string[]): Promise<void> {
    const plan = await this.rebasePlan(repo, hashes, 'Drop commits');
    if (!plan) {
      return;
    }
    const selected = new Set(hashes);
    const dropped = plan.commits.filter((c) => selected.has(c.hash));
    const ok = await vscode.window.showWarningMessage(
      dropped.length === 1 ? `Drop commit '${dropped[0].subject}'?` : `Drop ${dropped.length} commits from '${plan.branch}'?`,
      {
        modal: true,
        detail: dropped
          .slice(0, 15)
          .map((c) => `${shortHash(c.hash)}  ${c.subject}`)
          .join('\n'),
      },
      'Drop',
    );
    if (!ok || !(await this.confirmRewritingPushed(repo, plan.commits[0].hash, 'Drop'))) {
      return;
    }
    const entries = plan.commits.map((c): RebaseEntry => ({ hash: c.hash, action: selected.has(c.hash) ? 'drop' : 'pick' }));
    await this.runInteractiveRebase(repo, plan, entries);
  }

  /**
   * The commits a rebase of the current branch from the oldest of `hashes`
   * rewrites, or undefined (after telling the user) when that is not possible.
   */
  private async rebasePlan(repo: Repository, hashes: string[], title: string): Promise<RebasePlan | undefined> {
    const fail = (why: string) => {
      void vscode.window.showErrorMessage(`${title}: ${why}`);
      return undefined;
    };
    const branch = await this.requireBranch(repo);
    if (!branch) {
      return undefined;
    }
    const operation = await repo.operation();
    if (operation) {
      return fail(`a ${operation} is in progress. Finish or abort it first.`);
    }
    // For commits on one line of history, their common ancestor is the oldest of them.
    const oldest =
      hashes.length === 1
        ? hashes[0]
        : await repo.exec(['merge-base', '--octopus', ...hashes]).then((s) => s.trim(), () => '');
    const inBranch =
      !!oldest &&
      (await repo.exec(['merge-base', '--is-ancestor', oldest, 'HEAD']).then(
        () => true,
        () => false,
      ));
    if (!inBranch) {
      return fail(`the selected commits must be part of the current branch ('${branch}').`);
    }
    const head = (await repo.head()).hash!;
    const { onto, commits } = await repo.rebaseCommits(oldest);
    const inRange = new Set(commits.map((c) => c.hash));
    if (!hashes.every((h) => inRange.has(h))) {
      return fail(`the selected commits must be part of the current branch ('${branch}').`);
    }
    if (commits.some((c) => c.parents.length > 1)) {
      return fail('not possible when the commits to rewrite include merge commits.');
    }
    return { branch, onto, head, commits, entries: commits.map((c) => ({ hash: c.hash, action: 'pick' })) };
  }

  /**
   * Runs a rebase planned in the dialog. Returns false when it did not start,
   * so the dialog can stay open (true also when it stopped for conflicts or an edit).
   */
  async runInteractiveRebase(repo: Repository, plan: RebasePlan, entries: RebaseEntry[]): Promise<boolean> {
    // git silently drops commits missing from the todo: the plan must list each commit exactly once.
    const planned = new Set(entries.map((e) => e.hash));
    if (entries.length !== plan.commits.length || planned.size !== entries.length || !plan.commits.every((c) => planned.has(c.hash))) {
      void vscode.window.showErrorMessage('The rebase plan does not match the commits to rewrite. Start it again from the Log.');
      return false;
    }
    if ((await repo.head()).hash !== plan.head) {
      void vscode.window.showErrorMessage('The branch changed since the rebase was planned. Start it again from the Log.');
      return false;
    }
    const done = await this.run(
      repo,
      'Interactive rebase',
      async () => {
        await repo.interactiveRebase(plan.onto, entries);
        return true;
      },
      vscode.ProgressLocation.Notification,
    );
    const stopped = (await repo.operation()) === 'rebase';
    if (done && stopped) {
      const choice = await vscode.window.showInformationMessage(
        'The rebase stopped for editing. Change files, then use Continue Rebase in the Commit tab (the changes are amended into the commit).',
        'Show Commit Tab',
      );
      if (choice) {
        await this.hooks.focusCommit('commit');
      }
    }
    return !!done || stopped;
  }

  // ---- stash ----

  /**
   * Stash Changes…: all local changes, all including unversioned files, or
   * only `checked` (directly with `onlyThese`).
   */
  async stashChanges(repo: Repository, checked: LocalChange[], onlyThese = false): Promise<void> {
    const status = await repo.status();
    if (status.some((c) => c.kind === 'conflict')) {
      void vscode.window.showErrorMessage('Resolve the merge conflicts before stashing.');
      return;
    }
    const tracked = status.filter((c) => c.kind !== 'unversioned');
    const unversioned = status.filter((c) => c.kind === 'unversioned');
    const files = (n: number) => `${n} file${n === 1 ? '' : 's'}`;
    let changes: LocalChange[] | undefined;
    let includeUntracked = false;
    if (onlyThese) {
      changes = checked;
    } else {
      type Choice = vscode.QuickPickItem & { changes?: LocalChange[]; untracked: boolean };
      const choices: Choice[] = [];
      if (tracked.length) {
        choices.push({ label: '$(git-stash) All Local Changes', description: files(tracked.length), untracked: false });
      }
      if (unversioned.length) {
        choices.push({
          label: '$(git-stash) All Local Changes and Unversioned Files',
          description: files(status.length),
          untracked: true,
        });
      }
      // Offered when the checked files are not simply all tracked changes.
      const allTracked = checked.length === tracked.length && checked.every((c) => c.kind !== 'unversioned');
      if (checked.length && !allTracked) {
        choices.push({ label: '$(check) Only the Checked Files', description: files(checked.length), changes: checked, untracked: false });
      }
      if (!choices.length) {
        void vscode.window.showInformationMessage('There are no local changes to stash.');
        return;
      }
      const picked = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { title: 'Stash Changes', placeHolder: 'What should be stashed?' });
      if (!picked) {
        return;
      }
      changes = picked.changes;
      includeUntracked = picked.untracked;
    }
    if (changes) {
      if (!changes.length) {
        void vscode.window.showInformationMessage('Select the files to stash.');
        return;
      }
      includeUntracked = changes.some((c) => c.kind === 'unversioned');
    }
    const branch = await this.currentBranch(repo);
    const message = await vscode.window.showInputBox({
      title: changes ? `Stash ${files(changes.length)}` : 'Stash Changes',
      prompt: 'Message (optional)',
      placeHolder: `WIP on ${branch ?? 'HEAD'}`,
    });
    if (message === undefined) {
      return;
    }
    const stashed = await this.run(repo, 'Stash changes', () => repo.stash({ message, includeUntracked, changes }));
    if (stashed === false) {
      void vscode.window.showInformationMessage('There were no local changes to stash.');
    } else if (stashed) {
      vscode.window.setStatusBarMessage('$(git-stash) Changes stashed. They are listed in the Stash tab of the Commit window.', 5000);
    }
  }

  async stashAction(repo: Repository, action: StashAction, stash: StashEntry): Promise<void> {
    switch (action) {
      case 'apply':
      case 'pop':
        return this.unstash(repo, stash, action === 'pop');
      case 'branch': {
        const name = await this.askBranchName(repo, `Unstash '${stash.message}' as a New Branch`);
        if (name) {
          await this.run(repo, `Unstash as ${name}`, () => repo.stashBranch(stash, name));
        }
        return;
      }
      case 'drop': {
        const ok = await vscode.window.showWarningMessage(
          `Drop stash '${stash.message}'?`,
          { modal: true, detail: 'Its changes will be lost.' },
          'Drop',
        );
        if (ok) {
          await this.run(repo, 'Drop stash', () => repo.dropStash(stash));
        }
        return;
      }
      case 'showChanges': {
        const files = await repo.stashFiles(stash);
        const resources = files.map((file) => [workingUri(repo.root, file.path), ...this.stashSides(repo, stash, file)]);
        await vscode.commands.executeCommand('vscode.changes', `Stash: ${stash.message}`, resources);
        return;
      }
    }
  }

  private async unstash(repo: Repository, stash: StashEntry, pop: boolean): Promise<void> {
    const title = pop ? 'Pop stash' : 'Apply stash';
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title }, () => repo.unstash(stash, pop));
    } catch (e) {
      if ((await repo.status()).some((c) => c.kind === 'conflict')) {
        const choice = await vscode.window.showWarningMessage(
          `The stash was applied with conflicts.${pop ? ' It is kept in the stash list.' : ''} Resolve them in the Commit tab.`,
          'Show Conflicts',
        );
        if (choice) {
          await this.hooks.focusCommit('commit');
        }
      } else {
        void vscode.window.showErrorMessage(`${title} failed: ${errorText(e)}`);
      }
    } finally {
      this.manager.notifyChanged(repo);
    }
  }

  async clearStashes(repo: Repository): Promise<void> {
    const count = (await repo.stashes()).length;
    if (!count) {
      return;
    }
    const ok = await vscode.window.showWarningMessage(
      `Clear all ${count} stash${count === 1 ? '' : 'es'}?`,
      { modal: true, detail: 'Their changes will be lost.' },
      'Clear',
    );
    if (ok) {
      await this.run(repo, 'Clear stashes', () => repo.clearStashes());
    }
  }

  /** Left and right documents of a stashed file (untracked files live in the stash's third parent). */
  private stashSides(repo: Repository, stash: StashEntry, file: StashFile): [vscode.Uri, vscode.Uri] {
    const root = repo.root;
    const left =
      file.status === 'A' ? emptyUri(root, file.path) : revisionUri(root, file.oldPath ?? file.path, stash.base);
    const right =
      file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, file.untracked ? `${stash.hash}^3` : stash.hash);
    return [left, right];
  }

  async openStashFile(repo: Repository, stash: StashEntry, file: StashFile): Promise<void> {
    const [left, right] = this.stashSides(repo, stash, file);
    await vscode.commands.executeCommand('vscode.diff', left, right, `${basename(file.path)} (${shortHash(stash.base)} ↔ Stash)`, {
      preview: true,
    });
  }

  private async createTag(repo: Repository, hash: string): Promise<void> {
    const name = await vscode.window.showInputBox({ title: `New Tag on ${shortHash(hash)}`, prompt: 'Tag name' });
    if (name?.trim()) {
      await this.run(repo, `Tag ${name}`, () => repo.exec(['tag', name.trim(), hash]));
    }
  }

  private async isMerge(repo: Repository, hash: string): Promise<boolean> {
    const parents = (await repo.exec(['show', '-s', '--format=%P', hash])).trim();
    return parents.split(' ').length > 1;
  }

  private async cherryPick(repo: Repository, hash: string): Promise<void> {
    const mainline = (await this.isMerge(repo, hash)) ? ['-m', '1'] : [];
    await this.run(repo, `Cherry-pick ${shortHash(hash)}`, () => repo.exec(['cherry-pick', ...mainline, hash]));
  }

  private async revert(repo: Repository, hash: string): Promise<void> {
    const mainline = (await this.isMerge(repo, hash)) ? ['-m', '1'] : [];
    await this.run(repo, `Revert ${shortHash(hash)}`, () => repo.exec(['revert', '--no-edit', ...mainline, hash]));
  }

  private async reset(repo: Repository, hash: string): Promise<void> {
    const branch = (await this.currentBranch(repo)) ?? 'HEAD';
    const modes = [
      { label: 'Soft', mode: '--soft', detail: "Files won't change, differences will be staged for commit." },
      { label: 'Mixed', mode: '--mixed', detail: "Files won't change, differences won't be staged." },
      {
        label: 'Hard',
        mode: '--hard',
        detail: 'Files will be reverted to the state of the selected commit. Any local changes will be lost.',
      },
      { label: 'Keep', mode: '--keep', detail: 'Files will change, local changes will be kept.' },
    ];
    const picked = await vscode.window.showQuickPick(modes, {
      title: `Reset '${branch}' to ${shortHash(hash)}`,
      placeHolder: 'Choose a reset mode',
    });
    if (!picked) {
      return;
    }
    if (picked.mode === '--hard') {
      const ok = await vscode.window.showWarningMessage(
        `Hard reset '${branch}' to ${shortHash(hash)}?`,
        { modal: true, detail: 'All local changes will be lost.' },
        'Reset',
      );
      if (!ok) {
        return;
      }
    }
    await this.run(repo, `Reset ${branch}`, () => repo.exec(['reset', picked.mode, hash]));
  }

  private async confirmRewritingPushed(repo: Repository, hash: string, what: string): Promise<boolean> {
    const [refs, containing] = await Promise.all([repo.refs(), repo.containingBranches(hash)]);
    const remoteBranches = new Set(refs.filter((r) => r.kind === 'remote').map((r) => r.name));
    const pushedTo = containing.filter((b) => remoteBranches.has(b));
    if (!pushedTo.length) {
      return true;
    }
    const ok = await vscode.window.showWarningMessage(
      `This commit is already pushed to ${pushedTo.slice(0, 3).join(', ')}. ${what} anyway?`,
      { modal: true, detail: 'You will need to force-push afterwards.' },
      what,
    );
    return ok === what;
  }

  private async requireHead(repo: Repository, hash: string, what: string): Promise<boolean> {
    if ((await repo.head()).hash !== hash) {
      void vscode.window.showErrorMessage(`${what} is only available for the last commit of the current branch.`);
      return false;
    }
    return true;
  }

  private async undoCommit(repo: Repository, hash: string): Promise<void> {
    if (
      !(await this.requireBranch(repo)) ||
      !(await this.requireHead(repo, hash, 'Undo Commit')) ||
      !(await this.confirmRewritingPushed(repo, hash, 'Undo'))
    ) {
      return;
    }
    const isRoot = !(await repo.exec(['show', '-s', '--format=%P', hash])).trim();
    const done = await this.run(repo, 'Undo commit', async () => {
      await repo.exec(isRoot ? ['update-ref', '-d', 'HEAD'] : ['reset', '--soft', 'HEAD~1']);
      return true;
    });
    if (done) {
      await this.hooks.focusCommit();
    }
  }

  private async editMessage(repo: Repository, hash: string): Promise<void> {
    if (
      !(await this.requireHead(repo, hash, 'Edit Commit Message')) ||
      !(await this.confirmRewritingPushed(repo, hash, 'Edit'))
    ) {
      return;
    }
    const message = await repo.lastCommitMessage();
    const [subject, ...body] = message.split('\n');
    const edited = await vscode.window.showInputBox({
      title: 'Edit Commit Message',
      prompt: body.length ? 'Subject line (the message body is kept)' : 'Commit message',
      value: subject,
    });
    if (edited === undefined || !edited.trim() || edited === subject) {
      return;
    }
    const newMessage = [edited.trim(), ...body].join('\n');
    await this.run(repo, 'Edit commit message', () => repo.exec(['commit', '--amend', '--only', '-m', newMessage]));
  }

  // ---- opening files ----

  /** `range`: a file of a multi-commit selection, diffed against `range.base` instead of the commit's parent. */
  async openCommitFile(
    repo: Repository,
    hash: string,
    file: FileChange,
    mode: OpenMode,
    range?: { base?: string },
  ): Promise<void> {
    const name = basename(file.path);
    const parent = range ? range.base : (await repo.exec(['show', '-s', '--format=%P', hash])).trim().split(' ')[0];
    const root = repo.root;
    switch (mode) {
      case 'diff': {
        const left =
          file.status === 'A' || !parent ? emptyUri(root, file.path) : revisionUri(root, file.oldPath ?? file.path, parent);
        const right = file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, hash);
        const title = `${name} (${parent ? shortHash(parent) : 'empty'} ↔ ${shortHash(hash)})`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
        return;
      }
      case 'compareWithLocal': {
        const left = file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, hash);
        await vscode.commands.executeCommand(
          'vscode.diff',
          left,
          workingUri(root, file.path),
          `${name} (${shortHash(hash)} ↔ Local)`,
        );
        return;
      }
      case 'revision': {
        // A deleted file only exists in the parent.
        const ref = file.status === 'D' ? parent ?? hash : hash;
        const doc = await vscode.workspace.openTextDocument(revisionUri(root, file.path, ref));
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      case 'file':
        try {
          await vscode.window.showTextDocument(workingUri(root, file.path));
        } catch {
          void vscode.window.showWarningMessage(`'${file.path}' does not exist in the working tree.`);
        }
        return;
    }
  }

  async showCommitChanges(repo: Repository, details: CommitDetails): Promise<void> {
    const parent = details.parents[0];
    const root = repo.root;
    const resources = details.files.map((file) => [
      workingUri(root, file.path),
      file.status === 'A' || !parent ? emptyUri(root, file.path) : revisionUri(root, file.oldPath ?? file.path, parent),
      file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, details.hash),
    ]);
    const subject = details.message.split('\n')[0];
    await vscode.commands.executeCommand('vscode.changes', `${shortHash(details.hash)} ${subject}`, resources);
  }

  private async showCombinedChanges(repo: Repository, oldestFirst: string[]): Promise<void> {
    const files: MultiFileChange[] = await repo.combinedChanges(oldestFirst);
    const root = repo.root;
    const resources = files.map((file) => [
      workingUri(root, file.path),
      file.base ? revisionUri(root, file.oldPath ?? file.path, file.base) : emptyUri(root, file.path),
      file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, file.last),
    ]);
    await vscode.commands.executeCommand('vscode.changes', `Changes of ${oldestFirst.length} commits`, resources);
  }

  /** Compare Versions: everything that differs between two commits. */
  private async compareCommits(repo: Repository, older: string, newer: string): Promise<void> {
    const files = await repo.diffFiles(older, newer);
    const root = repo.root;
    const resources = files.map((file) => [
      workingUri(root, file.path),
      file.status === 'A' ? emptyUri(root, file.path) : revisionUri(root, file.oldPath ?? file.path, older),
      file.status === 'D' ? emptyUri(root, file.path) : revisionUri(root, file.path, newer),
    ]);
    await vscode.commands.executeCommand('vscode.changes', `${shortHash(older)} ↔ ${shortHash(newer)}`, resources);
  }

  /**
   * Paths filter, Select Folders…: the repository's folders and tracked files,
   * several at once. Undefined when cancelled, empty for all paths.
   */
  async pickPaths(repo: Repository, current: string[]): Promise<string[] | undefined> {
    let files: string[];
    try {
      files = await repo.trackedFiles();
    } catch (e) {
      void vscode.window.showErrorMessage(`Could not list the files: ${errorText(e)}`);
      return undefined;
    }
    const folders = new Set<string>();
    for (const file of files) {
      // Deepest folder first; once one is known, so are its parents.
      for (let i = file.lastIndexOf('/'); i > 0; i = file.lastIndexOf('/', i - 1)) {
        const folder = file.slice(0, i);
        if (folders.has(folder)) {
          break;
        }
        folders.add(folder);
      }
    }
    const selected = new Set(current);
    const item = (path: string, icon: string): vscode.QuickPickItem & { path: string } => ({
      label: `$(${icon}) ${path}`,
      path,
      picked: selected.has(path),
    });
    const known = new Set([...folders, ...files]);
    const items = [
      // Selected paths that no longer exist (the history of a deleted file).
      ...current.filter((p) => !known.has(p)).map((p) => item(p, 'history')),
      ...[...folders].sort((a, b) => a.localeCompare(b)).map((p) => item(p, 'folder')),
      ...files.map((p) => item(p, 'file')),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: 'Filter by Paths',
      placeHolder: 'Select folders or files; the Log shows the commits that changed them',
      canPickMany: true,
      matchOnDescription: false,
    });
    return picked?.map((p) => p.path);
  }

  // ---- network ----

  async fetch(repo: Repository): Promise<void> {
    const apiRepo = this.manager.apiRepository(repo);
    await this.run(
      repo,
      'Fetch',
      async () => {
        await (apiRepo ? apiRepo.fetch({ all: true, prune: true }) : repo.exec(['fetch', '--all', '--prune']));
      },
      vscode.ProgressLocation.Notification,
    );
  }

  async updateProject(repo: Repository): Promise<void> {
    const branch = await this.requireBranch(repo);
    if (!branch) {
      return;
    }
    const current = (await repo.refs()).find((r) => r.kind === 'branch' && r.name === branch);
    if (!current?.upstream || current.upstreamGone) {
      void vscode.window.showErrorMessage(
        current?.upstreamGone
          ? `The tracking branch of '${branch}' (${current.upstream}) no longer exists on the remote.`
          : `Branch '${branch}' has no tracking branch. Push it first to create one.`,
      );
      return;
    }
    const last = this.state.get<UpdateMode>('gitcharm.updateMode', 'merge');
    const modes: (vscode.QuickPickItem & { mode: UpdateMode })[] = [
      { label: '$(git-merge) Merge', mode: 'merge', detail: 'Merge incoming changes into the current branch' },
      { label: '$(git-pull-request) Rebase', mode: 'rebase', detail: 'Rebase the current branch on top of incoming changes' },
    ];
    if (last === 'rebase') {
      modes.reverse();
    }
    const picked = await vscode.window.showQuickPick(modes, {
      title: `Update '${branch}' from '${current.upstream}'`,
      placeHolder: 'How should incoming changes be applied?',
    });
    if (!picked) {
      return;
    }
    await this.state.update('gitcharm.updateMode', picked.mode);
    // `.` means the upstream is a local branch: nothing to fetch.
    const remote = current.upstreamRemote && current.upstreamRemote !== '.' ? current.upstreamRemote : undefined;
    const apiRepo = this.manager.apiRepository(repo);
    await this.run(
      repo,
      'Update project',
      async () => {
        if (remote) {
          await (apiRepo ? apiRepo.fetch({ remote, prune: true }) : repo.exec(['fetch', '--prune', remote]));
        }
        const incoming = Number((await repo.exec(['rev-list', '--count', 'HEAD..@{upstream}'])).trim());
        if (incoming === 0) {
          void vscode.window.showInformationMessage('All files are up-to-date.');
          return;
        }
        await repo.exec(
          picked.mode === 'rebase'
            ? ['rebase', '--autostash', '@{upstream}']
            : ['merge', '--no-edit', '--autostash', '@{upstream}'],
        );
        void vscode.window.showInformationMessage(`${incoming} commit${incoming === 1 ? '' : 's'} received.`);
      },
      vscode.ProgressLocation.Notification,
    );
  }

  /** Pushes `branchName` (default: the current branch), confirming the outgoing commits. */
  async push(repo: Repository, branchName?: string): Promise<boolean> {
    const branch = branchName ?? (await this.requireBranch(repo));
    if (!branch) {
      return false;
    }
    const [refs, remotes] = await Promise.all([repo.refs(), repo.remotes()]);
    const ref = refs.find((r) => r.kind === 'branch' && r.name === branch);
    if (!ref) {
      void vscode.window.showErrorMessage(`'${branch}' is not a local branch.`);
      return false;
    }
    // The upstream's remote, unless it is a local branch (`.`).
    const trackedRemote =
      ref.upstreamRemote && ref.upstreamRemote !== '.' && remotes.includes(ref.upstreamRemote) ? ref.upstreamRemote : undefined;
    const remote = trackedRemote ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
    if (!remote) {
      void vscode.window.showErrorMessage('No remote is configured for this repository.');
      return false;
    }
    const remoteBranch = trackedRemote && ref.upstreamBranch ? ref.upstreamBranch : branch;
    // A live remote upstream: show what it lacks. Otherwise (none, gone, or local) the branch is new there.
    const upstreamRemote = trackedRemote && !ref.upstreamGone ? trackedRemote : undefined;
    const setUpstream = !ref.upstream || !!ref.upstreamGone;
    const range = upstreamRemote ? [`${branch}@{upstream}..${branch}`] : [branch, '--not', '--remotes'];
    const outgoing = (await repo.exec(['log', '--max-count=50', '--format=%h  %s', ...range])).trim().split('\n').filter(Boolean);
    if (upstreamRemote && !outgoing.length) {
      void vscode.window.showInformationMessage(`Everything is up-to-date: '${branch}' has nothing to push.`);
      return true;
    }
    const target = `${remote}/${remoteBranch}`;
    const ok = await vscode.window.showInformationMessage(
      upstreamRemote
        ? `Push ${outgoing.length}${outgoing.length === 50 ? '+' : ''} commit${outgoing.length === 1 ? '' : 's'} from '${branch}' to '${target}'?`
        : `Push '${branch}' to '${target}' (new branch)?`,
      { modal: true, detail: outgoing.slice(0, 20).join('\n') + (outgoing.length > 20 ? '\n…' : '') },
      'Push',
    );
    if (!ok) {
      return false;
    }
    const apiRepo = this.manager.apiRepository(repo);
    const refspec = remoteBranch === branch ? branch : `${branch}:${remoteBranch}`;
    const pushed = await this.run(
      repo,
      `Push ${branch}`,
      async () => {
        if (apiRepo) {
          await apiRepo.push(remote, refspec, setUpstream);
        } else {
          await repo.exec(['push', ...(setUpstream ? ['--set-upstream'] : []), remote, refspec]);
        }
        return true;
      },
      vscode.ProgressLocation.Notification,
    );
    return pushed === true;
  }
}
