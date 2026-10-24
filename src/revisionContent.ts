import { join } from 'node:path';
import * as vscode from 'vscode';
import type { RepoManager } from './repoManager';

export const REVISION_SCHEME = 'gitcharm';

interface RevisionQuery {
  root: string;
  path: string;
  /** Empty string = an empty document (the "missing" side of an add/delete). */
  ref: string;
}

/**
 * A read-only document with a file's contents at a revision. The URI path is
 * the real file path so VS Code picks the right language.
 */
export function revisionUri(root: string, path: string, ref: string): vscode.Uri {
  const query: RevisionQuery = { root, path, ref };
  return vscode.Uri.file(join(root, path)).with({ scheme: REVISION_SCHEME, query: JSON.stringify(query) });
}

export function emptyUri(root: string, path: string): vscode.Uri {
  return revisionUri(root, path, '');
}

export function workingUri(root: string, path: string): vscode.Uri {
  return vscode.Uri.file(join(root, path));
}

export class RevisionContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changed.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: RepoManager) {
    // Refs like HEAD move: refresh open documents that use one (commit hashes never change).
    this.subscription = manager.onDidChangeState((repo) => {
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== REVISION_SCHEME) {
          continue;
        }
        const { root, ref } = JSON.parse(doc.uri.query) as RevisionQuery;
        if (root === repo.root && ref && !/^[0-9a-f]{40,64}$/.test(ref)) {
          this.changed.fire(doc.uri);
        }
      }
    });
  }

  dispose(): void {
    this.subscription.dispose();
    this.changed.dispose();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, path, ref } = JSON.parse(uri.query) as RevisionQuery;
    if (!ref) {
      return '';
    }
    const repo = this.manager.get(root);
    if (!repo) {
      return '';
    }
    try {
      return (await repo.show(ref, path)).toString('utf8');
    } catch {
      return '';
    }
  }
}

export function shortHash(hash: string): string {
  return /^[0-9a-f]{40,64}$/.test(hash) ? hash.slice(0, 8) : hash;
}
