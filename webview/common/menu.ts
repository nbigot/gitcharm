import { esc, icon } from './dom';

export interface MenuItem {
  label: string;
  icon?: string;
  /** Dim text on the right. */
  hint?: string;
  checked?: boolean;
  disabled?: boolean;
  separator?: boolean;
  run?: () => void;
}

export interface MenuOptions {
  /** Show a search field that filters the items. */
  search?: boolean;
  placeholder?: string;
  minWidth?: number;
}

let current: { el: HTMLElement; cleanup: () => void } | undefined;

export function closeMenu(): void {
  if (current) {
    const { el, cleanup } = current;
    current = undefined;
    cleanup();
    el.remove();
  }
}

export const separator: MenuItem = { label: '', separator: true };

/** A themed popup menu, used for context menus and filter dropdowns. */
export function showMenu(x: number, y: number, items: MenuItem[], options: MenuOptions = {}): void {
  closeMenu();
  const el = document.createElement('div');
  el.className = 'gc-menu';
  el.style.minWidth = `${options.minWidth ?? 180}px`;
  el.innerHTML =
    (options.search
      ? `<div class="gc-menu-search">${icon('search')}<input type="text" placeholder="${esc(options.placeholder ?? 'Search')}"></div>`
      : '') + '<div class="gc-menu-items" role="menu"></div>';
  document.body.appendChild(el);
  const list = el.querySelector<HTMLElement>('.gc-menu-items')!;
  const input = el.querySelector<HTMLInputElement>('input');

  let visible: MenuItem[] = [];
  let active = -1;

  const selectable = (i: number) => visible[i] && !visible[i].separator && !visible[i].disabled;

  const render = () => {
    const query = input?.value.trim().toLowerCase() ?? '';
    visible = query
      ? items.filter((item) => !item.separator && item.label.toLowerCase().includes(query))
      : items.filter((item, i, all) => !item.separator || (i > 0 && i < all.length - 1 && !all[i - 1].separator));
    if (!selectable(active)) {
      active = visible.findIndex((_, i) => selectable(i));
    }
    list.innerHTML = visible.length
      ? visible
          .map((item, i) =>
            item.separator
              ? '<div class="gc-menu-sep"></div>'
              : `<div class="gc-menu-item${i === active ? ' active' : ''}${item.disabled ? ' disabled' : ''}" data-i="${i}" role="menuitem">` +
                `<span class="gc-menu-icon">${item.checked ? icon('check') : item.icon ? icon(item.icon) : ''}</span>` +
                `<span class="gc-menu-label">${esc(item.label)}</span>` +
                (item.hint ? `<span class="gc-menu-hint">${esc(item.hint)}</span>` : '') +
                '</div>',
          )
          .join('')
      : '<div class="gc-menu-empty">Nothing found</div>';
  };

  const runItem = (i: number) => {
    const item = visible[i];
    if (!item || item.separator || item.disabled) {
      return;
    }
    closeMenu();
    item.run?.();
  };

  const move = (delta: number) => {
    if (!visible.length) {
      return;
    }
    let i = active;
    for (let n = 0; n < visible.length; n++) {
      i = (i + delta + visible.length) % visible.length;
      if (selectable(i)) {
        active = i;
        break;
      }
    }
    render();
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };

  list.addEventListener('mousemove', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.gc-menu-item');
    if (target && Number(target.dataset.i) !== active && !target.classList.contains('disabled')) {
      list.querySelector('.active')?.classList.remove('active');
      target.classList.add('active');
      active = Number(target.dataset.i);
    }
  });
  list.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('.gc-menu-item');
    if (target) {
      runItem(Number(target.dataset.i));
    }
  });
  input?.addEventListener('input', () => {
    active = -1;
    render();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      closeMenu();
    } else if (e.key === 'ArrowDown') {
      move(1);
    } else if (e.key === 'ArrowUp') {
      move(-1);
    } else if (e.key === 'Enter') {
      runItem(active);
    } else {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
  };
  const onDown = (e: MouseEvent) => {
    if (!el.contains(e.target as Node)) {
      closeMenu();
    }
  };
  const onBlur = () => closeMenu();
  document.addEventListener('keydown', onKey, true);
  document.addEventListener('mousedown', onDown, true);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', onBlur);
  current = {
    el,
    cleanup: () => {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    },
  };

  render();
  // Keep the menu inside the viewport.
  const rect = el.getBoundingClientRect();
  const left = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const top = y + rect.height > window.innerHeight - 4 ? Math.max(4, y - rect.height) : y;
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
  (input ?? el).focus();
}

/** Opens a menu below an anchor element (dropdown buttons). */
export function showMenuBelow(anchor: HTMLElement, items: MenuItem[], options?: MenuOptions): void {
  const rect = anchor.getBoundingClientRect();
  showMenu(rect.left, rect.bottom + 2, items, options);
}
