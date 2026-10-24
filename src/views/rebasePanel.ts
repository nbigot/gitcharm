import * as vscode from 'vscode';
import { errorText, type GitActions, type RebasePlan } from '../actions';
import type { Repository } from '../git/repository';
import { shortHash } from '../revisionContent';
import type { RebaseToExtension, RebaseToWebview } from '../shared/protocol';
import { renderWebviewHtml, webviewOptions } from './webviewHtml';

/** PyCharm's interactive rebase dialog, as an editor tab (one at a time). */
export class RebasePanel implements vscode.Disposable {
  static readonly viewType = 'gitcharm.rebase';

  private panel?: vscode.WebviewPanel;
  private session?: { id: number; repo: Repository; plan: RebasePlan };
  private nextId = 1;
  private ready = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly actions: GitActions,
  ) {}

  async open(repo: Repository, plan: RebasePlan): Promise<void> {
    this.session = { id: this.nextId++, repo, plan };
    const title = `Interactive Rebase: ${plan.branch}`;
    if (this.panel) {
      this.panel.title = title;
      this.panel.reveal();
      this.postInit();
      return;
    }
    const panel = vscode.window.createWebviewPanel(RebasePanel.viewType, title, vscode.ViewColumn.Active, {
      ...webviewOptions(this.extensionUri),
      retainContextWhenHidden: true,
    });
    this.panel = panel;
    this.ready = false;
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'gitcharm.svg');
    panel.webview.html = renderWebviewHtml(panel.webview, this.extensionUri, 'rebase');
    panel.webview.onDidReceiveMessage((message: RebaseToExtension) => {
      this.onMessage(message).catch((e) => vscode.window.showErrorMessage(errorText(e)));
    });
    panel.onDidDispose(() => {
      this.panel = undefined;
      this.session = undefined;
      this.ready = false;
    });
  }

  private post(message: RebaseToWebview): void {
    if (this.panel && this.ready) {
      void this.panel.webview.postMessage(message);
    }
  }

  private postInit(): void {
    if (!this.session) {
      return;
    }
    const { id, plan } = this.session;
    this.post({
      type: 'init',
      planId: id,
      branch: plan.branch,
      ontoLabel: plan.onto ? shortHash(plan.onto) : 'the root',
      commits: plan.commits,
      entries: plan.entries,
    });
  }

  private async onMessage(message: RebaseToExtension): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.postInit();
        return;
      case 'cancel':
        this.panel?.dispose();
        return;
      case 'start': {
        const session = this.session;
        if (!session || session.id !== message.planId) {
          // Replaced by a newer plan whose init is on its way to the dialog.
          return;
        }
        this.post({ type: 'busy', busy: true });
        try {
          const started = await this.actions.runInteractiveRebase(session.repo, session.plan, message.entries);
          // Only close the dialog if it still shows this plan.
          if (started && this.session === session) {
            this.panel?.dispose();
          }
        } finally {
          this.post({ type: 'busy', busy: false });
        }
        return;
      }
    }
  }

  dispose(): void {
    this.panel?.dispose();
  }
}
