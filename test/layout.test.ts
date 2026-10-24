import { describe, expect, it } from 'vitest';
import { layoutGraph } from '../src/graph/layout';

const c = (hash: string, ...parents: string[]) => ({ hash, parents });

describe('layoutGraph', () => {
  it('keeps a linear history in one lane', () => {
    const rows = layoutGraph([c('C', 'B'), c('B', 'A'), c('A')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(rows.map((r) => r.width)).toEqual([1, 1, 1]);
    expect(rows[0].edges).toEqual([{ kind: 'bottom', from: 0, to: 0, color: 0 }]);
    expect(rows[1].edges).toEqual([
      { kind: 'top', from: 0, to: 0, color: 0 },
      { kind: 'bottom', from: 0, to: 0, color: 0 },
    ]);
    expect(rows[2].edges).toEqual([{ kind: 'top', from: 0, to: 0, color: 0 }]);
  });

  it('opens a lane for the second parent of a merge and closes it at the fork point', () => {
    const rows = layoutGraph([c('M', 'B', 'F'), c('F', 'A'), c('B', 'A'), c('A')]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(rows[0].edges).toEqual([
      { kind: 'bottom', from: 0, to: 0, color: 0 },
      { kind: 'bottom', from: 0, to: 1, color: 1 },
    ]);
    expect(rows[1].edges).toEqual([
      { kind: 'through', from: 0, to: 0, color: 0 },
      { kind: 'top', from: 1, to: 1, color: 1 },
      { kind: 'bottom', from: 1, to: 1, color: 1 },
    ]);
    // Both lanes lead into A, which ends the history.
    expect(rows[3].edges).toEqual([
      { kind: 'top', from: 0, to: 0, color: 0 },
      { kind: 'top', from: 1, to: 0, color: 1 },
    ]);
    expect(rows[3].width).toBe(2);
  });

  it('gives each branch tip its own lane and color', () => {
    const rows = layoutGraph([c('T1', 'A'), c('T2', 'A'), c('A')]);
    expect(rows.map((r) => [r.lane, r.color])).toEqual([
      [0, 0],
      [1, 1],
      [0, 0],
    ]);
  });

  it('shifts lanes left when a lane ends', () => {
    const rows = layoutGraph([c('a', 'ra'), c('b', 'rb'), c('c', 'rc'), c('ra'), c('rb'), c('rc')]);
    const ra = rows[3];
    expect(ra.lane).toBe(0);
    expect(ra.edges).toEqual([
      { kind: 'top', from: 0, to: 0, color: 0 },
      { kind: 'through', from: 1, to: 0, color: 1 },
      { kind: 'through', from: 2, to: 1, color: 2 },
    ]);
    expect(rows[4].lane).toBe(0);
    expect(rows[5].lane).toBe(0);
  });

  it('joins a merge parent into a lane that already waits for it', () => {
    // X and M both lead to P; M's second parent P is already awaited by X's lane.
    const rows = layoutGraph([c('X', 'P'), c('M', 'Q', 'P'), c('Q', 'P'), c('P')]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].edges).toContainEqual({ kind: 'bottom', from: 1, to: 0, color: 0 });
    // No third lane is opened.
    expect(rows[1].width).toBe(2);
  });

  it('keeps lanes open for parents outside the loaded range', () => {
    const rows = layoutGraph([c('B', 'A'), c('Z', 'Y')]);
    expect(rows[1].lane).toBe(1);
    expect(rows[1].edges).toContainEqual({ kind: 'through', from: 0, to: 0, color: 0 });
  });

  it('handles an empty history', () => {
    expect(layoutGraph([])).toEqual([]);
  });
});
