import type { RefAction } from './protocol';
import type { Ref } from './types';

export interface RefActionItem {
  action: RefAction;
  label: string;
  icon: string;
  /** Draw a separator above this item. */
  group?: boolean;
}

/**
 * The PyCharm branch actions available for `ref`, given the current branch
 * (undefined when HEAD is detached). Shared by the branches popup and the
 * Log's branch tree.
 */
export function refActionItems(ref: Ref, current: string | undefined): RefActionItem[] {
  const items: RefActionItem[] = [];
  const isCurrent = ref.kind === 'branch' && ref.name === current;
  const other = !isCurrent;

  if (other) {
    items.push({ action: 'checkout', label: 'Checkout', icon: 'check' });
  }
  items.push({ action: 'newBranchFrom', label: `New Branch from '${ref.name}'…`, icon: 'add' });
  if (other && current && ref.kind === 'branch') {
    items.push({ action: 'checkoutAndRebase', label: `Checkout and Rebase onto '${current}'`, icon: 'git-pull-request' });
  }
  if (other) {
    items.push({ action: 'compare', label: `Compare with '${current ?? 'HEAD'}'`, icon: 'git-compare', group: true });
  }
  if (other && current) {
    items.push(
      { action: 'rebaseOnto', label: `Rebase '${current}' onto '${ref.name}'`, icon: 'git-pull-request', group: true },
      { action: 'merge', label: `Merge '${ref.name}' into '${current}'`, icon: 'git-merge' },
    );
  }
  if (ref.kind === 'branch') {
    items.push(
      { action: 'push', label: 'Push…', icon: 'arrow-up', group: true },
      { action: 'rename', label: 'Rename…', icon: 'edit' },
    );
  }
  if (other) {
    items.push({ action: 'delete', label: 'Delete', icon: 'trash', group: ref.kind !== 'branch' });
  }
  return items;
}
