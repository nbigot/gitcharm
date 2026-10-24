const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

export function icon(name: string, className = ''): string {
  return `<i class="codicon codicon-${name}${className ? ' ' + className : ''}"></i>`;
}

export function $(selector: string, root: ParentNode = document): HTMLElement {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) {
    throw new Error(`Missing element ${selector}`);
  }
  return el;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** PyCharm-like short date: "Today 14:32", "Yesterday 09:10", "12/10/26, 14:32". */
export function formatDate(seconds: number, now = new Date()): string {
  const date = new Date(seconds * 1000);
  const time = date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  if (sameDay(date, now)) {
    return `Today ${time}`;
  }
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) {
    return `Yesterday ${time}`;
  }
  const day = date.toLocaleDateString(undefined, { day: '2-digit', month: '2-digit', year: '2-digit' });
  return `${day}, ${time}`;
}

export function formatFullDate(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

/** A custom checkbox; state is `on`, `off` or `mixed`. */
export function checkbox(state: 'on' | 'off' | 'mixed'): string {
  return `<span class="cb cb-${state}" role="checkbox" aria-checked="${state === 'mixed' ? 'mixed' : state === 'on'}">${
    state === 'on' ? icon('check') : ''
  }</span>`;
}
