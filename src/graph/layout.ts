// Lane layout for the commit graph. Pure and shared with the webview.
//
// Commits are processed top to bottom (children before parents). Each lane
// "waits" for the next commit it leads to. A row is drawn in two halves:
// edges from the top of the row into the commit node, edges from the node to
// the bottom of the row, and edges that pass straight through. Lanes are
// compacted after every row so the graph stays narrow; a lane that moves left
// is drawn as a diagonal through the row.

export interface GraphInput {
  hash: string;
  parents: string[];
}

export type EdgeKind = 'top' | 'bottom' | 'through';

export interface GraphEdge {
  /**
   * `top`: from lane `from` at the row top into the node.
   * `bottom`: from the node to lane `to` at the row bottom.
   * `through`: from lane `from` at the top to lane `to` at the bottom.
   */
  kind: EdgeKind;
  from: number;
  to: number;
  color: number;
}

export interface GraphRow {
  /** Lane of the commit node. */
  lane: number;
  color: number;
  edges: GraphEdge[];
  /** Number of lanes this row spans. */
  width: number;
}

interface Lane {
  hash: string;
  color: number;
}

export function layoutGraph(commits: readonly GraphInput[]): GraphRow[] {
  let lanes: Lane[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];

  for (const commit of commits) {
    const before = lanes;
    const incoming: number[] = [];
    before.forEach((lane, i) => {
      if (lane.hash === commit.hash) {
        incoming.push(i);
      }
    });

    let nodeLane: number;
    let nodeColor: number;
    if (incoming.length === 0) {
      // A branch tip: nothing above leads here.
      nodeLane = before.length;
      nodeColor = nextColor++;
    } else {
      nodeLane = incoming[0];
      nodeColor = before[nodeLane].color;
    }

    const next: (Lane | null)[] = before.slice();
    if (nodeLane === next.length) {
      next.push(null);
    }
    for (const i of incoming) {
      next[i] = null;
    }

    // Slot (in `next`, before compaction) each parent edge leads to.
    const parentSlots: number[] = [];
    commit.parents.forEach((parent, index) => {
      if (index === 0) {
        next[nodeLane] = { hash: parent, color: nodeColor };
        parentSlots.push(nodeLane);
        return;
      }
      const existing = next.findIndex((lane) => lane !== null && lane.hash === parent);
      if (existing >= 0) {
        parentSlots.push(existing);
        return;
      }
      let slot = next.findIndex((lane, i) => lane === null && i > nodeLane);
      if (slot < 0) {
        slot = next.length;
        next.push(null);
      }
      next[slot] = { hash: parent, color: nextColor++ };
      parentSlots.push(slot);
    });

    // Compact: drop empty lanes and remember where each slot moved to.
    const after: Lane[] = [];
    const moved: number[] = [];
    next.forEach((lane, i) => {
      if (lane) {
        moved[i] = after.length;
        after.push(lane);
      }
    });

    const edges: GraphEdge[] = [];
    before.forEach((lane, i) => {
      if (lane.hash === commit.hash) {
        edges.push({ kind: 'top', from: i, to: nodeLane, color: lane.color });
      } else {
        edges.push({ kind: 'through', from: i, to: moved[i], color: lane.color });
      }
    });
    for (const slot of parentSlots) {
      edges.push({ kind: 'bottom', from: nodeLane, to: moved[slot], color: next[slot]!.color });
    }

    rows.push({
      lane: nodeLane,
      color: nodeColor,
      edges,
      width: Math.max(before.length, after.length, nodeLane + 1),
    });
    lanes = after;
  }
  return rows;
}
