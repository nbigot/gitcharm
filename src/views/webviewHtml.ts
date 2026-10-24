import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return {
    enableScripts: true,
    localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'dist'), vscode.Uri.joinPath(extensionUri, 'media')],
  };
}

export function renderWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, name: 'log' | 'commit' | 'rebase'): string {
  const nonce = randomBytes(16).toString('base64');
  const uri = (...path: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, ...path)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${uri('dist', 'codicons', 'codicon.css')}">
  <link rel="stylesheet" href="${uri('media', 'common.css')}">
  <link rel="stylesheet" href="${uri('media', `${name}.css`)}">
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${uri('dist', 'webview', `${name}.js`)}"></script>
</body>
</html>`;
}
