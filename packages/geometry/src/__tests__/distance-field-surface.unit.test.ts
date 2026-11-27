import type { MeshDistanceFieldSurface } from '@forgeax/engine-types';
import { expect, it } from 'vitest';
import { validateDistanceFieldSurface } from '../distance-field-surface';
import { buildDistanceFieldSurface } from '../distance-field-surface-build';
import { createTriangleQuery } from '../triangle-query';

function fixture(): MeshDistanceFieldSurface {
  const positions = new Float32Array([
    1, -1, -1, 1, 1, -1, 1, 0, 1, 3, -1, -1, 3, 1, -1, 3, 0, 1, 100, 0, 0,
  ]);
  const indices = new Uint32Array([0, 1, 2, 3, 4, 5, 6, 6, 6]),
    nodes = new Uint8Array(96),
    view = new DataView(nodes.buffer);
  for (const [node, lo, hi, end, first, size] of [
    [0, 1, 3, 3, 0, 0],
    [1, 1, 1, 2, 0, 1],
    [2, 3, 3, 3, 1, 1],
  ]) {
    if (
      node === undefined ||
      lo === undefined ||
      hi === undefined ||
      end === undefined ||
      first === undefined ||
      size === undefined
    )
      throw Error('Missing authored node');
    for (const [axis, value] of [lo, -1, -1].entries())
      view.setFloat32(node * 32 + axis * 4, value, true);
    for (const [axis, value] of [hi, 1, 1].entries())
      view.setFloat32(node * 32 + 16 + axis * 4, value, true);
    view.setUint32(node * 32 + 12, end, true);
    view.setUint32(node * 32 + 28, first * 4 + size, true);
  }
  return {
    positions,
    indices,
    nodes,
    triangleSidedness: new Uint32Array([2]),
    primitiveOrder: new Uint32Array([0, 1]),
  };
}
it('accepts a complete flat source tree and exactly degenerate omitted source primitive', () => {
  const source = fixture();
  expect(validateDistanceFieldSurface(source).ok).toBe(true);
  expect(Array.from(source.indices.slice(6))).toEqual([6, 6, 6]);
});
it('rejects missing, duplicate and spuriously included degenerate primitives', () => {
  const source = fixture();
  for (const primitiveOrder of [
    new Uint32Array([1]),
    new Uint32Array([0, 0]),
    new Uint32Array([0, 2]),
  ])
    expect(validateDistanceFieldSurface({ ...source, primitiveOrder }).ok).toBe(false);
});
it('rejects invalid topology, nonfinite coordinates, sidedness span and tail bits', () => {
  const outOfRange = fixture();
  outOfRange.indices[0] = 7;
  expect(validateDistanceFieldSurface(outOfRange).ok).toBe(false);
  const nonfinite = fixture();
  nonfinite.positions[0] = NaN;
  expect(validateDistanceFieldSurface(nonfinite).ok).toBe(false);
  const tail = fixture();
  tail.triangleSidedness[0] = 0x80000000;
  expect(validateDistanceFieldSurface(tail).ok).toBe(false);
  expect(
    validateDistanceFieldSurface({ ...fixture(), triangleSidedness: new Uint32Array() }).ok,
  ).toBe(false);
});
it('rejects broken subtree closure, source bounds, leaf ranges and nonfinite node words', () => {
  for (const [byte, value, asFloat] of [
    [12, 0, false],
    [2 * 32 + 12, 2, false],
    [28, 4, false],
    [32 + 28, 3, false],
    [32, 1.1, true],
    [16, 2, true],
    [32 + 16, NaN, true],
  ]) {
    if (byte === undefined || value === undefined || asFloat === undefined)
      throw Error('Missing negative node control');
    const source = fixture(),
      view = new DataView(source.nodes.buffer);
    if (asFloat) view.setFloat32(Number(byte), Number(value), true);
    else view.setUint32(Number(byte), Number(value), true);
    expect(validateDistanceFieldSurface(source).ok).toBe(false);
  }
  const shifted = fixture(),
    shiftedView = new DataView(shifted.nodes.buffer);
  shiftedView.setFloat32(32, 0.9, true);
  shiftedView.setFloat32(32 + 16, 0.95, true);
  expect(validateDistanceFieldSurface(shifted).ok).toBe(false);
  expect(validateDistanceFieldSurface({ ...fixture(), nodes: new Uint8Array(95) }).ok).toBe(false);
});
it('does not mistake a float-cancelled zero cross product for an exactly degenerate source primitive', () => {
  const source = fixture(),
    n = 2 ** 100;
  source.positions.set([n, n, 0, 0, 0, 0, 1, 2, 0]);
  // Rounded subtraction loses the small offsets; the exact xy determinant is -n.
  const ux = 0 - n,
    uy = 0 - n,
    vx = 1 - n,
    vy = 2 - n;
  expect(ux * vy - uy * vx).toBe(0);
  expect(-BigInt(n) * (2n - BigInt(n)) - -BigInt(n) * (1n - BigInt(n))).toBe(-BigInt(n));
  const result = validateDistanceFieldSurface({ ...source, primitiveOrder: new Uint32Array([1]) });
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error.detail.reason).toContain('coverage');
});

it('packs the one producer tree with original IDs and owns unchanged source channels', () => {
  const source = fixture(),
    query = createTriangleQuery([
      [
        [1, -1, -1],
        [1, 1, -1],
        [1, 0, 1],
      ],
      [
        [3, -1, -1],
        [3, 1, -1],
        [3, 0, 1],
      ],
    ]),
    tree = query.snapshot();
  const surface = buildDistanceFieldSurface(
    source.positions,
    source.indices,
    new Uint8Array([0, 1, 0]),
    tree,
    [0, 1],
  ).unwrap();
  expect(validateDistanceFieldSurface(surface).ok).toBe(true);
  expect(surface.nodes.byteLength).toBe(32);
  const view = new DataView(
    surface.nodes.buffer,
    surface.nodes.byteOffset,
    surface.nodes.byteLength,
  );
  expect(view.getUint32(12, true)).toBe(1);
  expect(view.getUint32(28, true)).toBe(2);
  expect(Array.from(surface.primitiveOrder)).toEqual([0, 1]);
  source.positions[0] = 777;
  source.indices[0] = 6;
  expect(surface.positions[0]).toBe(1);
  expect(surface.indices[0]).toBe(0);
  expect(validateDistanceFieldSurface(surface).ok).toBe(true);
});
it('rejects builder ID loss, invalid source flags and unpreservable or wrong leaf bounds', () => {
  const source = fixture(),
    query = createTriangleQuery([
      [
        [1, -1, -1],
        [1, 1, -1],
        [1, 0, 1],
      ],
      [
        [3, -1, -1],
        [3, 1, -1],
        [3, 0, 1],
      ],
    ]),
    tree = query.snapshot(),
    flags = new Uint8Array([0, 1, 0]);
  expect(buildDistanceFieldSurface(source.positions, source.indices, flags, tree, [0]).ok).toBe(
    false,
  );
  expect(
    buildDistanceFieldSurface(
      source.positions,
      source.indices,
      new Uint8Array([0, 2, 0]),
      tree,
      [0, 1],
    ).ok,
  ).toBe(false);
  const node = tree.nodes[0];
  if (!node) throw Error('Missing producer tree root');
  node.min[0] = 1.1;
  expect(buildDistanceFieldSurface(source.positions, source.indices, flags, tree, [0, 1]).ok).toBe(
    false,
  );
  node.min[0] = 2;
  expect(buildDistanceFieldSurface(source.positions, source.indices, flags, tree, [0, 1]).ok).toBe(
    false,
  );
});
