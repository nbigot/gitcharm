# GitCharm

[![CI](https://github.com/nbigot/gitcharm/actions/workflows/ci.yml/badge.svg)](https://github.com/nbigot/gitcharm/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/nbigot/gitcharm)](https://github.com/nbigot/gitcharm/releases/latest)
[![License: MIT](https://img.shields.io/github/license/nbigot/gitcharm)](LICENSE)

A PyCharm-style Git experience for VS Code. It replaces the staging-area-centric
Source Control view with the workflow JetBrains IDEs use: a Log with a commit
graph, a Commit window with checkboxes, and a branches popup.

## What you get

Like PyCharm's tool windows docked at the bottom, GitCharm adds two tabs to the
bottom panel, next to Terminal: **Git** and **Commit**. Toggle the panel with
⌘J (Ctrl+J), or run **GitCharm: Show Git Log** / **GitCharm: Commit…**. To see
both at once, drag one tab onto the other; to put Commit in the sidebar
instead, drag its tab there.

**Git** (the Log)

- **Branches tree** on the left: HEAD, Local (grouped by `feature/…` folders,
  with ↑ahead ↓behind), Remote (per remote), Tags. Click a branch to filter the
  log, double-click to jump to its head, right-click for the branch actions.
- **Commit list** with the lane graph, ref labels (`origin & main` when a branch
  and its upstream are on the same commit), author, date and hash. Virtualized,
  so large histories scroll smoothly; more commits load as you reach the end.
  Drag a column's left edge to resize it (double-click resets it); right-click
  the header to show or hide columns.
- **Filters**: text or hash, branch, user, date (last 24 hours, last 7 days, or
  a period you pick) and paths (folders and files, several at once; *Show
  History* uses it too). With a text or user filter, the graph links each commit
  to the next matching ones below it.
- **Commit details** on the right: changed files (tree or flat), message,
  author/committer, parents (clickable), and the branches containing the commit.
- Double-click a file to diff it against the parent. Right-click for *Compare
  with Local*, *Open Repository Version*, *Jump to Source*, *Show History*.
- Right-click a commit: *Copy Revision Number*, *Create Patch…* (save to a
  file or copy to the clipboard), *Show Changes* (multi-file diff), *New
  Branch*, *New Tag*, *Checkout Revision*, *Cherry-Pick*, *Revert Commit*,
  *Reset Current Branch to Here* (Soft/Mixed/Hard/Keep), *Undo Commit* and
  *Edit Commit Message* (last commit), *Drop Commit…* and *Interactively
  Rebase from Here…*.
- **Several commits**: ⌘-click (Ctrl-click) adds or removes a commit,
  Shift-click or Shift+↑/↓ selects a range. The details show the changes of
  all of them merged per file (a diff goes from before the first to after the
  last). Right-click: *Copy Revision Numbers*, *Create Patch…* (those merged
  changes, for `git apply`), *Show Changes*, *Compare Versions* (two
  commits), *Cherry-Pick*, *Revert*, *Squash Commits…*, *Drop Commits…*.

**Interactive rebase** (*Interactively Rebase from Here…* or *Squash Commits…*)

- A dialog lists the commits from the chosen one up to HEAD, in the order they
  are applied. Per commit: *Pick*, *Edit* (stop to change its files), *Reword*
  (type the new message right there), *Squash* or *Fixup* (combine with the
  commit above), *Drop*. Reorder by dragging the grip or with the arrows; the
  toolbar applies an action to all selected rows.
- *Start Rebasing* runs `git rebase -i` with that plan (local changes are
  auto-stashed). If it stops for an *Edit* or a conflict, finish in the Commit
  tab and click *Continue Rebase*: staged changes are amended into the commit.
- Not offered when the range contains merge commits, like in PyCharm.

**Commit** (with a *Stash* tab, like PyCharm's)

- *Changes* and *Unversioned Files* with checkboxes. There is no staging area:
  exactly the checked files are committed, whatever is in the git index.
- In the bottom panel the commit message sits to the right of the files, as
  in PyCharm; in a narrow view (the sidebar) it goes below them.
- Commit message, *Amend* (loads the previous message), *Commit*,
  *Commit and Push…*. ⌘/Ctrl+Enter commits.
- Double-click a file for a HEAD ↔ Local diff. Right-click: *Rollback…*,
  *Add to VCS*, *Delete…*, *Show History*, *Jump to Source*.
- During a merge, rebase, cherry-pick or revert: a banner with *Abort* (and
  *Continue*/*Skip* for a rebase), a *Merge Conflicts* group with *Merge…*
  (VS Code's merge editor), *Accept Yours*, *Accept Theirs*, *Mark as Resolved*.
  Unresolved conflicts can't be committed by accident.
- *Stash Changes…* (toolbar): all local changes, the same plus unversioned
  files, or only the checked files, with an optional message. Right-click
  files to stash just those (PyCharm's *Shelve*, done with `git stash`).
- **Stash tab**: every stash with its message, branch and date; expand one to
  see its files (double-click for a diff). Right-click: *Apply Stash*, *Pop
  Stash*, *Unstash as New Branch…*, *Show Changes*, *Drop Stash…*. Conflicts
  while unstashing show up in the Commit tab's *Merge Conflicts* group.

**Annotate with Git Blame** (right-click the line numbers, the editor or its tab)

- Shows the date and author of every line in front of it, coloured by age;
  lines you haven't committed yet say *Not Committed Yet*, and the annotations
  follow your edits. Hover one for the commit, with *Show in Git Log*, *Show
  Diff* and *Copy Revision*. *Close Annotations* in the same menus. Works on
  revision documents too.

**Branches popup** (click the branch in the status bar, bottom right)

- *Update Project…* (merge or rebase, with auto-stash), *Commit…*, *Push…*
  (shows the outgoing commits first), *New Branch…*, *Checkout Tag or Revision…*,
  then Recent, Local and Remote branches.
- Branch actions: *Checkout*, *New Branch from…*, *Checkout and Rebase onto
  current*, *Compare with current*, *Rebase current onto*, *Merge into current*,
  *Push…*, *Rename…*, *Delete*.
- Checkout with conflicting local changes offers **Smart Checkout** (stash,
  checkout, re-apply) or **Force Checkout**. Deleting a branch offers **Restore**.

Commands are in the palette under **GitCharm:** (Show Git Log, Branches…,
Commit…, Show History for File, Annotate with Git Blame, Stash Changes…, Show
Stashes, Update Project…, Push…, Fetch, Refresh).
*Show History for File* is also in the editor, tab and explorer context menus.

## Requirements

- VS Code 1.95 or later
- Git installed and on the `PATH`
- A trusted workspace: GitCharm stays off in
  [Restricted Mode](https://code.visualstudio.com/docs/editor/workspace-trust),
  because Git can run commands configured by the repository itself.

## Install

Download `gitcharm-X.Y.Z.vsix` from the
[latest release](https://github.com/nbigot/gitcharm/releases/latest), or build
the package yourself:

```bash
npm install
npm run package                      # builds gitcharm.vsix
```

Then install it in one of three ways (use the downloaded file's name if you
didn't build it):

- **With the `code` command.** On macOS it is not on the PATH by default: in
  VS Code press ⌘⇧P, run **Shell Command: Install 'code' command in PATH**,
  open a new terminal, then:

  ```bash
  code --install-extension gitcharm.vsix
  ```

- **With the full path**, which works without the step above:

  ```bash
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension gitcharm.vsix
  ```

- **From the UI:** Extensions view → `···` → **Install from VSIX…** → pick
  `gitcharm.vsix`.

The command line may print `[DEP0169] DeprecationWarning: url.parse() …` after
"successfully installed". That warning comes from VS Code's own CLI and shows
up for any `.vsix`; it is harmless. To hide it:

```bash
NODE_NO_WARNINGS=1 code --install-extension gitcharm.vsix
```

Reload the window if VS Code asks (**Developer: Reload Window**). To try it
without installing, press F5 in this folder to start an Extension Development
Host.

The extension is installed for your user, so it is available in every folder
you open. In a folder that isn't a git repository the views say so and the
status bar item stays hidden. To turn it off for one project, use
**Disable (Workspace)** in the Extensions view. Notes:

- **Profiles:** if you use VS Code profiles, it installs into the current one.
- **Remote windows:** Remote-SSH, WSL and Dev Containers windows need it
  installed on the remote side too.
- **Other git extensions:** it runs alongside VS Code's Source Control view,
  GitLens and Git Graph. To avoid two branch indicators in the status bar, set
  `gitcharm.statusBar.enabled` to `false`.

To update, run `npm run package` and the install command again. To remove it:
`code --uninstall-extension local.gitcharm`, or uninstall it from the
Extensions view.

Settings:

- `gitcharm.log.pageSize`: commits loaded at a time (default 2000).
- `gitcharm.statusBar.enabled`: show the branch widget (default on).

## How it works

- `src/git/`: a typed wrapper over the git CLI (`repository.ts`) and parsers for
  its output. Fetch and push go through the built-in Git extension's API when
  it's available, so VS Code's credential handling applies. `rebase.ts` turns
  the rebase dialog's plan into a `git rebase -i` todo list (passed through
  `GIT_SEQUENCE_EDITOR`; new messages are applied with `exec git commit
  --amend`).
- `src/graph/layout.ts`: assigns lanes and edges per row; shared by the webview.
- `src/views/`: webview hosts for the Log and Commit views and the rebase
  dialog; `webview/`: their UI (plain TypeScript, VS Code theme variables,
  codicons).
- `src/blame.ts`: the blame annotations (editor decorations from
  `git blame --porcelain --contents -`).
- `src/actions.ts`: every operation that prompts the user, so the Log, the
  Commit view and the branches popup behave the same.

## Development

```bash
npm run build        # bundle with esbuild (npm run watch to rebuild on change)
npm run typecheck
npm test             # unit tests + git integration tests on temp repos
npm run test:e2e     # runs the extension inside VS Code on a temp repo
```

`test:e2e` uses `/Applications/Visual Studio Code.app` by default; set
`VSCODE_PATH` to use another build. It runs with an isolated profile.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the commit message convention and
how releases are made.

## Keyboard shortcuts

GitCharm binds no global shortcuts (VS Code's own use ⌘K as a chord prefix, so
PyCharm's would clash). Add your own in Keyboard Shortcuts by searching for
"GitCharm".

## Privacy

GitCharm collects no telemetry and makes no network requests of its own. The
only network traffic comes from the Git commands you trigger (fetch, pull,
push), which use your own Git credentials (through VS Code's Git extension
when it is available).

## Contributing

Bug reports and ideas are welcome in
[Issues](https://github.com/nbigot/gitcharm/issues) and
[Discussions](https://github.com/nbigot/gitcharm/discussions). See
[CONTRIBUTING.md](CONTRIBUTING.md) to get started and
[SECURITY.md](SECURITY.md) to report a vulnerability privately.

## License

[MIT](LICENSE). GitCharm is not affiliated with or endorsed by JetBrains;
PyCharm is a trademark of JetBrains s.r.o. Bundled third-party material is
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
