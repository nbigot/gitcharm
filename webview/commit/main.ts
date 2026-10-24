import type { ChangeRef, CommitState, CommitTab, CommitToExtension, CommitToWebview } from '../../src/shared/protocol';
import type { LocalChange, LocalChangeKind, StashEntry, StashFile } from '../../src/shared/types';
import { $, basename, checkbox, dirname, esc, formatDate, icon } from '../common/dom';
import { separator, showMenu, type MenuItem } from '../common/menu';
import { makeSplitter } from '../common/splitter';
import { buildTree, flattenTree, itemsUnder, type DirNode } from '../common/tree';
import { connect } from '../common/vscode';

interface SavedState {
  message: string;
  amend: boolean;
  /** Message typed before Amend replaced it with the last commit's message. */
  draftBeforeAmend?: string;
  /** Per repository root: changed files the user unchecked (everything else is included). */
  excluded: Record<string, string[]>;
  /** Per repository root: unversioned files the user checked (they start unchecked). */
  includedUnversioned: Record<string, string[]>;
  collapsed: string[];
  groupByDir: boolean;
  /** Message pane height when it sits below the changes (narrow view). */
  messageHeight: number;
  /** Message pane width when it sits beside the changes (wide view, e.g. the bottom panel). */
  messageWidth?: number;
  tab: CommitTab;
  /** Hashes of the stashes whose files are shown. */
  expandedStashes: string[];
}

type GroupId = 'conflicts' | 'changes' | 'unversioned';

const GROUPS: { id: GroupId; label: string; kinds: LocalChangeKind[] }[] = [
  { id: 'conflicts', label: 'Merge Conflicts', kinds: ['conflict'] },
  { id: 'changes', label: 'Changes', kinds: ['modified', 'added', 'deleted', 'renamed'] },
  { id: 'unversioned', label: 'Unversioned Files', kinds: ['unversioned'] },
];

const OPERATION_TEXT: Record<string, string> = {
  merge: 'Merging. Resolve the conflicts, then commit to conclude the merge.',
  rebase: 'Rebasing. Resolve the conflicts, then continue.',
  'cherry-pick': 'Cherry-picking. Resolve the conflicts, then commit.',
  revert: 'Reverting. Resolve the conflicts, then commit.',
};

const vscode = connect<SavedState, CommitToExtension>();
const state: SavedState = {
  message: '',
  amend: false,
  excluded: {},
  includedUnversioned: {},
  collapsed: ['unversioned'],
  groupByDir: false,
  messageHeight: 140,
  tab: 'commit',
  expandedStashes: [],
  ...vscode.load(),
};
// State saved by older versions used plain arrays.
if (Array.isArray(state.excluded)) {
  state.excluded = {};
}
if (Array.isArray(state.includedUnversioned)) {
  state.includedUnversioned = {};
}
const save = () => vscode.save(state);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sends a file action, tagged with the repository the files belong to. */
function send(message: DistributiveOmit<Extract<CommitToExtension, { root: string }>, 'root'>): void {
  const root = repoState?.repo?.root;
  if (root) {
    vscode.post({ ...message, root } as CommitToExtension);
  }
}

let repoState: CommitState | undefined;
let busy = false;
let selectedKey: string | undefined;

document.getElementById('app')!.innerHTML = `
<div class="commit-root">
  <div class="tabs" id="tabs" role="tablist">
    <button class="tab" data-tab="commit" role="tab">Commit</button>
    <button class="tab" data-tab="stash" role="tab">Stash<span class="tab-count" id="stashCount"></span></button>
  </div>
  <div class="tab-page" id="stashPage" hidden>
    <div class="pane-toolbar">
      <button class="icon-btn" id="stashPageBtn" title="Stash Changes…">${icon('git-stash')}</button>
      <button class="icon-btn" id="stashRefreshBtn" title="Refresh">${icon('refresh')}</button>
      <span class="spacer"></span>
      <button class="icon-btn" id="clearStashesBtn" title="Clear All Stashes…">${icon('clear-all')}</button>
    </div>
    <div class="tree scroll" id="stashTree" tabindex="0"></div>
  </div>
  <div class="tab-page" id="commitPage">
    <div class="banner" id="banner" hidden></div>
    <div class="commit-body">
      <div class="changes-pane">
        <div class="pane-toolbar">
          <button class="icon-btn" id="refreshBtn" title="Refresh">${icon('refresh')}</button>
          <button class="icon-btn" id="rollbackBtn" title="Rollback checked files…">${icon('discard')}</button>
          <button class="icon-btn" id="diffBtn" title="Show Diff">${icon('diff')}</button>
          <button class="icon-btn" id="stashBtn" title="Stash Changes…">${icon('git-stash')}</button>
          <span class="spacer"></span>
          <button class="icon-btn" id="groupBtn" title="Group by directory">${icon('list-tree')}</button>
        </div>
        <div class="tree scroll" id="changes" tabindex="0"></div>
      </div>
      <div class="splitter splitter-y" id="splitMessageY"></div>
      <div class="splitter splitter-x" id="splitMessageX"></div>
      <div class="message-pane" id="messagePane">
        <div class="message-options">
          <label class="amend" id="amendLabel">${checkbox('off')}<span>Amend</span></label>
          <span class="spacer"></span>
          <span class="dim" id="summary"></span>
        </div>
        <textarea id="message" placeholder="Commit Message" spellcheck="true"></textarea>
        <div class="buttons">
          <button class="primary" id="commitBtn">Commit</button>
          <button class="secondary" id="pushBtn">Commit and Push…</button>
        </div>
      </div>
    </div>
  </div>
</div>`;

const banner = $('#banner');
const changesEl = $('#changes');
const messagePane = $('#messagePane');
const messageEl = $('#message') as HTMLTextAreaElement;
const amendLabel = $('#amendLabel');
const summary = $('#summary');
const commitBtn = $('#commitBtn') as HTMLButtonElement;
const pushBtn = $('#pushBtn') as HTMLButtonElement;
const groupBtn = $('#groupBtn');
const stashTree = $('#stashTree');
const stashCount = $('#stashCount');

messageEl.value = state.message;
// The stylesheet puts the message below the changes or, when the view is wide, beside them.
messagePane.style.setProperty('--message-height', `${state.messageHeight}px`);
if (state.messageWidth) {
  messagePane.style.setProperty('--message-width', `${state.messageWidth}px`);
}

makeSplitter($('#splitMessageY'), {
  axis: 'y',
  target: messagePane,
  after: true,
  min: 90,
  max: () => window.innerHeight / 2,
  cssVar: '--message-height',
  onResize: (h) => {
    state.messageHeight = h;
    save();
  },
});
makeSplitter($('#splitMessageX'), {
  axis: 'x',
  target: messagePane,
  after: true,
  min: 220,
  max: () => window.innerWidth - 200,
  cssVar: '--message-width',
  onResize: (w) => {
    state.messageWidth = w;
    save();
  },
});

// ---- inclusion ----

function changes(): LocalChange[] {
  return repoState?.changes ?? [];
}

function repoKey(): string {
  return repoState?.repo?.root ?? '';
}

function isIncluded(change: LocalChange): boolean {
  return change.kind === 'unversioned'
    ? (state.includedUnversioned[repoKey()] ?? []).includes(change.path)
    : !(state.excluded[repoKey()] ?? []).includes(change.path);
}

function setIncluded(list: LocalChange[], included: boolean): void {
  const excluded = new Set(state.excluded[repoKey()] ?? []);
  const unversioned = new Set(state.includedUnversioned[repoKey()] ?? []);
  for (const change of list) {
    if (change.kind === 'unversioned') {
      if (included) {
        unversioned.add(change.path);
      } else {
        unversioned.delete(change.path);
      }
    } else if (included) {
      excluded.delete(change.path);
    } else {
      excluded.add(change.path);
    }
  }
  // Bounded, oldest first out.
  state.excluded[repoKey()] = [...excluded].slice(-2000);
  state.includedUnversioned[repoKey()] = [...unversioned].slice(-2000);
  save();
  render();
}

function checkState(list: LocalChange[]): 'on' | 'off' | 'mixed' {
  const n = list.filter(isIncluded).length;
  return n === 0 ? 'off' : n === list.length ? 'on' : 'mixed';
}

function toggle(list: LocalChange[]): void {
  setIncluded(list, checkState(list) !== 'on');
}

// ---- rendering ----

type Row =
  | { kind: 'group'; key: string; group: (typeof GROUPS)[number]; items: LocalChange[]; expanded: boolean }
  | { kind: 'dir'; key: string; depth: number; dir: DirNode<LocalChange>; items: LocalChange[]; expanded: boolean }
  | { kind: 'file'; key: string; depth: number; change: LocalChange };

let rows: Row[] = [];

function buildRows(): Row[] {
  const result: Row[] = [];
  const collapsed = new Set(state.collapsed);
  for (const group of GROUPS) {
    const items = changes().filter((c) => group.kinds.includes(c.kind));
    if (!items.length && group.id !== 'changes') {
      continue;
    }
    const expanded = !collapsed.has(group.id);
    result.push({ kind: 'group', key: group.id, group, items, expanded });
    if (!expanded) {
      continue;
    }
    if (state.groupByDir) {
      const tree = buildTree(items.map((c) => ({ path: c.path, data: c })));
      const dirCollapsed = new Set(
        state.collapsed.filter((k) => k.startsWith(`${group.id}:`)).map((k) => k.slice(group.id.length + 1)),
      );
      for (const row of flattenTree(tree, dirCollapsed)) {
        if (row.kind === 'dir') {
          result.push({
            kind: 'dir',
            key: `${group.id}:${row.dir.path}`,
            depth: row.depth + 1,
            dir: row.dir,
            items: itemsUnder(row.dir),
            expanded: row.expanded,
          });
        } else {
          result.push({ kind: 'file', key: `${group.id}/${row.data.path}`, depth: row.depth + 1, change: row.data });
        }
      }
    } else {
      const sorted = [...items].sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
      for (const change of sorted) {
        result.push({ kind: 'file', key: `${group.id}/${change.path}`, depth: 1, change });
      }
    }
  }
  return result;
}

const KIND_LABEL: Record<LocalChangeKind, string> = {
  modified: 'modified',
  added: 'added',
  deleted: 'deleted',
  renamed: 'renamed',
  conflict: 'merge conflict',
  unversioned: 'unversioned',
};

function render(): void {
  rows = buildRows();
  groupBtn.classList.toggle('active', state.groupByDir);
  if (!repoState?.repo) {
    changesEl.innerHTML = '<div class="empty">No Git repository found in this workspace.</div>';
  } else {
    changesEl.innerHTML = rows
      .map((row, i) => {
        const selected = row.key === selectedKey ? ' selected' : '';
        if (row.kind === 'group') {
          const count = row.items.length;
          return (
            `<div class="tree-row group${selected}" data-n="${i}" style="--depth:0">` +
            icon(row.expanded ? 'chevron-down' : 'chevron-right', 'twisty') +
            (count ? checkbox(checkState(row.items)) : '') +
            `<span class="label">${row.group.label}</span>` +
            `<span class="hint">${count ? `${count} file${count === 1 ? '' : 's'}` : 'no changes'}</span></div>`
          );
        }
        if (row.kind === 'dir') {
          return (
            `<div class="tree-row${selected}" data-n="${i}" style="--depth:${row.depth}">` +
            icon(row.expanded ? 'chevron-down' : 'chevron-right', 'twisty') +
            checkbox(checkState(row.items)) +
            `${icon('folder', 'tree-icon')}<span class="label">${esc(row.dir.name)}</span>` +
            `<span class="hint">${row.items.length}</span></div>`
          );
        }
        const c = row.change;
        const dir = state.groupByDir ? '' : dirname(c.path);
        return (
          `<div class="tree-row file k-${esc(c.kind)}${selected}" data-n="${i}" style="--depth:${row.depth}" title="${esc(`${c.path} (${KIND_LABEL[c.kind]})`)}">` +
          '<span class="twisty-space"></span>' +
          checkbox(isIncluded(c) ? 'on' : 'off') +
          `${icon('file', 'tree-icon')}<span class="label">${esc(basename(c.path))}</span>` +
          (c.oldPath ? `<span class="hint">← ${esc(c.oldPath)}</span>` : '') +
          (dir ? `<span class="hint">${esc(dir)}</span>` : '') +
          '</div>'
        );
      })
      .join('');
  }
  renderBanner();
  renderFooter();
}

function renderBanner(): void {
  const op = repoState?.operation;
  banner.hidden = !op;
  if (!op) {
    return;
  }
  const buttons =
    op === 'rebase'
      ? '<button data-op="continue">Continue</button><button data-op="skip">Skip</button><button data-op="abort">Abort</button>'
      : '<button data-op="abort">Abort</button>';
  banner.innerHTML = `${icon('warning')}<span class="text">${OPERATION_TEXT[op]}</span><span class="banner-buttons">${buttons}</span>`;
}

function selectedChanges(): LocalChange[] {
  return changes().filter(isIncluded);
}

function toRef(change: LocalChange): ChangeRef {
  return { kind: change.kind, path: change.path };
}

function renderFooter(): void {
  const included = selectedChanges().length;
  const total = changes().length;
  summary.textContent = total ? `${included} of ${total} file${total === 1 ? '' : 's'} selected` : '';
  amendLabel.innerHTML = `${checkbox(state.amend ? 'on' : 'off')}<span>Amend</span>`;
  amendLabel.classList.toggle('disabled', !repoState?.hasCommits || !!repoState?.operation);
  const rebasing = repoState?.operation === 'rebase';
  messageEl.disabled = rebasing;
  messageEl.placeholder = rebasing ? 'The rebase keeps the original commit messages' : 'Commit Message';
  if (rebasing) {
    // The button resumes the rebase instead of committing.
    commitBtn.disabled = busy;
    commitBtn.textContent = 'Continue Rebase';
    pushBtn.hidden = true;
    commitBtn.title = 'Include the selected changes and continue the rebase';
    return;
  }
  pushBtn.hidden = false;
  // During a merge/cherry-pick/revert the index already holds the result, so no selection is needed.
  const concluding = !!repoState?.operation;
  const blocked = busy || !repoState?.repo || !messageEl.value.trim() || (!included && !state.amend && !concluding);
  commitBtn.disabled = blocked;
  pushBtn.disabled = blocked;
  commitBtn.textContent = state.amend ? 'Amend Commit' : 'Commit';
  pushBtn.textContent = state.amend ? 'Amend Commit and Push…' : 'Commit and Push…';
  const branch = repoState?.branch;
  commitBtn.title = branch ? `Commit to '${branch}' (⌘/Ctrl+Enter)` : 'Commit (⌘/Ctrl+Enter)';
}

// ---- interactions ----

function rowAt(e: Event): Row | undefined {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  return el ? rows[Number(el.dataset.n)] : undefined;
}

function rowChanges(row: Row): LocalChange[] {
  return row.kind === 'file' ? [row.change] : row.items;
}

function toggleExpanded(row: Row): void {
  if (row.kind === 'file') {
    return;
  }
  state.collapsed = state.collapsed.includes(row.key) ? state.collapsed.filter((k) => k !== row.key) : [...state.collapsed, row.key];
  save();
  render();
}

changesEl.addEventListener('click', (e) => {
  const row = rowAt(e);
  if (!row) {
    return;
  }
  selectedKey = row.key;
  const target = e.target as HTMLElement;
  if (target.closest('.cb')) {
    toggle(rowChanges(row));
  } else if (target.closest('.twisty') || row.kind !== 'file') {
    toggleExpanded(row);
  } else {
    render();
  }
});

changesEl.addEventListener('dblclick', (e) => {
  const row = rowAt(e);
  if (row?.kind === 'file' && !(e.target as HTMLElement).closest('.cb')) {
    send({ type: 'open', path: row.change.path, mode: 'diff' });
  }
});

changesEl.addEventListener('keydown', (e) => {
  const index = rows.findIndex((r) => r.key === selectedKey);
  const row = rows[index];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = rows[Math.max(0, Math.min(rows.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selectedKey = next.key;
      render();
      changesEl.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (row && e.key === ' ') {
    e.preventDefault();
    toggle(rowChanges(row));
  } else if (row?.kind === 'file' && e.key === 'Enter') {
    send({ type: 'open', path: row.change.path, mode: 'diff' });
  } else if (row && row.kind !== 'file' && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
    if (row.expanded !== (e.key === 'ArrowRight')) {
      toggleExpanded(row);
    }
  }
});

function contextItems(row: Row): MenuItem[] {
  const list = rowChanges(row);
  const paths = list.map((c) => c.path);
  const single = row.kind === 'file' ? row.change : undefined;
  const tracked = list.filter((c) => c.kind !== 'unversioned' && c.kind !== 'conflict');
  const unversioned = list.filter((c) => c.kind === 'unversioned');
  const items: MenuItem[] = [];
  if (single?.kind === 'conflict') {
    items.push(
      { label: 'Merge…', icon: 'git-merge', run: () => send({ type: 'resolve', path: single.path, how: 'merge' }) },
      { label: 'Accept Yours', icon: 'arrow-left', run: () => send({ type: 'resolve', path: single.path, how: 'yours' }) },
      { label: 'Accept Theirs', icon: 'arrow-right', run: () => send({ type: 'resolve', path: single.path, how: 'theirs' }) },
      { label: 'Mark as Resolved', icon: 'check', run: () => send({ type: 'addToVcs', paths: [single.path] }) },
      separator,
    );
  } else if (single && single.kind !== 'unversioned') {
    items.push({ label: 'Show Diff', icon: 'diff', run: () => send({ type: 'open', path: single.path, mode: 'diff' }) });
  }
  if (single && single.kind !== 'deleted') {
    items.push({ label: 'Jump to Source', icon: 'go-to-file', run: () => send({ type: 'open', path: single.path, mode: 'file' }) });
  }
  if (tracked.length) {
    items.push(separator, {
      label: 'Rollback…',
      icon: 'discard',
      run: () => send({ type: 'rollback', changes: tracked.map(toRef) }),
    });
  }
  if (unversioned.length) {
    items.push(
      separator,
      { label: 'Add to VCS', icon: 'add', run: () => send({ type: 'addToVcs', paths: unversioned.map((c) => c.path) }) },
      { label: 'Delete…', icon: 'trash', run: () => send({ type: 'delete', paths: unversioned.map((c) => c.path) }) },
    );
  }
  const stashable = list.filter((c) => c.kind !== 'conflict');
  if (stashable.length) {
    items.push(separator, {
      label: stashable.length === 1 ? 'Stash This File…' : `Stash These ${stashable.length} Files…`,
      icon: 'git-stash',
      run: () => send({ type: 'stash', changes: stashable.map(toRef), onlyThese: true }),
    });
  }
  if (single && single.kind !== 'unversioned' && single.kind !== 'added') {
    items.push(separator, { label: 'Show History', icon: 'history', run: () => send({ type: 'history', path: single.path }) });
  }
  if (single) {
    items.push({ label: 'Copy Path', icon: 'copy', run: () => vscode.post({ type: 'copy', text: single.path }) });
  } else if (paths.length) {
    items.push(separator, {
      label: checkState(list) === 'on' ? 'Exclude from Commit' : 'Include in Commit',
      icon: 'check',
      run: () => toggle(list),
    });
  }
  return items;
}

changesEl.addEventListener('contextmenu', (e) => {
  const row = rowAt(e);
  if (!row) {
    return;
  }
  e.preventDefault();
  selectedKey = row.key;
  render();
  const items = contextItems(row);
  if (items.length) {
    showMenu(e.clientX, e.clientY, items);
  }
});

banner.addEventListener('click', (e) => {
  const op = (e.target as HTMLElement).closest<HTMLElement>('[data-op]')?.dataset.op;
  if (op === 'continue') {
    send({ type: 'operation', action: op, changes: selectedChanges().map(toRef) });
  } else if (op === 'skip' || op === 'abort') {
    send({ type: 'operation', action: op });
  }
});

$('#refreshBtn').addEventListener('click', () => vscode.post({ type: 'refresh' }));
$('#rollbackBtn').addEventListener('click', () => {
  const tracked = selectedChanges().filter((c) => c.kind !== 'unversioned' && c.kind !== 'conflict');
  send({ type: 'rollback', changes: tracked.map(toRef) });
});
$('#diffBtn').addEventListener('click', () => {
  const row = rows.find((r) => r.key === selectedKey);
  const target = row?.kind === 'file' ? row.change : selectedChanges()[0];
  if (target) {
    send({ type: 'open', path: target.path, mode: 'diff' });
  }
});
$('#stashBtn').addEventListener('click', () => send({ type: 'stash', changes: selectedChanges().map(toRef) }));
groupBtn.addEventListener('click', () => {
  state.groupByDir = !state.groupByDir;
  save();
  render();
});

amendLabel.addEventListener('click', () => {
  if (amendLabel.classList.contains('disabled')) {
    return;
  }
  state.amend = !state.amend;
  if (state.amend) {
    state.draftBeforeAmend = messageEl.value;
    vscode.post({ type: 'requestLastMessage' });
  } else {
    messageEl.value = state.draftBeforeAmend ?? '';
    state.message = messageEl.value;
    state.draftBeforeAmend = undefined;
  }
  save();
  renderFooter();
});

messageEl.addEventListener('input', () => {
  state.message = messageEl.value;
  save();
  renderFooter();
});

function commit(push: boolean): void {
  if (commitBtn.disabled) {
    return;
  }
  if (repoState?.operation === 'rebase') {
    send({ type: 'operation', action: 'continue', changes: selectedChanges().map(toRef) });
    return;
  }
  send({
    type: 'commit',
    message: messageEl.value,
    amend: state.amend,
    changes: selectedChanges().map(toRef),
    push,
  });
}

messageEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    commit(false);
  }
});
commitBtn.addEventListener('click', () => commit(false));
pushBtn.addEventListener('click', () => commit(true));

// ---- tabs ----

function showTab(tab: CommitTab): void {
  state.tab = tab;
  save();
  for (const el of document.querySelectorAll<HTMLElement>('.tab')) {
    const active = el.dataset.tab === tab;
    el.classList.toggle('active', active);
    el.setAttribute('aria-selected', String(active));
  }
  $('#commitPage').hidden = tab !== 'commit';
  $('#stashPage').hidden = tab !== 'stash';
}

$('#tabs').addEventListener('click', (e) => {
  const tab = (e.target as HTMLElement).closest<HTMLElement>('.tab')?.dataset.tab as CommitTab | undefined;
  if (tab) {
    showTab(tab);
  }
});

// ---- stash tab ----

type StashRow =
  | { kind: 'stash'; key: string; stash: StashEntry; expanded: boolean }
  | { kind: 'file'; key: string; stash: StashEntry; file: StashFile }
  | { kind: 'note'; key: string; text: string };

/** Files of expanded stashes, loaded on demand (stashes never change). */
const stashFiles = new Map<string, { files?: StashFile[]; error?: string }>();
let stashRows: StashRow[] = [];
let selectedStashKey: string | undefined;

function stashes(): StashEntry[] {
  return repoState?.stashes ?? [];
}

function buildStashRows(): StashRow[] {
  const rows: StashRow[] = [];
  const expanded = new Set(state.expandedStashes);
  for (const stash of stashes()) {
    const open = expanded.has(stash.hash);
    rows.push({ kind: 'stash', key: stash.hash, stash, expanded: open });
    if (!open) {
      continue;
    }
    const loaded = stashFiles.get(stash.hash);
    if (!loaded?.files) {
      rows.push({ kind: 'note', key: `${stash.hash}:note`, text: loaded?.error ?? 'Loading…' });
      continue;
    }
    for (const file of [...loaded.files].sort((a, b) => a.path.localeCompare(b.path))) {
      rows.push({ kind: 'file', key: `${stash.hash}/${file.untracked ? '?' : ''}${file.path}`, stash, file });
    }
  }
  return rows;
}

function renderStashes(): void {
  stashRows = buildStashRows();
  const count = stashes().length;
  stashCount.textContent = count ? String(count) : '';
  if (!repoState?.repo) {
    stashTree.innerHTML = '<div class="empty">No Git repository found in this workspace.</div>';
    return;
  }
  if (!count) {
    stashTree.innerHTML = '<div class="empty">No stashes. Use Stash Changes… to put local changes aside.</div>';
    return;
  }
  stashTree.innerHTML = stashRows
    .map((row, i) => {
      const selected = row.key === selectedStashKey ? ' selected' : '';
      if (row.kind === 'note') {
        return `<div class="tree-row note" data-n="${i}" style="--depth:1"><span class="twisty-space"></span><span class="hint">${esc(row.text)}</span></div>`;
      }
      if (row.kind === 'stash') {
        const s = row.stash;
        const where = [s.ref, s.branch, formatDate(s.date)].filter(Boolean).join(' · ');
        return (
          `<div class="tree-row stash${selected}" data-n="${i}" style="--depth:0" title="${esc(`${s.message}\n${where}`)}">` +
          icon(row.expanded ? 'chevron-down' : 'chevron-right', 'twisty') +
          `${icon('git-stash', 'tree-icon')}<span class="label">${esc(s.message)}</span><span class="hint">${esc(where)}</span></div>`
        );
      }
      const f = row.file;
      const kind = f.untracked ? 'k-unversioned' : `s-${esc(f.status)}`;
      return (
        `<div class="tree-row file ${kind}${selected}" data-n="${i}" style="--depth:1" title="${esc(f.path + (f.untracked ? ' (unversioned)' : ''))}">` +
        `<span class="twisty-space"></span>${icon('file', 'tree-icon')}<span class="label">${esc(basename(f.path))}</span>` +
        (f.oldPath ? `<span class="hint">← ${esc(f.oldPath)}</span>` : '') +
        (dirname(f.path) ? `<span class="hint">${esc(dirname(f.path))}</span>` : '') +
        '</div>'
      );
    })
    .join('');
}

function toggleStash(stash: StashEntry): void {
  const open = state.expandedStashes.includes(stash.hash);
  state.expandedStashes = open ? state.expandedStashes.filter((h) => h !== stash.hash) : [...state.expandedStashes, stash.hash];
  save();
  if (!open && !stashFiles.get(stash.hash)?.files) {
    stashFiles.set(stash.hash, {});
    send({ type: 'stashFiles', hash: stash.hash });
  }
  renderStashes();
}

function stashRowAt(e: Event): StashRow | undefined {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  return el ? stashRows[Number(el.dataset.n)] : undefined;
}

stashTree.addEventListener('click', (e) => {
  const row = stashRowAt(e);
  if (!row || row.kind === 'note') {
    return;
  }
  selectedStashKey = row.key;
  if (row.kind === 'stash') {
    toggleStash(row.stash);
  } else {
    renderStashes();
  }
});

stashTree.addEventListener('dblclick', (e) => {
  const row = stashRowAt(e);
  if (row?.kind === 'file') {
    send({ type: 'stashOpen', stash: row.stash, file: row.file });
  }
});

stashTree.addEventListener('keydown', (e) => {
  const index = stashRows.findIndex((r) => r.key === selectedStashKey);
  const row = stashRows[index];
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    let next = index;
    do {
      next = Math.max(0, Math.min(stashRows.length - 1, next + step));
    } while (stashRows[next]?.kind === 'note' && next > 0 && next < stashRows.length - 1);
    if (stashRows[next] && stashRows[next].kind !== 'note') {
      selectedStashKey = stashRows[next].key;
      renderStashes();
      stashTree.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
    }
  } else if (row?.kind === 'file' && e.key === 'Enter') {
    send({ type: 'stashOpen', stash: row.stash, file: row.file });
  } else if (row?.kind === 'stash' && (e.key === 'Enter' || ((e.key === 'ArrowRight') !== row.expanded && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')))) {
    toggleStash(row.stash);
  }
});

stashTree.addEventListener('contextmenu', (e) => {
  const row = stashRowAt(e);
  if (!row || row.kind === 'note') {
    return;
  }
  e.preventDefault();
  selectedStashKey = row.key;
  renderStashes();
  const stash = row.stash;
  const act = (action: 'apply' | 'pop' | 'branch' | 'drop' | 'showChanges') => () => send({ type: 'stashAction', action, stash });
  const items: MenuItem[] =
    row.kind === 'file'
      ? [
          { label: 'Show Diff', icon: 'diff', run: () => send({ type: 'stashOpen', stash, file: row.file }) },
          { label: 'Copy Path', icon: 'copy', run: () => vscode.post({ type: 'copy', text: row.file.path }) },
          separator,
        ]
      : [];
  items.push(
    { label: 'Apply Stash', icon: 'git-stash-apply', hint: 'keep it in the list', run: act('apply') },
    { label: 'Pop Stash', icon: 'git-stash-pop', hint: 'apply and drop', run: act('pop') },
    { label: 'Unstash as New Branch…', icon: 'git-branch', run: act('branch') },
    separator,
    { label: 'Show Changes', icon: 'diff-multiple', run: act('showChanges') },
    { label: 'Copy Revision Number', icon: 'copy', run: () => vscode.post({ type: 'copy', text: stash.hash }) },
    separator,
    { label: 'Drop Stash…', icon: 'trash', run: act('drop') },
  );
  showMenu(e.clientX, e.clientY, items);
});

$('#stashPageBtn').addEventListener('click', () => send({ type: 'stash', changes: selectedChanges().map(toRef) }));
$('#stashRefreshBtn').addEventListener('click', () => vscode.post({ type: 'refresh' }));
$('#clearStashesBtn').addEventListener('click', () => send({ type: 'clearStashes' }));

// ---- messages ----

window.addEventListener('message', (event: MessageEvent<CommitToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'state': {
      repoState = message;
      // Unchecked files stay unchecked even if they briefly disappear (auto-stash,
      // smart checkout). Checked unversioned files are forgotten: the safe direction.
      const unversioned = new Set(message.changes.filter((c) => c.kind === 'unversioned').map((c) => c.path));
      state.includedUnversioned[repoKey()] = (state.includedUnversioned[repoKey()] ?? []).filter((p) => unversioned.has(p));
      if (!message.hasCommits || message.operation) {
        state.amend = false;
      }
      if (message.preparedMessage && !messageEl.value.trim()) {
        messageEl.value = message.preparedMessage;
        state.message = messageEl.value;
      }
      save();
      render();
      const hashes = new Set(message.stashes.map((st) => st.hash));
      for (const hash of stashFiles.keys()) {
        if (!hashes.has(hash)) {
          stashFiles.delete(hash);
        }
      }
      // Load the files of stashes left expanded last time.
      for (const hash of state.expandedStashes) {
        if (hashes.has(hash) && !stashFiles.has(hash)) {
          stashFiles.set(hash, {});
          send({ type: 'stashFiles', hash });
        }
      }
      renderStashes();
      return;
    }
    case 'lastMessage':
      if (state.amend) {
        messageEl.value = message.message;
        state.message = message.message;
        save();
        renderFooter();
      }
      return;
    case 'committed':
      messageEl.value = '';
      state.message = '';
      state.amend = false;
      state.draftBeforeAmend = undefined;
      // Files left unchecked stay unchecked; committed unversioned files are tracked now.
      state.includedUnversioned[repoKey()] = [];
      save();
      renderFooter();
      return;
    case 'busy':
      busy = message.busy;
      renderFooter();
      return;
    case 'focusMessage':
      showTab('commit');
      messageEl.focus();
      return;
    case 'showTab':
      showTab(message.tab);
      return;
    case 'stashFiles':
      stashFiles.set(message.hash, message.error ? { error: message.error } : { files: message.files });
      renderStashes();
      return;
  }
});

showTab(state.tab);
renderStashes();
render();
vscode.post({ type: 'ready' });
