import type { RebaseEntry } from '../shared/types';
import { isCommitHash } from './parsers';

const ACTIONS = new Set<string>(['pick', 'edit', 'reword', 'squash', 'fixup', 'drop']);

/** Quotes a path for the POSIX shell git runs editors with. */
export function shellQuote(path: string): string {
  const portable = process.platform === 'win32' ? path.replace(/\\/g, '/') : path;
  return `'${portable.replace(/'/g, `'\\''`)}'`;
}

/**
 * Builds a `git rebase -i` todo list from the dialog's plan (oldest first).
 *
 * New messages use git's own `reword`, so a commit that is skipped or becomes
 * empty never hands its message to another commit. `writeMessage(hash, text)`
 * stores the message git should get when it asks for the message of the todo
 * line naming `hash`: the reworded commit itself and, when squash rows follow
 * it, the last row of that group (where git asks for the combined message).
 */
export function buildRebaseTodo(entries: RebaseEntry[], writeMessage: (hash: string, message: string) => void): string {
  const lines: string[] = [];
  let applied = false;
  let group: { message?: string; squashes: boolean; last?: string } = { squashes: false };
  const endGroup = () => {
    if (group.message && group.squashes && group.last) {
      writeMessage(group.last, group.message);
    }
    group = { squashes: false };
  };
  for (const entry of entries) {
    // Each entry becomes a todo line: anything but a known action and a full
    // hash could add lines of its own, such as `exec`.
    if (!ACTIONS.has(entry.action) || !isCommitHash(entry.hash)) {
      throw new Error('The rebase plan contains an invalid commit.');
    }
    switch (entry.action) {
      case 'drop':
        // Dropped rows don't end a squash group: the next squash joins the commit above.
        lines.push(`drop ${entry.hash}`);
        break;
      case 'squash':
      case 'fixup':
        if (!applied) {
          throw new Error('The first commit cannot be squashed: there is no earlier commit to combine it with.');
        }
        lines.push(`${entry.action} ${entry.hash}`);
        group.last = entry.hash;
        group.squashes ||= entry.action === 'squash';
        break;
      default: {
        endGroup();
        applied = true;
        const message = entry.action === 'reword' ? entry.message?.trim() : undefined;
        if (message) {
          lines.push(`reword ${entry.hash}`);
          writeMessage(entry.hash, message + '\n');
          group.message = message + '\n';
        } else {
          lines.push(`${entry.action === 'edit' ? 'edit' : 'pick'} ${entry.hash}`);
        }
      }
    }
  }
  endGroup();
  return lines.join('\n') + '\n';
}

/**
 * The GIT_EDITOR used during a GitCharm rebase: when git asks for a message, it
 * writes the one stored for the todo line git is executing (the last line of
 * `rebase-merge/done`), and leaves git's own message otherwise.
 */
export function rebaseEditorScript(gitDir: string, messageDir: string): string {
  const done = shellQuote(`${gitDir}/rebase-merge/done`);
  return [
    '#!/bin/sh',
    '# Written by GitCharm for one interactive rebase.',
    'target="$1"',
    `set -- $(tail -n 1 ${done} 2>/dev/null)`,
    '[ -n "$2" ] || exit 0',
    // `done` may abbreviate hashes; the message files are named by full hash.
    `for message in ${shellQuote(messageDir)}/message-"$2"*.txt; do`,
    '  [ -f "$message" ] && cat "$message" > "$target"',
    '  break',
    'done',
    'exit 0',
    '',
  ].join('\n');
}
