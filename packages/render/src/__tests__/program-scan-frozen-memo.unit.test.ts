import { afterEach, describe, expect, it, vi } from 'vitest';
import { ownRenderFeatureProgramData } from '../features/prepared-gpu-work';

// containsProgram is the only caller of Object.values in the ownership walk, so the
// number of Object.values calls is the number of node visits it performs.
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Complete tree of plain JSON; the cooked program sits in the last leaf. */
function tree(
  depth: number,
  branching: number,
  program: boolean,
): { node: unknown; nodes: number } {
  if (depth === 0)
    return {
      node: program
        ? { wgsl: 'fn main() {}', entryPoints: ['main'] }
        : { size: 64, kind: 'uniform' },
      nodes: 1,
    };
  const children: unknown[] = [];
  let nodes = 1;
  for (let index = 0; index < branching; index++) {
    const child = tree(depth - 1, branching, program && index === branching - 1);
    children.push(child.node);
    nodes += child.nodes;
  }
  return { node: { children }, nodes: nodes + 1 };
}

describe('ownRenderFeatureProgramData program scan on deep-frozen data', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('visits each frozen node a bounded number of times, not once per ancestor level', () => {
    const { node, nodes } = tree(6, 4, true);
    const root = deepFreeze(node) as { children: unknown[] };
    const values = vi.spyOn(Object, 'values');
    const owned = ownRenderFeatureProgramData(root);
    const visits = values.mock.calls.length;
    // Each node is scanned about once. Without the per-node answer an ancestor's search and
    // each level's own check repeat the walk, about 3.7 visits per node at this depth.
    expect(visits).toBeLessThanOrEqual(nodes * 1.1);
    expect(owned).toEqual(root);
    expect(owned).not.toBe(root);
  });

  it('keeps program-free frozen subtrees shared by identity', () => {
    const { node } = tree(3, 3, true);
    const root = deepFreeze(node) as { children: Record<string, unknown>[] };
    const owned = ownRenderFeatureProgramData(root);
    expect(owned.children[0]).toBe(root.children[0]);
  });

  it('still finds a program added to a tree that was scanned before', () => {
    const clean = deepFreeze({ list: [{ size: 1 }, { size: 2 }] });
    expect(ownRenderFeatureProgramData(clean)).toBe(clean);
    const withProgram = deepFreeze({ list: [...clean.list, { wgsl: 'x', entryPoints: ['m'] }] });
    const owned = ownRenderFeatureProgramData(withProgram);
    expect(owned).not.toBe(withProgram);
    expect(owned.list[0]).toBe(clean.list[0]);
  });
});
