import { layoutGraph, type GraphRow } from '../../src/graph/layout';
import type { CommitAction, CommitsAction, LogData, LogToExtension, LogToWebview, OpenMode } from '../../src/shared/protocol';
import { refActionItems } from '../../src/shared/refActions';
import type { Commit, CommitDetails, FileChange, LogFilter, MultiFileChange, Ref, RepoSummary } from '../../src/shared/types';
import { $, basename, debounce, esc, formatDate, formatFullDate, icon } from '../common/dom';
import { closeMenu, separator, showMenu, showMenuBelow, type MenuItem } from '../common/menu';
import { makeSplitter } from '../common/splitter';
import { buildTree, flattenTree, type TreeRow } from '../common/tree';
import { connect } from '../common/vscode';

interface SavedState {
  filter: LogFilter;
  branchesWidth: number;
  detailsWidth: number;
  infoHeight: number;
  filesAsTree: boolean;
  collapsedBranches: string[];
  collapsedFiles: string[];
  selected?: string;
  /** Widths of the resizable commit columns (the subject takes the rest). */
  columnWidths: Partial<Record<Column, number>>;
  hiddenColumns: Column[];
  /** Per repository root: recent Paths filter selections, latest first. */
  recentPaths: Record<string, string[][]>;
}

type Column = 'author' | 'date' | 'hash';
const COLUMNS: { id: Column; label: string; width: number }[] = [
  { id: 'author', label: 'Author', width: 150 },
  { id: 'date', label: 'Date', width: 136 },
  { id: 'hash', label: 'Hash', width: 86 },
];

/** A multi-commit selection loads the changes of at most this many commits. */
const MAX_MULTI = 300;

const ROW_HEIGHT = 22;
const LANE_WIDTH = 14;
const COLORS = 8;

const vscode = connect<SavedState, LogToExtension>();
const state: SavedState = {
  filter: {},
  branchesWidth: 220,
  detailsWidth: 380,
  infoHeight: 170,
  filesAsTree: true,
  collapsedBranches: ['tags'],
  collapsedFiles: [],
  columnWidths: {},
  hiddenColumns: [],
  recentPaths: {},
  ...vscode.load(),
};
// Saved before the Paths filter took several paths.
const { path: savedPath, ...savedFilter } = state.filter as LogFilter & { path?: string };
if (savedPath) {
  state.filter = { ...savedFilter, paths: [savedPath] };
}
const isMac = /Mac/.test(navigator.platform);
const save = () => vscode.save(state);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Sends an action about the shown data, tagged with the repository it was loaded from. */
function send(message: DistributiveOmit<Exclude<Extract<LogToExtension, { root: string }>, { type: 'selectRepo' }>, 'root'>): void {
  const root = data?.root;
  if (root) {
    vscode.post({ ...message, root } as LogToExtension);
  }
}

// ---- data ----
let repos: RepoSummary[] = [];
let currentRoot: string | undefined;
let pageSize = 2000;
let maxCount = pageSize;
let requestId = 0;
let loading = false;
let data: LogData | undefined;
let commits: Commit[] = [];
let graph: GraphRow[] = [];
let refsByHash = new Map<string, Ref[]>();
let indexByHash = new Map<string, number>();
/** The lead row: keyboard focus, and the commit whose details show when only one is selected. */
let selectedIndex = -1;
/** Where a Shift selection starts. */
let anchorIndex = -1;
/** Selected commits (hashes, so a selection survives reloads). */
let selection = new Set<string>();
let pendingSelect: string | undefined;
let details: CommitDetails | undefined;
/** Merged changes of a multi-commit selection. */
let multi: { hashes: string[]; files: MultiFileChange[]; error?: string } | undefined;
let contains: string[] | undefined;
let selectedFile: string | undefined;
let selectedBranchKey: string | undefined;

// ---- layout ----
document.getElementById('app')!.innerHTML = `
<div class="log-root">
  <section class="pane branches-pane" id="branchesPane">
    <div class="pane-toolbar">
      <div class="search-box">${icon('search')}<input id="branchSearch" type="text" placeholder="Search branches"></div>
    </div>
    <div class="tree scroll" id="branchTree" tabindex="0"></div>
  </section>
  <div class="splitter splitter-x" id="splitBranches"></div>
  <section class="pane log-pane" id="logPane">
    <div class="log-toolbar">
      <select id="repoSelect" class="repo-select" title="Repository" hidden></select>
      <div class="search-box grow">${icon('search')}<input id="textFilter" type="text" placeholder="Text or hash">
        <button class="icon-btn clear" id="clearText" title="Clear" hidden>${icon('close')}</button></div>
      <button class="filter-btn" id="branchFilter"></button>
      <button class="filter-btn" id="userFilter"></button>
      <button class="filter-btn" id="dateFilter"></button>
      <button class="filter-btn" id="pathsFilter"></button>
      <span class="spacer"></span>
      <button class="icon-btn" id="fetchBtn" title="Fetch">${icon('repo-fetch')}</button>
      <button class="icon-btn" id="refreshBtn" title="Refresh">${icon('refresh')}</button>
    </div>
    <div class="progress" id="progress" hidden></div>
    <div class="log-header" id="logHeader">
      <div class="col subject">Subject</div>
      ${COLUMNS.map((c) => `<div class="col ${c.id}"><span class="col-resizer" data-col="${c.id}" title="Drag to resize, double-click to reset"></span>${c.label}</div>`).join('')}
    </div>
    <div class="log-scroll scroll" id="logScroll" tabindex="0">
      <div id="logSpacer"><div id="logRows"></div></div>
      <div class="empty" id="logEmpty" hidden></div>
    </div>
  </section>
  <div class="splitter splitter-x" id="splitDetails"></div>
  <section class="pane details-pane" id="detailsPane">
    <div class="pane-toolbar">
      <span class="pane-title" id="changesTitle">Changes</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="diffAllBtn" title="Show all changes in a multi-file diff">${icon('diff-multiple')}</button>
      <button class="icon-btn" id="treeToggle" title="Group by directory">${icon('list-tree')}</button>
    </div>
    <div class="tree scroll" id="fileTree" tabindex="0"></div>
    <div class="splitter splitter-y" id="splitInfo"></div>
    <div class="commit-info scroll" id="commitInfo"></div>
  </section>
</div>`;

const branchesPane = $('#branchesPane');
const logPane = $('#logPane');
const logHeader = $('#logHeader');
const detailsPane = $('#detailsPane');
const branchTree = $('#branchTree');
const branchSearch = $('#branchSearch') as HTMLInputElement;
const repoSelect = $('#repoSelect') as HTMLSelectElement;
const textFilter = $('#textFilter') as HTMLInputElement;
const clearText = $('#clearText');
const branchFilterBtn = $('#branchFilter');
const userFilterBtn = $('#userFilter');
const dateFilterBtn = $('#dateFilter');
const pathsFilterBtn = $('#pathsFilter');
const progress = $('#progress');
const logScroll = $('#logScroll');
const logSpacer = $('#logSpacer');
const logRows = $('#logRows');
const logEmpty = $('#logEmpty');
const fileTree = $('#fileTree');
const commitInfo = $('#commitInfo');
const changesTitle = $('#changesTitle');
const treeToggle = $('#treeToggle');

branchesPane.style.width = `${state.branchesWidth}px`;
detailsPane.style.width = `${state.detailsWidth}px`;
commitInfo.style.height = `${state.infoHeight}px`;
textFilter.value = state.filter.text ?? '';
applyColumns();

makeSplitter($('#splitBranches'), {
  axis: 'x',
  target: branchesPane,
  min: 120,
  max: () => window.innerWidth / 2,
  onResize: (w) => {
    state.branchesWidth = w;
    save();
  },
});
makeSplitter($('#splitDetails'), {
  axis: 'x',
  target: detailsPane,
  after: true,
  min: 200,
  max: () => window.innerWidth / 2,
  onResize: (w) => {
    state.detailsWidth = w;
    save();
    renderRows();
  },
});
makeSplitter($('#splitInfo'), {
  axis: 'y',
  target: commitInfo,
  after: true,
  min: 60,
  max: () => detailsPane.clientHeight - 80,
  onResize: (h) => {
    state.infoHeight = h;
    save();
  },
});

// ---- loading ----

function load(reset: boolean): void {
  if (reset) {
    maxCount = pageSize;
  }
  loading = true;
  progress.hidden = false;
  requestId++;
  vscode.post({ type: 'load', requestId, filter: state.filter, maxCount });
  renderToolbar();
}

function setFilter(filter: LogFilter, select?: string): void {
  state.filter = filter;
  textFilter.value = filter.text ?? '';
  pendingSelect = select;
  save();
  load(true);
}

function updateFilter(patch: Partial<LogFilter>): void {
  const filter = { ...state.filter, ...patch };
  for (const key of Object.keys(filter) as (keyof LogFilter)[]) {
    const value = filter[key];
    if (!value || (Array.isArray(value) && !value.length)) {
      delete filter[key];
    }
  }
  if (!('revision' in patch) && !filter.revision) {
    delete filter.revisionLabel;
  }
  setFilter(filter);
}

function onLog(message: LogData): void {
  if (message.requestId !== requestId) {
    return;
  }
  const target = pendingSelect;
  if (target && !message.commits.some((c) => c.hash === target) && message.hasMore && maxCount < pageSize * 25) {
    // Navigating to an older commit: keep loading until it is in the list.
    maxCount += pageSize * 4;
    load(false);
    return;
  }
  loading = false;
  progress.hidden = true;
  const firstLoad = !data;
  const navigate = pendingSelect !== undefined;
  const previous = pendingSelect ?? commits[selectedIndex]?.hash ?? state.selected;
  const previousSelection = [...selection];
  const previousAnchor = commits[anchorIndex]?.hash;
  pendingSelect = undefined;
  data = message;
  commits = message.commits;
  // A text or author filter links each commit to the next listed ones (graphParents).
  graph = layoutGraph(commits.map((c) => ({ hash: c.hash, parents: c.graphParents ?? c.parents })));
  indexByHash = new Map(commits.map((c, i) => [c.hash, i]));
  refsByHash = new Map();
  for (const ref of message.refs) {
    const list = refsByHash.get(ref.hash) ?? [];
    list.push(ref);
    refsByHash.set(ref.hash, list);
  }
  logSpacer.style.height = `${commits.length * ROW_HEIGHT}px`;

  let index = previous !== undefined ? indexByHash.get(previous) : undefined;
  if (index === undefined && message.head.hash) {
    index = indexByHash.get(message.head.hash);
  }
  if (index === undefined && commits.length) {
    index = 0;
  }
  selectedIndex = -1;
  if (!navigate && previousSelection.length > 1 && previousSelection.every((h) => indexByHash.has(h))) {
    // A background reload keeps a multi-commit selection (commits don't change).
    selection = new Set(previousSelection);
    selectedIndex = index ?? indexByHash.get(previousSelection[0])!;
    // Row indexes moved if commits were added: find the Shift anchor again by hash.
    anchorIndex = previousAnchor !== undefined ? (indexByHash.get(previousAnchor) ?? -1) : -1;
  } else if (index !== undefined) {
    // Only jump to the selection when navigating; a background reload keeps the scroll position.
    select(index, { scroll: firstLoad || navigate });
  } else {
    selection = new Set();
    details = undefined;
    multi = undefined;
    renderDetails();
  }
  renderEmptyState();
  renderRows();
  renderBranches();
  renderToolbar();
}

function renderEmptyState(): void {
  let text = '';
  if (!currentRoot) {
    text = 'No Git repository found in this workspace.';
  } else if (data?.error) {
    text = data.error;
  } else if (!commits.length) {
    const f = state.filter;
    const filtered = f.text || f.author || f.paths || f.days || f.after || f.before || f.revision;
    text = filtered ? 'No commits matching the filters.' : 'No commits yet.';
  }
  logEmpty.hidden = !text;
  logEmpty.textContent = text;
}

// ---- commit list ----

function laneX(lane: number): number {
  return lane * LANE_WIDTH + LANE_WIDTH / 2;
}

function graphSvg(row: GraphRow, isHead: boolean): string {
  const width = row.width * LANE_WIDTH;
  const h = ROW_HEIGHT;
  const mid = h / 2;
  let lines = '';
  for (const edge of row.edges) {
    const x1 = laneX(edge.from);
    const x2 = laneX(edge.to);
    const [y1, y2] = edge.kind === 'top' ? [0, mid] : edge.kind === 'bottom' ? [mid, h] : [0, h];
    lines += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="c${edge.color % COLORS}"/>`;
  }
  const cx = laneX(row.lane);
  const node = isHead
    ? `<circle cx="${cx}" cy="${mid}" r="4.5" class="node head f${row.color % COLORS}"/>`
    : `<circle cx="${cx}" cy="${mid}" r="3.5" class="node f${row.color % COLORS}"/>`;
  return `<svg class="graph" width="${width}" height="${h}" viewBox="0 0 ${width} ${h}">${lines}${node}</svg>`;
}

interface Label {
  kind: 'current' | 'branch' | 'remote' | 'tag' | 'head';
  text: string;
  title: string;
}

/** Ref labels for a commit; a local branch and its upstream on the same commit are merged ("origin & main"). */
function labelsFor(hash: string): Label[] {
  const refs = refsByHash.get(hash) ?? [];
  const labels: Label[] = [];
  const used = new Set<string>();
  if (!data?.head.branch && data?.head.hash === hash) {
    labels.push({ kind: 'head', text: 'HEAD', title: 'HEAD (detached)' });
  }
  const locals = refs.filter((r) => r.kind === 'branch').sort((a, b) => Number(!!b.isCurrent) - Number(!!a.isCurrent));
  for (const ref of locals) {
    const upstream = ref.upstream && refs.find((r) => r.kind === 'remote' && r.name === ref.upstream);
    if (upstream) {
      used.add(upstream.name);
      labels.push({
        kind: ref.isCurrent ? 'current' : 'branch',
        text: `${upstream.remote} & ${ref.name}`,
        title: `${ref.name} and ${upstream.name}`,
      });
    } else {
      labels.push({ kind: ref.isCurrent ? 'current' : 'branch', text: ref.name, title: ref.name });
    }
  }
  for (const ref of refs) {
    if (ref.kind === 'remote' && !used.has(ref.name)) {
      labels.push({ kind: 'remote', text: ref.name, title: ref.name });
    }
  }
  for (const ref of refs) {
    if (ref.kind === 'tag') {
      labels.push({ kind: 'tag', text: ref.name, title: `tag ${ref.name}` });
    }
  }
  return labels;
}

const LABEL_ICONS: Record<Label['kind'], string> = {
  current: 'git-branch',
  branch: 'git-branch',
  remote: 'cloud',
  tag: 'tag',
  head: 'target',
};

function labelsHtml(hash: string): string {
  const labels = labelsFor(hash);
  if (!labels.length) {
    return '';
  }
  const shown = labels.slice(0, 3);
  const rest = labels.slice(3);
  return (
    '<span class="refs">' +
    shown
      .map(
        (l) =>
          `<span class="ref ref-${l.kind}" title="${esc(l.title)}">${icon(LABEL_ICONS[l.kind])}<span class="ref-text">${esc(l.text)}</span></span>`,
      )
      .join('') +
    (rest.length ? `<span class="ref ref-more" title="${esc(rest.map((l) => l.title).join('\n'))}">+${rest.length}</span>` : '') +
    '</span>'
  );
}

function rowHtml(i: number): string {
  const c = commits[i];
  const isHead = c.hash === data?.head.hash;
  const me = data?.me && c.author === data.me;
  return (
    `<div class="log-row${selection.has(c.hash) ? ' selected' : ''}${i === selectedIndex ? ' lead' : ''}${isHead ? ' head' : ''}" data-i="${i}" style="top:${i * ROW_HEIGHT}px">` +
    `<div class="col subject">${graphSvg(graph[i], isHead)}<span class="msg">${esc(c.subject)}</span>${labelsHtml(c.hash)}</div>` +
    `<div class="col author${me ? ' me' : ''}" title="${esc(`${c.author} <${c.email}>`)}">${esc(c.author)}</div>` +
    `<div class="col date">${formatDate(c.date)}</div>` +
    `<div class="col hash">${c.hash.slice(0, 8)}</div>` +
    '</div>'
  );
}

let renderQueued = false;
function renderRows(): void {
  const top = logScroll.scrollTop;
  const height = logScroll.clientHeight;
  const first = Math.max(0, Math.floor(top / ROW_HEIGHT) - 8);
  const last = Math.min(commits.length - 1, Math.ceil((top + height) / ROW_HEIGHT) + 8);
  let html = '';
  for (let i = first; i <= last; i++) {
    html += rowHtml(i);
  }
  logRows.innerHTML = html;
  if (data?.hasMore && !loading && last >= commits.length - 40) {
    maxCount += pageSize;
    load(false);
  }
}

function queueRender(): void {
  if (!renderQueued) {
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderRows();
    });
  }
}

logScroll.addEventListener('scroll', queueRender);
new ResizeObserver(queueRender).observe(logScroll);

const requestDetails = debounce((hash: string) => send({ type: 'select', hash }), 60);
const requestMulti = debounce((hashes: string[]) => send({ type: 'selectMany', hashes }), 120);

function scrollToRow(index: number): void {
  const top = index * ROW_HEIGHT;
  if (top < logScroll.scrollTop) {
    logScroll.scrollTop = top;
  } else if (top + ROW_HEIGHT > logScroll.scrollTop + logScroll.clientHeight) {
    logScroll.scrollTop = top + ROW_HEIGHT - logScroll.clientHeight;
  }
}

function updateSelectionClasses(): void {
  for (const el of logRows.querySelectorAll<HTMLElement>('.log-row')) {
    const i = Number(el.dataset.i);
    // Rows still on screen from a longer list (onLog selects before it re-renders).
    if (i >= commits.length) {
      continue;
    }
    el.classList.toggle('selected', selection.has(commits[i].hash));
    el.classList.toggle('lead', i === selectedIndex);
  }
}

/** Selected hashes in Log order (newest first). */
function selectedHashes(): string[] {
  return commits.filter((c) => selection.has(c.hash)).map((c) => c.hash);
}

/** Selects only this commit. */
function select(index: number, options: { scroll?: boolean } = {}): void {
  if (index < 0 || index >= commits.length) {
    return;
  }
  const hash = commits[index].hash;
  const changed = selectedIndex !== index || selection.size !== 1;
  selectedIndex = index;
  anchorIndex = index;
  selection = new Set([hash]);
  multi = undefined;
  state.selected = hash;
  save();
  updateSelectionClasses();
  if (options.scroll !== false) {
    scrollToRow(index);
  }
  if (changed || !details || details.hash !== hash) {
    if (details?.hash !== hash) {
      details = undefined;
      contains = undefined;
      renderDetails(true);
    }
    requestDetails(hash);
  }
}

/** Shift: select from the anchor to this row. */
function selectRange(index: number): void {
  if (anchorIndex < 0 || anchorIndex >= commits.length) {
    select(index);
    return;
  }
  const [from, to] = [Math.min(anchorIndex, index), Math.max(anchorIndex, index)];
  selection = new Set(commits.slice(from, to + 1).map((c) => c.hash));
  selectedIndex = index;
  selectionChanged();
}

/** ⌘/Ctrl: add or remove this row (the last selected row stays selected). */
function toggleSelected(index: number): void {
  const hash = commits[index].hash;
  if (selection.has(hash) && selection.size > 1) {
    selection.delete(hash);
  } else {
    selection.add(hash);
  }
  selectedIndex = index;
  anchorIndex = index;
  selectionChanged();
}

function selectionChanged(): void {
  if (selection.size === 1) {
    const [hash] = selection;
    const anchor = anchorIndex;
    select(indexByHash.get(hash)!, { scroll: false });
    anchorIndex = anchor;
    return;
  }
  updateSelectionClasses();
  multi = undefined;
  renderDetails(true);
  const hashes = selectedHashes();
  if (hashes.length <= MAX_MULTI) {
    requestMulti(hashes);
  }
}

function selectHash(hash: string): boolean {
  const index = indexByHash.get(hash);
  if (index === undefined) {
    return false;
  }
  select(index);
  logScroll.focus();
  return true;
}

logRows.addEventListener('mousedown', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.log-row');
  // Right clicks (and Ctrl+click on macOS) are handled by the context menu.
  if (!row || e.button !== 0 || (isMac && e.ctrlKey)) {
    return;
  }
  const i = Number(row.dataset.i);
  if (e.shiftKey) {
    selectRange(i);
  } else if (isMac ? e.metaKey : e.ctrlKey) {
    toggleSelected(i);
  } else {
    select(i, { scroll: false });
  }
});

logRows.addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.log-row');
  if (!row) {
    return;
  }
  e.preventDefault();
  const index = Number(row.dataset.i);
  const commit = commits[index];
  if (selection.size > 1 && selection.has(commit.hash)) {
    showMenu(e.clientX, e.clientY, multiCommitMenu(selectedHashes()));
    return;
  }
  select(index, { scroll: false });
  showMenu(e.clientX, e.clientY, commitMenu(commit));
});

function commitAction(action: CommitAction, hash: string): void {
  send({ type: 'commitAction', action, hash });
}

function commitsAction(action: CommitsAction, hashes: string[]): void {
  send({ type: 'commitsAction', action, hashes });
}

function multiCommitMenu(hashes: string[]): MenuItem[] {
  const n = hashes.length;
  const onBranch = !!data?.head.branch;
  return [
    { label: 'Copy Revision Numbers', icon: 'copy', run: () => vscode.post({ type: 'copy', text: hashes.join(' ') }) },
    { label: 'Create Patch…', icon: 'diff', run: () => commitsAction('createPatch', hashes) },
    { label: 'Show Changes', icon: 'diff-multiple', run: () => commitsAction('showChanges', hashes) },
    { label: 'Compare Versions', icon: 'git-compare', disabled: n !== 2, run: () => commitsAction('compare', hashes) },
    separator,
    { label: `Cherry-Pick ${n} Commits`, icon: 'git-commit', run: () => commitsAction('cherryPick', hashes) },
    { label: `Revert ${n} Commits`, icon: 'discard', run: () => commitsAction('revert', hashes) },
    separator,
    { label: 'Squash Commits…', icon: 'fold-up', disabled: !onBranch, run: () => commitsAction('squash', hashes) },
    { label: 'Drop Commits…', icon: 'trash', disabled: !onBranch, run: () => commitsAction('drop', hashes) },
  ];
}

function commitMenu(commit: Commit): MenuItem[] {
  const isHead = commit.hash === data?.head.hash && !!data?.head.branch;
  const branch = data?.head.branch ?? 'HEAD';
  return [
    { label: 'Copy Revision Number', icon: 'copy', run: () => vscode.post({ type: 'copy', text: commit.hash }) },
    { label: 'Create Patch…', icon: 'diff', run: () => commitsAction('createPatch', [commit.hash]) },
    { label: 'Show Changes', icon: 'diff-multiple', run: () => commitAction('showChanges', commit.hash) },
    separator,
    { label: 'New Branch…', icon: 'git-branch', run: () => commitAction('createBranch', commit.hash) },
    { label: 'New Tag…', icon: 'tag', run: () => commitAction('createTag', commit.hash) },
    separator,
    { label: 'Checkout Revision', icon: 'check', run: () => commitAction('checkout', commit.hash) },
    { label: 'Cherry-Pick', icon: 'git-commit', run: () => commitAction('cherryPick', commit.hash) },
    { label: 'Revert Commit', icon: 'discard', run: () => commitAction('revert', commit.hash) },
    { label: `Reset Current Branch ('${branch}') to Here…`, icon: 'history', run: () => commitAction('reset', commit.hash) },
    separator,
    { label: 'Undo Commit…', icon: 'reply', disabled: !isHead, run: () => commitAction('undo', commit.hash) },
    { label: 'Edit Commit Message…', icon: 'edit', disabled: !isHead, run: () => commitAction('editMessage', commit.hash) },
    {
      label: 'Drop Commit…',
      icon: 'trash',
      disabled: !data?.head.branch,
      run: () => commitsAction('drop', [commit.hash]),
    },
    {
      label: 'Interactively Rebase from Here…',
      icon: 'list-ordered',
      disabled: !data?.head.branch,
      run: () => commitAction('interactiveRebase', commit.hash),
    },
  ];
}

logScroll.addEventListener('keydown', (e) => {
  const page = Math.max(1, Math.floor(logScroll.clientHeight / ROW_HEIGHT) - 1);
  const moves: Record<string, number> = {
    ArrowDown: selectedIndex + 1,
    ArrowUp: selectedIndex - 1,
    PageDown: selectedIndex + page,
    PageUp: selectedIndex - page,
    Home: 0,
    End: commits.length - 1,
  };
  if (e.key in moves) {
    e.preventDefault();
    const target = Math.max(0, Math.min(commits.length - 1, moves[e.key]));
    if (e.shiftKey) {
      selectRange(target);
      scrollToRow(target);
    } else {
      select(target);
    }
  } else if ((e.metaKey || e.ctrlKey) && e.key === 'c' && selection.size) {
    vscode.post({ type: 'copy', text: selectedHashes().join(' ') });
  }
});

// ---- toolbar ----

function renderToolbar(): void {
  repoSelect.hidden = repos.length < 2;
  repoSelect.innerHTML = repos
    .map((r) => `<option value="${esc(r.root)}"${r.root === currentRoot ? ' selected' : ''}>${esc(r.name)}</option>`)
    .join('');
  clearText.hidden = !textFilter.value;

  const f = state.filter;
  const branchLabel = f.revisionLabel ?? f.revision;
  branchFilterBtn.classList.toggle('active', !!f.revision);
  branchFilterBtn.innerHTML = f.revision
    ? `${icon(f.revision.includes('..') ? 'git-compare' : 'git-branch')}<span class="value">${esc(branchLabel!)}</span>` +
      (f.revision.includes('..') ? `<span class="x swap" title="Swap sides">${icon('arrow-swap')}</span>` : '') +
      `<span class="x" title="Show all branches">${icon('close')}</span>`
    : `Branch: <span class="value">All</span>${icon('chevron-down')}`;
  branchFilterBtn.title = f.revision ? `Branch filter: ${f.revision}` : 'Filter by branch';

  userFilterBtn.classList.toggle('active', !!f.author);
  userFilterBtn.innerHTML = f.author
    ? `${icon('person')}<span class="value">${esc(f.author)}</span><span class="x" title="Show all users">${icon('close')}</span>`
    : `User: <span class="value">All</span>${icon('chevron-down')}`;

  const dates = dateLabel(f);
  dateFilterBtn.classList.toggle('active', !!dates);
  dateFilterBtn.innerHTML = dates
    ? `${icon('calendar')}<span class="value">${esc(dates)}</span><span class="x" title="Show all dates">${icon('close')}</span>`
    : `Date: <span class="value">All</span>${icon('chevron-down')}`;

  pathsFilterBtn.classList.toggle('active', !!f.paths);
  pathsFilterBtn.innerHTML = f.paths
    ? `${icon('folder')}<span class="value">${esc(f.paths.join(', '))}</span><span class="x" title="Show all paths">${icon('close')}</span>`
    : `Paths: <span class="value">All</span>${icon('chevron-down')}`;
  pathsFilterBtn.title = f.paths ? `Paths filter:\n${f.paths.join('\n')}` : 'Filter by paths';
}

/** The Date filter as the button shows it; undefined when off. */
function dateLabel(f: LogFilter): string | undefined {
  if (f.days) {
    return f.days === 1 ? 'Last 24 hours' : `Last ${f.days} days`;
  }
  const day = (value: string) => {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d).toLocaleDateString();
  };
  if (f.after && f.before) {
    return f.after === f.before ? day(f.after) : `${day(f.after)} – ${day(f.before)}`;
  }
  return f.after ? `Since ${day(f.after)}` : f.before ? `Until ${day(f.before)}` : undefined;
}

repoSelect.addEventListener('change', () => vscode.post({ type: 'selectRepo', root: repoSelect.value }));

const applyText = debounce(() => updateFilter({ text: textFilter.value.trim() || undefined }), 350);
textFilter.addEventListener('input', () => {
  clearText.hidden = !textFilter.value;
  applyText();
});
textFilter.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && textFilter.value) {
    textFilter.value = '';
    updateFilter({ text: undefined });
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    logScroll.focus();
  }
});
clearText.addEventListener('click', () => {
  textFilter.value = '';
  updateFilter({ text: undefined });
  textFilter.focus();
});

branchFilterBtn.addEventListener('click', (e) => {
  const x = (e.target as HTMLElement).closest('.x');
  if (x) {
    const rev = state.filter.revision;
    if (x.classList.contains('swap') && rev) {
      const [a, b] = rev.split('..');
      updateFilter({ revision: `${b}..${a}`, revisionLabel: `in ${a}, not in ${b}` });
    } else {
      updateFilter({ revision: undefined, revisionLabel: undefined });
    }
    return;
  }
  const refs = data?.refs ?? [];
  const pick = (revision?: string) => () => updateFilter({ revision, revisionLabel: undefined });
  const items: MenuItem[] = [
    { label: 'All', checked: !state.filter.revision, run: pick(undefined) },
    { label: 'HEAD', icon: 'target', checked: state.filter.revision === 'HEAD', run: pick('HEAD') },
    separator,
    ...refs
      .filter((r) => r.kind === 'branch')
      .map((r) => ({ label: r.name, icon: 'git-branch', checked: state.filter.revision === r.name, run: pick(r.name) })),
    separator,
    ...refs
      .filter((r) => r.kind === 'remote')
      .map((r) => ({ label: r.name, icon: 'cloud', checked: state.filter.revision === r.name, run: pick(r.name) })),
    separator,
    ...refs
      .filter((r) => r.kind === 'tag')
      .map((r) => ({ label: r.name, icon: 'tag', checked: state.filter.revision === r.name, run: pick(r.name) })),
  ];
  showMenuBelow(branchFilterBtn, items, { search: true, placeholder: 'Search branches', minWidth: 240 });
});

userFilterBtn.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.x')) {
    updateFilter({ author: undefined });
    return;
  }
  const authors = [...new Set(commits.map((c) => c.author))].sort((a, b) => a.localeCompare(b)).slice(0, 300);
  const pick = (author?: string) => () => updateFilter({ author });
  const items: MenuItem[] = [{ label: 'All', checked: !state.filter.author, run: pick(undefined) }];
  if (data?.me) {
    items.push({ label: `me (${data.me})`, icon: 'person', run: pick(data.me) });
  }
  items.push(separator, ...authors.map((a) => ({ label: a, checked: state.filter.author === a, run: pick(a) })));
  showMenuBelow(userFilterBtn, items, { search: true, placeholder: 'Search users', minWidth: 220 });
});

const noDates = { days: undefined, after: undefined, before: undefined };

dateFilterBtn.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.x')) {
    updateFilter(noDates);
    return;
  }
  const f = state.filter;
  const last = (days: number) => () => updateFilter({ ...noDates, days });
  showMenuBelow(
    dateFilterBtn,
    [
      { label: 'All', checked: !dateLabel(f), run: () => updateFilter(noDates) },
      { label: 'Select…', icon: 'calendar', checked: !!(f.after || f.before), run: showDatePicker },
      separator,
      { label: 'Last 24 Hours', checked: f.days === 1, run: last(1) },
      { label: 'Last 7 Days', checked: f.days === 7, run: last(7) },
    ],
    { minWidth: 180 },
  );
});

/** Date filter, Select…: a period between two days, both included. */
function showDatePicker(): void {
  closeMenu();
  const el = document.createElement('form');
  el.className = 'gc-menu date-picker';
  el.innerHTML =
    `<label>After<input type="date" name="after" value="${esc(state.filter.after ?? '')}"></label>` +
    `<label>Before<input type="date" name="before" value="${esc(state.filter.before ?? '')}"></label>` +
    '<div class="buttons"><button type="button" class="secondary" data-cancel>Cancel</button><button class="primary">OK</button></div>';
  document.body.appendChild(el);
  const after = el.elements.namedItem('after') as HTMLInputElement;
  const before = el.elements.namedItem('before') as HTMLInputElement;
  const close = () => {
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    el.remove();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) {
      close();
    }
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  };
  document.addEventListener('mousedown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  el.querySelector('[data-cancel]')!.addEventListener('click', close);
  el.addEventListener('submit', (e) => {
    e.preventDefault();
    close();
    // Dates are YYYY-MM-DD, so they compare as strings.
    const [from, to] = [after.value, before.value].sort((a, b) => (a && b ? a.localeCompare(b) : 0));
    updateFilter({ ...noDates, after: from || undefined, before: to || undefined });
  });
  const rect = dateFilterBtn.getBoundingClientRect();
  el.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - el.offsetWidth - 4))}px`;
  el.style.top = `${rect.bottom + 2}px`;
  after.focus();
}

pathsFilterBtn.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.x')) {
    updateFilter({ paths: undefined });
    return;
  }
  const current = (state.filter.paths ?? []).join('\n');
  const items: MenuItem[] = [
    { label: 'All', checked: !current, run: () => updateFilter({ paths: undefined }) },
    { label: 'Select Folders…', icon: 'folder-opened', run: () => send({ type: 'pickPaths', paths: state.filter.paths ?? [] }) },
  ];
  const recent = state.recentPaths[data?.root ?? ''] ?? [];
  if (recent.length) {
    items.push(
      separator,
      ...recent.map((paths) => ({
        label: paths.join(', '),
        checked: paths.join('\n') === current,
        run: () => setPaths(paths),
      })),
    );
  }
  showMenuBelow(pathsFilterBtn, items, { minWidth: 200 });
});

function setPaths(paths: string[]): void {
  const root = data?.root;
  if (root && paths.length) {
    const key = paths.join('\n');
    const recent = (state.recentPaths[root] ?? []).filter((p) => p.join('\n') !== key);
    state.recentPaths[root] = [paths, ...recent].slice(0, 5);
  }
  updateFilter({ paths });
}

$('#fetchBtn').addEventListener('click', () => send({ type: 'fetch' }));
$('#refreshBtn').addEventListener('click', () => load(false));

// ---- branches tree ----

type BranchNode =
  | { kind: 'head' }
  | { kind: 'group'; key: string; label: string; icon: string; count: number }
  | { kind: 'dir'; key: string; depth: number; name: string; expanded: boolean }
  | { kind: 'ref'; key: string; depth: number; ref: Ref; name: string };

let branchNodes: BranchNode[] = [];

function refRows(refs: Ref[], collapsedKeys: ReadonlySet<string>, keyPrefix: string, depth: number, strip = ''): BranchNode[] {
  const collapsed = new Set([...collapsedKeys].filter((k) => k.startsWith(keyPrefix)).map((k) => k.slice(keyPrefix.length)));
  const tree = buildTree(refs.map((ref) => ({ path: ref.name.slice(strip.length), data: ref })));
  return flattenTree(tree, collapsed).map((row: TreeRow<Ref>) =>
    row.kind === 'dir'
      ? { kind: 'dir', key: keyPrefix + row.dir.path, depth: depth + row.depth, name: row.dir.name, expanded: row.expanded }
      : { kind: 'ref', key: row.data.fullName, depth: depth + row.depth, ref: row.data, name: row.name },
  );
}

function renderBranches(): void {
  const refs = data?.refs ?? [];
  const query = branchSearch.value.trim().toLowerCase();
  const match = (r: Ref) => !query || r.name.toLowerCase().includes(query);
  const collapsed = new Set(query ? [] : state.collapsedBranches);
  const nodes: BranchNode[] = [];
  if (data?.head.hash || data?.head.branch) {
    nodes.push({ kind: 'head' });
  }
  const local = refs.filter((r) => r.kind === 'branch' && match(r));
  const remote = refs.filter((r) => r.kind === 'remote' && match(r));
  const tags = refs.filter((r) => r.kind === 'tag' && match(r));

  const group = (key: string, label: string, iconName: string, items: Ref[], children: () => BranchNode[]) => {
    if (!items.length) {
      return;
    }
    nodes.push({ kind: 'group', key, label, icon: iconName, count: items.length });
    if (!collapsed.has(key)) {
      nodes.push(...children());
    }
  };
  group('local', 'Local', 'git-branch', local, () => refRows(local, collapsed, 'local:', 1));
  group('remote', 'Remote', 'cloud', remote, () => {
    const rows: BranchNode[] = [];
    for (const name of [...new Set(remote.map((r) => r.remote ?? ''))].sort()) {
      const key = `remote:${name}`;
      rows.push({ kind: 'dir', key, depth: 1, name, expanded: !collapsed.has(key) });
      if (!collapsed.has(key)) {
        rows.push(...refRows(remote.filter((r) => r.remote === name), collapsed, `${key}/`, 2, `${name}/`));
      }
    }
    return rows;
  });
  group('tags', 'Tags', 'tag', tags, () => refRows(tags, collapsed, 'tags:', 1));
  branchNodes = nodes;

  const filterRev = state.filter.revision;
  branchTree.innerHTML = nodes
    .map((node, i) => {
      if (node.kind === 'head') {
        const label = data?.head.branch ?? `detached at ${data?.head.hash?.slice(0, 8)}`;
        return `<div class="tree-row${filterRev === 'HEAD' ? ' selected' : ''}" data-n="${i}" style="--depth:0">${icon('target', 'tree-icon head-icon')}<span class="label">HEAD (Current Branch)</span><span class="hint">${esc(label)}</span></div>`;
      }
      if (node.kind === 'group') {
        const open = !collapsed.has(node.key);
        return `<div class="tree-row group" data-n="${i}" style="--depth:0">${icon(open ? 'chevron-down' : 'chevron-right', 'twisty')}<span class="label">${node.label}</span><span class="hint">${node.count}</span></div>`;
      }
      if (node.kind === 'dir') {
        return `<div class="tree-row" data-n="${i}" style="--depth:${node.depth}">${icon(node.expanded ? 'chevron-down' : 'chevron-right', 'twisty')}${icon('folder', 'tree-icon')}<span class="label">${esc(node.name)}</span></div>`;
      }
      const ref = node.ref;
      const sync = [ref.ahead ? `↑${ref.ahead}` : '', ref.behind ? `↓${ref.behind}` : ''].filter(Boolean).join(' ');
      const selected = filterRev === ref.name || selectedBranchKey === node.key;
      const iconName = ref.kind === 'tag' ? 'tag' : ref.isCurrent ? 'star-full' : 'git-branch';
      return (
        `<div class="tree-row branch${selected ? ' selected' : ''}${ref.isCurrent ? ' current' : ''}" data-n="${i}" style="--depth:${node.depth}" title="${esc(ref.name + (ref.upstream ? ` → ${ref.upstream}` : ''))}">` +
        `<span class="twisty-space"></span>${icon(iconName, 'tree-icon ' + ref.kind + '-icon')}<span class="label">${esc(node.name)}</span>` +
        (sync ? `<span class="sync">${sync}</span>` : '') +
        (ref.upstreamGone ? '<span class="hint">gone</span>' : '') +
        '</div>'
      );
    })
    .join('');
}

branchSearch.addEventListener('input', renderBranches);
branchSearch.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    branchSearch.value = '';
    renderBranches();
  }
});

function toggleCollapsed(list: string[], key: string): string[] {
  return list.includes(key) ? list.filter((k) => k !== key) : [...list, key];
}

branchTree.addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  if (!row) {
    return;
  }
  const node = branchNodes[Number(row.dataset.n)];
  if (node.kind === 'group' || node.kind === 'dir') {
    state.collapsedBranches = toggleCollapsed(state.collapsedBranches, node.key);
    save();
    renderBranches();
  } else if (node.kind === 'head') {
    selectedBranchKey = undefined;
    updateFilter({ revision: state.filter.revision === 'HEAD' ? undefined : 'HEAD', revisionLabel: undefined });
  } else {
    selectedBranchKey = node.key;
    updateFilter({ revision: state.filter.revision === node.ref.name ? undefined : node.ref.name, revisionLabel: undefined });
  }
});

branchTree.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  const node = row && branchNodes[Number(row.dataset.n)];
  if (node?.kind === 'ref') {
    // Navigate: show everything and jump to the branch head.
    setFilter({ ...state.filter, revision: undefined, revisionLabel: undefined }, node.ref.hash);
  }
});

branchTree.addEventListener('contextmenu', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  const node = row && branchNodes[Number(row.dataset.n)];
  if (!node || node.kind !== 'ref') {
    return;
  }
  e.preventDefault();
  const ref = node.ref;
  const items: MenuItem[] = [];
  if (ref.kind === 'tag') {
    items.push(
      { label: 'Checkout', icon: 'check', run: () => send({ type: 'refAction', action: 'checkout', ref }) },
      { label: `New Branch from '${ref.name}'…`, icon: 'add', run: () => send({ type: 'refAction', action: 'newBranchFrom', ref }) },
      separator,
      { label: 'Delete Tag', icon: 'trash', run: () => send({ type: 'refAction', action: 'delete', ref }) },
    );
  } else {
    for (const item of refActionItems(ref, data?.head.branch)) {
      if (item.group) {
        items.push(separator);
      }
      items.push({ label: item.label, icon: item.icon, run: () => send({ type: 'refAction', action: item.action, ref }) });
    }
  }
  items.push(separator, {
    label: 'Navigate Log to Branch Head',
    icon: 'go-to-file',
    run: () => setFilter({ ...state.filter, revision: undefined, revisionLabel: undefined }, ref.hash),
  });
  showMenu(e.clientX, e.clientY, items);
});

// ---- details ----

const STATUS_NAMES: Record<string, string> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type changed',
  U: 'unmerged',
};

let fileRows: TreeRow<FileChange>[] = [];

function renderDetails(loadingDetails = false): void {
  const selectedCount = selection.size;
  const files: FileChange[] | undefined = selectedCount > 1 ? multi?.files : details?.files;
  if (!files) {
    fileRows = [];
    changesTitle.textContent = 'Changes';
    const tooMany = selectedCount > MAX_MULTI ? `Select at most ${MAX_MULTI} commits to see their changes.` : '';
    const empty = tooMany || multi?.error || (loadingDetails ? '' : commits.length ? 'Select a commit to see its changes.' : '');
    fileTree.innerHTML = empty ? `<div class="empty">${esc(empty)}</div>` : '';
    renderCommitInfo();
    return;
  }
  changesTitle.textContent =
    `${files.length} file${files.length === 1 ? '' : 's'} changed` + (selectedCount > 1 ? ` in ${selectedCount} commits` : '');
  if (state.filesAsTree) {
    const tree = buildTree(files.map((f) => ({ path: f.path, data: f })));
    fileRows = flattenTree(tree, new Set(state.collapsedFiles));
  } else {
    fileRows = [...files]
      .sort((a, b) => basename(a.path).localeCompare(basename(b.path)))
      .map((f): TreeRow<FileChange> => ({ kind: 'item', depth: 0, name: basename(f.path), path: f.path, data: f }));
  }
  treeToggle.classList.toggle('active', state.filesAsTree);
  fileTree.innerHTML = fileRows.length
    ? fileRows
        .map((row, i) => {
          if (row.kind === 'dir') {
            return `<div class="tree-row" data-n="${i}" style="--depth:${row.depth}">${icon(row.expanded ? 'chevron-down' : 'chevron-right', 'twisty')}${icon('folder', 'tree-icon')}<span class="label">${esc(row.dir.name)}</span></div>`;
          }
          const f = row.data;
          const dir = state.filesAsTree ? '' : f.path.slice(0, -row.name.length - 1);
          return (
            `<div class="tree-row file s-${f.status}${selectedFile === f.path ? ' selected' : ''}" data-n="${i}" style="--depth:${row.depth}" title="${esc(`${f.path} (${STATUS_NAMES[f.status] ?? f.status})`)}">` +
            `<span class="twisty-space"></span>${icon('file', 'tree-icon')}<span class="label">${esc(row.name)}</span>` +
            (f.oldPath ? `<span class="hint">← ${esc(f.oldPath)}</span>` : '') +
            (dir ? `<span class="hint">${esc(dir)}</span>` : '') +
            '</div>'
          );
        })
        .join('')
    : `<div class="empty">${selectedCount > 1 ? 'No changes left: the commits cancel each other out.' : 'No changes (empty commit).'}</div>`;
  renderCommitInfo();
}

function renderCommitInfo(): void {
  if (selection.size > 1) {
    const hashes = selectedHashes();
    commitInfo.innerHTML =
      `<div class="ci-subject">${hashes.length} commits selected</div>` +
      hashes
        .slice(0, 200)
        .map((hash) => {
          const c = commits[indexByHash.get(hash)!];
          return (
            `<div class="ci-item"><a class="ci-parent" data-hash="${hash}" title="Show only this commit">${hash.slice(0, 8)}</a> ` +
            `${esc(c.subject)} <span class="dim">${esc(c.author)}, ${esc(formatDate(c.date))}</span></div>`
          );
        })
        .join('') +
      (hashes.length > 200 ? '<div class="dim">…</div>' : '');
    return;
  }
  if (!details) {
    commitInfo.innerHTML = '';
    return;
  }
  const d = details;
  const [subject, ...bodyLines] = d.message.split('\n');
  const body = bodyLines.join('\n').trim();
  const committedSeparately = d.committer !== d.author || Math.abs(d.committerDate - d.authorDate) > 60;
  const branches = contains
    ? contains.length
      ? `In ${contains.length} branch${contains.length === 1 ? '' : 'es'}: ${contains.slice(0, 12).map(esc).join(', ')}${contains.length > 12 ? ', …' : ''}`
      : 'Not in any branch'
    : 'Looking for branches…';
  commitInfo.innerHTML =
    `<div class="ci-subject">${esc(subject)}</div>` +
    (body ? `<div class="ci-body">${esc(body)}</div>` : '') +
    '<div class="ci-meta">' +
    `<div><a class="ci-hash" title="Copy full hash" data-copy="${d.hash}">${d.hash.slice(0, 10)}</a> ` +
    `<b>${esc(d.author)}</b> <span class="dim">&lt;${esc(d.authorEmail)}&gt;</span> on ${esc(formatFullDate(d.authorDate))}</div>` +
    (committedSeparately
      ? `<div class="dim">committed by ${esc(d.committer)} on ${esc(formatFullDate(d.committerDate))}</div>`
      : '') +
    (d.parents.length
      ? `<div class="dim">${d.parents.length > 1 ? 'Merge of' : 'Parent'}: ${d.parents
          .map((p) => `<a class="ci-parent" data-hash="${p}">${p.slice(0, 8)}</a>`)
          .join(', ')}${d.parents.length > 1 ? ' — changes shown against the first parent' : ''}</div>`
      : '<div class="dim">Root commit</div>') +
    `<div class="dim">${branches}</div>` +
    '</div>';
}

commitInfo.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  if (target.dataset.copy) {
    vscode.post({ type: 'copy', text: target.dataset.copy });
  } else if (target.dataset.hash) {
    if (!selectHash(target.dataset.hash)) {
      setFilter({}, target.dataset.hash);
    }
  }
});

function openFile(file: FileChange, mode: OpenMode): void {
  if (selection.size > 1 && multi) {
    // The file as of the last selected commit that touched it, against before the first one.
    const change = file as MultiFileChange;
    send({ type: 'open', hash: change.last, file, mode, range: { base: change.base } });
  } else if (details) {
    send({ type: 'open', hash: details.hash, file, mode });
  }
}

function fileAt(e: Event): TreeRow<FileChange> | undefined {
  const row = (e.target as HTMLElement).closest<HTMLElement>('.tree-row');
  return row ? fileRows[Number(row.dataset.n)] : undefined;
}

fileTree.addEventListener('click', (e) => {
  const row = fileAt(e);
  if (!row) {
    return;
  }
  if (row.kind === 'dir') {
    state.collapsedFiles = toggleCollapsed(state.collapsedFiles, row.dir.path);
    save();
  } else {
    selectedFile = row.data.path;
  }
  renderDetails();
});

fileTree.addEventListener('dblclick', (e) => {
  const row = fileAt(e);
  if (row?.kind === 'item') {
    openFile(row.data, 'diff');
  }
});

fileTree.addEventListener('keydown', (e) => {
  const items = fileRows.filter((r): r is Extract<TreeRow<FileChange>, { kind: 'item' }> => r.kind === 'item');
  const index = items.findIndex((r) => r.data.path === selectedFile);
  if (e.key === 'Enter' && index >= 0) {
    openFile(items[index].data, 'diff');
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, index + (e.key === 'ArrowDown' ? 1 : -1)))];
    if (next) {
      selectedFile = next.data.path;
      renderDetails();
    }
  }
});

fileTree.addEventListener('contextmenu', (e) => {
  const row = fileAt(e);
  if (row?.kind !== 'item') {
    return;
  }
  e.preventDefault();
  const file = row.data;
  selectedFile = file.path;
  renderDetails();
  showMenu(e.clientX, e.clientY, [
    { label: 'Show Diff', icon: 'diff', run: () => openFile(file, 'diff') },
    { label: 'Compare with Local', icon: 'git-compare', disabled: file.status === 'D', run: () => openFile(file, 'compareWithLocal') },
    separator,
    { label: 'Open Repository Version', icon: 'file', run: () => openFile(file, 'revision') },
    { label: 'Jump to Source', icon: 'go-to-file', run: () => openFile(file, 'file') },
    separator,
    { label: 'Show History for File', icon: 'history', run: () => setPaths([file.path]) },
    { label: 'Copy Path', icon: 'copy', run: () => vscode.post({ type: 'copy', text: file.path }) },
  ]);
});

treeToggle.addEventListener('click', () => {
  state.filesAsTree = !state.filesAsTree;
  save();
  renderDetails();
});

$('#diffAllBtn').addEventListener('click', () => {
  if (selection.size > 1) {
    commitsAction('showChanges', selectedHashes());
  } else if (details) {
    commitAction('showChanges', details.hash);
  }
});

// ---- columns ----

function applyColumns(): void {
  for (const column of COLUMNS) {
    const width = state.columnWidths[column.id];
    if (width) {
      logPane.style.setProperty(`--col-${column.id}`, `${width}px`);
    } else {
      logPane.style.removeProperty(`--col-${column.id}`);
    }
    logPane.classList.toggle(`hide-${column.id}`, state.hiddenColumns.includes(column.id));
  }
}

logHeader.addEventListener('pointerdown', (start) => {
  const handle = (start.target as HTMLElement).closest<HTMLElement>('.col-resizer');
  if (!handle) {
    return;
  }
  start.preventDefault();
  const column = handle.dataset.col as Column;
  const startWidth = handle.parentElement!.getBoundingClientRect().width;
  handle.setPointerCapture(start.pointerId);
  handle.classList.add('dragging');
  const onMove = (e: PointerEvent) => {
    // The handle is on the column's left edge: dragging left widens it.
    state.columnWidths[column] = Math.round(Math.max(50, Math.min(600, startWidth - (e.clientX - start.clientX))));
    applyColumns();
  };
  const onUp = () => {
    handle.classList.remove('dragging');
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    save();
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
});

logHeader.addEventListener('dblclick', (e) => {
  const handle = (e.target as HTMLElement).closest<HTMLElement>('.col-resizer');
  if (handle) {
    delete state.columnWidths[handle.dataset.col as Column];
    applyColumns();
    save();
  }
});

logHeader.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const toggleColumn = (id: Column) => () => {
    state.hiddenColumns = state.hiddenColumns.includes(id)
      ? state.hiddenColumns.filter((c) => c !== id)
      : [...state.hiddenColumns, id];
    applyColumns();
    save();
  };
  showMenu(e.clientX, e.clientY, [
    ...COLUMNS.map((c) => ({ label: c.label, checked: !state.hiddenColumns.includes(c.id), run: toggleColumn(c.id) })),
    separator,
    {
      label: 'Reset Column Widths',
      icon: 'discard',
      run: () => {
        state.columnWidths = {};
        applyColumns();
        save();
      },
    },
  ]);
});

// ---- messages ----

window.addEventListener('message', (event: MessageEvent<LogToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'repos': {
      const changedRepo = message.current !== currentRoot;
      repos = message.repos;
      pageSize = message.pageSize;
      if (changedRepo && currentRoot !== undefined) {
        // Filters and selection belong to the previous repository.
        const { text, author, days, after, before } = state.filter;
        state.filter = { text, author, days, after, before };
        state.selected = undefined;
        selectedBranchKey = undefined;
      }
      currentRoot = message.current;
      load(true);
      return;
    }
    case 'log':
      onLog(message);
      return;
    case 'multiDetails':
      if (selection.size > 1 && message.hashes.join() === selectedHashes().join()) {
        multi = { hashes: message.hashes, files: message.files, error: message.error };
        renderDetails();
      }
      return;
    case 'details':
      if (commits[selectedIndex]?.hash === message.hash && selection.size === 1) {
        details = message.details;
        if (message.error) {
          fileTree.innerHTML = `<div class="empty">${esc(message.error)}</div>`;
          return;
        }
        renderDetails();
      }
      return;
    case 'contains':
      if (details?.hash === message.hash) {
        contains = message.branches;
        renderCommitInfo();
      }
      return;
    case 'setFilter':
      setFilter(message.filter, message.select);
      return;
    case 'pickedPaths':
      if (message.root === data?.root) {
        setPaths(message.paths);
      }
      return;
    case 'reload':
      load(false);
      return;
  }
});

renderToolbar();
vscode.post({ type: 'ready' });
