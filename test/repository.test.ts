import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGitRunner } from '../src/git/exec';
import { Repository } from '../src/git/repository';
import type { LogFilter } from '../src/shared/types';

let dir: string;
let repo: Repository;

const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const write = (name: string, content: string) => writeFileSync(join(dir, name), content);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gitcharm-test-'));
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Tester');
  git('config', 'user.email', 'tester@example.com');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('a.txt', 'a1\n');
  write('b.txt', 'b1\n');
  git('add', '.');
  git('commit', '-qm', 'initial');
  repo = new Repository(dir, createGitRunner('git'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('Repository reads', () => {
  it('reads head, refs and a log with a merge', async () => {
    git('checkout', '-qb', 'feature');
    write('f.txt', 'f\n');
    git('add', '.');
    git('commit', '-qm', 'feature work');
    git('checkout', '-q', 'main');
    write('a.txt', 'a2\n');
    git('commit', '-qam', 'main work');
    git('merge', '-q', '--no-ff', '-m', 'Merge feature', 'feature');
    git('tag', '-a', 'v1', '-m', 'v1');

    const head = await repo.head();
    expect(head.branch).toBe('main');

    const refs = await repo.refs();
    expect(refs.map((r) => `${r.kind}:${r.name}`).sort()).toEqual(['branch:feature', 'branch:main', 'tag:v1']);
    expect(refs.find((r) => r.name === 'v1')!.hash).toBe(head.hash);
    expect(refs.find((r) => r.name === 'main')!.isCurrent).toBe(true);

    const { commits, hasMore } = await repo.log({}, 100);
    expect(hasMore).toBe(false);
    expect(commits.map((c) => c.subject)).toEqual(['Merge feature', 'main work', 'feature work', 'initial']);
    expect(commits[0].parents).toHaveLength(2);

    const limited = await repo.log({}, 2);
    expect(limited.commits).toHaveLength(2);
    expect(limited.hasMore).toBe(true);

    const fileHistory = await repo.log({ paths: ['f.txt'] }, 100);
    expect(fileHistory.commits.map((c) => c.subject)).toEqual(['feature work']);

    const grep = await repo.log({ text: 'FEATURE' }, 100);
    expect(grep.commits.map((c) => c.subject)).toEqual(['Merge feature', 'feature work']);

    const range = await repo.log({ revision: 'feature..main' }, 100);
    expect(range.commits.map((c) => c.subject)).toEqual(['Merge feature', 'main work']);

    expect((await repo.containingBranches(commits[2].hash)).sort()).toEqual(['feature', 'main']);
  });

  it('filters by date and by several paths', async () => {
    git('checkout', '-q', '--orphan', 'dated');
    git('rm', '-qrf', '.');
    const commitAt = (file: string, message: string, date?: string) => {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      write(file, message);
      git('add', '.');
      const env = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
      execFileSync('git', ['commit', '-qm', message], { cwd: dir, env: { ...process.env, ...env } });
    };
    commitAt('dir1/a.txt', 'd1', '2020-01-10 12:00:00');
    commitAt('dir2/b.txt', 'd2', '2020-03-05 08:00:00');
    commitAt('dir1/a.txt', 'd3', '2020-03-06 23:30:00');
    commitAt('c.txt', 'd4');
    const subjectsOf = async (filter: LogFilter) =>
      (await repo.log({ revision: 'dated', ...filter }, 100)).commits.map((c) => c.subject);

    // Both days are included, whatever the time of day.
    expect(await subjectsOf({ after: '2020-03-05', before: '2020-03-06' })).toEqual(['d3', 'd2']);
    expect(await subjectsOf({ before: '2020-03-04' })).toEqual(['d1']);
    expect(await subjectsOf({ after: '2020-03-06' })).toEqual(['d4', 'd3']);
    expect(await subjectsOf({ days: 1 })).toEqual(['d4']);
    expect(await subjectsOf({ paths: ['dir2', 'c.txt'] })).toEqual(['d4', 'd2']);
    expect(await subjectsOf({ paths: ['dir1'], after: '2020-02-01' })).toEqual(['d3']);
  });

  it('filters by a branch named like a directory', async () => {
    mkdirSync(join(dir, 'docs'));
    write('docs/readme.md', 'd\n');
    git('add', '.');
    git('commit', '-qm', 'docs');
    git('branch', 'docs');
    const { commits } = await repo.log({ revision: 'docs' }, 10);
    expect(commits.map((c) => c.subject)).toEqual(['docs', 'initial']);
  });

  it('links commits filtered by author to their nearest listed ancestors', async () => {
    let time = 1_700_000_000;
    const commitAs = (author: string, message: string, ...extra: string[]) => {
      time += 60;
      const date = `@${time} +0000`;
      execFileSync('git', ['commit', '-q', '--allow-empty', '-m', message, ...extra], {
        cwd: dir,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: author,
          GIT_AUTHOR_EMAIL: `${author}@example.com`,
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        },
      });
      return git('rev-parse', 'HEAD');
    };
    const merge = (branch: string, author: string, message: string) => {
      execFileSync('git', ['merge', '-q', '--no-ff', '--no-commit', branch], { cwd: dir, stdio: 'ignore' });
      return commitAs(author, message);
    };
    const a1 = commitAs('Alice', 'a1');
    commitAs('Bob', 'b1');
    const a2 = commitAs('Alice', 'a2');
    git('branch', 'side');
    git('checkout', '-qb', 'feature');
    commitAs('Bob', 'b2');
    commitAs('Carol', 'c1');
    const a3 = commitAs('Alice', 'a3');
    git('checkout', '-q', 'main');
    const a5 = commitAs('Alice', 'a5');
    const mergeFeature = merge('feature', 'Bob', 'Merge feature');
    git('checkout', '-q', 'side');
    const b5 = commitAs('Bob', 'b5');
    git('checkout', '-q', 'main');
    const mergeSide = merge('side', 'Alice', 'Merge side');
    const a4 = commitAs('Alice', 'a4');
    commitAs('Bob', 'b4');

    const { commits } = await repo.log({ author: 'alice' }, 100);
    const links = Object.fromEntries(commits.map((c) => [c.subject, c.graphParents]));
    expect(commits.map((c) => c.subject)).toEqual(['a4', 'Merge side', 'a5', 'a3', 'a2', 'a1']);
    expect(links).toEqual({
      a4: [mergeSide],
      // Bob's merge brings both a5 and a3; the side branch's way down to a2 is
      // dropped, as a5 and a3 already lead there.
      'Merge side': [a5, a3],
      a5: [a2],
      a3: [a2],
      a2: [a1],
      a1: [],
    });
    expect(commits[1].parents).toEqual([mergeFeature, b5]);

    // A partial page: paths that leave it lead to a commit below, so the graph draws them on down.
    const page = await repo.log({ author: 'alice' }, 2);
    expect(page.hasMore).toBe(true);
    expect(page.commits.map((c) => c.graphParents)).toEqual([[mergeSide], [mergeFeature, b5]]);

    // A commit found by its hash isn't in log order: it stands alone.
    const exact = await repo.log({ text: a4.slice(0, 10) }, 100);
    expect(exact.commits.map((c) => [c.subject, c.graphParents])).toEqual([['a4', []]]);
    expect(a4).toBe(git('rev-parse', 'main~1'));
  });

  it('records the exact upstream remote and branch', async () => {
    const remote = mkdtempSync(join(tmpdir(), 'gitcharm-remote-'));
    try {
      execFileSync('git', ['init', '-q', '--bare', remote]);
      git('remote', 'add', 'my/fork', remote);
      git('push', '-q', '-u', 'my/fork', 'main:dev');
      const main = (await repo.refs()).find((r) => r.name === 'main')!;
      expect([main.upstream, main.upstreamRemote, main.upstreamBranch]).toEqual(['my/fork/dev', 'my/fork', 'dev']);
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it('reads commit details with renames', async () => {
    git('mv', 'a.txt', 'renamed.txt');
    write('c.txt', 'c\n');
    git('add', '.');
    git('commit', '-qm', 'subject', '-m', 'body');
    const details = await repo.commitDetails(git('rev-parse', 'HEAD'));
    expect(details.message).toBe('subject\n\nbody');
    expect(details.files).toEqual([
      { status: 'A', path: 'c.txt' },
      { status: 'R', path: 'renamed.txt', oldPath: 'a.txt' },
    ]);

    const root = await repo.commitDetails(git('rev-list', '--max-parents=0', 'HEAD'));
    expect(root.files.map((f) => f.path)).toEqual(['a.txt', 'b.txt']);
  });

  it('reports an empty log for a repository without commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'gitcharm-empty-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: empty });
      const r = new Repository(empty, createGitRunner('git'));
      const head = await r.head();
      expect(head).toEqual({ hash: undefined, branch: 'main' });
      expect((await r.log({}, 10, false)).commits).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('Repository.commit', () => {
  it('commits only the selected files, ignoring the index', async () => {
    write('a.txt', 'a2\n');
    write('b.txt', 'b2\n');
    git('add', 'b.txt'); // staged, but not selected
    write('new file.txt', 'n\n');

    const status = await repo.status();
    const selected = status.filter((c) => c.path !== 'b.txt');
    await repo.commit({ message: 'partial', amend: false, changes: selected });

    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['a.txt', 'new file.txt']);
    // b.txt is still a local change.
    expect((await repo.status()).map((c) => c.path)).toEqual(['b.txt']);
  });

  it('commits an untracking (git rm --cached) without re-adding the file', async () => {
    git('rm', '-q', '--cached', 'b.txt');
    write('b.txt', 'local secret\n');
    const status = await repo.status();
    expect(status).toEqual([
      { kind: 'deleted', path: 'b.txt' },
      { kind: 'unversioned', path: 'b.txt' },
    ]);
    await repo.commit({ message: 'untrack b', amend: false, changes: [status[0]] });
    expect(git('ls-tree', '--name-only', 'HEAD')).toBe('a.txt');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('local secret\n');
    expect(await repo.status()).toEqual([{ kind: 'unversioned', path: 'b.txt' }]);
  });

  it('runs hooks and leaves the index alone when a hook rejects the commit', async () => {
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "rejected by hook" >&2\nexit 1\n', {
      mode: 0o755,
    });
    write('a.txt', 'a2\n');
    git('add', 'a.txt');
    await expect(repo.commit({ message: 'x', amend: false, changes: await repo.status() })).rejects.toThrow('rejected by hook');
    expect(git('log', '--format=%s')).toBe('initial');
    expect(git('diff', '--cached', '--name-only')).toBe('a.txt');
    expect(existsSync(join(dir, '.git', 'gitcharm-commit.index'))).toBe(false);
  });

  it('commits intent-to-add files', async () => {
    write('ita.txt', 'new\n');
    git('add', '-N', 'ita.txt');
    expect(await repo.status()).toEqual([{ kind: 'added', path: 'ita.txt' }]);
    await repo.commit({ message: 'ita', amend: false, changes: await repo.status() });
    expect(git('show', 'HEAD:ita.txt')).toBe('new');
    expect(await repo.status()).toEqual([]);
  });

  it('commits deletions and staged renames', async () => {
    unlinkSync(join(dir, 'b.txt'));
    git('mv', 'a.txt', 'moved.txt');
    await repo.commit({ message: 'move and delete', amend: false, changes: await repo.status() });
    expect(git('ls-tree', '--name-only', 'HEAD')).toBe('moved.txt');
    expect(await repo.status()).toEqual([]);
  });

  it('amends the last commit, optionally only its message', async () => {
    await repo.commit({ message: 'reworded', amend: true, changes: [] });
    expect(git('log', '--format=%s')).toBe('reworded');

    write('a.txt', 'a3\n');
    await repo.commit({ message: 'reworded again', amend: true, changes: await repo.status() });
    expect(git('log', '--format=%s')).toBe('reworded again');
    expect(git('show', 'HEAD:a.txt')).toBe('a3');
  });

  it('rejects an empty selection or message', async () => {
    await expect(repo.commit({ message: 'x', amend: false, changes: [] })).rejects.toThrow('No files selected');
    await expect(repo.commit({ message: '  ', amend: false, changes: [] })).rejects.toThrow('message is empty');
  });

  it('commits everything selected while a merge is in progress', async () => {
    git('checkout', '-qb', 'other');
    write('a.txt', 'other\n');
    git('commit', '-qam', 'other');
    git('checkout', '-q', 'main');
    write('a.txt', 'mine\n');
    git('commit', '-qam', 'mine');
    expect(() => git('merge', 'other')).toThrow();
    expect(await repo.operation()).toBe('merge');
    expect((await repo.status()).map((c) => c.kind)).toEqual(['conflict']);

    write('a.txt', 'resolved\n');
    await expect(repo.commit({ message: 'Merge other', amend: false, changes: await repo.status() })).rejects.toThrow(
      'Resolve the merge conflicts first',
    );

    git('add', 'a.txt'); // "Mark as Resolved"
    write('b.txt', 'also changed during the merge\n');
    await repo.commit({ message: 'Merge other', amend: false, changes: await repo.status() });
    expect(await repo.operation()).toBeUndefined();
    expect(git('show', 'HEAD:b.txt')).toBe('also changed during the merge');
    expect(git('log', '-1', '--format=%p').split(' ')).toHaveLength(2);
  });
});

describe('Repository.rollback', () => {
  it('restores modified and deleted files and un-adds added ones', async () => {
    write('a.txt', 'changed\n');
    unlinkSync(join(dir, 'b.txt'));
    write('added.txt', 'x\n');
    git('add', 'added.txt');
    await repo.rollback(await repo.status());

    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(existsSync(join(dir, 'b.txt'))).toBe(true);
    // The added file is kept on disk, now unversioned.
    expect(await repo.status()).toEqual([{ kind: 'unversioned', path: 'added.txt' }]);
  });

  it('keeps intent-to-add files and untracked copies on disk', async () => {
    write('ita.txt', 'keep me\n');
    git('add', '-N', 'ita.txt');
    git('rm', '-q', '--cached', 'b.txt');
    write('b.txt', 'edited after untracking\n');
    await repo.rollback((await repo.status()).filter((c) => c.kind !== 'unversioned'));
    expect(readFileSync(join(dir, 'ita.txt'), 'utf8')).toBe('keep me\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('edited after untracking\n');
    // b.txt is tracked again (now showing the local edit), ita.txt is unversioned.
    expect(await repo.status()).toEqual([
      { kind: 'modified', path: 'b.txt' },
      { kind: 'unversioned', path: 'ita.txt' },
    ]);
  });
});

const commitFile = (name: string, content: string, message: string) => {
  write(name, content);
  git('add', '--', name);
  git('commit', '-qm', message);
  return git('rev-parse', 'HEAD');
};
const subjects = () => git('log', '--format=%s').split('\n');

describe('Repository.interactiveRebase', () => {
  it('reorders, rewords, squashes and drops commits', async () => {
    const c1 = commitFile('c1.txt', '1\n', 'one');
    const c2 = commitFile('c2.txt', '2\n', 'two');
    const c3 = commitFile('c3.txt', '3\n', 'three');
    const c4 = commitFile('c4.txt', '4\n', 'four');

    const { onto, commits } = await repo.rebaseCommits(c1);
    expect(commits.map((c) => c.subject)).toEqual(['one', 'two', 'three', 'four']);
    expect(onto).toBe(git('rev-parse', 'HEAD~4'));

    await repo.interactiveRebase(onto, [
      { hash: c3, action: 'pick' },
      { hash: c1, action: 'reword', message: 'one and two\n\nsquashed' },
      { hash: c2, action: 'fixup' },
      { hash: c4, action: 'drop' },
    ]);
    expect(await repo.operation()).toBeUndefined();
    expect(subjects()).toEqual(['one and two', 'three', 'initial']);
    expect(git('log', '-1', '--format=%B')).toBe('one and two\n\nsquashed');
    expect(git('show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['c1.txt', 'c2.txt']);
    expect(existsSync(join(dir, 'c4.txt'))).toBe(false);
  });

  it('rebases from the root commit and keeps local changes (autostash)', async () => {
    commitFile('c1.txt', '1\n', 'one');
    write('a.txt', 'local edit\n');
    const root = git('rev-list', '--max-parents=0', 'HEAD');
    const { onto, commits } = await repo.rebaseCommits(root);
    expect(onto).toBeUndefined();
    await repo.interactiveRebase(onto, [
      { hash: commits[1].hash, action: 'pick' },
      { hash: commits[0].hash, action: 'reword', message: 'initial (reworded)' },
    ]);
    expect(subjects()).toEqual(['initial (reworded)', 'one']);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('local edit\n');
  });

  it('never gives a new message to another commit when the reworded one is skipped', async () => {
    const c1 = commitFile('f.txt', 'one\n', 'C1');
    const c2 = commitFile('f.txt', 'two\n', 'C2');
    const { onto } = await repo.rebaseCommits(c1);
    // C2 first: it conflicts, since it changes a file C1 creates.
    await expect(
      repo.interactiveRebase(onto, [
        { hash: c2, action: 'reword', message: 'NEW MESSAGE' },
        { hash: c1, action: 'pick' },
      ]),
    ).rejects.toThrow();
    expect(await repo.operation()).toBe('rebase');
    await repo.sequencer('rebase', 'skip');
    expect(await repo.operation()).toBeUndefined();
    expect(subjects()).toEqual(['C1', 'initial']);
    expect(existsSync(join(dir, '.git', 'gitcharm-rebase'))).toBe(false);
  });

  it('applies a new message when the reworded commit is continued after a conflict', async () => {
    const c1 = commitFile('f.txt', 'one\n', 'C1');
    const c2 = commitFile('f.txt', 'two\n', 'C2');
    const { onto } = await repo.rebaseCommits(c1);
    await expect(
      repo.interactiveRebase(onto, [
        { hash: c2, action: 'reword', message: 'C2 reworded' },
        { hash: c1, action: 'pick' },
      ]),
    ).rejects.toThrow();
    write('f.txt', 'two\n');
    await repo.stage([{ kind: 'modified', path: 'f.txt' }]);
    // C2 is committed with its new message; then C1 conflicts and is skipped.
    await expect(repo.sequencer('rebase', 'continue')).rejects.toThrow();
    await repo.sequencer('rebase', 'skip');
    expect(subjects()).toEqual(['C2 reworded', 'initial']);
  });

  it('uses the new message for a reworded commit with squashes below it', async () => {
    const c1 = commitFile('c1.txt', '1\n', 'one');
    const c2 = commitFile('c2.txt', '2\n', 'two');
    const c3 = commitFile('c3.txt', '3\n', 'three');
    const { onto } = await repo.rebaseCommits(c1);
    await repo.interactiveRebase(onto, [
      { hash: c1, action: 'reword', message: 'All three' },
      { hash: c2, action: 'squash' },
      { hash: c3, action: 'fixup' },
    ]);
    expect(subjects()).toEqual(['All three', 'initial']);
    expect(git('log', '-1', '--format=%B')).toBe('All three');
  });

  it('stops at an edit and amends the staged changes on continue', async () => {
    const c1 = commitFile('c1.txt', '1\n', 'one');
    commitFile('c2.txt', '2\n', 'two');
    const { onto, commits } = await repo.rebaseCommits(c1);
    await repo.interactiveRebase(onto, [
      { hash: commits[0].hash, action: 'edit' },
      { hash: commits[1].hash, action: 'pick' },
    ]);
    expect(await repo.operation()).toBe('rebase');
    write('c1.txt', '1 edited\n');
    await repo.stage([{ kind: 'modified', path: 'c1.txt' }]);
    await repo.sequencer('rebase', 'continue');
    expect(await repo.operation()).toBeUndefined();
    expect(subjects()).toEqual(['two', 'one', 'initial']);
    expect(git('show', 'HEAD~1:c1.txt')).toBe('1 edited');
  });
});

describe('Repository multi-commit changes', () => {
  it('merges the changes of several commits per file', async () => {
    const c1 = commitFile('new.txt', 'n\n', 'add new');
    write('a.txt', 'a2\n');
    write('tmp.txt', 't\n');
    git('add', '.');
    git('commit', '-qm', 'modify a, add tmp');
    const c2 = git('rev-parse', 'HEAD');
    git('rm', '-q', 'tmp.txt', 'b.txt');
    git('commit', '-qm', 'remove tmp and b');
    const c3 = git('rev-parse', 'HEAD');
    git('mv', 'new.txt', 'renamed.txt');
    git('commit', '-qm', 'rename new');
    const c4 = git('rev-parse', 'HEAD');

    const changes = await repo.combinedChanges([c1, c2, c3, c4]);
    expect(changes).toEqual([
      { status: 'M', path: 'a.txt', base: c1, last: c2 },
      { status: 'D', path: 'b.txt', base: c2, last: c3 },
      // Added within the selection, then renamed: still an addition.
      { status: 'A', path: 'renamed.txt', last: c4 },
    ]);

    // Only the last two: a rename of a file that existed before.
    expect(await repo.combinedChanges([c4])).toEqual([
      { status: 'R', path: 'renamed.txt', oldPath: 'new.txt', base: c3, last: c4 },
    ]);
    // Renamed twice within the selection: one rename from where it started.
    git('mv', 'renamed.txt', 'final.txt');
    git('commit', '-qm', 'rename again');
    const c5 = git('rev-parse', 'HEAD');
    expect(await repo.combinedChanges([c4, c5])).toEqual([
      { status: 'R', path: 'final.txt', oldPath: 'new.txt', base: c3, last: c5 },
    ]);

    expect((await repo.diffFiles(c1, c4)).map((f) => `${f.status} ${f.path}`)).toEqual([
      'M a.txt',
      'D b.txt',
      'R renamed.txt',
    ]);
  });
});

describe('Repository.patch', () => {
  const diff = (...args: string[]) => execFileSync('git', ['diff', '--binary', '-M', ...args], { cwd: dir, encoding: 'latin1' });
  const applyOn = (rev: string, patch: Buffer) => {
    git('checkout', '-q', '--detach', rev);
    execFileSync('git', ['apply', '--index'], { cwd: dir, input: patch });
  };

  it('creates a patch of several commits that applies to the commit before them', async () => {
    const initial = git('rev-parse', 'HEAD');
    const c1 = commitFile('new.txt', 'n\n', 'add new');
    write('a.txt', 'a2\n');
    writeFileSync(join(dir, 'bin.dat'), Buffer.from([0, 1, 2, 255]));
    git('add', '.');
    git('commit', '-qm', 'modify a, add binary');
    const c2 = git('rev-parse', 'HEAD');
    git('rm', '-q', 'b.txt');
    git('mv', 'new.txt', 'renamed.txt');
    git('commit', '-qm', 'remove b, rename new');
    const c3 = git('rev-parse', 'HEAD');

    // Consecutive commits: what git diff gives for the range, sorted by path.
    const all = await repo.patch([c1, c2, c3]);
    expect(all.toString('latin1')).toBe(diff(initial, c3));
    applyOn(initial, all);
    expect(git('diff', '--cached', '--stat', c3)).toBe('');

    // Without the middle commit: the added file arrives renamed, b.txt is deleted, a.txt untouched.
    git('checkout', '-qf', 'main');
    const some = await repo.patch([c1, c3]);
    applyOn(initial, some);
    expect(git('diff', '--cached', '--name-status', initial)).toBe('D\tb.txt\nA\trenamed.txt');

    // A root commit is diffed against the empty tree.
    expect((await repo.patch([initial])).toString('latin1')).toBe(diff('4b825dc642cb6eb9a060e54bf8d69288fbee4904', initial));

    git('checkout', '-qf', 'main');
    git('commit', '-q', '--allow-empty', '-m', 'empty');
    expect((await repo.patch([git('rev-parse', 'HEAD')])).length).toBe(0);
  });
});

describe('Repository multi-commit edge cases', () => {
  it('handles a path re-added after a rename and a rename onto a deleted path', async () => {
    git('mv', 'a.txt', 'z.txt');
    git('commit', '-qm', 'rename a to z');
    const c1 = git('rev-parse', 'HEAD');
    const c2 = commitFile('a.txt', 'new a\n', 'new a');
    git('rm', '-q', 'z.txt');
    git('commit', '-qm', 'remove z');
    const c3 = git('rev-parse', 'HEAD');
    // a existed before and after (with other contents), z came and went.
    expect(await repo.combinedChanges([c1, c2, c3])).toEqual([
      { status: 'M', path: 'a.txt', base: git('rev-parse', `${c1}~1`), last: c2 },
    ]);

    git('rm', '-q', 'b.txt');
    git('commit', '-qm', 'remove b');
    const c4 = git('rev-parse', 'HEAD');
    git('mv', 'a.txt', 'b.txt');
    git('commit', '-qm', 'rename a onto b');
    const c5 = git('rev-parse', 'HEAD');
    expect(await repo.combinedChanges([c4, c5])).toEqual([
      { status: 'D', path: 'a.txt', base: c4, last: c5 },
      { status: 'M', path: 'b.txt', base: c3, last: c5 },
    ]);
  });
});

describe('Repository stash', () => {
  it('stashes selected files including unversioned ones, lists and re-applies them', async () => {
    write('a.txt', 'a2\n');
    write('b.txt', 'b2\n');
    write('new.txt', 'new\n');
    const status = await repo.status();
    const picked = status.filter((c) => c.path === 'a.txt' || c.path === 'new.txt');
    expect(await repo.stash({ message: 'only a and new', includeUntracked: true, changes: picked })).toBe(true);
    expect(await repo.status()).toEqual([{ kind: 'modified', path: 'b.txt' }]);

    expect(await repo.stash({ includeUntracked: false })).toBe(true);
    expect(await repo.stash({ includeUntracked: false })).toBe(false);

    const [rest, first] = await repo.stashes();
    expect(first).toMatchObject({ ref: 'stash@{1}', message: 'only a and new', branch: 'main', hasUntracked: true });
    expect(rest.message).toMatch(/^WIP on main: /);
    expect(await repo.stashFiles(first)).toEqual([
      { status: 'M', path: 'a.txt' },
      { status: 'A', path: 'new.txt', untracked: true },
    ]);

    await repo.unstash(first, false);
    expect((await repo.status()).map((c) => `${c.kind} ${c.path}`)).toEqual(['modified a.txt', 'unversioned new.txt']);
    expect(await repo.stashes()).toHaveLength(2);

    // Popping by a stale index is refused once the list has shifted.
    await repo.dropStash(rest);
    await expect(repo.unstash({ ...first, ref: 'stash@{1}' }, true)).rejects.toThrow(/stash list changed/);
    const [current] = await repo.stashes();
    git('checkout', '-q', '--', 'a.txt');
    rmSync(join(dir, 'new.txt'));
    await repo.unstash(current, true);
    expect(await repo.stashes()).toHaveLength(0);
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n');
  });

  it('stashes selected staged renames and deletions', async () => {
    git('mv', 'a.txt', 'moved.txt');
    git('rm', '-q', 'b.txt');
    write('new.txt', 'new\n');
    const picked = await repo.status();
    expect(picked.map((c) => c.kind).sort()).toEqual(['deleted', 'renamed', 'unversioned']);
    expect(await repo.stash({ message: 'moves', includeUntracked: true, changes: picked })).toBe(true);
    expect(await repo.status()).toEqual([]);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('a1\n');
    expect(readFileSync(join(dir, 'b.txt'), 'utf8')).toBe('b1\n');

    const [entry] = await repo.stashes();
    await repo.unstash(entry, true);
    expect(existsSync(join(dir, 'a.txt'))).toBe(false);
    expect(existsSync(join(dir, 'b.txt'))).toBe(false);
    expect(readFileSync(join(dir, 'moved.txt'), 'utf8')).toBe('a1\n');
    expect(readFileSync(join(dir, 'new.txt'), 'utf8')).toBe('new\n');
  });

  it('unstashes as a new branch and clears stashes', async () => {
    write('a.txt', 'a2\n');
    await repo.stash({ message: 'for a branch', includeUntracked: false });
    const [entry] = await repo.stashes();
    await repo.stashBranch(entry, 'from-stash');
    expect((await repo.head()).branch).toBe('from-stash');
    expect(await repo.status()).toEqual([{ kind: 'modified', path: 'a.txt' }]);
    await repo.stash({ includeUntracked: false });
    await repo.clearStashes();
    expect(await repo.stashes()).toEqual([]);
  });
});

describe('Repository.blame', () => {
  it('blames the editor contents, marking unsaved lines as not committed', async () => {
    const first = git('rev-parse', 'HEAD');
    write('a.txt', 'a1\nsecond\n');
    git('commit', '-qam', 'second line');
    const second = git('rev-parse', 'HEAD');

    const blame = await repo.blame('a.txt', { contents: 'a1\nsecond\nunsaved\n' });
    expect(blame.lines).toEqual([first, second, '0'.repeat(40)]);
    expect(blame.commits.get(second)!.summary).toBe('second line');

    const old = await repo.blame('a.txt', { revision: first });
    expect(old.lines).toEqual([first]);
  });
});

describe('Untrusted repository content', () => {
  it('shows no fake commits for separators forged in a commit message', async () => {
    write('msg.txt', 'Nice change\x1e--output=pwned.txt\x1f\x1fEve\x1fe@x\x1f0\x1fFake\n');
    git('commit', '-q', '--allow-empty', '-F', 'msg.txt');
    const real = git('log', '--format=%H').split('\n');

    const { commits } = await repo.log({}, 100);
    expect(commits.map((c) => c.hash)).toEqual(real);
    expect(commits[0].subject).toBe('Nice change');
    expect(existsSync(join(dir, 'pwned.txt'))).toBe(false);
  });
});
