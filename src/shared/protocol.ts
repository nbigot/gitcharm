// Messages exchanged between the extension host and the webviews.

import type {
  Commit,
  CommitDetails,
  FileChange,
  HeadInfo,
  LocalChange,
  LocalChangeKind,
  LogFilter,
  MultiFileChange,
  RebaseCommit,
  RebaseEntry,
  Ref,
  RepoOperation,
  RepoSummary,
  StashEntry,
  StashFile,
} from './types';

export type RefAction =
  | 'checkout'
  | 'newBranchFrom'
  | 'checkoutAndRebase'
  | 'compare'
  | 'rebaseOnto'
  | 'merge'
  | 'push'
  | 'rename'
  | 'delete';

export type CommitAction =
  | 'copyHash'
  | 'createBranch'
  | 'createTag'
  | 'checkout'
  | 'cherryPick'
  | 'revert'
  | 'reset'
  | 'undo'
  | 'editMessage'
  | 'showChanges'
  | 'interactiveRebase';

/** Actions on several commits selected in the Log. */
export type CommitsAction = 'cherryPick' | 'revert' | 'squash' | 'drop' | 'showChanges' | 'compare' | 'createPatch';

/** How to open a file of a commit. */
export type OpenMode = 'diff' | 'compareWithLocal' | 'revision' | 'file';

// ---- Log view ----

/** Messages about shown commits/refs name the repository they were loaded from. */
export type LogToExtension =
  | { type: 'ready' }
  | { type: 'load'; requestId: number; filter: LogFilter; maxCount: number }
  | { type: 'select'; root: string; hash: string }
  /** Several commits selected; `hashes` in Log order (newest first). */
  | { type: 'selectMany'; root: string; hashes: string[] }
  /**
   * `range`: a file of a multi-commit selection; the left side of the diff is
   * `range.base` (empty when undefined) instead of the commit's parent.
   */
  | { type: 'open'; root: string; hash: string; file: FileChange; mode: OpenMode; range?: { base?: string } }
  | { type: 'commitAction'; root: string; action: CommitAction; hash: string }
  | { type: 'commitsAction'; root: string; action: CommitsAction; hashes: string[] }
  | { type: 'refAction'; root: string; action: RefAction; ref: Ref }
  | { type: 'selectRepo'; root: string }
  | { type: 'fetch'; root: string }
  /** Paths filter, Select Folders…: `paths` are the selected ones. */
  | { type: 'pickPaths'; root: string; paths: string[] }
  | { type: 'copy'; text: string };

export interface LogData {
  type: 'log';
  requestId: number;
  root?: string;
  commits: Commit[];
  refs: Ref[];
  head: HeadInfo;
  hasMore: boolean;
  me?: string;
  error?: string;
}

export type LogToWebview =
  | { type: 'repos'; repos: RepoSummary[]; current?: string; pageSize: number }
  | LogData
  | { type: 'details'; hash: string; details?: CommitDetails; error?: string }
  | { type: 'multiDetails'; hashes: string[]; files: MultiFileChange[]; error?: string }
  | { type: 'contains'; hash: string; branches: string[] }
  | { type: 'setFilter'; filter: LogFilter; select?: string }
  /** The answer to `pickPaths` for repository `root`; empty for all paths. */
  | { type: 'pickedPaths'; root: string; paths: string[] }
  | { type: 'reload' };

// ---- Commit view ----

/**
 * Identifies one row of the Commit view. The same path can appear twice
 * (`git rm --cached`: deleted + unversioned), so the kind is part of the key.
 */
export interface ChangeRef {
  kind: LocalChangeKind;
  path: string;
}

/** Messages that act on files name the repository they were shown for. */
export type CommitToExtension =
  | { type: 'ready' }
  | { type: 'commit'; root: string; message: string; amend: boolean; changes: ChangeRef[]; push: boolean }
  | { type: 'requestLastMessage' }
  | { type: 'open'; root: string; path: string; mode: 'diff' | 'file' }
  | { type: 'rollback'; root: string; changes: ChangeRef[] }
  | { type: 'addToVcs'; root: string; paths: string[] }
  | { type: 'delete'; root: string; paths: string[] }
  | { type: 'history'; root: string; path: string }
  | { type: 'resolve'; root: string; path: string; how: 'yours' | 'theirs' | 'merge' }
  /** `changes`: selection to include before continuing a rebase. */
  | { type: 'operation'; root: string; action: 'continue' | 'skip' | 'abort'; changes?: ChangeRef[] }
  /** Stash Changes…; `changes`: the checked files, offered as "only the checked files". */
  | { type: 'stash'; root: string; changes: ChangeRef[]; onlyThese?: boolean }
  | { type: 'stashFiles'; root: string; hash: string }
  | { type: 'stashAction'; root: string; action: StashAction; stash: StashEntry }
  | { type: 'stashOpen'; root: string; stash: StashEntry; file: StashFile }
  | { type: 'clearStashes'; root: string }
  | { type: 'copy'; text: string }
  | { type: 'refresh' };

export type StashAction = 'apply' | 'pop' | 'branch' | 'drop' | 'showChanges';

export interface CommitState {
  type: 'state';
  repo?: RepoSummary;
  branch?: string;
  hasCommits: boolean;
  changes: LocalChange[];
  operation?: RepoOperation;
  /** Message git prepared for an in-progress merge/cherry-pick/revert. */
  preparedMessage?: string;
  stashes: StashEntry[];
}

export type CommitToWebview =
  | CommitState
  | { type: 'lastMessage'; message: string }
  | { type: 'committed' }
  | { type: 'busy'; busy: boolean }
  | { type: 'focusMessage' }
  | { type: 'stashFiles'; hash: string; files: StashFile[]; error?: string }
  | { type: 'showTab'; tab: CommitTab };

export type CommitTab = 'commit' | 'stash';

// ---- Interactive rebase dialog ----

/** `planId` names the plan the dialog showed, so a Start can't run a plan replaced meanwhile. */
export type RebaseToExtension = { type: 'ready' } | { type: 'start'; planId: number; entries: RebaseEntry[] } | { type: 'cancel' };

export interface RebaseInit {
  type: 'init';
  planId: number;
  branch: string;
  /** What the commits are replayed onto, for the title ("onto 1a2b3c4d" or "from the root"). */
  ontoLabel: string;
  /** Oldest first, the order they are applied in. */
  commits: RebaseCommit[];
  /** Initial plan (all `pick`, or prepared by Squash Commits…). */
  entries: RebaseEntry[];
}

export type RebaseToWebview = RebaseInit | { type: 'busy'; busy: boolean };
