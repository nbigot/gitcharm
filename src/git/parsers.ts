import type { ChangeStatus, Commit, CommitDetails, FileChange, LocalChange, RebaseCommit, Ref, StashEntry } from '../shared/types';

// Field / record separators used in our --format strings. They cannot appear
// in commit subjects or ref names in practice.
export const FS = '\x1f';
export const RS = '\x1e';

export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s'].join('%x1f') + '%x1e';

export function parseLog(stdout: string): Commit[] {
  const commits: Commit[] = [];
  for (const raw of stdout.split(RS)) {
    const record = raw.replace(/^\n/, '');
    if (!record) {
      continue;
    }
    const [hash, parents, author, email, date, subject] = record.split(FS);
    if (!hash) {
      continue;
    }
    commits.push({
      hash,
      parents: parents ? parents.split(' ') : [],
      author,
      email,
      date: Number(date),
      subject: subject ?? '',
    });
  }
  return commits;
}

/** LOG_FORMAT plus the full message. */
export const FULL_LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%B'].join('%x1f') + '%x1e';

export function parseFullLog(stdout: string): RebaseCommit[] {
  const commits: RebaseCommit[] = [];
  for (const raw of stdout.split(RS)) {
    const [hash, parents, author, email, date, subject, ...message] = raw.replace(/^\n/, '').split(FS);
    if (hash) {
      commits.push({
        hash,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date: Number(date),
        subject: subject ?? '',
        message: message.join(FS).replace(/\s+$/, ''),
      });
    }
  }
  return commits;
}

export const DETAILS_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%cn', '%ce', '%ct', '%B'].join('%x1f');

export function parseCommitDetails(stdout: string, files: FileChange[]): CommitDetails {
  const [hash, parents, author, authorEmail, authorDate, committer, committerEmail, committerDate, ...rest] =
    stdout.split(FS);
  return {
    hash,
    parents: parents ? parents.split(' ') : [],
    author,
    authorEmail,
    authorDate: Number(authorDate),
    committer,
    committerEmail,
    committerDate: Number(committerDate),
    message: rest.join(FS).replace(/\s+$/, ''),
    files,
  };
}

export const REFS_FORMAT = [
  '%(objectname)',
  '%(*objectname)',
  '%(refname)',
  '%(upstream:short)',
  '%(upstream:track)',
  '%(HEAD)',
  '%(upstream:remotename)',
  '%(upstream:remoteref)',
].join('%00');

/**
 * Parses `git for-each-ref --format=REFS_FORMAT`. `remotes` is the list of
 * configured remotes, used to split `origin/feature/x` into remote + branch.
 */
export function parseRefs(stdout: string, remotes: string[]): Ref[] {
  const byLength = [...remotes].sort((a, b) => b.length - a.length);
  const refs: Ref[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue;
    }
    const [objectName, peeled, fullName, upstream, track, head, upstreamRemote, upstreamRef] = line.split('\0');
    const hash = peeled || objectName;
    if (fullName.startsWith('refs/heads/')) {
      const ref: Ref = { name: fullName.slice('refs/heads/'.length), fullName, kind: 'branch', hash };
      if (upstream) {
        ref.upstream = upstream;
        if (upstreamRemote) {
          ref.upstreamRemote = upstreamRemote;
          ref.upstreamBranch = (upstreamRef ?? '').replace(/^refs\/heads\//, '');
        }
        Object.assign(ref, parseTrack(track));
      }
      if (head === '*') {
        ref.isCurrent = true;
      }
      refs.push(ref);
    } else if (fullName.startsWith('refs/remotes/')) {
      const name = fullName.slice('refs/remotes/'.length);
      if (name.endsWith('/HEAD')) {
        continue;
      }
      const remote = byLength.find((r) => name.startsWith(r + '/')) ?? name.split('/')[0];
      refs.push({ name, fullName, kind: 'remote', hash, remote });
    } else if (fullName.startsWith('refs/tags/')) {
      refs.push({ name: fullName.slice('refs/tags/'.length), fullName, kind: 'tag', hash });
    }
  }
  return refs;
}

/** Parses `%(upstream:track)`: `[ahead 1, behind 2]`, `[gone]` or empty. */
export function parseTrack(track: string): Pick<Ref, 'ahead' | 'behind' | 'upstreamGone'> {
  if (track === '[gone]') {
    return { upstreamGone: true };
  }
  const ahead = /ahead (\d+)/.exec(track);
  const behind = /behind (\d+)/.exec(track);
  return { ahead: ahead ? Number(ahead[1]) : 0, behind: behind ? Number(behind[1]) : 0 };
}

/** Parses `git diff-tree -r -z --name-status -M` output. */
export function parseNameStatus(stdout: string): FileChange[] {
  const tokens = stdout.split('\0');
  const files: FileChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const code = tokens[i++];
    if (!code) {
      continue;
    }
    const status = code[0] as ChangeStatus;
    if (status === 'R' || status === 'C') {
      const oldPath = tokens[i++];
      const path = tokens[i++];
      files.push({ status, path, oldPath });
    } else {
      files.push({ status, path: tokens[i++] });
    }
  }
  return files;
}

const CONFLICT_CODES = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/**
 * Parses `git status --porcelain=v1 -z` into PyCharm-style changes: one entry
 * per file, described relative to HEAD (the index is not exposed).
 */
export function parseStatus(stdout: string): LocalChange[] {
  const tokens = stdout.split('\0');
  const changes: LocalChange[] = [];
  let i = 0;
  while (i < tokens.length) {
    const entry = tokens[i++];
    if (entry.length < 4) {
      continue;
    }
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    if (x === 'R' || x === 'C' || y === 'R' || y === 'C') {
      // Renames/copies carry the original path in the next token (` R` = intent-to-add rename).
      const oldPath = tokens[i++];
      const renamed = x === 'R' || (x !== 'C' && y === 'R');
      changes.push(renamed ? { kind: 'renamed', path, oldPath } : { kind: 'added', path });
      continue;
    }
    if (x === '?' && y === '?') {
      changes.push({ kind: 'unversioned', path });
    } else if (x === '!' && y === '!') {
      continue;
    } else if (CONFLICT_CODES.has(x + y)) {
      changes.push({ kind: 'conflict', path });
    } else if (y === 'D' || x === 'D') {
      changes.push({ kind: 'deleted', path });
    } else if (x === 'A' || y === 'A') {
      // `A ` added, ` A` intent-to-add (`git add -N`).
      changes.push({ kind: 'added', path });
    } else {
      changes.push({ kind: 'modified', path });
    }
  }
  return changes;
}

/**
 * Extracts recently checked-out branch names from `git reflog --format=%gs`,
 * most recent first.
 */
export function parseRecentCheckouts(stdout: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const line of stdout.split('\n')) {
    const m = /^checkout: moving from (\S+) to (\S+)$/.exec(line.trim());
    if (!m) {
      continue;
    }
    for (const name of [m[2], m[1]]) {
      if (!seen.has(name)) {
        seen.add(name);
        result.push(name);
      }
    }
  }
  return result;
}

export const STASH_FORMAT = ['%gd', '%H', '%P', '%ct', '%gs'].join('%x1f');

/** Parses `git stash list --format=STASH_FORMAT`, newest first. */
export function parseStashList(stdout: string): StashEntry[] {
  const entries: StashEntry[] = [];
  for (const line of stdout.split('\n')) {
    if (!line) {
      continue;
    }
    const [ref, hash, parents, date, subject = ''] = line.split(FS);
    const parentList = parents ? parents.split(' ') : [];
    // "On main: message" when a message was given, "WIP on main: 1a2b3c4 subject" otherwise.
    const m = /^(WIP on|On) ([^:]+): (.*)$/.exec(subject);
    entries.push({
      ref,
      hash,
      base: parentList[0] ?? '',
      hasUntracked: parentList.length > 2,
      date: Number(date),
      message: m && m[1] === 'On' ? m[3] : subject,
      branch: m && m[2] !== '(no branch)' ? m[2] : undefined,
    });
  }
  return entries;
}

export interface BlameCommit {
  hash: string;
  author: string;
  authorMail: string;
  /** Unix seconds. */
  authorTime: number;
  summary: string;
  /** Path of the file in this commit. */
  filename: string;
  /** The commit's parent and the file's path there (absent for the commit that added the file). */
  previous?: { hash: string; path: string };
}

export interface BlameResult {
  /** Commit hash per line (index = line number - 1); all zeros = not committed yet. */
  lines: string[];
  commits: Map<string, BlameCommit>;
}

/** Parses `git blame --porcelain`. */
export function parseBlame(stdout: string): BlameResult {
  const lines: string[] = [];
  const commits = new Map<string, BlameCommit>();
  let current: BlameCommit | undefined;
  for (const line of stdout.split('\n')) {
    const header = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(line);
    if (header) {
      const hash = header[1];
      lines[Number(header[2]) - 1] = hash;
      current = commits.get(hash);
      if (!current) {
        current = { hash, author: '', authorMail: '', authorTime: 0, summary: '', filename: '' };
        commits.set(hash, current);
      }
      continue;
    }
    if (!current || line.startsWith('\t')) {
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    switch (key) {
      case 'author':
        current.author = value;
        break;
      case 'author-mail':
        current.authorMail = value.replace(/^<|>$/g, '');
        break;
      case 'author-time':
        current.authorTime = Number(value);
        break;
      case 'summary':
        current.summary = value;
        break;
      case 'filename':
        current.filename = value;
        break;
      case 'previous': {
        const i = value.indexOf(' ');
        current.previous = { hash: value.slice(0, i), path: value.slice(i + 1) };
        break;
      }
    }
  }
  return { lines, commits };
}

/** True for the all-zeros hash git uses for lines that are not committed yet. */
export function isUncommitted(hash: string): boolean {
  return /^0+$/.test(hash);
}
