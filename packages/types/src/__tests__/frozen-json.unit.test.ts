import { describe, expect, it } from 'vitest';
import { freezeJson, isDeepFrozenJson } from '../frozen-json.js';

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

describe('isDeepFrozenJson', () => {
  it('walks a proven tree once, however often it or its subtrees are checked', () => {
    let walked = 0;
    // A frozen Proxy reports its frozen target exactly; it only counts key walks.
    const counted = (value: object): object =>
      new Proxy(value, {
        ownKeys: (target) => {
          walked++;
          return Reflect.ownKeys(target);
        },
      });
    const build = (depth: number): object =>
      counted(
        Object.freeze(
          depth === 0 ? { leaf: 1 } : { a: build(depth - 1), b: Object.freeze([1, 'x']) },
        ),
      );
    const root = build(12);
    expect(isDeepFrozenJson(root)).toBe(true);
    const first = walked;
    // Object.isFrozen and the property walk each list a node's keys once.
    expect(first).toBe(2 * 13);
    // Repeated adoption checks, including a caller that recurses node by node.
    for (let round = 0; round < 5; round++) expect(isDeepFrozenJson(root)).toBe(true);
    let node: Record<string, unknown> | undefined = root as Record<string, unknown>;
    while (node !== undefined) {
      expect(isDeepFrozenJson(node)).toBe(true);
      node = node.a as Record<string, unknown> | undefined;
    }
    expect(walked).toBe(first);
  });

  it('does not remember a negative answer', () => {
    const inner: { b: number } = { b: 1 };
    const outer = Object.freeze({ a: inner });
    expect(isDeepFrozenJson(outer)).toBe(false);
    Object.freeze(inner);
    expect(isDeepFrozenJson(outer)).toBe(true);
  });

  it('accepts deep-frozen plain JSON trees', () => {
    expect(isDeepFrozenJson(deepFreeze({ a: [1, 'x', true, null, { b: undefined }] }))).toBe(true);
    expect(isDeepFrozenJson(deepFreeze(Object.assign(Object.create(null), { a: 1 })))).toBe(true);
  });

  it('rejects mutable nodes anywhere in the tree', () => {
    expect(isDeepFrozenJson({ a: 1 })).toBe(false);
    expect(isDeepFrozenJson(Object.freeze({ a: { b: 1 } }))).toBe(false);
  });

  it('rejects frozen cycles while accepting repeated immutable children', () => {
    const child = Object.freeze({ value: 1 });
    expect(isDeepFrozenJson(Object.freeze({ left: child, right: child }))).toBe(true);
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    expect(isDeepFrozenJson(Object.freeze(cyclic))).toBe(false);
  });

  it('retains ancestry across shared immutable leaves without reading hidden or accessor values', () => {
    const leaf = Object.freeze({ value: 1 });
    expect(isDeepFrozenJson(leaf)).toBe(true);
    const nested: { leaf: object; back?: object } = { leaf };
    const cycle = Object.freeze({ left: leaf, right: nested });
    nested.back = cycle;
    Object.freeze(nested);
    expect(isDeepFrozenJson(cycle)).toBe(false);
    let reads = 0;
    const accessor = Object.freeze({
      get field() {
        reads++;
        return leaf;
      },
    });
    const withHidden = Object.freeze(Object.defineProperty({ leaf }, 'hidden', { value: leaf }));
    const withSymbol = Object.freeze({ leaf, [Symbol('extra')]: leaf });
    const frozenView = Object.freeze(new Uint8Array(0));
    for (const value of [accessor, withHidden, withSymbol, frozenView]) {
      expect(isDeepFrozenJson(Object.freeze({ left: leaf, right: value }))).toBe(false);
    }
    expect(reads).toBe(0);
    expect(
      isDeepFrozenJson(Object.freeze({ left: leaf, right: Object.freeze([leaf, leaf]) })),
    ).toBe(true);
  });

  it('rejects accessors, hidden or symbol keys, foreign prototypes, functions and views', () => {
    const rejected: object[] = [
      Object.defineProperty({}, 'a', { get: () => 1, enumerable: true }),
      Object.defineProperty({}, 'a', { value: 1 }),
      { [Symbol('a')]: 1 },
      Object.create({ inherited: 1 }),
      { a: () => 1 },
      { a: 1n },
    ];
    for (const value of rejected) expect(isDeepFrozenJson(Object.freeze(value))).toBe(false);
    expect(isDeepFrozenJson(Object.freeze(new Uint8Array(0)))).toBe(false);
  });
});
describe('freezeJson', () => {
  it('freezes an owned tree in place and returns the same object', () => {
    const tree = { bindings: [{ group: 0, fields: ['cameraPos'] }], tag: 'a' };
    const bindings = tree.bindings;
    expect(freezeJson(tree)).toBe(tree);
    expect(Object.isFrozen(tree)).toBe(true);
    expect(Object.isFrozen(bindings)).toBe(true);
    expect(isDeepFrozenJson(tree)).toBe(true);
  });

  it('does not merge equal trees: each owner keeps its own object', () => {
    const first = freezeJson({ value: 1 });
    const second = freezeJson({ value: 1 });
    expect(second).not.toBe(first);
    expect(isDeepFrozenJson(second)).toBe(true);
  });

  it('terminates on a cycle because a node freezes before its children', () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    expect(freezeJson(cyclic)).toBe(cyclic);
    expect(Object.isFrozen(cyclic)).toBe(true);
  });
});
