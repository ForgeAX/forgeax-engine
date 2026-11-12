import { afterEach, describe, expect, it, vi } from 'vitest';
import { materialArtifactConflict } from '../material/artifact-registry.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function artifact(metadata: Record<string, unknown>) {
  return { key: 'k', bytes: new Uint8Array([1, 2, 3]), digest: 'd', metadata };
}

const schema = () => ({
  params: [{ name: 'a', type: 'f32', range: [0, 1] }],
  layout: { size: 16 },
});
const receipt = () => ({ stages: ['vs', 'fs'], hash: 'abc', nested: { a: [1, 2, { b: 3 }] } });

describe('material artifact metadata comparison', () => {
  afterEach(() => vi.restoreAllMocks());

  it('compares distinct deep-frozen metadata without serializing it', () => {
    const left = artifact(deepFreeze({ paramSchema: schema(), abi: schema(), receipt: receipt() }));
    const right = artifact(
      deepFreeze({ paramSchema: schema(), abi: schema(), receipt: receipt() }),
    );
    const spy = vi.spyOn(JSON, 'stringify');
    expect(materialArtifactConflict(left, right)).toBeUndefined();
    expect(spy).not.toHaveBeenCalled();
  });

  it('still reports param-schema and receipt conflicts', () => {
    const base = { paramSchema: schema(), abi: schema(), receipt: receipt() };
    const l = artifact(deepFreeze(structuredClone(base)));
    const badSchema = structuredClone(base);
    badSchema.paramSchema.params = [{ name: 'a', type: 'f32', range: [0, 2] }];
    expect(materialArtifactConflict(l, artifact(deepFreeze(badSchema)))?.detail.dimension).toBe(
      'param-schema',
    );
    const badReceipt = structuredClone(base);
    badReceipt.receipt.nested.a = [1, 2, { b: 4 }];
    expect(materialArtifactConflict(l, artifact(deepFreeze(badReceipt)))?.detail.dimension).toBe(
      'receipt',
    );
  });

  it('keeps key-order, mutable and non-finite cases on the canonical comparison', () => {
    const a = artifact(deepFreeze({ paramSchema: { x: 1, y: 2 } }));
    const reordered = artifact(deepFreeze({ paramSchema: { y: 2, x: 1 } }));
    expect(materialArtifactConflict(a, reordered)?.detail.dimension).toBe('param-schema');
    const m1 = artifact({ paramSchema: { x: 1 } });
    const m2 = artifact({ paramSchema: { x: 1 } });
    expect(materialArtifactConflict(m1, m2)).toBeUndefined();
    const n1 = artifact(deepFreeze({ paramSchema: { x: Number.NaN } }));
    const n2 = artifact(deepFreeze({ paramSchema: { x: null } }));
    expect(materialArtifactConflict(n1, n2)).toBeUndefined();
    // Arrays follow the serializer: holes are null, named properties are not emitted.
    const short: unknown[] = [];
    short[1] = 1;
    const long: unknown[] = [];
    long[1] = 1;
    long.length = 3;
    const s1 = artifact(deepFreeze({ paramSchema: { x: short } }));
    const s2 = artifact(deepFreeze({ paramSchema: { x: long } }));
    expect(materialArtifactConflict(s1, s2)?.detail.dimension).toBe('param-schema');
    const named = (tag: number) => Object.assign([1, 2], { tag });
    const p1 = artifact(deepFreeze({ paramSchema: { x: named(1) } }));
    const p2 = artifact(deepFreeze({ paramSchema: { x: named(2) } }));
    expect(materialArtifactConflict(p1, p2)).toBeUndefined();
    const h1 = artifact(deepFreeze({ paramSchema: { x: [1, undefined, 3] } }));
    const h2 = artifact(deepFreeze({ paramSchema: { x: [1, null, 3] } }));
    expect(materialArtifactConflict(h1, h2)).toBeUndefined();
    const u1 = artifact(deepFreeze({ paramSchema: { x: 1, y: undefined } }));
    const u2 = artifact(deepFreeze({ paramSchema: { x: 1 } }));
    expect(materialArtifactConflict(u1, u2)).toBeUndefined();
  });

  it('agrees with the canonical JSON comparison on generated trees', () => {
    let state = 0x2f6e2b1;
    const next = (bound: number): number => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state % bound;
    };
    const leaves: readonly unknown[] = [0, -0, 1, 2, '', 'a', true, false, null, undefined, NaN];
    const tree = (depth: number): unknown => {
      const kind = depth === 0 ? 0 : next(4);
      if (kind < 2) return leaves[next(leaves.length)];
      if (kind === 2) {
        const array: unknown[] = [];
        const length = next(4);
        for (let index = 0; index < length; index++)
          if (next(5) !== 0) array[index] = tree(depth - 1);
        array.length = length;
        return array;
      }
      const object: Record<string, unknown> = {};
      for (let index = next(4); index > 0; index--)
        object['abc'[next(3)] as string] = tree(depth - 1);
      return object;
    };
    let equalPairs = 0;
    for (let round = 0; round < 4000; round++) {
      const left = tree(3);
      const right = next(3) === 0 ? structuredClone(left) : tree(3);
      const expected = JSON.stringify(left) === JSON.stringify(right);
      if (expected) equalPairs++;
      const conflict = materialArtifactConflict(
        artifact(deepFreeze({ paramSchema: left })),
        artifact(deepFreeze({ paramSchema: right })),
      );
      expect(conflict === undefined, JSON.stringify([left, right])).toBe(expected);
    }
    expect(equalPairs).toBeGreaterThan(500);
  });
});
