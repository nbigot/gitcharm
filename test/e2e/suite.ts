// Runs inside a real VS Code instance (see run.mjs). Checks that the extension
// activates, finds the repository through the built-in git extension, and that
// both webviews load and talk to the extension host.

import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import * as vscode from 'vscode';
import type { GitCharmApi } from '../../src/extension';
import type { Repository } from '../../src/git/repository';
import { revisionUri } from '../../src/revisionContent';
import { RebasePanel } from '../../src/views/rebasePanel';
import type { LogFilter } from '../../src/shared/types';

async function waitFor<T>(what: string, probe: () => T | undefined | false, timeout = 20000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value) {
      return value;
    }
    if (Date.now() - start > timeout) {
      throw new Error(`Timed out waiting for: ${what}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function step(name: string): void {
  console.log(`  ✓ ${name}`);
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<GitCharmApi>('local.gitcharm');
  assert.ok(extension, 'extension is installed');
  const api = await extension.activate();
  step('extension activated');

  const commands = await vscode.commands.getCommands(true);
  for (const container of ['gitcharm-panel', 'gitcharm-commit']) {
    assert.ok(commands.includes(`workbench.view.extension.${container}`), `${container} view container is registered`);
  }
  step('Git and Commit tabs are registered');

  const repo = await waitFor('repository discovered', () => api.manager.current);
  assert.ok(api.manager.apiRepository(repo), 'repository comes from the built-in git extension');
  step(`repository discovered: ${repo.root}`);

  // Record what the views ask the git layer for.
  const calls: { name: string; args: unknown[] }[] = [];
  for (const name of ['log', 'commitDetails', 'status', 'containingBranches', 'stashes', 'blame'] as const) {
    const original = (repo[name] as (...a: unknown[]) => Promise<unknown>).bind(repo);
    (repo as unknown as Record<string, unknown>)[name] = (...args: unknown[]) => {
      calls.push({ name, args });
      return original(...args);
    };
  }
  const called = (name: string) => calls.find((c) => c.name === name);

  await vscode.commands.executeCommand('gitcharm.showLog');
  await waitFor('log webview requested commits', () => called('log'));
  step('log webview loaded and requested the history');
  await waitFor('log webview requested details of the selected commit', () => called('commitDetails'));
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();
  assert.equal(called('commitDetails')!.args[0], head, 'HEAD commit is selected initially');
  await waitFor('branches containing the commit', () => called('containingBranches'));
  step('log webview selected HEAD and loaded its details');

  await vscode.commands.executeCommand('gitcharm.showCommit');
  await waitFor('commit webview requested the status', () => called('status'));
  step('commit webview loaded the local changes');
  await waitFor('commit webview requested the stashes', () => called('stashes'));
  const [stash] = await (repo as Repository).stashes();
  assert.equal(stash?.message, 'E2E stash');
  assert.deepEqual(await (repo as Repository).stashFiles(stash), [{ status: 'A', path: 'scratch.txt', untracked: true }]);
  step('stash list and stashed files are read');

  const readme = await vscode.workspace.openTextDocument(revisionUri(repo.root, 'README.md', 'HEAD~1'));
  const expected = execFileSync('git', ['show', 'HEAD~1:README.md'], { cwd: repo.root, encoding: 'utf8' });
  assert.equal(readme.getText(), expected);
  step('revision documents show file contents at a commit');

  await vscode.window.showTextDocument(vscode.Uri.file(join(repo.root, 'src', 'app.txt')));
  calls.length = 0;
  await vscode.commands.executeCommand('gitcharm.showFileHistory');
  await waitFor('file history load', () =>
    calls.find((c) => c.name === 'log' && (c.args[0] as LogFilter).paths?.[0] === 'src/app.txt'),
  );
  step('Show History for File filters the log by path');

  // Annotate with Git Blame on the open file, following unsaved edits.
  const appUri = vscode.Uri.file(join(repo.root, 'src', 'app.txt'));
  await vscode.commands.executeCommand('gitcharm.annotate');
  await waitFor('blame of the editor', () => called('blame'));
  assert.ok(api.blame.isAnnotated(appUri), 'the editor is annotated');
  await vscode.window.activeTextEditor!.edit((edit) => edit.insert(new vscode.Position(0, 0), 'typed line\n'));
  await waitFor('blame after an edit', () => calls.filter((c) => c.name === 'blame').length >= 2);
  const lastBlame = calls.filter((c) => c.name === 'blame').pop()!;
  assert.match((lastBlame.args[1] as { contents: string }).contents, /^typed line\n/);
  await vscode.commands.executeCommand('gitcharm.closeAnnotations');
  assert.ok(!api.blame.isAnnotated(appUri), 'annotations closed');
  await vscode.commands.executeCommand('workbench.action.files.revert');
  step('Annotate with Git Blame annotates the editor and follows edits');

  // Interactively Rebase from Here opens the dialog (the commit on top is linear).
  const top = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo.root, encoding: 'utf8' }).trim();
  await api.actions.interactiveRebase(repo as Repository, top);
  await waitFor('rebase dialog tab', () =>
    vscode.window.tabGroups.all
      .flatMap((g) => g.tabs)
      .find((t) => t.input instanceof vscode.TabInputWebview && t.input.viewType.endsWith(RebasePanel.viewType)),
  );
  await waitFor('rebase dialog loaded', () => (api.rebasePanel as unknown as { ready: boolean }).ready);
  api.rebasePanel.dispose();
  step('Interactively Rebase from Here opens the rebase dialog');

  const popup = vscode.commands.executeCommand('gitcharm.showBranches');
  await new Promise((r) => setTimeout(r, 1500));
  await vscode.commands.executeCommand('workbench.action.closeQuickOpen');
  await popup;
  step('branches popup opens and closes');

  // The repository wrapper is shared with the views; make sure it still works.
  const status = await (repo as Repository).status();
  assert.deepEqual(
    status.map((c) => c.kind),
    ['modified'],
  );
  step('status reflects the working tree');
}
