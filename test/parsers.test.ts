import { describe, expect, it } from 'vitest';
import {
  isCommitHash,
  isUncommitted,
  parseBlame,
  parseCommitDetails,
  parseFullLog,
  parseLog,
  parseNameStatus,
  parseRecentCheckouts,
  parseRefs,
  parseStashList,
  parseStatus,
  parseTrack,
} from '../src/git/parsers';
import { buildRebaseTodo } from '../src/git/rebase';

/** A full-length fake hash made of one hex digit. */
const sha = (digit: string) => digit.repeat(40);

describe('isCommitHash', () => {
  it('accepts full SHA-1 and SHA-256 hashes only', () => {
    expect(isCommitHash(sha('a'))).toBe(true);
    expect(isCommitHash('0'.repeat(64))).toBe(true);
    expect(isCommitHash('abc1234')).toBe(false);
    expect(isCommitHash(sha('A'))).toBe(false);
    expect(isCommitHash('--output=/tmp/x')).toBe(false);
    expect(isCommitHash(`${sha('a')}\nexec rm -rf ~`)).toBe(false);
    expect(isCommitHash(undefined)).toBe(false);
  });
});

describe('parseLog', () => {
  it('parses records separated by the record separator', () => {
    const out =
      `${sha('a')}\x1f${sha('b')} ${sha('c')}\x1fAlice\x1falice@x.io\x1f1700000000\x1fMerge branch\x1e\n` +
      `${sha('b')}\x1f\x1fBob\x1fbob@x.io\x1f1690000000\x1fInitial\x1e\n`;
    expect(parseLog(out)).toEqual([
      { hash: sha('a'), parents: [sha('b'), sha('c')], author: 'Alice', email: 'alice@x.io', date: 1700000000, subject: 'Merge branch' },
      { hash: sha('b'), parents: [], author: 'Bob', email: 'bob@x.io', date: 1690000000, subject: 'Initial' },
    ]);
  });

  it('returns nothing for empty output', () => {
    expect(parseLog('')).toEqual([]);
  });

  it('ignores fake commits forged with separators inside a commit message', () => {
    // The subject ends the record early; the rest would read as a commit whose
    // "hash" is a git option or HTML.
    const subject = 'Nice change\x1e--output=/home/u/.bashrc\x1f<b>x</b>\x1fEve\x1fe@x\x1f0\x1fFake';
    const out =
      `${sha('a')}\x1f${sha('b')}\x1fAlice\x1falice@x.io\x1f1700000000\x1f${subject}\x1e\n` +
      `${sha('b')}\x1f\x1fBob\x1fbob@x.io\x1f1690000000\x1fInitial\x1e\n`;
    expect(parseLog(out).map((c) => c.hash)).toEqual([sha('a'), sha('b')]);
    expect(parseLog(out)[0].subject).toBe('Nice change');
  });
});

describe('parseCommitDetails', () => {
  it('keeps the full multi-line message', () => {
    const out = `${sha('1')}\x1f${sha('2')}\x1fA\x1fa@x\x1f1\x1fC\x1fc@x\x1f2\x1fSubject\n\nBody line\n\n`;
    const d = parseCommitDetails(out, []);
    expect(d.message).toBe('Subject\n\nBody line');
    expect(d.committerDate).toBe(2);
    expect(d.parents).toEqual([sha('2')]);
  });

  it('refuses output whose hashes are not hashes', () => {
    expect(() => parseCommitDetails('--output=x\x1f\x1fA\x1fa@x\x1f1\x1fC\x1fc@x\x1f2\x1fSubject', [])).toThrow();
  });
});

describe('parseRefs', () => {
  it('classifies branches, remotes and tags', () => {
    const lines = [
      ['111', '', 'refs/heads/main', 'origin/main', '[ahead 2, behind 1]', '*', 'origin', 'refs/heads/main'],
      ['888', '', 'refs/heads/fork-dev', 'my/fork/dev', '', ' ', 'my/fork', 'refs/heads/dev'],
      ['222', '', 'refs/heads/feature/x', '', '', ' '],
      ['333', '', 'refs/remotes/origin/HEAD', '', '', ' '],
      ['111', '', 'refs/remotes/origin/main', '', '', ' '],
      ['444', '', 'refs/remotes/my/fork/dev', '', '', ' '],
      ['555', '666', 'refs/tags/v1.0', '', '', ' '],
      ['777', '', 'refs/stash', '', '', ' '],
    ].map((f) => f.join('\0'));
    const refs = parseRefs(lines.join('\n') + '\n', ['origin', 'my/fork']);
    expect(refs).toEqual([
      {
        name: 'main',
        fullName: 'refs/heads/main',
        kind: 'branch',
        hash: '111',
        upstream: 'origin/main',
        upstreamRemote: 'origin',
        upstreamBranch: 'main',
        ahead: 2,
        behind: 1,
        isCurrent: true,
      },
      {
        name: 'fork-dev',
        fullName: 'refs/heads/fork-dev',
        kind: 'branch',
        hash: '888',
        upstream: 'my/fork/dev',
        upstreamRemote: 'my/fork',
        upstreamBranch: 'dev',
        ahead: 0,
        behind: 0,
      },
      { name: 'feature/x', fullName: 'refs/heads/feature/x', kind: 'branch', hash: '222' },
      { name: 'origin/main', fullName: 'refs/remotes/origin/main', kind: 'remote', hash: '111', remote: 'origin' },
      { name: 'my/fork/dev', fullName: 'refs/remotes/my/fork/dev', kind: 'remote', hash: '444', remote: 'my/fork' },
      { name: 'v1.0', fullName: 'refs/tags/v1.0', kind: 'tag', hash: '666' },
    ]);
  });
});

describe('parseTrack', () => {
  it('reads ahead/behind and gone', () => {
    expect(parseTrack('[ahead 3]')).toEqual({ ahead: 3, behind: 0 });
    expect(parseTrack('[behind 4]')).toEqual({ ahead: 0, behind: 4 });
    expect(parseTrack('')).toEqual({ ahead: 0, behind: 0 });
    expect(parseTrack('[gone]')).toEqual({ upstreamGone: true });
  });
});

describe('parseNameStatus', () => {
  it('reads plain changes and renames', () => {
    const out = 'M\0src/a.ts\0R087\0old/b.ts\0new/b.ts\0A\0c.md\0D\0d.txt\0';
    expect(parseNameStatus(out)).toEqual([
      { status: 'M', path: 'src/a.ts' },
      { status: 'R', path: 'new/b.ts', oldPath: 'old/b.ts' },
      { status: 'A', path: 'c.md' },
      { status: 'D', path: 'd.txt' },
    ]);
  });
});

describe('parseStatus', () => {
  it('describes every file relative to HEAD', () => {
    const out = [' M a.ts', 'M  b.ts', 'MM c.ts', 'A  d.ts', ' D e.ts', 'R  new.ts', 'old.ts', 'UU f.ts', '?? g.ts', 'AM h.ts', ''].join('\0');
    expect(parseStatus(out)).toEqual([
      { kind: 'modified', path: 'a.ts' },
      { kind: 'modified', path: 'b.ts' },
      { kind: 'modified', path: 'c.ts' },
      { kind: 'added', path: 'd.ts' },
      { kind: 'deleted', path: 'e.ts' },
      { kind: 'renamed', path: 'new.ts', oldPath: 'old.ts' },
      { kind: 'conflict', path: 'f.ts' },
      { kind: 'unversioned', path: 'g.ts' },
      { kind: 'added', path: 'h.ts' },
    ]);
  });

  it('handles intent-to-add files and renames, and added-then-deleted files', () => {
    const out = [' A ita.txt', ' R new.txt', 'old.txt', 'AD gone.txt', 'RM moved.txt', 'orig.txt', ''].join('\0');
    expect(parseStatus(out)).toEqual([
      { kind: 'added', path: 'ita.txt' },
      { kind: 'renamed', path: 'new.txt', oldPath: 'old.txt' },
      { kind: 'deleted', path: 'gone.txt' },
      { kind: 'renamed', path: 'moved.txt', oldPath: 'orig.txt' },
    ]);
  });

  it('keeps spaces in paths', () => {
    expect(parseStatus('?? my file.txt\0')).toEqual([{ kind: 'unversioned', path: 'my file.txt' }]);
  });
});

describe('parseRecentCheckouts', () => {
  it('lists branches most recent first without duplicates', () => {
    const out = [
      'checkout: moving from feature to main',
      'commit: something',
      'checkout: moving from main to feature',
      'checkout: moving from dev to main',
    ].join('\n');
    expect(parseRecentCheckouts(out)).toEqual(['main', 'feature', 'dev']);
  });
});

describe('parseFullLog', () => {
  it('keeps multi-line messages', () => {
    const out = `${sha('1')}\x1f${sha('3')}\x1fAnn\x1fann@x\x1f100\x1fSubject\x1fSubject\n\nBody line\n\x1e\n${sha('2')}\x1f\x1fBob\x1fbob@x\x1f50\x1fRoot\x1fRoot\n\x1e\n`;
    expect(parseFullLog(out)).toEqual([
      { hash: sha('1'), parents: [sha('3')], author: 'Ann', email: 'ann@x', date: 100, subject: 'Subject', message: 'Subject\n\nBody line' },
      { hash: sha('2'), parents: [], author: 'Bob', email: 'bob@x', date: 50, subject: 'Root', message: 'Root' },
    ]);
  });

  it('ignores fake commits forged inside a message, so they never reach the rebase todo', () => {
    const message = 'Subject\n\x1e\nfeed\nexec touch pwned\x1f\x1fEve\x1fe@x\x1f0\x1fFake\x1fFake';
    const out = `${sha('1')}\x1f\x1fAnn\x1fann@x\x1f100\x1fSubject\x1f${message}\n\x1e\n`;
    expect(parseFullLog(out).map((c) => c.hash)).toEqual([sha('1')]);
  });
});

describe('parseStashList', () => {
  it('reads messages, branches and untracked parts', () => {
    const [s0, s1, s2, b0, b1, b2, i, u] = ['0', '1', '2', 'b', 'c', 'd', 'e', 'f'].map(sha);
    const out = [
      `stash@{0}\x1f${s0}\x1f${b0} ${i}\x1f200\x1fOn feature/x: half done: really`,
      `stash@{1}\x1f${s1}\x1f${b1} ${i} ${u}\x1f100\x1fWIP on main: 1a2b3c4 Fix parser`,
      `stash@{2}\x1f${s2}\x1f${b2} ${i}\x1f50\x1fOn (no branch): detached work`,
      'stash@{3}\x1fnot-a-hash\x1f\x1f10\x1fOn main: forged',
    ].join('\n');
    expect(parseStashList(out)).toEqual([
      { ref: 'stash@{0}', hash: s0, base: b0, hasUntracked: false, date: 200, message: 'half done: really', branch: 'feature/x' },
      { ref: 'stash@{1}', hash: s1, base: b1, hasUntracked: true, date: 100, message: 'WIP on main: 1a2b3c4 Fix parser', branch: 'main' },
      { ref: 'stash@{2}', hash: s2, base: b2, hasUntracked: false, date: 50, message: 'detached work', branch: undefined },
    ]);
  });
});

describe('parseBlame', () => {
  it('maps every line to its commit, including uncommitted lines', () => {
    const a = 'a'.repeat(40);
    const zero = '0'.repeat(40);
    const out = [
      `${a} 1 1 2`,
      'author Ann',
      'author-mail <ann@example.com>',
      'author-time 1700000000',
      'summary First commit',
      'filename src/x.ts',
      '\tline one',
      `${a} 2 2`,
      'filename src/x.ts',
      '\tline two',
      `${zero} 3 3 1`,
      'author External file (--contents)',
      'author-time 1800000000',
      'summary Version of src/x.ts from standard input',
      `previous ${a} src/old name.ts`,
      'filename src/x.ts',
      '\tunsaved',
      '',
    ].join('\n');
    const blame = parseBlame(out);
    expect(blame.lines).toEqual([a, a, zero]);
    expect(blame.commits.get(a)).toMatchObject({ author: 'Ann', authorMail: 'ann@example.com', authorTime: 1700000000, summary: 'First commit' });
    expect(blame.commits.get(zero)!.previous).toEqual({ hash: a, path: 'src/old name.ts' });
    expect(isUncommitted(zero)).toBe(true);
    expect(isUncommitted(a)).toBe(false);
  });
});

describe('buildRebaseTodo', () => {
  const build = (entries: Parameters<typeof buildRebaseTodo>[0]) => {
    const messages: Record<string, string> = {};
    const todo = buildRebaseTodo(entries, (hash, message) => {
      messages[hash] = message;
    });
    return { todo: todo.split('\n'), messages };
  };

  const [a, b, c, d, e, f, g] = ['a', 'b', 'c', 'd', 'e', 'f', '9'].map(sha);

  it('uses git reword, and gives the new message to the end of a squash group', () => {
    const { todo, messages } = build([
      { hash: a, action: 'reword', message: 'New message' },
      { hash: b, action: 'drop' },
      { hash: c, action: 'squash' },
      { hash: d, action: 'fixup' },
      { hash: e, action: 'edit' },
      { hash: f, action: 'reword', message: 'Only fixups below' },
      { hash: g, action: 'fixup' },
    ]);
    expect(todo).toEqual([`reword ${a}`, `drop ${b}`, `squash ${c}`, `fixup ${d}`, `edit ${e}`, `reword ${f}`, `fixup ${g}`, '']);
    // git asks for the combined message at `d` (the group has a squash), not at `g` (fixups only).
    expect(messages).toEqual({ [a]: 'New message\n', [d]: 'New message\n', [f]: 'Only fixups below\n' });
  });

  it('keeps a reword without a new message as a plain pick', () => {
    expect(build([{ hash: a, action: 'reword', message: '  ' }])).toEqual({ todo: [`pick ${a}`, ''], messages: {} });
  });

  it('refuses to squash the first commit', () => {
    expect(() => build([{ hash: a, action: 'drop' }, { hash: b, action: 'fixup' }])).toThrow(/first commit/);
  });

  it('refuses entries that could add todo lines of their own', () => {
    expect(() => build([{ hash: `${a}\nexec touch pwned`, action: 'pick' }])).toThrow(/invalid commit/);
    expect(() => build([{ hash: a, action: 'exec touch pwned' as 'pick' }])).toThrow(/invalid commit/);
  });
});
