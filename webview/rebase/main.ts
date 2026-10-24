import type { RebaseInit, RebaseToExtension, RebaseToWebview } from '../../src/shared/protocol';
import type { RebaseAction, RebaseCommit, RebaseEntry } from '../../src/shared/types';
import { $, esc, formatDate, icon } from '../common/dom';
import { connect } from '../common/vscode';

interface Row {
  commit: RebaseCommit;
  action: RebaseAction;
  /** The message for `reword` (starts as the commit's message). */
  message: string;
}

const ACTIONS: { id: RebaseAction; label: string; icon: string; hint: string }[] = [
  { id: 'pick', label: 'Pick', icon: 'check', hint: 'Keep the commit' },
  { id: 'edit', label: 'Edit', icon: 'edit', hint: 'Stop after this commit to change its files' },
  { id: 'reword', label: 'Reword', icon: 'whole-word', hint: 'Change the commit message' },
  { id: 'squash', label: 'Squash', icon: 'fold-up', hint: 'Combine with the commit above, keeping both messages' },
  { id: 'fixup', label: 'Fixup', icon: 'fold-up', hint: "Combine with the commit above, discarding this commit's message" },
  { id: 'drop', label: 'Drop', icon: 'trash', hint: 'Remove the commit' },
];

const vscode = connect<undefined, RebaseToExtension>();

let init: RebaseInit | undefined;
let rows: Row[] = [];
let selected = new Set<number>();
/** Where a Shift selection starts. */
let anchor = 0;
/** The row last clicked or moved to: arrow keys go from here. */
let lead = 0;
/** A plain click on a row of a multi-selection selects only it on release (unless it starts a drag). */
let collapseTo: number | undefined;
let busy = false;

document.getElementById('app')!.innerHTML = `
<div class="rb-root">
  <header class="rb-header">
    <div class="rb-title" id="title"></div>
    <div class="dim">Commits are applied from top to bottom. Drag rows or use the arrows to reorder.</div>
  </header>
  <div class="rb-toolbar" id="toolbar">
    ${ACTIONS.map((a) => `<button class="tool" data-action="${a.id}" title="${esc(a.hint)}">${icon(a.icon)}<span>${a.label}</span></button>`).join('')}
    <span class="sep"></span>
    <button class="icon-btn" id="upBtn" title="Move up">${icon('arrow-up')}</button>
    <button class="icon-btn" id="downBtn" title="Move down">${icon('arrow-down')}</button>
    <span class="spacer"></span>
    <button class="icon-btn" id="resetBtn" title="Reset all changes">${icon('discard')}</button>
  </div>
  <div class="rb-columns">
    <span class="grip-space"></span><span class="c-action">Action</span><span class="c-hash">Hash</span>
    <span class="c-subject">Subject</span><span class="c-author">Author</span><span class="c-date">Date</span>
  </div>
  <div class="rb-list scroll" id="list" tabindex="0"></div>
  <footer class="rb-footer">
    <span class="rb-status" id="status"></span>
    <span class="spacer"></span>
    <button class="secondary" id="cancelBtn">Cancel</button>
    <button class="primary" id="startBtn">Start Rebasing</button>
  </footer>
</div>`;

const title = $('#title');
const list = $('#list');
const status = $('#status');
const startBtn = $('#startBtn') as HTMLButtonElement;

function subject(row: Row): string {
  return row.action === 'reword' ? row.message.split('\n')[0] || '(empty message)' : row.commit.subject;
}

/** What is wrong with the plan, if anything. */
function problem(): string | undefined {
  const firstKept = rows.find((r) => r.action !== 'drop');
  if (firstKept && (firstKept.action === 'squash' || firstKept.action === 'fixup')) {
    return 'The first commit cannot be squashed: there is no commit above it to combine it with.';
  }
  if (rows.some((r) => r.action === 'reword' && !r.message.trim())) {
    return 'A reworded commit needs a message.';
  }
  return undefined;
}

function changes(): string[] {
  if (!init) {
    return [];
  }
  const count = (action: RebaseAction) => rows.filter((r) => r.action === action).length;
  const reworded = rows.filter((r) => r.action === 'reword' && r.message.trim() !== r.commit.message.trim()).length;
  const parts: string[] = [];
  if (rows.some((r, i) => r.commit.hash !== init!.commits[i].hash)) {
    parts.push('reordered');
  }
  const add = (n: number, what: string) => n && parts.push(`${n} ${what}`);
  add(reworded, 'reworded');
  add(count('edit'), 'to edit');
  add(count('squash') + count('fixup'), 'squashed');
  add(count('drop'), 'dropped');
  return parts;
}

function renderFooter(): void {
  const error = problem();
  const parts = changes();
  status.classList.toggle('error', !!error);
  status.textContent = error ?? (parts.length ? parts.join(' · ') : 'Nothing changed yet.');
  startBtn.disabled = busy || !!error || !parts.length;
  for (const button of document.querySelectorAll<HTMLButtonElement>('#toolbar button, #cancelBtn')) {
    button.disabled = busy;
  }
}

function render(): void {
  title.textContent = init
    ? `Rebasing ${rows.length} commit${rows.length === 1 ? '' : 's'} of '${init.branch}' onto ${init.ontoLabel}`
    : '';
  list.innerHTML = rows
    .map((row, i) => {
      const joined = row.action === 'squash' || row.action === 'fixup';
      return (
        `<div class="rb-row a-${esc(row.action)}${selected.has(i) ? ' selected' : ''}" data-i="${i}">` +
        `<span class="grip" title="Drag to reorder">${icon('gripper')}</span>` +
        `<select class="c-action" data-i="${i}" title="${esc(ACTIONS.find((a) => a.id === row.action)!.hint)}">` +
        ACTIONS.map((a) => `<option value="${a.id}"${a.id === row.action ? ' selected' : ''}>${a.label}</option>`).join('') +
        '</select>' +
        `<span class="c-hash">${esc(row.commit.hash.slice(0, 8))}</span>` +
        `<span class="c-subject">${joined ? icon('arrow-small-up', 'joined') : ''}<span class="text" title="${esc(row.commit.message)}">${esc(subject(row))}</span></span>` +
        `<span class="c-author">${esc(row.commit.author)}</span>` +
        `<span class="c-date">${formatDate(row.commit.date)}</span>` +
        '</div>' +
        (row.action === 'reword'
          ? `<div class="rb-message"><textarea data-i="${i}" spellcheck="true" placeholder="Commit message">${esc(row.message)}</textarea></div>`
          : '')
      );
    })
    .join('');
  renderFooter();
}

function setAction(indexes: Iterable<number>, action: RebaseAction): void {
  for (const i of indexes) {
    rows[i].action = action;
  }
  render();
  if (action === 'reword') {
    const first = Math.min(...indexes);
    list.querySelector<HTMLTextAreaElement>(`textarea[data-i="${first}"]`)?.focus();
  }
}

/** Moves the selected rows one step up or down, keeping them selected. */
function move(delta: -1 | 1): void {
  const indexes = [...selected].sort((a, b) => a - b);
  if (!indexes.length || (delta < 0 ? indexes[0] === 0 : indexes[indexes.length - 1] === rows.length - 1)) {
    return;
  }
  const order = delta < 0 ? indexes : indexes.reverse();
  for (const i of order) {
    [rows[i], rows[i + delta]] = [rows[i + delta], rows[i]];
  }
  selected = new Set(indexes.map((i) => i + delta));
  anchor += delta;
  lead += delta;
  render();
}

function moveRow(from: number, to: number): void {
  const [row] = rows.splice(from, 1);
  rows.splice(to, 0, row);
  selected = new Set([to]);
  anchor = to;
  lead = to;
  render();
}

// ---- events ----

function rowIndex(e: Event): number | undefined {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  return el ? Number(el.dataset.i) : undefined;
}

function showSelection(): void {
  for (const el of list.querySelectorAll<HTMLElement>('.rb-row')) {
    el.classList.toggle('selected', selected.has(Number(el.dataset.i)));
  }
}

list.addEventListener('mousedown', (e) => {
  const i = rowIndex(e);
  collapseTo = undefined;
  if (i === undefined || (e.target as HTMLElement).closest('select, textarea')) {
    return;
  }
  lead = i;
  if (e.shiftKey) {
    selected = new Set();
    for (let k = Math.min(anchor, i); k <= Math.max(anchor, i); k++) {
      selected.add(k);
    }
  } else if (e.metaKey || e.ctrlKey) {
    if (!selected.delete(i)) {
      selected.add(i);
    }
    anchor = i;
  } else if (selected.has(i) && selected.size > 1) {
    // Keep the selection for a drag; a click selects only this row (see mouseup).
    collapseTo = i;
  } else {
    selected = new Set([i]);
    anchor = i;
  }
  showSelection();
});

list.addEventListener('mouseup', (e) => {
  if (collapseTo !== undefined && rowIndex(e) === collapseTo) {
    selected = new Set([collapseTo]);
    anchor = collapseTo;
    showSelection();
  }
  collapseTo = undefined;
});

list.addEventListener('change', (e) => {
  const select = e.target as HTMLSelectElement;
  if (select.matches('select.c-action')) {
    const i = Number(select.dataset.i);
    // Changing a selected row's action applies it to the whole selection.
    setAction(selected.has(i) ? selected : [i], select.value as RebaseAction);
  }
});

list.addEventListener('input', (e) => {
  const area = e.target as HTMLTextAreaElement;
  if (area.matches('textarea')) {
    const i = Number(area.dataset.i);
    rows[i].message = area.value;
    const text = list.querySelector(`.rb-row[data-i="${i}"] .c-subject .text`);
    if (text) {
      text.textContent = subject(rows[i]);
    }
    renderFooter();
  }
});

list.addEventListener('keydown', (e) => {
  if (e.target !== list || !rows.length) {
    return;
  }
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const next = Math.max(0, Math.min(rows.length - 1, lead + (e.key === 'ArrowDown' ? 1 : -1)));
    selected = new Set([next]);
    anchor = next;
    lead = next;
    render();
    list.querySelector('.rb-row.selected')?.scrollIntoView({ block: 'nearest' });
  }
});

// Drag and drop by the grip.
let dragFrom: number | undefined;
list.addEventListener('pointerdown', (e) => {
  const grip = (e.target as HTMLElement).closest('.grip');
  const row = grip?.closest<HTMLElement>('.rb-row');
  if (row) {
    row.draggable = true;
  }
});
list.addEventListener('dragstart', (e) => {
  collapseTo = undefined;
  dragFrom = rowIndex(e);
  e.dataTransfer?.setData('text/plain', String(dragFrom));
  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = 'move';
  }
});
list.addEventListener('dragover', (e) => {
  if (dragFrom === undefined) {
    return;
  }
  e.preventDefault();
  const el = (e.target as HTMLElement).closest<HTMLElement>('.rb-row');
  list.querySelectorAll('.drop-before, .drop-after').forEach((x) => x.classList.remove('drop-before', 'drop-after'));
  if (el) {
    const rect = el.getBoundingClientRect();
    el.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drop-before' : 'drop-after');
  }
});
list.addEventListener('drop', (e) => {
  e.preventDefault();
  const el = list.querySelector<HTMLElement>('.drop-before, .drop-after');
  if (dragFrom !== undefined && el) {
    let to = Number(el.dataset.i) + (el.classList.contains('drop-after') ? 1 : 0);
    if (to > dragFrom) {
      to--;
    }
    if (to !== dragFrom) {
      moveRow(dragFrom, to);
    }
  }
});
list.addEventListener('dragend', () => {
  dragFrom = undefined;
  list.querySelectorAll<HTMLElement>('.rb-row').forEach((x) => {
    x.draggable = false;
    x.classList.remove('drop-before', 'drop-after');
  });
});

$('#toolbar').addEventListener('click', (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>('[data-action]')?.dataset.action as RebaseAction | undefined;
  if (action && selected.size) {
    setAction(selected, action);
  }
});
$('#upBtn').addEventListener('click', () => move(-1));
$('#downBtn').addEventListener('click', () => move(1));
$('#resetBtn').addEventListener('click', () => {
  if (init) {
    load(init);
  }
});
$('#cancelBtn').addEventListener('click', () => vscode.post({ type: 'cancel' }));
startBtn.addEventListener('click', () => {
  if (startBtn.disabled) {
    return;
  }
  const entries: RebaseEntry[] = rows.map((r) => ({
    hash: r.commit.hash,
    action: r.action,
    message: r.action === 'reword' ? r.message : undefined,
  }));
  vscode.post({ type: 'start', planId: init!.planId, entries });
});

function load(message: RebaseInit): void {
  init = message;
  const byHash = new Map(message.commits.map((c) => [c.hash, c]));
  rows = message.entries
    .filter((e) => byHash.has(e.hash))
    .map((e) => {
      const commit = byHash.get(e.hash)!;
      return { commit, action: e.action, message: e.message ?? commit.message };
    });
  selected = new Set(rows.length ? [0] : []);
  anchor = 0;
  lead = 0;
  render();
  list.focus();
}

window.addEventListener('message', (event: MessageEvent<RebaseToWebview>) => {
  const message = event.data;
  if (message.type === 'init') {
    load(message);
  } else if (message.type === 'busy') {
    busy = message.busy;
    renderFooter();
  }
});

vscode.post({ type: 'ready' });
