import { build, context } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = { bundle: true, sourcemap: !production, minify: production, logLevel: 'info' };

const configs = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['vscode'],
  },
  {
    ...common,
    entryPoints: { log: 'webview/log/main.ts', commit: 'webview/commit/main.ts', rebase: 'webview/rebase/main.ts' },
    outdir: 'dist/webview',
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
  },
];

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/codicons', { recursive: true });
for (const file of ['codicon.css', 'codicon.ttf']) {
  cpSync(`node_modules/@vscode/codicons/dist/${file}`, `dist/codicons/${file}`);
}

if (watch) {
  for (const config of configs) {
    await (await context(config)).watch();
  }
} else {
  await Promise.all(configs.map((config) => build(config)));
}
