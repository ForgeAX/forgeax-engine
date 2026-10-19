import { describe, expect, it } from 'vitest';
import { boxPoints } from '../../../../scripts/test/convex-geometry-fixture.mjs';
import {
  type ConvexCompoundShapeInput,
  cloneDerivedPhysicsInput,
  DERIVED_PHYSICS_LIMITS,
  type DerivedPhysicsCandidateInput,
  normalizeConvexCompoundShapeInput,
} from '../index.js';

const shape = (): ConvexCompoundShapeInput => ({
  kind: 'convex-compound',
  id: 'piece',
  revision: 1,
  pieces: [new Float32Array([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 3])],
});
const candidate = (input = shape()): DerivedPhysicsCandidateInput => ({
  entity: 7,
  revision: 1,
  sourceKey: 'geometry',
  shapes: [input],
});

describe('portable convex geometry input', () => {
  it('accepts a tetrahedron and copies points, pose and snapshot input', () => {
    const source = shape();
    const prepared = cloneDerivedPhysicsInput(candidate(source)).unwrap();
    const sourcePoints = source.pieces[0];
    if (sourcePoints === undefined) throw new Error('missing source points');
    sourcePoints[0] = 99;
    const copied = prepared.shapes[0];
    expect(copied?.kind).toBe('convex-compound');
    if (copied?.kind !== 'convex-compound') throw new Error('missing compound');
    expect(copied.pieces[0]?.[0]).toBe(0);
    const restored = cloneDerivedPhysicsInput(prepared).unwrap();
    const copiedPoints = copied.pieces[0];
    if (copiedPoints === undefined) throw new Error('missing copied points');
    copiedPoints[0] = 88;
    const restoredShape = restored.shapes[0];
    expect(restoredShape?.kind === 'convex-compound' && restoredShape.pieces[0]?.[0]).toBe(0);
    expect(Object.isFrozen(prepared.shapes)).toBe(true);
  });

  it('copies a compound into disjoint views of one shape-owned point buffer', () => {
    const backing = new Float32Array(40);
    const first = backing.subarray(4, 16);
    const second = backing.subarray(20, 32);
    first.set([0, 0, 0, 2, 0, 0, 0, 1, 0, 0, 0, 3]);
    second.set([4, 0, 0, 6, 0, 0, 4, 1, 0, 4, 0, 3]);
    const source = { ...shape(), pieces: [first, second, first] };
    const prepared = normalizeConvexCompoundShapeInput(source).unwrap();
    if (prepared.kind !== 'convex-compound') throw new Error('missing compound');
    const [a, b, c] = prepared.pieces;
    if (a === undefined || b === undefined || c === undefined) throw new Error('missing pieces');
    expect(a.buffer).not.toBe(backing.buffer);
    expect(b.buffer).toBe(a.buffer);
    expect(c.buffer).toBe(a.buffer);
    expect(a.byteOffset).toBe(0);
    expect(b.byteOffset).toBe(a.byteLength);
    expect(c.byteOffset).toBe(a.byteLength + b.byteLength);
    expect(a.buffer.byteLength).toBe(a.byteLength + b.byteLength + c.byteLength);
    expect(prepared.pieces).toEqual([first, second, first]);
    backing.fill(99);
    expect(a[0]).toBe(0);
    expect(b[0]).toBe(4);
    expect(c[0]).toBe(0);
    a[0] = 8;
    expect(c[0]).toBe(0);
    const restored = normalizeConvexCompoundShapeInput(prepared).unwrap();
    if (restored.kind !== 'convex-compound') throw new Error('missing restored compound');
    expect(restored.pieces).toEqual(prepared.pieces);
    expect(restored.pieces[0]?.buffer).not.toBe(a.buffer);
    expect(Object.isFrozen(prepared.pieces)).toBe(true);
  });

  it.each([
    new Float32Array([]),
    new Float32Array(11),
    new Float32Array(12),
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]),
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, Infinity]),
  ])('rejects incomplete, collapsed and nonfinite hulls', (points) => {
    expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [points] })).toMatchObject({
      ok: false,
      error: { code: 'derived-shape-invalid' },
    });
  });

  it('rejects nonfinite coordinates even after a complete positive-volume witness', () => {
    const finite = boxPoints([0, 0, 0], [1, 1, 1]);
    for (let coordinate = 0; coordinate < finite.length; coordinate++)
      for (const value of [NaN, Infinity, -Infinity]) {
        const points = new Float32Array(finite);
        points[coordinate] = value;
        expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [points] }).ok).toBe(false);
      }
  });

  it('retains the noncoplanarity decision for tiny and translated finite point sets', () => {
    const tiny = Math.fround(1e-40);
    const points = new Float32Array([0, 0, 0, tiny, 0, 0, 0, tiny, 0, 0, 0, tiny]);
    expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [points] }).ok).toBe(true);
    points[11] = 0;
    expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [points] }).ok).toBe(false);
    const translated = boxPoints([1e20, 1e20, 1e20], [2e20, 2e20, 2e20]);
    expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [translated] }).ok).toBe(true);
    for (let coordinate = 2; coordinate < translated.length; coordinate += 3)
      translated[coordinate] = Math.fround(1e20);
    expect(normalizeConvexCompoundShapeInput({ ...shape(), pieces: [translated] }).ok).toBe(false);
  });

  it('bounds piece counts and bytes before point reads', () => {
    let reads = 0;
    const pieces = new Proxy([boxPoints([0, 0, 0], [1, 1, 1])], {
      get(target, key, receiver) {
        if (key === 'length') return DERIVED_PHYSICS_LIMITS.maxConvexPiecesPerCandidate + 1;
        if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    expect(cloneDerivedPhysicsInput(candidate({ ...shape(), pieces }))).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-budget-exceeded' },
    });
    expect(reads).toBe(0);
    expect(
      cloneDerivedPhysicsInput(candidate({ ...shape(), pieces: [new Float32Array(1024 * 1024)] })),
    ).toMatchObject({
      ok: false,
      error: { code: 'derived-candidate-budget-exceeded' },
    });
  });

  it('rejects undeclared fields, duplicate identities and unsafe revisions', () => {
    const unknown = shape();
    Object.defineProperty(unknown, 'extension', { value: true });
    expect(cloneDerivedPhysicsInput(candidate(unknown)).ok).toBe(false);
    expect(cloneDerivedPhysicsInput({ ...candidate(), shapes: [shape(), shape()] })).toMatchObject({
      ok: false,
      error: { code: 'derived-shape-duplicate' },
    });
    expect(
      cloneDerivedPhysicsInput({ ...candidate(), revision: Number.MAX_SAFE_INTEGER + 1 }).ok,
    ).toBe(false);
    expect(
      normalizeConvexCompoundShapeInput({ ...shape(), revision: Number.MAX_SAFE_INTEGER + 1 }).ok,
    ).toBe(false);
  });
});
