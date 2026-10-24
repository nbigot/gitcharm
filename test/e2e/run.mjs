// Launches VS Code with GitCharm on a throwaway repository and runs suite.ts.
// Uses an isolated profile, so your own settings and extensions are untouched.
//   VSCODE_PATH=/path/to/Code npm run test:e2e

import { runTests } from '@vscode/test-electron';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Set when this script runs from a VS Code terminal; it would start Code as plain Node.
delete process.env.ELECTRON_RUN_AS_NODE;

const root = resolve(import.meta.dirname, '..', '..');
const work = mkdtempSync(join(tmpdir(), 'gitcharm-e2e-'));
const repo = join(work, 'repo');
mkdirSync(join(repo, 'src'), { recursive: true });

const git = (...args) => execFileSync('git', args, { cwd: repo });
git('init', '-q', '-b', 'main');
git('config', 'user.name', 'E2E');
git('config', 'user.email', 'e2e@example.com');
git('config', 'commit.gpgsign', 'false');
writeFileSync(join(repo, 'README.md'), 'first\n');
writeFileSync(join(repo, 'src', 'app.txt'), 'app\n');
git('add', '.');
git('commit', '-qm', 'Initial commit');
git('checkout', '-qb', 'feature');
writeFileSync(join(repo, 'README.md'), 'second\n');
git('commit', '-qam', 'Feature work');
git('checkout', '-q', 'main');
git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
// A linear commit on top, for the interactive rebase dialog.
writeFileSync(join(repo, 'docs.txt'), 'docs\n');
git('add', 'docs.txt');
git('commit', '-qm', 'Add docs');
writeFileSync(join(repo, 'scratch.txt'), 'scratch\n');
git('stash', 'push', '-q', '--include-untracked', '-m', 'E2E stash', '--', 'scratch.txt');
writeFileSync(join(repo, 'src', 'app.txt'), 'app changed\n');

await runTests({
  vscodeExecutablePath: process.env.VSCODE_PATH ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code',
  extensionDevelopmentPath: root,
  extensionTestsPath: join(root, 'dist-test', 'suite.js'),
  launchArgs: [
    repo,
    '--user-data-dir',
    join(work, 'user-data'),
    '--extensions-dir',
    join(work, 'extensions'),
    '--disable-extensions',
    '--disable-workspace-trust',
    '--skip-welcome',
    '--skip-release-notes',
  ],
});
