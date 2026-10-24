import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';

export class GitError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stdout: string,
    readonly stderr: string,
  ) {
    super(stderr.trim() || stdout.trim() || `git ${args[0]} failed with exit code ${exitCode}`);
    this.name = 'GitError';
  }
}

export interface RunOptions {
  /** Written to stdin, then stdin is closed. */
  input?: string;
  /** Extra environment variables, e.g. GIT_INDEX_FILE. */
  env?: Record<string, string>;
  /**
   * Receives stdout as it arrives, instead of the result's `stdout`. Returning
   * `false` stops git, which then counts as success.
   */
  onStdout?: (text: string) => boolean | void;
}

export interface GitResult<T = string> {
  stdout: T;
  stderr: string;
}

export type GitRunner = {
  (cwd: string, args: string[], options?: RunOptions): Promise<GitResult<string>>;
  /** `binary`: resolve with the raw bytes of stdout instead of decoding them. */
  (cwd: string, args: string[], options: RunOptions & { binary: true }): Promise<GitResult<Buffer>>;
};

/** Options passed before the sub-command on every invocation. */
const GLOBAL_ARGS = ['-c', 'core.quotepath=false', '-c', 'color.ui=false', '--literal-pathspecs'];

export function createGitRunner(gitPath: string, log?: (line: string) => void): GitRunner {
  return ((cwd: string, args: string[], options: RunOptions & { binary?: boolean } = {}) =>
    new Promise<GitResult<string | Buffer>>((resolve, reject) => {
      const started = Date.now();
      const child = spawn(gitPath, [...GLOBAL_ARGS, ...args], {
        cwd,
        env: {
          ...process.env,
          // English messages so we can recognise specific failures.
          LANGUAGE: 'en_US:en',
          GIT_TERMINAL_PROMPT: '0',
          GIT_OPTIONAL_LOCKS: '0',
          // Never block on an interactive editor; messages are always passed explicitly.
          GIT_EDITOR: 'true',
          ...options.env,
        },
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      const { onStdout } = options;
      const decoder = new StringDecoder('utf8');
      let stopped = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (!onStdout) {
          out.push(chunk);
        } else if (!stopped && onStdout(decoder.write(chunk)) === false) {
          stopped = true;
          child.kill();
        }
      });
      child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const stdoutBuf = Buffer.concat(out);
        const stderr = Buffer.concat(err).toString('utf8');
        const failed = code !== 0 && !stopped;
        log?.(`> git ${args.join(' ')} [${Date.now() - started}ms]${stopped ? ' (stopped)' : ''}${failed ? `\n${stderr.trim()}` : ''}`);
        if (failed) {
          reject(new GitError(args, code, stdoutBuf.toString('utf8'), stderr));
          return;
        }
        const rest = decoder.end();
        if (onStdout && !stopped && rest) {
          onStdout(rest);
        }
        resolve({ stdout: options.binary ? stdoutBuf : stdoutBuf.toString('utf8'), stderr });
      });
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }
    })) as GitRunner;
}
