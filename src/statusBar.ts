import * as vscode from 'vscode';
import type { RepoManager } from './repoManager';
import { shortHash } from './revisionContent';

/** The branch widget: current branch, click to open the branches popup. */
export class BranchStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem('gitcharm.branch', vscode.StatusBarAlignment.Right, 100);
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: RepoManager) {
    this.item.name = 'GitCharm Branch';
    this.item.command = 'gitcharm.showBranches';
    this.disposables.push(
      manager.onDidChangeRepositories(() => void this.update()),
      manager.onDidChangeState((repo) => {
        if (repo === manager.current) {
          void this.update();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('gitcharm.statusBar')) {
          void this.update();
        }
      }),
    );
  }

  async update(): Promise<void> {
    const repo = this.manager.current;
    if (!repo || !vscode.workspace.getConfiguration('gitcharm').get<boolean>('statusBar.enabled', true)) {
      this.item.hide();
      return;
    }
    try {
      const head = await repo.head();
      const ref = head.branch ? (await repo.refs()).find((r) => r.kind === 'branch' && r.name === head.branch) : undefined;
      const sync = [ref?.ahead ? `↑${ref.ahead}` : '', ref?.behind ? `↓${ref.behind}` : ''].filter(Boolean).join(' ');
      const label = head.branch ?? (head.hash ? shortHash(head.hash) : 'no commits');
      this.item.text = `$(git-branch) ${label}${sync ? ` ${sync}` : ''}`;
      this.item.tooltip = `Git Branch: ${label}${ref?.upstream ? ` → ${ref.upstream}` : ''}\nClick for branches and actions`;
      this.item.show();
    } catch {
      this.item.hide();
    }
  }

  dispose(): void {
    this.item.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
