import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Commit,
  CommitDetails,
  FileChange,
  HeadInfo,
  LocalChange,
  LogFilter,
  MultiFileChange,
  RebaseCommit,
  RebaseEntry,
  Ref,
  RepoOperation,
  StashEntry,
  StashFile,
} from '../shared/types';
import { GitError, type GitRunner, type RunOptions } from './exec';
import {
  DETAILS_FORMAT,
  FULL_LOG_FORMAT,
  LOG_FORMAT,
  REFS_FORMAT,
  STASH_FORMAT,
  parseBlame,
  parseCommitDetails,
  parseFullLog,
  parseLog,
  parseNameStatus,
  parseRecentCheckouts,
  parseRefs,
  parseStashList,
  parseStatus,
  type BlameResult,
} from './parsers';
import { buildRebaseTodo, rebaseEditorScript, shellQuote } from './rebase';

export interface CommitRequest {
  message: string;
  amend: boolean;
  /** Selected changes; only these end up in the commit. */
  changes: LocalChange[];
}

/** Thin, typed wrapper over the git CLI for one repository. */
export class Repository {
  private gitDir?: Promise<string>;

  constructor(
    readonly root: string,
    private readonly run: GitRunner,
  ) {}

  private async out(args: string[], options?: RunOptions): Promise<string> {
    return (await this.run(this.root, args, options)).stdout;
  }

  /** Runs an arbitrary git command in this repository and returns stdout. */
  exec(args: string[], options?: RunOptions): Promise<string> {
    return this.out(args, options);
  }

  private async optional(args: string[]): Promise<string | undefined> {
    try {
      return (await this.out(args)).trim();
    } catch (e) {
      if (e instanceof GitError) {
        return undefined;
      }
      throw e;
    }
  }

  async head(): Promise<HeadInfo> {
    const [hash, branch] = await Promise.all([
      this.optional(['rev-parse', '--verify', '--quiet', 'HEAD']),
      this.optional(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    ]);
    return { hash: hash || undefined, branch: branch || undefined };
  }

  async remotes(): Promise<string[]> {
    return (await this.out(['remote'])).split('\n').filter(Boolean);
  }

  async refs(): Promise<Ref[]> {
    const [stdout, remotes] = await Promise.all([
      this.out(['for-each-ref', `--format=${REFS_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
      this.remotes(),
    ]);
    return parseRefs(stdout, remotes);
  }

  async log(filter: LogFilter, maxCount: number, hasHead = true): Promise<{ commits: Commit[]; hasMore: boolean }> {
    const args = ['log', `--max-count=${maxCount + 1}`, '--date-order', '--parents', `--format=${LOG_FORMAT}`];
    const filtered = !!(filter.text || filter.author);
    if (filtered) {
      args.push('--regexp-ignore-case', '--fixed-strings');
      if (filter.text) {
        args.push(`--grep=${filter.text}`);
      }
      if (filter.author) {
        args.push(`--author=${filter.author}`);
      }
    }
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (filter.days) {
      args.push(`--since=${filter.days * 24} hours ago`);
    }
    if (filter.after && day.test(filter.after)) {
      args.push(`--since=${filter.after} 00:00:00`);
    }
    if (filter.before && day.test(filter.before)) {
      args.push(`--until=${filter.before} 23:59:59`);
    }
    const revisions = filter.revision
      ? ['--end-of-options', filter.revision]
      : ['--branches', '--remotes', '--tags', ...(hasHead ? ['HEAD'] : [])];
    // Always end revisions with `--`, or a branch named like a file is ambiguous.
    revisions.push('--');
    revisions.push(...(filter.paths ?? []));
    let commits = parseLog(await this.out([...args, ...revisions]));
    const hasMore = commits.length > maxCount;
    if (hasMore) {
      commits = commits.slice(0, maxCount);
    }
    if (filtered) {
      await this.linkFiltered(commits, revisions, hasMore);
    }
    // Searching for a hash: also show that exact commit.
    if (filter.text && /^[0-9a-f]{4,64}$/i.test(filter.text)) {
      const exact = await this.optional(['rev-parse', '--verify', '--quiet', `${filter.text}^{commit}`]);
      if (exact && !commits.some((c) => c.hash === exact)) {
        // It isn't in log order, so the graph shows it on its own.
        const [commit] = parseLog(await this.out(['log', '-1', `--format=${LOG_FORMAT}`, exact]));
        commits.unshift({ ...commit, graphParents: [] });
      }
    }
    return { commits, hasMore };
  }

  /**
   * Sets `graphParents` on a log filtered by text or author, so its graph links
   * each commit to the next listed ones below it. Git rewrites parents only for
   * path filters, so this walks the unfiltered history (children before
   * parents), carrying each listed commit down its paths until they reach
   * listed commits, and stops once it has passed them all.
   */
  private async linkFiltered(commits: Commit[], revisions: string[], hasMore: boolean): Promise<void> {
    // Listed commit → listed ancestors it reaches, each with the index of the parent it goes through.
    const found = new Map(commits.map((c) => [c.hash, new Map<string, number>()]));
    // Commit not walked yet → listed commits whose paths reach it, with that parent index.
    const waiting = new Map<string, Map<string, number>>();
    const reach = (hash: string, child: string, rank: number, into = waiting) => {
      let children = into.get(hash);
      if (!children) {
        children = new Map();
        into.set(hash, children);
      }
      const known = children.get(child);
      if (known === undefined || rank < known) {
        children.set(child, rank);
      }
    };
    let left = found.size;
    const visit = (line: string) => {
      const [hash, ...parents] = line.split(' ');
      const children = waiting.get(hash);
      waiting.delete(hash);
      if (found.has(hash)) {
        for (const [child, rank] of children ?? []) {
          reach(child, hash, rank, found);
        }
        parents.forEach((parent, rank) => reach(parent, hash, rank));
        left--;
      } else if (children) {
        for (const parent of parents) {
          for (const [child, rank] of children) {
            reach(parent, child, rank);
          }
        }
      }
    };
    let partial = '';
    if (left) {
      await this.run(this.root, ['rev-list', '--date-order', '--parents', ...revisions], {
        onStdout: (text) => {
          const lines = (partial + text).split('\n');
          partial = lines.pop()!;
          for (const line of lines) {
            if (line) {
              visit(line);
            }
            if (!left) {
              return false;
            }
          }
          return true;
        },
      });
    }
    if (hasMore) {
      // Paths still open continue below the page: one line per parent, to the commit it waits at.
      for (const [hash, children] of waiting) {
        for (const [child, rank] of children) {
          const links = found.get(child)!;
          if (![...links.values()].includes(rank)) {
            links.set(hash, rank);
          }
        }
      }
    }
    for (const commit of commits) {
      commit.graphParents = [...found.get(commit.hash)!].sort((a, b) => a[1] - b[1]).map(([hash]) => hash);
    }
    // Drop links to commits another link already leads to (like git's
    // --simplify-merges), or merge-heavy histories draw a tangle of lines.
    // Ancestors come later in the list, so the search stops at the deepest link.
    const index = new Map(commits.map((c, i) => [c.hash, i]));
    for (const commit of [...commits].reverse()) {
      const links = commit.graphParents!;
      if (links.length < 2) {
        continue;
      }
      const deepest = Math.max(...links.map((hash) => index.get(hash) ?? -1));
      const below = new Set<string>();
      const stack = links.flatMap((hash) => (index.has(hash) ? commits[index.get(hash)!].graphParents! : []));
      while (stack.length) {
        const hash = stack.pop()!;
        const i = index.get(hash);
        if (i !== undefined && i <= deepest && !below.has(hash)) {
          below.add(hash);
          stack.push(...commits[i].graphParents!);
        }
      }
      commit.graphParents = links.filter((hash) => !below.has(hash));
    }
  }

  async commitDetails(hash: string): Promise<CommitDetails> {
    const raw = await this.out(['show', '-s', `--format=${DETAILS_FORMAT}`, hash]);
    const parents = raw.split('\x1f')[1];
    const files = await this.changedFiles(hash, parents ? parents.split(' ')[0] : undefined);
    return parseCommitDetails(raw, files);
  }

  /** Files a commit changed against `parent` (or the empty tree for a root commit). */
  private async changedFiles(hash: string, parent: string | undefined): Promise<FileChange[]> {
    const args = parent
      ? ['diff-tree', '-r', '-z', '-M', '--name-status', parent, hash]
      : ['diff-tree', '--root', '-r', '-z', '-M', '--name-status', '--no-commit-id', hash];
    return parseNameStatus(await this.out(args));
  }

  /**
   * The changes of several commits merged per file, as PyCharm shows a
   * multi-commit selection. `hashes` oldest first.
   */
  async combinedChanges(hashes: string[]): Promise<MultiFileChange[]> {
    const parentOf = new Map<string, string | undefined>();
    for (const line of (await this.out(['show', '-s', '--format=%H %P', ...hashes])).split('\n')) {
      const [hash, parent] = line.split(' ');
      if (hash) {
        parentOf.set(hash, parent || undefined);
      }
    }
    // Per path: did it exist before the first commit touching it, does it exist after the last one.
    interface Track {
      before: boolean;
      base?: string;
      exists: boolean;
      last: string;
      /** The path it was renamed from (followed through renames within the selection). */
      from?: string;
    }
    const tracks = new Map<string, Track>();
    const touch = (path: string, hash: string, parent: string | undefined, kind: 'add' | 'modify' | 'delete', from?: string) => {
      let track = tracks.get(path);
      if (!track) {
        track = { before: kind !== 'add', base: kind !== 'add' ? parent : undefined, exists: true, last: hash };
        tracks.set(path, track);
      }
      track.exists = kind !== 'delete';
      track.last = hash;
      if (kind !== 'modify') {
        track.from = kind === 'add' ? from : undefined;
      }
    };
    for (const hash of hashes) {
      const parent = parentOf.get(hash);
      for (const f of await this.changedFiles(hash, parent)) {
        if (f.status === 'R' && f.oldPath) {
          // A file renamed within the selection was renamed from wherever it started.
          const source = tracks.get(f.oldPath);
          const origin = source && !source.before ? source.from : f.oldPath;
          touch(f.oldPath, hash, parent, 'delete');
          touch(f.path, hash, parent, 'add', origin);
        } else {
          touch(f.path, hash, parent, f.status === 'A' || f.status === 'C' ? 'add' : f.status === 'D' ? 'delete' : 'modify');
        }
      }
    }
    const files = new Map<string, MultiFileChange>();
    for (const [path, t] of tracks) {
      if (t.before && t.exists) {
        files.set(path, { status: 'M', path, base: t.base, last: t.last });
      } else if (t.before) {
        files.set(path, { status: 'D', path, base: t.base, last: t.last });
      } else if (t.exists) {
        files.set(path, { status: 'A', path, last: t.last });
      }
    }
    // An added file whose origin is gone is a rename of it.
    for (const [path, t] of tracks) {
      const origin = t.from ? files.get(t.from) : undefined;
      if (files.get(path)?.status === 'A' && origin?.status === 'D') {
        files.delete(origin.path);
        files.set(path, { status: 'R', path, oldPath: origin.path, base: origin.base, last: t.last });
      }
    }
    return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * Create Patch: the changes of `combinedChanges` (oldest first) as one patch
   * in `git apply` format, binary files included. Empty when nothing changed.
   */
  async patch(hashes: string[]): Promise<Buffer> {
    // One diff per pair of revisions, limited to the files that use that pair.
    const groups = new Map<string, { from: string; to: string; paths: string[][] }>();
    let emptyTree: string | undefined;
    for (const file of await this.combinedChanges(hashes)) {
      const from = file.base ?? (emptyTree ??= (await this.out(['hash-object', '-t', 'tree', '--stdin'], { input: '' })).trim());
      const key = `${from} ${file.last}`;
      const group = groups.get(key) ?? { from, to: file.last, paths: [] };
      groups.set(key, group);
      group.paths.push(file.oldPath ? [file.oldPath, file.path] : [file.path]);
    }
    const options = ['--binary', '-M', '--no-color', '--no-ext-diff', '--no-textconv', '--submodule=short'];
    const chunks: string[] = [];
    for (const { from, to, paths } of groups.values()) {
      for (let i = 0; i < paths.length; i += 500) {
        const args = ['diff', ...options, '--src-prefix=a/', '--dst-prefix=b/', from, to, '--', ...paths.slice(i, i + 500).flat()];
        const { stdout } = await this.run(this.root, args, { binary: true });
        // Per file, sorted by path below; latin1 keeps every byte as one character.
        chunks.push(...stdout.toString('latin1').split(/^(?=diff --git )/m).filter(Boolean));
      }
    }
    return Buffer.from(chunks.sort().join(''), 'latin1');
  }

  /** Repository-relative paths of the files in the index. */
  async trackedFiles(): Promise<string[]> {
    return (await this.out(['ls-files', '-z'])).split('\0').filter(Boolean);
  }

  /** Files that differ between two revisions. */
  async diffFiles(from: string, to: string): Promise<FileChange[]> {
    return parseNameStatus(await this.out(['diff', '-z', '-M', '--name-status', from, to, '--']));
  }

  /** Branch names (local and remote) that contain the commit. */
  async containingBranches(hash: string): Promise<string[]> {
    const stdout = await this.out(['branch', '--all', '--contains', hash, '--format=%(refname)']);
    return stdout
      .split('\n')
      .filter((name) => name && !name.endsWith('/HEAD'))
      .map((name) => name.replace(/^refs\/(heads|remotes)\//, ''));
  }

  async status(): Promise<LocalChange[]> {
    return parseStatus(await this.out(['status', '--porcelain=v1', '-z', '--untracked-files=all']));
  }

  private absoluteGitDir(): Promise<string> {
    this.gitDir ??= this.out(['rev-parse', '--absolute-git-dir']).then((s) => s.trim());
    return this.gitDir;
  }

  async operation(): Promise<RepoOperation | undefined> {
    const dir = await this.absoluteGitDir();
    if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) {
      return 'rebase';
    }
    if (existsSync(join(dir, 'MERGE_HEAD'))) {
      return 'merge';
    }
    if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) {
      return 'cherry-pick';
    }
    if (existsSync(join(dir, 'REVERT_HEAD'))) {
      return 'revert';
    }
    return undefined;
  }

  /** The message git prepared for an in-progress merge, cherry-pick or revert. */
  async preparedMessage(): Promise<string | undefined> {
    try {
      const raw = readFileSync(join(await this.absoluteGitDir(), 'MERGE_MSG'), 'utf8');
      return raw
        .split('\n')
        .filter((line) => !line.startsWith('#'))
        .join('\n')
        .trim();
    } catch {
      return undefined;
    }
  }

  /** File contents at a revision. */
  async show(ref: string, path: string): Promise<Buffer> {
    return (await this.run(this.root, ['show', `${ref}:${path}`], { binary: true })).stdout;
  }

  async userName(): Promise<string | undefined> {
    return this.optional(['config', 'user.name']);
  }

  /** Recently checked-out local branches, most recent first. */
  async recentBranches(): Promise<string[]> {
    const stdout = await this.optional(['reflog', '--format=%gs', '-n', '300']);
    return stdout ? parseRecentCheckouts(stdout) : [];
  }

  /** Commits that a push of the current branch would send. */
  async outgoingCommits(hasUpstream: boolean): Promise<Commit[]> {
    const range = hasUpstream ? ['@{upstream}..HEAD'] : ['HEAD', '--not', '--remotes'];
    return parseLog(await this.out(['log', '--max-count=100', `--format=${LOG_FORMAT}`, ...range]));
  }

  async lastCommitMessage(): Promise<string> {
    return (await this.out(['log', '-1', '--format=%B'])).replace(/\s+$/, '');
  }

  async commit(request: CommitRequest): Promise<void> {
    const message = request.message.trim();
    if (!message) {
      throw new Error('Commit message is empty.');
    }
    if (request.changes.some((c) => c.kind === 'conflict')) {
      // `git add` would silently mark them resolved, conflict markers included.
      throw new Error('Resolve the merge conflicts first (Merge…, Accept Yours/Theirs or Mark as Resolved).');
    }
    const operation = await this.operation();
    if (operation === 'merge' || operation === 'cherry-pick' || operation === 'revert') {
      // Partial commits are not allowed while an operation is in progress:
      // stage the selection and commit the whole index (which holds the merge).
      await this.stage(request.changes);
      await this.out(['commit', '-m', message]);
      return;
    }
    if (!request.changes.length && !request.amend) {
      throw new Error('No files selected to commit.');
    }

    // Build the commit in a temporary index (HEAD + the selected changes, as on
    // disk), so exactly the selection is committed whatever is staged. This is
    // what `git commit --only` does internally; `git commit` still runs hooks.
    const index = join(await this.absoluteGitDir(), 'gitcharm-commit.index');
    const env = { GIT_INDEX_FILE: index };
    try {
      const head = await this.optional(['rev-parse', '--verify', '--quiet', 'HEAD']);
      await this.out(head ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env });
      await this.stage(request.changes, env);
      await this.out(['commit', ...(request.amend ? ['--amend'] : []), '-m', message], { env });
    } finally {
      rmSync(index, { force: true });
      rmSync(`${index}.lock`, { force: true });
    }
    // Sync the real index with the new commit for the committed paths only.
    const paths = request.changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]));
    if (paths.length) {
      await this.withPathspecs(['reset', '--quiet', 'HEAD'], paths);
    }
  }

  /** Stages changes as they are on disk: deletions are removed, everything else is added. */
  async stage(changes: LocalChange[], env?: Record<string, string>): Promise<void> {
    const remove = changes.flatMap((c) =>
      c.kind === 'deleted' ? [c.path] : c.kind === 'renamed' && c.oldPath ? [c.oldPath] : [],
    );
    const add = changes.filter((c) => c.kind !== 'deleted').map((c) => c.path);
    if (remove.length) {
      await this.withPathspecs(['rm', '--cached', '--quiet', '--ignore-unmatch', '-r'], remove, env);
    }
    if (add.length) {
      await this.withPathspecs(['add'], add, env);
    }
  }

  /**
   * Discards local changes. Added files are un-added and kept on disk; a file
   * that was only untracked (`git rm --cached`) is re-tracked without touching
   * its contents on disk.
   */
  async rollback(changes: LocalChange[]): Promise<void> {
    const restore: string[] = [];
    const restoreIndexOnly: string[] = [];
    const unadd: string[] = [];
    for (const change of changes) {
      if (change.kind === 'added') {
        unadd.push(change.path);
      } else if (change.kind === 'renamed') {
        unadd.push(change.path);
        (existsSync(join(this.root, change.oldPath!)) ? restoreIndexOnly : restore).push(change.oldPath!);
      } else if (change.kind === 'deleted') {
        (existsSync(join(this.root, change.path)) ? restoreIndexOnly : restore).push(change.path);
      } else if (change.kind === 'modified') {
        restore.push(change.path);
      }
    }
    if (unadd.length) {
      await this.withPathspecs(['rm', '--cached', '--quiet', '-r'], unadd);
    }
    if (restoreIndexOnly.length) {
      await this.withPathspecs(['restore', '--source=HEAD', '--staged'], restoreIndexOnly);
    }
    if (restore.length) {
      await this.withPathspecs(['restore', '--source=HEAD', '--staged', '--worktree'], restore);
    }
  }

  // ---- stash ----

  async stashes(): Promise<StashEntry[]> {
    return parseStashList((await this.optional(['stash', 'list', `--format=${STASH_FORMAT}`])) ?? '');
  }

  async stashFiles(stash: StashEntry): Promise<StashFile[]> {
    const tracked = parseNameStatus(
      await this.out(['diff-tree', '-r', '-z', '-M', '--name-status', stash.base, stash.hash]),
    );
    const untracked: StashFile[] = stash.hasUntracked
      ? (await this.out(['ls-tree', '-r', '-z', '--name-only', `${stash.hash}^3`]))
          .split('\0')
          .filter(Boolean)
          .map((path) => ({ status: 'A', path, untracked: true }))
      : [];
    return [...tracked, ...untracked];
  }

  /**
   * Stashes local changes (with `changes`: only those files). Returns false
   * when there was nothing to stash.
   */
  async stash(options: { message?: string; includeUntracked: boolean; changes?: LocalChange[] }): Promise<boolean> {
    const top = () => this.optional(['rev-parse', '--verify', '--quiet', 'refs/stash']);
    const before = await top();
    const args = ['stash', 'push', ...(options.includeUntracked ? ['--include-untracked'] : [])];
    if (options.message?.trim()) {
      args.push('--message', options.message.trim());
    }
    try {
      if (options.changes) {
        const paths = options.changes.flatMap((c) => (c.oldPath ? [c.path, c.oldPath] : [c.path]));
        await this.restoreIndexEntries(paths);
        await this.withPathspecs(args, paths);
      } else {
        await this.out(args);
      }
    } catch (e) {
      if ((await top()) !== before) {
        throw new Error(
          `The stash was created, but git then failed, so the changes may also still be in the working tree: ${e instanceof Error ? e.message : e}`,
        );
      }
      throw e;
    }
    return (await top()) !== before;
  }

  /**
   * `git stash push <paths>` refuses paths missing from the index: staged
   * deletions and the old side of staged renames. Put those back in the index
   * from HEAD, which leaves them deleted in the working tree (what stash saves).
   */
  private async restoreIndexEntries(paths: string[]): Promise<void> {
    // (Neither command reads pathspecs from stdin; selections are small.)
    const indexed = new Set((await this.out(['ls-files', '--cached', '-z', '--', ...paths])).split('\0'));
    const missing = paths.filter((p) => !indexed.has(p));
    const inHead = missing.length
      ? new Set((await this.out(['ls-tree', '-r', '-z', '--name-only', 'HEAD', '--', ...missing])).split('\0'))
      : new Set<string>();
    const restore = missing.filter((p) => inHead.has(p));
    if (restore.length) {
      await this.withPathspecs(['reset', '--quiet', 'HEAD'], restore);
    }
  }

  /** Re-applies a stash; `pop` also drops it (git keeps it when there are conflicts). */
  async unstash(stash: StashEntry, pop: boolean): Promise<void> {
    if (pop) {
      await this.checkStash(stash);
      await this.out(['stash', 'pop', stash.ref]);
    } else {
      await this.out(['stash', 'apply', stash.hash]);
    }
  }

  async dropStash(stash: StashEntry): Promise<void> {
    await this.checkStash(stash);
    await this.out(['stash', 'drop', stash.ref]);
  }

  /** Creates a branch at the stash's base commit, applies the stash there and drops it. */
  async stashBranch(stash: StashEntry, branch: string): Promise<void> {
    await this.checkStash(stash);
    await this.out(['stash', 'branch', branch, stash.ref]);
  }

  async clearStashes(): Promise<void> {
    await this.out(['stash', 'clear']);
  }

  /** Stash indexes shift: make sure `stash@{n}` is still the stash the user picked. */
  private async checkStash(stash: StashEntry): Promise<void> {
    if ((await this.optional(['rev-parse', '--verify', '--quiet', stash.ref])) !== stash.hash) {
      throw new Error('The stash list changed. Refresh and try again.');
    }
  }

  // ---- blame ----

  /** `git blame` of a file at `revision`, or of `contents` (an editor's text) on top of HEAD. */
  async blame(path: string, source: { revision: string } | { contents: string }): Promise<BlameResult> {
    if ('revision' in source) {
      return parseBlame(await this.out(['blame', '--porcelain', source.revision, '--', path]));
    }
    return parseBlame(await this.out(['blame', '--porcelain', '--contents', '-', '--', path], { input: source.contents }));
  }

  // ---- interactive rebase ----

  /**
   * The commits an interactive rebase from `from` (inclusive) rewrites, oldest
   * first, and the commit they are replayed onto (undefined for the root).
   */
  async rebaseCommits(from: string): Promise<{ onto?: string; commits: RebaseCommit[] }> {
    const parent = (await this.out(['show', '-s', '--format=%P', from])).trim().split(' ')[0] || undefined;
    const range = parent ? [`${parent}..HEAD`] : ['HEAD'];
    const commits = parseFullLog(await this.out(['log', '--reverse', '--topo-order', `--format=${FULL_LOG_FORMAT}`, ...range, '--']));
    return { onto: parent, commits };
  }

  /** Runs `git rebase --interactive` with the given plan (oldest first) instead of an editor. */
  async interactiveRebase(onto: string | undefined, entries: RebaseEntry[]): Promise<void> {
    const gitDir = await this.absoluteGitDir();
    const dir = join(gitDir, 'gitcharm-rebase');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const todo = buildRebaseTodo(entries, (hash, message) => writeFileSync(join(dir, `message-${hash}.txt`), message));
    const todoFile = join(dir, 'todo');
    writeFileSync(todoFile, todo);
    // Kept while the rebase is stopped (conflicts, edit): continuing uses it too.
    writeFileSync(join(dir, 'editor.sh'), rebaseEditorScript(gitDir, dir));
    try {
      await this.out(['rebase', '--interactive', '--autostash', onto ?? '--root'], {
        env: { GIT_SEQUENCE_EDITOR: `cp ${shellQuote(todoFile)}`, ...this.rebaseEditor(dir) },
      });
    } finally {
      await this.cleanUpRebase(dir);
    }
  }

  /**
   * `git <operation> --continue/--skip/--abort`. A GitCharm rebase keeps
   * supplying the messages typed in the dialog when it is continued.
   */
  async sequencer(operation: RepoOperation, action: 'continue' | 'skip' | 'abort'): Promise<void> {
    const dir = join(await this.absoluteGitDir(), 'gitcharm-rebase');
    try {
      await this.out([operation, `--${action}`], { env: operation === 'rebase' ? this.rebaseEditor(dir) : undefined });
    } finally {
      await this.cleanUpRebase(dir);
    }
  }

  private rebaseEditor(dir: string): Record<string, string> | undefined {
    const script = join(dir, 'editor.sh');
    return existsSync(script) ? { GIT_EDITOR: `sh ${shellQuote(script)}` } : undefined;
  }

  /** Removes the dialog's messages once no rebase is in progress any more. */
  private async cleanUpRebase(dir: string): Promise<void> {
    if ((await this.operation()) !== 'rebase') {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private withPathspecs(args: string[], paths: string[], env?: Record<string, string>): Promise<string> {
    return this.out([...args, '--pathspec-from-file=-', '--pathspec-file-nul'], { input: paths.join('\0'), env });
  }
}
