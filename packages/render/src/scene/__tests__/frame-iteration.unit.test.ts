import { describe, expect, it } from 'vitest';
import { MemberCandidates } from '../../gpu-driven/batch-members';
import { FrameProjection, RetainedFrameProjection } from '../frame-list';
import { nodes, put, remove } from '../frame-tree';
import { TreeFrame } from '../frame-tree-list';

function tree(keys: readonly number[]) {
  let root: ReturnType<typeof put<string>> | undefined;
  for (const key of keys) root = put(root, `v${key}`, 0, key, 1);
  return root;
}

describe('frame tree iteration and no-op edits', () => {
  it('walks nodes in key order and supports independent nested walks', () => {
    const root = tree([5, 1, 9, 3, 7]);
    expect([...nodes(root)].map((node) => node.key)).toEqual([1, 3, 5, 7, 9]);
    const outer = nodes(root);
    const pairs: string[] = [];
    for (const a of outer) {
      const inner = nodes(root).next();
      pairs.push(`${a.key}:${inner.done ? '-' : inner.value.key}`);
    }
    expect(pairs).toEqual(['1:1', '3:1', '5:1', '7:1', '9:1']);
    expect([...nodes(undefined)]).toEqual([]);
  });

  it('keeps the root for an identical put and a remove of a missing key', () => {
    const root = tree([4, 2, 6]);
    expect(put(root, 'v2', 0, 2, 1)).toBe(root);
    expect(remove(root, 0, 99)).toBe(root);
    const replaced = put(root, 'other', 0, 2, 1);
    expect(replaced).not.toBe(root);
    expect([...nodes(replaced)].map((node) => node.value)).toEqual(['other', 'v4', 'v6']);
    expect([...nodes(remove(root, 0, 2))].map((node) => node.key)).toEqual([4, 6]);
  });
});

describe('frame projections', () => {
  it('projects every row with its index, and stops cleanly on break', () => {
    const source = new TreeFrame(tree([1, 2, 3]));
    const projected = new FrameProjection(source, (value, index) => `${value}@${index}`);
    expect([...projected]).toEqual(['v1@0', 'v2@1', 'v3@2']);
    expect(projected.filter((value) => value !== 'v2@1')).toEqual(['v1@0', 'v3@2']);
    const seen: string[] = [];
    for (const value of projected) {
      seen.push(value);
      if (seen.length === 2) break;
    }
    expect(seen).toEqual(['v1@0', 'v2@1']);
  });

  it('leaves row identity to the projector memo instead of copying rows by index', () => {
    const memo = new Map<unknown, { value: unknown }>();
    let calls = 0;
    const retained = new RetainedFrameProjection(new TreeFrame(tree([1, 2])), (value) => {
      calls += 1;
      let row = memo.get(value);
      if (row === undefined) {
        row = { value };
        memo.set(value, row);
      }
      return row;
    });
    const first = [...retained];
    const second = [...retained];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(retained.at(1)).toBe(first[1]);
    expect(calls).toBe(5);
  });
});

describe('member candidate iteration', () => {
  it('yields single, small and paged members in member then lane order', () => {
    const member = (primitiveIndex: number, instanceCount: number) => ({
      primitiveIndex,
      generation: 1,
      entityKey: primitiveIndex,
      drawItemIndex: 0,
      instanceCount,
    });
    const members = new MemberCandidates()
      .with(member(3, 2))
      .with(member(1, 1))
      .with(member(7, 150));
    const walked = [...members].map((c) => `${c.primitiveIndex}:${c.instanceOrdinal}`);
    const expected = [
      '1:0',
      '3:0',
      '3:1',
      ...Array.from({ length: 150 }, (_, lane) => `7:${lane}`),
    ];
    expect(walked).toEqual(expected);
    expect(walked.length).toBe(members.length);
    for (let index = 0; index < members.length; index++)
      expect(`${members.at(index)?.primitiveIndex}:${members.at(index)?.instanceOrdinal}`).toBe(
        expected[index],
      );
  });
});
