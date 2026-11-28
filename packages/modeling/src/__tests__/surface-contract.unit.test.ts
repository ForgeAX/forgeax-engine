import { describe, expect, it } from 'vitest';
import { model } from '../model';
import type { Issue } from '../report';
import { sel } from '../selectors';
import type { SurfaceContract } from '../surface-contract';
import type { ValidationCode } from '../validate';

const ZONES = { hull: [0, 0], glass: [1, 0] } as const;
const CONTRACT: SurfaceContract = { zones: ZONES };

/** Two faces: tag `hull` on x < 0 in zone (0,0), tag `glass` on x > 0 in zone (1,0); colour and uv1 in contract. */
function asset() {
  const m = model();
  m.plane({ width: 1, height: 1, widthSegments: 2, heightSegments: 1 });
  m.tag(sel.side([0, 0, 0], [1, 0, 0], { by: 'centroid' }), 'glass');
  m.tag(sel.all().minus(sel.tag('glass')), 'hull');
  const mesh = m.editMesh;
  for (const f of mesh.faces()) {
    const cell = mesh.hasTag(f, mesh.tagIndex('glass', false)) ? 1 : 0;
    for (const h of mesh.faceHalves(f)) {
      const p = mesh.position(mesh.hVert[h] as number);
      const lx = (p[0] as number) + 0.5;
      const ly = (p[1] as number) + (p[2] as number) + 0.5;
      mesh.setCorner('uv0', h, [
        cell + 0.1 + 0.8 * Math.min(1, Math.max(0, lx)),
        0.1 + 0.8 * Math.min(1, Math.max(0, ly)),
      ]);
      mesh.setCorner('uv1', h, [Math.min(1, Math.max(0, lx)), Math.min(1, Math.max(0, ly))]);
      mesh.setCorner('color', h, [0.5, 0.25, 0, 1]);
    }
  }
  return m;
}

const surfaceIssues = (issues: readonly Issue<ValidationCode>[]) =>
  issues.filter((i) => i.code === 'surface');
const checksOf = (m: ReturnType<typeof asset>, contract: SurfaceContract = CONTRACT) =>
  surfaceIssues(m.validate({ surface: contract }).issues).map((i) => i.detail.check);

function edit(
  m: ReturnType<typeof asset>,
  channel: 'uv0' | 'uv1' | 'color',
  face: number,
  value: number[],
) {
  const mesh = m.editMesh;
  for (const h of mesh.faceHalves(face)) mesh.setCorner(channel, h, value);
}

describe('validate({ surface }): P2-S1', () => {
  it('a mesh inside the contract has no surface issue and is covered', () => {
    const m = asset();
    const r = m.validate({ surface: CONTRACT });
    expect(surfaceIssues(r.issues)).toEqual([]);
    expect(r.coverage.checked.some((c) => c.code === 'surface')).toBe(true);
  });

  it('without the option the check is reported as not requested', () => {
    const r = asset().validate({});
    expect(
      r.coverage.unchecked.some((u) => u.code === 'surface' && u.reason === 'not-requested'),
    ).toBe(true);
  });

  it('falsifier: a colour lane above 1 is color-range', () => {
    const m = asset();
    edit(m, 'color', 0, [1.5, 0, 0, 1]);
    expect(checksOf(m)).toEqual(['color-range']);
  });

  it('falsifier: a uv1 corner outside the unit square is uv1-range', () => {
    const m = asset();
    edit(m, 'uv1', 1, [1.2, 0.5]);
    expect(checksOf(m)).toEqual(['uv1-range']);
  });

  it('falsifier: a face moved into another zone cell is zone-unknown (mismatch)', () => {
    const m = asset();
    const hull = m.editMesh
      .faces()
      .find((f) => m.editMesh.hasTag(f, m.editMesh.tagIndex('hull', false))) as number;
    edit(m, 'uv0', hull, [1.5, 0.5]);
    const issues = surfaceIssues(m.validate({ surface: CONTRACT }).issues);
    expect(issues.map((i) => i.detail)).toMatchObject([
      { check: 'zone-unknown', reason: 'mismatch', count: 1 },
    ]);
  });

  it('falsifier: a face across two cells is zone-straddle', () => {
    const m = asset();
    const mesh = m.editMesh;
    const hull = mesh.faces().find((f) => mesh.hasTag(f, mesh.tagIndex('hull', false))) as number;
    const [h0] = mesh.faceHalves(hull);
    mesh.setCorner('uv0', h0 as number, [1.4, 0.5]);
    expect(checksOf(m)).toContain('zone-straddle');
  });

  it('a tag without a declared zone is zone-unknown (no-zone)', () => {
    const m = asset();
    const issues = surfaceIssues(m.validate({ surface: { zones: { hull: [0, 0] } } }).issues);
    expect(issues.map((i) => i.detail)).toMatchObject([
      { check: 'zone-unknown', reason: 'no-zone', count: 1 },
    ]);
  });

  it('a tiling tag is exempt from the zone checks and the report says so', () => {
    const m = asset();
    const mesh = m.editMesh;
    const hull = mesh.faces().find((f) => mesh.hasTag(f, mesh.tagIndex('hull', false))) as number;
    edit(m, 'uv0', hull, [3.5, 2.5]);
    const issues = surfaceIssues(
      m.validate({ surface: { zones: ZONES, tiling: ['hull'] } }).issues,
    );
    expect(issues.map((i) => [i.severity, i.detail.reason])).toEqual([['info', 'exempt']]);
  });

  it('a missing required channel is channel-missing; need narrows the list', () => {
    const m = model();
    m.plane({ width: 1, height: 1 });
    m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
    const found = surfaceIssues(m.validate({ surface: {} }).issues);
    expect(found[0]?.detail).toMatchObject({
      check: 'channel-missing',
      channels: ['color', 'uv1'],
    });
    expect(checksOf(m, { need: ['uv0'] })).not.toContain('channel-missing');
  });
});

describe('toMesh({ surface }): P2-S1', () => {
  it('reports the findings as diagnostics and exports the mesh unchanged', () => {
    const m = asset();
    const plain = m.toMesh({});
    expect(plain.ok && plain.value.report.diagnostics).toBeFalsy();
    edit(m, 'color', 0, [1.5, 0, 0, 1]);
    const r = m.toMesh({ surface: CONTRACT });
    if (!r.ok) throw r.error;
    expect(r.value.report.diagnostics?.map((d) => d.detail?.check)).toEqual(['color-range']);
    expect(r.value.report.faces).toBe(2);
  });

  it('a mesh inside the contract has no diagnostics', () => {
    const r = asset().toMesh({ surface: CONTRACT });
    if (!r.ok) throw r.error;
    expect(r.value.report.diagnostics).toBeUndefined();
  });
});

describe('surface contract boundaries and non-finite values: audit follow-up', () => {
  const hullFace = (m: ReturnType<typeof asset>) => {
    const mesh = m.editMesh;
    return mesh.faces().find((f) => mesh.hasTag(f, mesh.tagIndex('hull', false))) as number;
  };
  const setCorners = (m: ReturnType<typeof asset>, f: number, uvs: number[][]) => {
    const halves = m.editMesh.faceHalves(f);
    halves.forEach((h, i) => {
      m.editMesh.setCorner('uv0', h, uvs[i % uvs.length] as number[]);
    });
  };
  const only = (m: ReturnType<typeof asset>) =>
    surfaceIssues(m.validate({ surface: CONTRACT }).issues).map((i) => i.detail);

  it('falsifier: a NaN or infinite uv0 corner is uv0-range, not a silent pass', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const m = asset();
      const f = hullFace(m);
      setCorners(m, f, [
        [bad, 0.5],
        [0.5, 0.5],
      ]);
      expect(only(m)).toEqual([{ check: 'uv0-range', count: 1, faces: [f] }]);
      const v = asset();
      setCorners(v, hullFace(v), [
        [0.5, bad],
        [0.5, 0.5],
      ]);
      expect(checksOf(v)).toEqual(['uv0-range']);
    }
  });

  it('a non-finite colour lane is color-range for NaN and both infinities', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const m = asset();
      edit(m, 'color', 0, [0.5, bad, 0, 1]);
      expect(checksOf(m)).toEqual(['color-range']);
    }
  });

  it('a corner on the cell border stays inside its cell; the cell comes from the face mean', () => {
    const m = asset();
    setCorners(m, hullFace(m), [
      [1, 0.2],
      [0.1, 0.2],
      [0.1, 0.8],
      [1, 0.8],
    ]);
    expect(only(m)).toEqual([]);
    const lo = asset();
    setCorners(lo, hullFace(lo), [
      [0, 0],
      [0.5, 0],
      [0.5, 1],
      [0, 1],
    ]);
    expect(only(lo)).toEqual([]);
  });

  it('a corner within the border slack is inside; beyond it, each of the four sides straddles', () => {
    const slack = asset();
    setCorners(slack, hullFace(slack), [
      [-5e-7, 0.5],
      [1 + 5e-7, 0.5],
      [0.5, -5e-7],
      [0.5, 1 + 5e-7],
    ]);
    expect(only(slack)).toEqual([]);
    for (const corner of [
      [-5e-6, 0.5],
      [1 + 5e-6, 0.5],
      [0.5, -5e-6],
      [0.5, 1 + 5e-6],
      [-5e-4, 0.5],
      [1 + 5e-4, 0.5],
      [0.5, -5e-4],
      [0.5, 1 + 5e-4],
      [-0.01, 0.5],
      [1.01, 0.5],
      [0.5, -0.01],
      [0.5, 1.01],
    ]) {
      const m = asset();
      setCorners(m, hullFace(m), [corner as number[], [0.5, 0.5], [0.5, 0.5]]);
      expect(checksOf(m)).toEqual(['zone-straddle']);
    }
  });

  it('a face outside its cell on the v axis is a mismatch even when u matches', () => {
    const m = asset();
    setCorners(m, hullFace(m), [[0.5, 1.5]]);
    expect(only(m)).toMatchObject([{ check: 'zone-unknown', reason: 'mismatch', count: 1 }]);
  });

  it('two tags with different zones on one face are ambiguous, in i or in j', () => {
    for (const zone of [
      [1, 0],
      [0, 1],
    ] as const) {
      const m = asset();
      const f = hullFace(m);
      m.editMesh.addTag(f, m.editMesh.tagIndex('glass', false));
      const rows = surfaceIssues(
        m.validate({ surface: { zones: { hull: [0, 0], glass: zone } } }).issues,
      ).map((i) => i.detail);
      expect(rows).toContainEqual({
        check: 'zone-unknown',
        reason: 'ambiguous',
        count: 1,
        faces: [f],
      });
    }
  });

  it('two tags that agree on the zone are neither ambiguous nor a mismatch', () => {
    const m = asset();
    m.editMesh.addTag(hullFace(m), m.editMesh.tagIndex('glass', false));
    const r = m.validate({ surface: { zones: { hull: [0, 0], glass: [0, 0] } } });
    expect(surfaceIssues(r.issues).map((i) => i.detail.reason)).toEqual(['mismatch']);
  });
});
