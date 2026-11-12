import { describe, expect, it, vi } from 'vitest';
import { internJson, isDeepFrozenJson } from '../frozen-json.js';

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

describe('internJson', () => {
  it('holds equal subtrees once and returns deep-frozen JSON', () => {
    const first = { bindings: [{ group: 0, fields: ['cameraPos', 'worldViewProj'] }], tag: 'a' };
    const second = { bindings: [{ group: 0, fields: ['cameraPos', 'worldViewProj'] }], tag: 'b' };
    const left = internJson(first);
    const right = internJson(second);
    expect(left).toBe(first);
    expect(right).toBe(second);
    expect(right?.bindings).toBe(left?.bindings);
    expect(isDeepFrozenJson(right as object)).toBe(true);
    // An equal tree received later resolves to the same canonical root.
    expect(internJson(structuredClone(second))).toBe(second);
  });

  it('keeps exact primitives distinct and rejects values that are not plain JSON', () => {
    const zero = internJson({ value: 0 });
    expect(internJson({ value: -0 })).not.toBe(zero);
    expect(internJson({ value: '0' })).not.toBe(zero);
    expect(internJson({ bytes: new Uint8Array(1) })).toBeUndefined();
    expect(internJson({ value: Number.NaN })).toBeUndefined();
    expect(internJson(new Map())).toBeUndefined();
  });

  it('rejects sparse, extra-key and accessor inputs without reading accessors', () => {
    expect(internJson(new Array(1))).toBeUndefined();
    expect(internJson(Object.assign([1], { tag: 'extra' }))).toBeUndefined();
    expect(internJson({ [Symbol('hidden')]: 1 })).toBeUndefined();
    let reads = 0;
    expect(
      internJson({
        get value() {
          reads++;
          return 1;
        },
      }),
    ).toBeUndefined();
    expect(reads).toBe(0);
    expect(internJson(Object.defineProperty({}, 'hidden', { value: 1 }))).toBeUndefined();
  });

  it('rejects cycles and shares separately frozen inputs without mutating them', () => {
    const cyclic: { self?: object } = {};
    cyclic.self = cyclic;
    expect(internJson(cyclic)).toBeUndefined();
    const first = internJson({ nested: { field: 7 } });
    const input = Object.freeze({ nested: Object.freeze({ field: 7 }) });
    expect(internJson(input)).toBe(first);
  });

  it('separates a canonical child id from the next object field length', async () => {
    vi.resetModules();
    const { internJson: isolated } = await import('../frozen-json.js');
    // These roots have ids 1 through 12 in this isolated interner.
    const children = Array.from({ length: 12 }, (_, value) => isolated({ value }));
    const left = isolated({ a: children[0], 'foos19:abcdefghijklmnop': 7 });
    const right = isolated({ a: children[11], foo: 'abcdefghijklmnopn7,' });
    // Without a child-id terminator both keys spell #123:foos19:abcdefghijklmnopn7,.
    expect(right).not.toBe(left);
    expect(right?.foo).toBe('abcdefghijklmnopn7,');
  });
});
