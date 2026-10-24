import * as vscode from 'vscode';
import type { GitActions, ViewHooks } from './actions';
import type { Repository } from './git/repository';
import type { RepoManager } from './repoManager';
import { refActionItems } from './shared/refActions';
import type { Ref } from './shared/types';

interface PopupItem extends vscode.QuickPickItem {
  run?: () => Promise<unknown>;
  ref?: Ref;
}

function trackingDescription(ref: Ref): string {
  const parts: string[] = [];
  if (ref.ahead) {
    parts.push(`↑${ref.ahead}`);
  }
  if (ref.behind) {
    parts.push(`↓${ref.behind}`);
  }
  if (ref.upstreamGone) {
    parts.push('upstream gone');
  } else if (ref.upstream) {
    parts.push(ref.upstream);
  }
  return parts.join('  ');
}

function branchItem(ref: Ref): PopupItem {
  return {
    label: `${ref.isCurrent ? '$(check)' : ref.kind === 'remote' ? '$(cloud)' : '$(git-branch)'} ${ref.name}`,
    description: ref.kind === 'branch' ? trackingDescription(ref) : undefined,
    ref,
  };
}

/** PyCharm's Git branches popup (the branch widget in the status bar). */
export async function showBranchesPopup(manager: RepoManager, actions: GitActions, hooks: ViewHooks): Promise<void> {
  const repo = manager.current;
  if (!repo) {
    void vscode.window.showInformationMessage('No git repository is open.');
    return;
  }
  const [head, refs, recent] = await Promise.all([repo.head(), repo.refs(), repo.recentBranches()]);
  const local = refs.filter((r) => r.kind === 'branch');
  const remote = refs.filter((r) => r.kind === 'remote');
  const current = local.find((r) => r.isCurrent);
  const separator = (label: string): PopupItem => ({ label, kind: vscode.QuickPickItemKind.Separator });

  const items: PopupItem[] = [
    { label: '$(arrow-down) Update Project…', run: () => actions.updateProject(repo) },
    { label: '$(check) Commit…', run: () => hooks.focusCommit() },
    { label: '$(arrow-up) Push…', run: () => actions.push(repo) },
    separator(''),
    { label: '$(add) New Branch…', run: () => actions.newBranch(repo) },
    { label: '$(tag) Checkout Tag or Revision…', run: () => actions.checkoutRevision(repo) },
  ];
  if (manager.repositories.length > 1) {
    const name = manager.summaries.find((s) => s.root === repo.root)?.name;
    items.push({
      label: `$(repo) Repository: ${name}`,
      description: 'switch…',
      run: async () => {
        const picked = await vscode.window.showQuickPick(
          manager.summaries.map((s) => ({ label: s.name, description: s.root, root: s.root })),
          { title: 'Select Repository' },
        );
        if (picked) {
          manager.setCurrent(picked.root);
          await showBranchesPopup(manager, actions, hooks);
        }
      },
    });
  }

  const recentRefs = recent
    .filter((name) => name !== head.branch)
    .map((name) => local.find((r) => r.name === name))
    .filter((r): r is Ref => !!r)
    .slice(0, 5);
  if (recentRefs.length) {
    items.push(separator('Recent'), ...recentRefs.map(branchItem));
  }
  items.push(separator('Local'));
  if (current) {
    items.push(branchItem(current));
  }
  items.push(...local.filter((r) => !r.isCurrent).map(branchItem));
  if (remote.length) {
    items.push(separator('Remote'), ...remote.map(branchItem));
  }

  const picked = await vscode.window.showQuickPick(items, {
    title: `Git Branches${head.branch ? ` — on '${head.branch}'` : ' — detached HEAD'}`,
    placeHolder: 'Search for branches and actions',
    matchOnDescription: true,
  });
  if (!picked) {
    return;
  }
  if (picked.run) {
    await picked.run();
  } else if (picked.ref) {
    await showBranchActions(repo, actions, picked.ref, head.branch);
  }
}

async function showBranchActions(repo: Repository, actions: GitActions, ref: Ref, current?: string): Promise<void> {
  const items: (vscode.QuickPickItem & { action?: ReturnType<typeof refActionItems>[number]['action'] })[] = [];
  for (const item of refActionItems(ref, current)) {
    if (item.group && items.length) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
    }
    items.push({ label: `$(${item.icon}) ${item.label}`, action: item.action });
  }
  const picked = await vscode.window.showQuickPick(items, { title: `Branch '${ref.name}'` });
  if (picked?.action) {
    await actions.refAction(repo, picked.action, ref);
  }
}
