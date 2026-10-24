import { relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { errorText } from './actions';
import { isUncommitted, type BlameCommit, type BlameResult } from './git/parsers';
import type { Repository } from './git/repository';
import type { RepoManager } from './repoManager';
import { REVISION_SCHEME, shortHash } from './revisionContent';

interface Annotation {
  repo: Repository;
  path: string;
  /** Blame at this revision (revision documents); otherwise the editor's current text. */
  revision?: string;
  blame?: BlameResult;
  /** Ignore results of a blame started before a newer one. */
  generation: number;
}

const MAX_AUTHOR = 16;

/** Arguments of the commands linked from the annotation hover. */
export type BlameCommitArgs = [root: string, hash: string, path: string, previousPath?: string];

/** "Annotate with Git Blame": the date and author of every line in front of it, like PyCharm's gutter. */
export class BlameController implements vscode.Disposable {
  private readonly annotations = new Map<string, Annotation>();
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly decoration = vscode.window.createTextEditorDecorationType({
    before: { margin: '0 1.2em 0 0' },
  });
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly manager: RepoManager) {
    this.updateContext();
    this.disposables.push(
      this.decoration,
      vscode.window.onDidChangeVisibleTextEditors(() => this.renderVisible()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.contentChanges.length && this.annotations.has(e.document.uri.toString())) {
          this.schedule(e.document);
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.close(doc.uri)),
      // A commit, checkout or reset changes who wrote which line.
      manager.onDidChangeState((repo) => {
        for (const doc of vscode.workspace.textDocuments) {
          if (this.annotations.get(doc.uri.toString())?.repo === repo) {
            this.schedule(doc);
          }
        }
      }),
    );
  }

  isAnnotated(uri: vscode.Uri): boolean {
    return this.annotations.has(uri.toString());
  }

  async annotate(uri: vscode.Uri): Promise<void> {
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString()) ?? (await vscode.workspace.openTextDocument(uri));
    const target = this.target(doc.uri);
    if (!target) {
      void vscode.window.showInformationMessage('Annotate is available for files in a git repository.');
      return;
    }
    const annotation: Annotation = { ...target, generation: 0 };
    this.annotations.set(doc.uri.toString(), annotation);
    this.updateContext();
    if (!(await this.blame(doc, annotation))) {
      this.close(doc.uri);
    }
  }

  close(uri: vscode.Uri): void {
    const key = uri.toString();
    if (!this.annotations.delete(key)) {
      return;
    }
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.uri.toString() === key) {
        editor.setDecorations(this.decoration, []);
      }
    }
    this.updateContext();
  }

  private target(uri: vscode.Uri): { repo: Repository; path: string; revision?: string } | undefined {
    if (uri.scheme === REVISION_SCHEME) {
      const { root, path, ref } = JSON.parse(uri.query) as { root: string; path: string; ref: string };
      const repo = this.manager.get(root);
      return repo && ref ? { repo, path, revision: ref } : undefined;
    }
    if (uri.scheme !== 'file') {
      return undefined;
    }
    const repo = this.manager.repositoryFor(uri);
    return repo ? { repo, path: relative(repo.root, uri.fsPath).split(sep).join('/') } : undefined;
  }

  private schedule(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    clearTimeout(this.pending.get(key));
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        const annotation = this.annotations.get(key);
        if (annotation) {
          void this.blame(doc, annotation);
        }
      }, 400),
    );
  }

  /** Runs blame and renders it; false (after telling the user) when the file can't be annotated. */
  private async blame(doc: vscode.TextDocument, annotation: Annotation): Promise<boolean> {
    const generation = ++annotation.generation;
    try {
      const blame = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: 'Git blame' }, () =>
        annotation.repo.blame(
          annotation.path,
          annotation.revision ? { revision: annotation.revision } : { contents: doc.getText() },
        ),
      );
      if (generation === annotation.generation && this.annotations.get(doc.uri.toString()) === annotation) {
        annotation.blame = blame;
        this.renderVisible();
      }
      return true;
    } catch (e) {
      if (annotation.blame) {
        // Keep the last result while the file is being edited.
        return true;
      }
      const text = errorText(e);
      void vscode.window.showInformationMessage(
        /no such path|no such ref|bad revision/i.test(text)
          ? `'${annotation.path}' has no committed history to annotate yet.`
          : `Annotate failed: ${text}`,
      );
      return false;
    }
  }

  private renderVisible(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      const annotation = this.annotations.get(editor.document.uri.toString());
      if (annotation?.blame) {
        editor.setDecorations(this.decoration, this.decorations(annotation, annotation.blame, editor.document.lineCount));
      }
    }
  }

  private decorations(annotation: Annotation, blame: BlameResult, lineCount: number): vscode.DecorationOptions[] {
    const date = new Intl.DateTimeFormat(vscode.env.language, { year: '2-digit', month: '2-digit', day: '2-digit' });
    const label = (c: BlameCommit) => {
      if (isUncommitted(c.hash)) {
        return 'Not Committed Yet';
      }
      const author = c.author.length > MAX_AUTHOR ? `${c.author.slice(0, MAX_AUTHOR - 1)}…` : c.author;
      return `${date.format(c.authorTime * 1000)}  ${author}`;
    };
    // Newer commits get a stronger background, like PyCharm's age colouring.
    const times = [...new Set([...blame.commits.values()].filter((c) => !isUncommitted(c.hash)).map((c) => c.authorTime))].sort(
      (a, b) => a - b,
    );
    const rank = new Map(times.map((t, i) => [t, times.length > 1 ? i / (times.length - 1) : 1]));
    const labels = new Map([...blame.commits.values()].map((c) => [c.hash, label(c)]));
    const width = Math.max(...[...labels.values()].map((l) => l.length)) + 1;
    const hovers = new Map<string, vscode.MarkdownString>();
    const result: vscode.DecorationOptions[] = [];
    for (let line = 0; line < Math.min(lineCount, blame.lines.length); line++) {
      const commit = blame.commits.get(blame.lines[line]);
      if (!commit) {
        continue;
      }
      const uncommitted = isUncommitted(commit.hash);
      if (!hovers.has(commit.hash)) {
        hovers.set(commit.hash, this.hover(annotation, commit));
      }
      result.push({
        range: new vscode.Range(line, 0, line, 0),
        hoverMessage: hovers.get(commit.hash),
        renderOptions: {
          before: {
            contentText: labels.get(commit.hash),
            width: `${width}ch`,
            color: new vscode.ThemeColor(uncommitted ? 'gitDecoration.modifiedResourceForeground' : 'editorLineNumber.foreground'),
            backgroundColor: uncommitted ? undefined : `rgba(78, 156, 245, ${(0.05 + 0.27 * (rank.get(commit.authorTime) ?? 0)).toFixed(3)})`,
          },
        },
      });
    }
    return result;
  }

  private hover(annotation: Annotation, commit: BlameCommit): vscode.MarkdownString {
    const md = new vscode.MarkdownString(undefined, true);
    if (isUncommitted(commit.hash)) {
      md.appendMarkdown('$(edit) **Not committed yet**');
      return md;
    }
    const args: BlameCommitArgs = [annotation.repo.root, commit.hash, commit.filename, commit.previous?.path];
    const link = (command: string, commandArgs: unknown[]) => `command:${command}?${encodeURIComponent(JSON.stringify(commandArgs))}`;
    md.isTrusted = { enabledCommands: ['gitcharm.showCommitInLog', 'gitcharm.blameDiff', 'gitcharm.copyText'] };
    md.appendMarkdown('**');
    md.appendText(commit.summary);
    md.appendMarkdown('**\n\n');
    md.appendText(`${commit.author} <${commit.authorMail}>, ${new Date(commit.authorTime * 1000).toLocaleString(vscode.env.language)}`);
    md.appendMarkdown(
      `\n\n\`${shortHash(commit.hash)}\` · [$(git-commit) Show in Git Log](${link('gitcharm.showCommitInLog', args)})` +
        ` · [$(diff) Show Diff](${link('gitcharm.blameDiff', args)})` +
        ` · [$(copy) Copy Revision](${link('gitcharm.copyText', [commit.hash])})`,
    );
    return md;
  }

  /** Menus show Annotate or Close Annotations with `resource in gitcharm.annotatedResources`. */
  private updateContext(): void {
    void vscode.commands.executeCommand('setContext', 'gitcharm.annotatedResources', [...this.annotations.keys()]);
  }

  dispose(): void {
    this.pending.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }
}
