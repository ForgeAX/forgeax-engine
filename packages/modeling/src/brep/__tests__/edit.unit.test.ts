// biome-ignore-all lint/style/noNonNullAssertion: fixed-size fixtures indexed under noUncheckedIndexedAccess
import { describe, expect, it } from 'vitest';
import type { ModelingError } from '../../errors';
import { box, cone, cylinder, extrude, sphere, torus } from '../build';
import {
  deleteFaces,
  type EditResult,
  holeLoops,
  mergeEdges,
  mergeFaces,
  removeHole,
  replaceFace,
  simplify,
  splitEdge,
  splitFace,
} from '../edit';
import { measure } from '../measure';
import type { Shape } from '../types';
import { validate } from '../validate';

function must<T>(r: { ok: true; value: T } | { ok: false; error: ModelingError }): T {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
}

function fail(r: { ok: boolean; error?: ModelingError }): ModelingError {
  if (r.ok || r.error === undefined) throw new Error('expected a failure');
  return r.error;
}

const reason = (e: ModelingError) => (e.detail as { reason?: string }).reason;

function sizes(shape: Shape) {
  const m = must(measure(shape));
  return { area: m.area, volume: m.volume };
}

function expectValid(shape: Shape) {
  const v = validate(shape);
  expect(v.issues).toEqual([]);
  expect(Object.isFrozen(shape)).toBe(true);
  expect(Object.isFrozen(shape.faces[0])).toBe(true);
}

function expectSameSize(a: Shape, b: Shape) {
  const x = sizes(a);
  const y = sizes(b);
  expect(y.area).toBeCloseTo(x.area, 9);
  expect(y.volume).toBeCloseTo(x.volume, 9);
}

const L_PLATE = must(
  extrude({
    profile: [
      [0, 0],
      [4, 0],
      [4, 3],
      [0, 3],
    ],
    holes: [
      [
        [1, 1],
        [2, 1],
        [2, 2],
        [1, 2],
      ],
    ],
    depth: 2,
  }),
);

const unit = must(box({ size: [2, 3, 4] }));

describe('deleteFaces', () => {
  it('leaves an open shell: only single-use edges remain and the area drops by the face', () => {
    const r = must(deleteFaces(unit, [4]));
    expect(r.shape.faces).toHaveLength(5);
    const v = validate(r.shape);
    expect(v.ok).toBe(false);
    expect(v.issues).toHaveLength(4);
    for (const i of v.issues) {
      expect(i.code).toBe('brep-edge-use');
      expect((i.ids as { uses?: number }).uses).toBe(1);
    }
    expect(sizes(r.shape).area).toBeCloseTo(sizes(unit).area - 6, 9);
  });

  it('provenance names the input face behind every output face', () => {
    const r = must(deleteFaces(unit, [0, 1]));
    expect(r.provenance.faces).toEqual([[2], [3], [4], [5]]);
    expect(r.provenance.edges.every((e) => e.length === 1)).toBe(true);
  });

  it('refuses an empty list, a bad index and a delete of every face', () => {
    expect(fail(deleteFaces(unit, [])).code).toBe('model-invalid-argument');
    expect(fail(deleteFaces(unit, [9])).code).toBe('model-invalid-argument');
    expect(fail(deleteFaces(unit, [0, 1, 2, 3, 4, 5])).code).toBe('model-invalid-argument');
  });

  it('does not touch its input', () => {
    const before = JSON.stringify(unit);
    must(deleteFaces(unit, [3]));
    expect(JSON.stringify(unit)).toBe(before);
  });
});

describe('removeHole', () => {
  const faceWithHole = L_PLATE.faces.findIndex((f) => f.loops.length === 2);
  const hole = holeLoops(L_PLATE, faceWithHole)[0]!;

  it('fills a through hole: four wall faces go, both caps lose the hole, volume grows by the hole', () => {
    const r = must(removeHole(L_PLATE, faceWithHole, hole));
    expectValid(r.shape);
    expect(r.shape.faces).toHaveLength(6);
    expect(r.shape.faces.every((f) => f.loops.length === 1)).toBe(true);
    const m = sizes(r.shape);
    expect(m.volume).toBeCloseTo(24, 9);
    expect(m.area).toBeCloseTo(2 * 12 + 14 * 2, 9);
    expect(validate(r.shape).shells[0]!.genus).toBe(0);
    expect(r.provenance.faces.flat().every((f) => f < L_PLATE.faces.length)).toBe(true);
  });

  it('refuses the outer loop and a loop that is not on the face', () => {
    const outer = L_PLATE.faces[faceWithHole]!.loops.find((l) => L_PLATE.loops[l]!.outer)!;
    expect(reason(fail(removeHole(L_PLATE, faceWithHole, outer)))).toBe('loop-is-outer');
    expect(reason(fail(removeHole(L_PLATE, 2, hole)))).toBe('loop-not-on-face');
  });

  it('refuses to unwrap a hole whose wall is a rim of the outer boundary', () => {
    const r = removeHole(unit, 0, unit.faces[0]!.loops[0]!);
    expect(r.ok).toBe(false);
  });
});

describe('splitEdge', () => {
  it('splits a box edge: one new vertex and edge, both neighbors gain a coedge, size unchanged', () => {
    const r = must(splitEdge(unit, 0, 0.5 * (unit.edges[0]!.t0 + unit.edges[0]!.t1)));
    expectValid(r.shape);
    expect(r.shape.vertices).toHaveLength(unit.vertices.length + 1);
    expect(r.shape.edges).toHaveLength(unit.edges.length + 1);
    expect(r.shape.coedges).toHaveLength(unit.coedges.length + 2);
    expectSameSize(unit, r.shape);
    expect(r.provenance.vertices[r.shape.vertices.length - 1]).toEqual([]);
    expect(r.provenance.edges.flat().filter((e) => e === 0)).toHaveLength(2);
  });

  it('splits a circle edge of a cylinder', () => {
    const cyl = must(cylinder({ radius: 1.5, height: 3 }));
    const e = cyl.edges.findIndex((x) => x.curve >= 0 && cyl.curves[x.curve]!.kind === 'circle');
    const edge = cyl.edges[e]!;
    const r = must(splitEdge(cyl, e, 0.5 * (edge.t0 + edge.t1)));
    expectValid(r.shape);
    expectSameSize(cyl, r.shape);
  });

  it('refuses a parameter at or outside the ends', () => {
    const e = unit.edges[0]!;
    expect(reason(fail(splitEdge(unit, 0, e.t0)))).toBe('parameter-outside-edge');
    expect(reason(fail(splitEdge(unit, 0, e.t1 + 1)))).toBe('parameter-outside-edge');
    expect(fail(splitEdge(unit, 99, 0)).code).toBe('model-invalid-argument');
  });
});

describe('mergeEdges', () => {
  it('undoes a split: counts return to the original and the size is unchanged', () => {
    const e = unit.edges[0]!;
    const cut = must(splitEdge(unit, 0, 0.5 * (e.t0 + e.t1)));
    const added = cut.shape.edges.length - 1;
    const back = must(mergeEdges(cut.shape, 0, added));
    expectValid(back.shape);
    expect(back.shape.edges).toHaveLength(unit.edges.length);
    expect(back.shape.coedges).toHaveLength(unit.coedges.length);
    expectSameSize(unit, back.shape);
    expect(back.provenance.edges[0]).toEqual([0, added]);
  });

  it('refuses edges that meet at a real corner and edges that do not meet', () => {
    const corner = unit.edges.findIndex(
      (e, i) => i > 0 && (e.v0 === unit.edges[0]!.v1 || e.v1 === unit.edges[0]!.v1),
    );
    expect(fail(mergeEdges(unit, 0, corner)).code).toBe('model-partial');
    expect(fail(mergeEdges(unit, 0, 0)).code).toBe('model-invalid-argument');
  });
});

describe('splitFace and mergeFaces', () => {
  const cases: [string, Shape, number, 'u' | 'v', number][] = [
    ['box top', unit, 4, 'u', 0.3],
    ['box top v', unit, 4, 'v', -0.7],
    ['cylinder side u', must(cylinder({ radius: 1.5, height: 3 })), 1, 'u', 2],
    ['cylinder side v', must(cylinder({ radius: 1.5, height: 3 })), 1, 'v', 0.4],
    ['sphere v', must(sphere({ radius: 2 })), 0, 'v', 0.5],
    ['torus u', must(torus({ major: 3, minor: 1 })), 0, 'u', 1.1],
    ['torus v', must(torus({ major: 3, minor: 1 })), 0, 'v', 2.2],
    ['cone v', must(cone({ radius: 2, height: 3 })), 1, 'v', 1.5],
  ];
  for (const [name, shape, face, axis, at] of cases) {
    it(`${name}: split keeps area and volume, adds one face, and merge restores the face count`, () => {
      const cut = must(splitFace(shape, face, { axis, at }));
      expectValid(cut.shape);
      expect(cut.shape.faces).toHaveLength(shape.faces.length + 1);
      expectSameSize(shape, cut.shape);
      const added = cut.shape.faces.length - 1;
      expect(cut.provenance.faces[face]).toEqual([face]);
      expect(cut.provenance.faces[added]).toEqual([face]);
      const back = must(mergeFaces(cut.shape, face, added));
      expectValid(back.shape);
      expect(back.shape.faces).toHaveLength(shape.faces.length);
      expectSameSize(shape, back.shape);
    });
  }

  it('refuses a cut outside the face and a cut through a pole', () => {
    expect(reason(fail(splitFace(unit, 4, { axis: 'u', at: 99 })))).toBe('parameter-outside-face');
    const sph = must(sphere({ radius: 2 }));
    expect(reason(fail(splitFace(sph, 0, { axis: 'u', at: 0.5 })))).toBe('cut-through-pole');
  });

  it('refuses faces that are not adjacent, not co-surface or in the same index', () => {
    expect(reason(fail(mergeFaces(unit, 0, 1)))).toBe('faces-not-adjacent');
    expect(reason(fail(mergeFaces(unit, 0, 2)))).toBe('not-coplanar');
    expect(reason(fail(mergeFaces(unit, 0, 0)))).toBe('same-face');
  });

  it('merges coplanar faces that carry differently framed planes', () => {
    const cut = must(splitFace(unit, 4, { axis: 'u', at: 0.3 }));
    const added = cut.shape.faces.length - 1;
    const base = cut.shape.surfaces[cut.shape.faces[added]!.surface]!;
    if (base.kind !== 'plane') throw new Error('plane expected');
    const f = base.frame;
    const turned = must(
      replaceFace(cut.shape, added, {
        surface: {
          kind: 'plane',
          frame: { o: f.o, x: f.y, y: [-f.x[0], -f.x[1], -f.x[2]], z: f.z },
        },
      }),
    );
    expectValid(turned.shape);
    const merged = must(mergeFaces(turned.shape, 4, added));
    expectValid(merged.shape);
    expect(merged.shape.faces).toHaveLength(unit.faces.length);
    expectSameSize(unit, merged.shape);
  });

  it('merges coplanar faces whose plane frames are mirrored', () => {
    const cut = must(splitFace(unit, 4, { axis: 'v', at: 0.2 }));
    const added = cut.shape.faces.length - 1;
    const base = cut.shape.surfaces[cut.shape.faces[added]!.surface]!;
    if (base.kind !== 'plane') throw new Error('plane expected');
    const f = base.frame;
    const mirrored = must(
      replaceFace(cut.shape, added, {
        surface: {
          kind: 'plane',
          frame: { o: f.o, x: f.y, y: f.x, z: [-f.z[0], -f.z[1], -f.z[2]] },
        },
      }),
    );
    expectValid(mirrored.shape);
    const merged = must(mergeFaces(mirrored.shape, 4, added));
    expectValid(merged.shape);
    expectSameSize(unit, merged.shape);
  });
});

describe('replaceFace', () => {
  it('refuses a surface that does not contain the face boundary', () => {
    const r = replaceFace(unit, 4, {
      surface: { kind: 'plane', frame: { o: [0, 0, 1], x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] } },
    });
    expect(r.ok).toBe(false);
  });
});

describe('simplify', () => {
  it('collapses a split box face and a split edge back to the 6-face box', () => {
    const e = unit.edges[0]!;
    const a = must(splitFace(unit, 4, { axis: 'u', at: 0.3 }));
    const b = must(splitEdge(a.shape, 0, 0.5 * (e.t0 + e.t1)));
    const r = must(simplify(b.shape));
    expectValid(r.shape);
    expect(r.shape.faces).toHaveLength(6);
    expect(r.shape.edges).toHaveLength(12);
    expect(r.shape.vertices).toHaveLength(8);
    expectSameSize(unit, r.shape);
  });

  it('keeps the L-plate with its hole: nothing in it is mergeable', () => {
    const r = must(simplify(L_PLATE));
    expect(r.shape.faces).toHaveLength(L_PLATE.faces.length);
  });
});

describe('edits compose and stay deterministic', () => {
  it('equal inputs give byte-equal outputs', () => {
    const run = () => JSON.stringify(must(splitFace(unit, 4, { axis: 'u', at: 0.3 })));
    expect(run()).toBe(run());
  });

  it('a chain split, split, merge, merge returns to the box area and volume', () => {
    const r1: EditResult = must(splitFace(unit, 4, { axis: 'u', at: 0.3 }));
    const r2: EditResult = must(splitFace(r1.shape, 4, { axis: 'v', at: 0.2 }));
    const back = must(simplify(r2.shape));
    expectValid(back.shape);
    expect(back.shape.faces).toHaveLength(6);
    expectSameSize(unit, back.shape);
  });
});
