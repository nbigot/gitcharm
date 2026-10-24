// Builds a directory tree out of slash-separated paths (files or branch names)
// and flattens it into rows for rendering. Single-child directory chains are
// compressed ("src/views") like in PyCharm.

export interface DirNode<T> {
  name: string;
  /** Full path of the directory, used as its collapse key. */
  path: string;
  dirs: DirNode<T>[];
  items: { name: string; path: string; data: T }[];
}

export function buildTree<T>(entries: { path: string; data: T }[]): DirNode<T> {
  const root: DirNode<T> = { name: '', path: '', dirs: [], items: [] };
  for (const entry of entries) {
    const parts = entry.path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = parts.slice(0, i + 1).join('/');
      let child = node.dirs.find((d) => d.path === path);
      if (!child) {
        child = { name: parts[i], path, dirs: [], items: [] };
        node.dirs.push(child);
      }
      node = child;
    }
    node.items.push({ name: parts[parts.length - 1], path: entry.path, data: entry.data });
  }
  const compress = (node: DirNode<T>): DirNode<T> => {
    node.dirs = node.dirs.map(compress);
    if (node !== root && node.items.length === 0 && node.dirs.length === 1) {
      const only = node.dirs[0];
      return { ...only, name: `${node.name}/${only.name}` };
    }
    return node;
  };
  const sort = (node: DirNode<T>) => {
    node.dirs.sort((a, b) => a.name.localeCompare(b.name));
    node.items.sort((a, b) => a.name.localeCompare(b.name));
    node.dirs.forEach(sort);
  };
  compress(root);
  sort(root);
  return root;
}

export type TreeRow<T> =
  | { kind: 'dir'; depth: number; dir: DirNode<T>; expanded: boolean }
  | { kind: 'item'; depth: number; name: string; path: string; data: T };

export function flattenTree<T>(node: DirNode<T>, collapsed: ReadonlySet<string>, depth = 0, out: TreeRow<T>[] = []): TreeRow<T>[] {
  for (const dir of node.dirs) {
    const expanded = !collapsed.has(dir.path);
    out.push({ kind: 'dir', depth, dir, expanded });
    if (expanded) {
      flattenTree(dir, collapsed, depth + 1, out);
    }
  }
  for (const item of node.items) {
    out.push({ kind: 'item', depth, ...item });
  }
  return out;
}

/** Every item below a directory node. */
export function itemsUnder<T>(node: DirNode<T>): T[] {
  return [...node.items.map((i) => i.data), ...node.dirs.flatMap((d) => itemsUnder(d))];
}
