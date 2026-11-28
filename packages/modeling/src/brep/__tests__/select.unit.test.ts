import { describe, expect, it } from 'vitest';
import { box, cone, cylinder, extrude, sphere, torus } from '../build';
import { faceReference, selectFace, selectFaces } from '../select';
import type { Shape, SurfaceKind } from '../types';

function must<T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

const plate = must(box({ size: [2, 3, 4], label: 'plate', role: 'body' }));
const post = must(cylinder({ radius: 1, height: 2, label: 'post', role: 'shaft' }));

function labels(shape: Shape, faces: readonly number[]): string[] {
  return faces.map((f) => (shape.faces[f] as Shape['faces'][number]).label);
}

describe('selectFaces', () => {
  it('an empty query selects every face in ascending order', () => {
    expect(must(selectFaces(plate, {}))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('selects by exact label, label prefix and role', () => {
    expect(labels(plate, must(selectFaces(plate, { label: 'plate.pz' })))).toEqual(['plate.pz']);
    expect(must(selectFaces(plate, { labelPrefix: 'plate.' }))).toHaveLength(6);
    expect(must(selectFaces(plate, { labelPrefix: 'post.' }))).toEqual([]);
    expect(must(selectFaces(plate, { role: 'body' }))).toHaveLength(6);
    expect(must(selectFaces(plate, { role: 'lid' }))).toEqual([]);
  });

  it('selects by surface kind on every primitive', () => {
    const cases: [string, Shape, SurfaceKind, number][] = [
      ['box', plate, 'plane', 6],
      ['cylinder', post, 'cylinder', 1],
      ['cylinder', post, 'plane', 2],
      ['cone', must(cone({ radius: 1, height: 2 })), 'cone', 1],
      ['sphere', must(sphere({ radius: 1 })), 'sphere', 1],
      ['torus', must(torus({ major: 2, minor: 0.5 })), 'torus', 1],
    ];
    for (const [name, shape, kind, count] of cases) {
      expect(must(selectFaces(shape, { surface: kind })), `${name} ${kind}`).toHaveLength(count);
    }
    expect(must(selectFaces(plate, { surface: 'sphere' }))).toEqual([]);
  });

  it('selects by outward normal and rejects the opposite direction', () => {
    expect(labels(plate, must(selectFaces(plate, { normal: { dir: [0, 0, 1] } })))).toEqual([
      'plate.pz',
    ]);
    expect(labels(plate, must(selectFaces(plate, { normal: { dir: [0, 0, -5] } })))).toEqual([
      'plate.nz',
    ]);
    const all = must(selectFaces(plate, { normal: { dir: [1, 1, 1], angle: Math.PI } }));
    expect(all).toHaveLength(6);
    const tilted = must(selectFaces(plate, { normal: { dir: [1, 0.2, 0], angle: 0.3 } }));
    expect(labels(plate, tilted)).toEqual(['plate.px']);
  });

  it('a reversed face reports the flipped normal', () => {
    const flipped: Shape = {
      ...plate,
      faces: plate.faces.map((f) => ({ ...f, reversed: !f.reversed })),
    };
    expect(labels(flipped, must(selectFaces(flipped, { normal: { dir: [0, 0, 1] } })))).toEqual([
      'plate.nz',
    ]);
  });

  it('selects by position within a radius of the reference point', () => {
    const top = must(selectFaces(plate, { near: { point: [0, 0, 2], radius: 0.1 } }));
    expect(labels(plate, top)).toEqual(['plate.pz']);
    expect(must(selectFaces(plate, { near: { point: [0, 0, 0], radius: 0.1 } }))).toEqual([]);
    expect(must(selectFaces(plate, { near: { point: [0, 0, 0], radius: 10 } }))).toHaveLength(6);
  });

  it('a disc cap reference is strictly inside the disc, on the cap plane', () => {
    const caps = must(selectFaces(post, { surface: 'plane' }));
    for (const f of caps) {
      const ref = faceReference(post, f);
      expect(Math.hypot(ref.point[0], ref.point[1])).toBeLessThan(0.9);
      expect(Math.abs(ref.normal[2])).toBeCloseTo(1, 12);
    }
    const up = must(selectFaces(post, { surface: 'plane', normal: { dir: [0, 0, 1] } }));
    expect(up).toHaveLength(1);
    expect(faceReference(post, up[0] as number).point[2]).toBeCloseTo(1, 12);
  });

  it('combines every key with AND', () => {
    const q = {
      labelPrefix: 'plate.',
      surface: 'plane' as const,
      normal: { dir: [1, 0, 0] as const },
    };
    expect(labels(plate, must(selectFaces(plate, { ...q, role: 'body' })))).toEqual(['plate.px']);
    expect(must(selectFaces(plate, { ...q, role: 'lid' }))).toEqual([]);
  });

  it('selects the faces of an extruded outline by normal', () => {
    const prism = must(
      extrude({
        profile: [
          [0, 0],
          [2, 0],
          [2, 1],
          [0, 1],
        ],
        depth: 3,
      }),
    );
    const up = must(selectFaces(prism, { normal: { dir: [0, 0, 1] } }));
    expect(up).toHaveLength(1);
    expect(
      must(selectFaces(prism, { normal: { dir: [0, 0, 1], angle: Math.PI / 2 - 0.01 } })),
    ).toEqual(up);
  });

  it('rejects malformed queries with brep-bad-argument and never throws', () => {
    const bad = [
      { normal: { dir: [0, 0, 0] as const } },
      { normal: { dir: [0, 0, 1] as const, angle: -1 } },
      { normal: { dir: [0, 0, 1] as const, angle: 4 } },
      { near: { point: [0, 0, 0] as const, radius: -1 } },
      { near: { point: [0, 0, 0] as const, radius: Number.NaN } },
    ];
    for (const q of bad) {
      const r = selectFaces(plate, q);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { brep: string }).brep).toBe('brep-bad-argument');
    }
  });

  it('is deterministic and returns a frozen list', () => {
    const a = must(selectFaces(plate, { surface: 'plane' }));
    const b = must(selectFaces(plate, { surface: 'plane' }));
    expect(a).toEqual(b);
    expect(Object.isFrozen(a)).toBe(true);
  });
});

describe('selectFace', () => {
  it('returns the single match and reports the match count otherwise', () => {
    expect(must(selectFace(plate, { label: 'plate.nx' }))).toBe(1);
    for (const [q, count] of [
      [{ role: 'body' }, 6],
      [{ label: 'nope' }, 0],
    ] as const) {
      const r = selectFace(plate, q);
      expect(r.ok).toBe(false);
      if (!r.ok) expect((r.error.detail as { matches: number }).matches).toBe(count);
    }
  });
});
