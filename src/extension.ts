import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { GitActions, type ViewHooks } from './actions';
import { BlameController, type BlameCommitArgs } from './blame';
import { showBranchesPopup } from './branchesPopup';
import { RepoManager } from './repoManager';
import { REVISION_SCHEME, RevisionContentProvider } from './revisionContent';
import { BranchStatusBar } from './statusBar';
import { CommitView } from './views/commitView';
import { LogView } from './views/logView';
import { RebasePanel } from './views/rebasePanel';

/** Returned from `activate`; only used by the end-to-end tests. */
export interface GitCharmApi {
  manager: RepoManager;
  actions: GitActions;
  blame: BlameController;
  rebasePanel: RebasePanel;
}

/** The document a command from an editor, tab, explorer or line-number menu is about. */
function targetUri(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  // editor/lineNumber/context passes { lineNumber, uri }.
  const uri = (arg as { uri?: unknown } | undefined)?.uri;
  return uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
}

export async function activate(context: vscode.ExtensionContext): Promise<GitCharmApi> {
  const output = vscode.window.createOutputChannel('GitCharm');
  const manager = new RepoManager((line) => output.appendLine(line));

  // The views reference each other through these hooks.
  let logView: LogView | undefined;
  let commitView: CommitView | undefined;
  let rebasePanel: RebasePanel | undefined;
  const hooks: ViewHooks = {
    showLog: async (filter, select) => logView?.show(filter, select),
    focusCommit: async (tab) => commitView?.focus(tab),
    openInteractiveRebase: async (repo, plan) => rebasePanel?.open(repo, plan),
  };
  const actions = new GitActions(manager, hooks, context.globalState);
  logView = new LogView(context.extensionUri, manager, actions);
  commitView = new CommitView(context.extensionUri, manager, actions, hooks);
  rebasePanel = new RebasePanel(context.extensionUri, actions);
  const statusBar = new BranchStatusBar(manager);
  const revisions = new RevisionContentProvider(manager);
  const blame = new BlameController(manager);

  const withRepo =
    (fn: (repo: NonNullable<typeof manager.current>) => Promise<unknown>) =>
    async () => {
      const repo = manager.current;
      if (!repo) {
        void vscode.window.showInformationMessage('No git repository is open.');
        return;
      }
      await fn(repo);
    };

  context.subscriptions.push(
    output,
    manager,
    logView,
    commitView,
    statusBar,
    revisions,
    rebasePanel,
    blame,
    vscode.window.registerWebviewViewProvider(LogView.viewId, logView, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.window.registerWebviewViewProvider(CommitView.viewId, commitView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisions),
    vscode.commands.registerCommand('gitcharm.showLog', () => logView!.show()),
    vscode.commands.registerCommand('gitcharm.showCommit', () => commitView!.focus()),
    vscode.commands.registerCommand('gitcharm.showBranches', () => showBranchesPopup(manager, actions, hooks)),
    vscode.commands.registerCommand('gitcharm.updateProject', withRepo((repo) => actions.updateProject(repo))),
    vscode.commands.registerCommand('gitcharm.push', withRepo((repo) => actions.push(repo))),
    vscode.commands.registerCommand('gitcharm.fetch', withRepo((repo) => actions.fetch(repo))),
    vscode.commands.registerCommand(
      'gitcharm.refresh',
      withRepo(async (repo) => {
        manager.notifyChanged(repo);
        logView!.reload();
      }),
    ),
    vscode.commands.registerCommand('gitcharm.stash', withRepo((repo) => actions.stashChanges(repo, []))),
    vscode.commands.registerCommand('gitcharm.showStashes', () => commitView!.focus('stash')),
    vscode.commands.registerCommand('gitcharm.annotate', async (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri) {
        await blame.annotate(uri);
      }
    }),
    vscode.commands.registerCommand('gitcharm.closeAnnotations', (arg?: unknown) => {
      const uri = targetUri(arg);
      if (uri) {
        blame.close(uri);
      }
    }),
    // Linked from the annotation hover.
    vscode.commands.registerCommand('gitcharm.showCommitInLog', async (...[root, hash]: BlameCommitArgs) => {
      manager.setCurrent(root);
      await logView!.show({}, hash);
    }),
    vscode.commands.registerCommand('gitcharm.blameDiff', async (...[root, hash, path, previousPath]: BlameCommitArgs) => {
      const repo = manager.get(root);
      if (repo) {
        const status = !previousPath ? 'A' : previousPath !== path ? 'R' : 'M';
        await actions.openCommitFile(repo, hash, { status, path, oldPath: status === 'R' ? previousPath : undefined }, 'diff');
      }
    }),
    vscode.commands.registerCommand('gitcharm.copyText', (text: string) => vscode.env.clipboard.writeText(text)),
    vscode.commands.registerCommand('gitcharm.showFileHistory', async (arg?: unknown) => {
      const target = targetUri(arg);
      const repo = target && target.scheme === 'file' ? manager.repositoryFor(target) : undefined;
      if (!target || !repo) {
        void vscode.window.showInformationMessage('Open a file that is inside a git repository.');
        return;
      }
      manager.setCurrent(repo.root);
      const path = relative(repo.root, target.fsPath).split(sep).join('/');
      await logView!.show({ paths: path ? [path] : undefined });
    }),
  );

  await manager.initialize();
  await statusBar.update();
  return { manager, actions, blame, rebasePanel };
}

export function deactivate(): void {
  // Everything is disposed through context.subscriptions.
}
