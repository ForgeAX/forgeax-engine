import { afterEach, describe, expect, it, vi } from 'vitest';
import { freezeRuntimePayload } from '../internal/immutable-payload.js';

function payload(depth: number, branching: number): { value: unknown; nodes: number } {
  if (depth === 0) return { value: { size: 64, kind: 'uniform' }, nodes: 1 };
  const children: unknown[] = [];
  let nodes = 2;
  for (let index = 0; index < branching; index++) {
    const child = payload(depth - 1, branching);
    children.push(child.value);
    nodes += child.nodes;
  }
  return { value: { children }, nodes };
}

describe('freezeRuntimePayload', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('walks a payload once and skips it on every later freeze', () => {
    const { value, nodes } = payload(5, 4);
    const values = vi.spyOn(Object, 'values');
    freezeRuntimePayload(value);
    const first = values.mock.calls.length;
    expect(first).toBe(nodes);
    // Promotion freezes the same decoded payload again, and so does any payload
    // that embeds it: none of them walk the frozen graph.
    values.mockClear();
    freezeRuntimePayload(value);
    freezeRuntimePayload({ nested: value, other: value });
    expect(values.mock.calls.length).toBe(1);
  });

  it('freezes a mutable node that gained a child after an earlier freeze elsewhere', () => {
    const shared = { size: 1 };
    freezeRuntimePayload({ shared });
    expect(Object.isFrozen(shared)).toBe(true);
    const fresh = { size: 2 };
    const outer = freezeRuntimePayload({ shared, fresh });
    expect(Object.isFrozen(fresh)).toBe(true);
    expect(Object.isFrozen(outer)).toBe(true);
  });

  it('still freezes mutable descendants of an already frozen node it did not freeze itself', () => {
    const mutable = { size: 1 };
    const outer = Object.freeze({ mutable });
    freezeRuntimePayload(outer);
    expect(Object.isFrozen(mutable)).toBe(true);
  });

  it('freezes cyclic graphs and leaves typed arrays unfrozen', () => {
    const a: Record<string, unknown> = { bytes: new Uint8Array([1, 2]) };
    const b: Record<string, unknown> = { a };
    a.b = b;
    freezeRuntimePayload(a);
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.isFrozen(a.bytes)).toBe(false);
  });

  it('does not claim a graph whose walk threw', () => {
    const hostile = {
      get boom(): never {
        throw new Error('getter');
      },
    };
    const sibling = { size: 1 };
    expect(() => freezeRuntimePayload({ sibling, hostile })).toThrow('getter');
    // The sibling was frozen before the throw, but the outer graph never completed.
    const outer = { sibling, late: { size: 2 } };
    freezeRuntimePayload(outer);
    expect(Object.isFrozen(outer.late)).toBe(true);
    expect(Object.isFrozen(outer)).toBe(true);
  });
});
