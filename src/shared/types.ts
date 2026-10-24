// Model types shared by the extension host and the webviews.
// Keep this file free of `vscode` and Node imports.

export interface Commit {
  hash: string;
  parents: string[];
  author: string;
  email: string;
  /** Author date, unix seconds. */
  date: number;
  subject: string;
  /**
   * Text or author filter only: the commit's nearest ancestors in the list (or
   * a commit below it, when the path leaves the loaded page), which the graph
   * links it to. `parents` keeps the real parents.
   */
  graphParents?: string[];
}

/** `branch` = local branch, `remote` = remote-tracking branch. */
export type RefKind = 'branch' | 'remote' | 'tag';

export interface Ref {
  /** Short name: `main`, `origin/main`, `v1.0`. */
  name: string;
  /** Full name: `refs/heads/main`. */
  fullName: string;
  kind: RefKind;
  /** Commit the ref points at (peeled for annotated tags). */
  hash: string;
  /** Local branches: short name of the upstream, e.g. `origin/main`. */
  upstream?: string;
  /** Remote of the upstream (`origin`, `my/fork`), or `.` when it is a local branch. */
  upstreamRemote?: string;
  /** Branch name of the upstream on its remote, e.g. `main`. */
  upstreamBranch?: string;
  ahead?: number;
  behind?: number;
  /** Local branches: the upstream was deleted on the remote. */
  upstreamGone?: boolean;
  /** Remote branches: the remote name, e.g. `origin`. */
  remote?: string;
  /** Local branch checked out in this worktree. */
  isCurrent?: boolean;
}

export interface HeadInfo {
  /** Undefined for a repository without commits. */
  hash?: string;
  /** Undefined when HEAD is detached. */
  branch?: string;
}

export interface LogFilter {
  /** A branch/tag/revision or a range (`main..feature`). Undefined = all refs. */
  revision?: string;
  /** Human readable label for `revision` when it is a range. */
  revisionLabel?: string;
  text?: string;
  author?: string;
  /** Repository-relative files or folders (Paths filter, file history). */
  paths?: string[];
  /** Date filter: the last `days` days (1 = the last 24 hours). */
  days?: number;
  /** Date filter: committed on or after this day (`YYYY-MM-DD`, local time). */
  after?: string;
  /** Date filter: committed on or before this day (`YYYY-MM-DD`, local time). */
  before?: string;
}

export type ChangeStatus = 'A' | 'M' | 'D' | 'R' | 'C' | 'T' | 'U';

export interface FileChange {
  status: ChangeStatus;
  /** Repository-relative path (the new path for renames). */
  path: string;
  /** Previous path for renames and copies. */
  oldPath?: string;
}

export interface CommitDetails {
  hash: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  /** Full commit message. */
  message: string;
  /** Changes against the first parent (or the empty tree for a root commit). */
  files: FileChange[];
}

export type LocalChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'conflict' | 'unversioned';

export interface LocalChange {
  kind: LocalChangeKind;
  /** Repository-relative path. */
  path: string;
  /** Previous path for staged renames. */
  oldPath?: string;
}

export type RepoOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

export interface RepoSummary {
  root: string;
  name: string;
}

/** A file changed by several commits (multi-commit selection in the Log). */
export interface MultiFileChange extends FileChange {
  /** Revision before the first selected commit that touched the file; undefined when that commit added it. */
  base?: string;
  /** Last selected commit that touched the file. */
  last: string;
}

export interface StashEntry {
  /** Reflog name, `stash@{0}`. Shifts when stashes are added or dropped. */
  ref: string;
  hash: string;
  /** The commit the stash was made on. */
  base: string;
  /** Untracked files are stored in a third parent. */
  hasUntracked: boolean;
  date: number;
  /** Message without git's "On main:" / "WIP on main:" prefix. */
  message: string;
  branch?: string;
}

export interface StashFile extends FileChange {
  /** Stored as an untracked file (in the stash's third parent). */
  untracked?: boolean;
}

export type RebaseAction = 'pick' | 'reword' | 'edit' | 'squash' | 'fixup' | 'drop';

export interface RebaseEntry {
  hash: string;
  action: RebaseAction;
  /** New message for `reword`; with squash/fixup rows below it, the message of the combined commit. */
  message?: string;
}

/** A commit shown in the interactive rebase dialog. */
export interface RebaseCommit extends Commit {
  /** Full message. */
  message: string;
}
