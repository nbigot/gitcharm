// The subset of the built-in `vscode.git` extension API that GitCharm uses.
// See https://github.com/microsoft/vscode/blob/main/extensions/git/src/api/git.d.ts

import type { Event, Uri } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitApi;
}

export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: Event<'uninitialized' | 'initialized'>;
  readonly git: { readonly path: string };
  readonly repositories: GitApiRepository[];
  readonly onDidOpenRepository: Event<GitApiRepository>;
  readonly onDidCloseRepository: Event<GitApiRepository>;
}

export interface GitApiRepository {
  readonly rootUri: Uri;
  readonly state: { readonly onDidChange: Event<void> };
  fetch(options?: { remote?: string; all?: boolean; prune?: boolean }): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}
