import { describe, expect, it } from 'vitest';
import { EDGE_KIND, edgeKinds, type NormalMode, shadingHard, uvContinuous } from '../finish';
import { decodeSnapshot } from '../fxem';
import { NONE } from '../mesh';
import { type Model, model } from '../model';
import { sel } from '../selectors';

const HARD_45: NormalMode = { mode: 'autoSmooth', angle: 45 };
const SEAM_BOUNDED: NormalMode = { mode: 'autoSmooth', angle: 45, split: 'seams' };

/** A 3 x 3 x 3 box whose uv0 is one planar projection: no UV seam on any of its 90 degree edges. */
function planarBox(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
  m.uv.project({ mode: 'planar', axis: 'z', scale: 1 });
  return m;
}

/** A box with a lid opening cut away, unwrapped by the seam planner that ignores sharp edges. */
function plannedBox(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
  m.delete(sel.facing('+y'));
  expect(m.uv.plan({ respectSharp: false }).status).toBe('ok');
  return m;
}

function compactKinds(m: Model, normals: NormalMode): Uint8Array {
  const decoded = decodeSnapshot(m.snapshot());
  if (!decoded.ok) throw decoded.error;
  return edgeKinds(decoded.value, normals);
}

const count = (kinds: Uint8Array, all: number, none = 0) =>
  kinds.filter((k) => (k & all) === all && (k & none) === 0).length;

const bakeFindings = (m: Model, normals: NormalMode) =>
  m
    .validate({ bake: { normals, checks: ['sharp-not-seam'] } })
    .issues.filter((i) => i.code === 'bake').length;

describe('edge kinds (BK49)', () => {
  it('classifies boundary, seam, hard, crease and smooth edges from one table', () => {
    const m = plannedBox();
    m.markCrease(sel.facing('-y').boundary(), 2);
    const kinds = compactKinds(m, HARD_45);
    const edges = m.inspect().edges;
    expect(count(kinds, EDGE_KIND.boundary)).toBe(12);
    // Interior edges are either hard or smooth, never both.
    expect(count(kinds, EDGE_KIND.hard) + count(kinds, EDGE_KIND.smooth)).toBe(edges - 12);
    expect(count(kinds, EDGE_KIND.hard | EDGE_KIND.smooth)).toBe(0);
    // The eight box rims below the lid opening are the 90 degree dihedrals (3 segments each).
    expect(count(kinds, EDGE_KIND.hard)).toBe(8 * 3);
    expect(count(kinds, EDGE_KIND.crease)).toBe(12);
    expect(count(kinds, EDGE_KIND.seam)).toBeGreaterThan(0);
    // Derived, never written back: edge flags are unchanged by the classification.
    const before = m.editMesh.eFlags.slice();
    edgeKinds(m.editMesh, SEAM_BOUNDED);
    expect(m.editMesh.eFlags).toEqual(before);
  });

  it("falsifier: by default hard edges lie inside a UV island; split 'seams' leaves none", () => {
    expect(count(compactKinds(planarBox(), HARD_45), EDGE_KIND.hard, EDGE_KIND.seam)).toBe(36);
    for (const m of [planarBox(), plannedBox()]) {
      const plain = compactKinds(m, HARD_45);
      const bounded = compactKinds(m, SEAM_BOUNDED);
      const inside = count(plain, EDGE_KIND.hard, EDGE_KIND.seam);
      // The planner's own angle seams already bound its islands; the planar box has none.
      if (inside === 0) expect(bakeFindings(m, HARD_45)).toBe(0);
      else expect(bakeFindings(m, HARD_45)).toBe(1);
      expect(count(bounded, EDGE_KIND.hard, EDGE_KIND.seam)).toBe(0);
      // Hard edges on a seam stay hard: the split only removes the ones inside islands.
      expect(count(bounded, EDGE_KIND.hard)).toBe(count(plain, EDGE_KIND.hard | EDGE_KIND.seam));
      expect(bakeFindings(m, SEAM_BOUNDED)).toBe(0);
    }
  });

  it("export splits normals exactly on the table's hard edges; the default export is unchanged", () => {
    const m = planarBox();
    const plain = m.toMesh({ normals: HARD_45 });
    const bounded = m.toMesh({ normals: SEAM_BOUNDED });
    if (!plain.ok || !bounded.ok) throw new Error('export failed');
    // A planar uv0 has no seam: the seam-bounded box shades as one smooth group per vertex.
    expect(bounded.value.report.gpuVertices).toBe(m.inspect().vertices);
    expect(plain.value.report.gpuVertices).toBeGreaterThan(bounded.value.report.gpuVertices);
    const again = m.toMesh({ normals: { mode: 'autoSmooth', angle: 45 } });
    if (!again.ok) throw again.error;
    expect(again.value.mesh).toEqual(plain.value.mesh);
    expect(m.toMesh({ normals: { mode: 'smooth', split: 'edges' as 'seams' } }).ok).toBe(false);
  });

  it('respectSharp with a normal mode cuts a seam along every hard edge of that mode', () => {
    for (const plan of [true, false]) {
      const m = model();
      m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
      const report = plan
        ? m.uv.plan({ respectSharp: HARD_45 })
        : m.uv.auto({ resolution: 256, padding: 2, respectSharp: HARD_45 });
      expect(report.status).toBe('ok');
      const kinds = compactKinds(m, HARD_45);
      expect(count(kinds, EDGE_KIND.hard)).toBe(12 * 3);
      expect(count(kinds, EDGE_KIND.hard, EDGE_KIND.seam)).toBe(0);
    }
    const m = model();
    m.box({ size: [1, 1, 1] });
    expect(
      m.uv.auto({ resolution: 256, padding: 2, respectSharp: 'yes' as unknown as boolean }).status,
    ).toBe('failed');
  });

  it('rejects a seam-bounded split on flat shading, which hardens every edge', () => {
    const m = planarBox();
    const flat = m.toMesh({ normals: { mode: 'flat', split: 'seams' } });
    expect(flat.ok).toBe(false);
    if (!flat.ok) expect(flat.error.code).toBe('model-invalid-argument');
    const plain = m.toMesh({ normals: { mode: 'flat' } });
    expect(plain.ok).toBe(true);
    expect(m.toMesh({ normals: { mode: 'smooth', split: 'seams' } }).ok).toBe(true);
  });

  it('uv continuity needs both ends of an edge to agree', () => {
    const decoded = decodeSnapshot(planarBox().snapshot());
    if (!decoded.ok) throw decoded.error;
    const mesh = decoded.value;
    const e = mesh.edges().find((x) => (mesh.hFace[x * 2 + 1] as number) !== NONE) as number;
    const h = e * 2;
    expect(uvContinuous(mesh, e)).toBe(true);
    const moved = (corner: number) => {
      const copy = mesh.clone();
      const uv = copy.corner('uv0', corner) as Float32Array;
      copy.setCorner('uv0', corner, [(uv[0] as number) + 0.25, uv[1] as number]);
      return uvContinuous(copy, e);
    };
    // A break at the start corner, or at the end corner, of one side each makes the edge a seam.
    expect(moved(h)).toBe(false);
    expect(moved(mesh.hNext[h] as number)).toBe(false);
    expect(moved(h + 1)).toBe(false);
    expect(moved(mesh.hNext[h + 1] as number)).toBe(false);
  });

  it('an infinite sharp edge is hard, not a crease; seams split softens it inside an island', () => {
    const m = planarBox();
    m.markSharp(sel.facing('+z').boundary());
    const sharp = compactKinds(m, HARD_45);
    const level = compactKinds(planarBox(), HARD_45);
    expect(count(sharp, EDGE_KIND.crease)).toBe(0);
    expect(count(sharp, EDGE_KIND.hard)).toBe(count(level, EDGE_KIND.hard));
    m.markCrease(sel.facing('-z').boundary(), 2);
    expect(count(compactKinds(m, HARD_45), EDGE_KIND.crease)).toBe(12);
    // Documented: UV continuity decides under split 'seams', so an author sharp edge inside an
    // island exports smooth (plain smooth shading hardens it).
    const smooth: NormalMode = { mode: 'smooth' };
    const split = m.toMesh({ normals: { ...smooth, split: 'seams' } });
    const plain = m.toMesh({ normals: smooth });
    if (!split.ok || !plain.ok) throw new Error('export failed');
    expect(plain.value.report.gpuVertices).toBeGreaterThan(split.value.report.gpuVertices);
    expect(split.value.report.gpuVertices).toBe(m.inspect().vertices);
  });

  it('shadingHard reads the shading alone, even for a seam-bounded mode', () => {
    const decoded = decodeSnapshot(planarBox().snapshot());
    if (!decoded.ok) throw decoded.error;
    const mesh = decoded.value;
    const hardEdges = mesh.edges().filter((e) => shadingHard(mesh, e, SEAM_BOUNDED));
    expect(hardEdges).toHaveLength(36);
    expect(mesh.edges().filter((e) => shadingHard(mesh, e, HARD_45))).toEqual(hardEdges);
    expect(mesh.edges().filter((e) => shadingHard(mesh, e, { mode: 'flat' }))).toHaveLength(
      mesh.edgeCount,
    );
  });

  describe('respectSharp with a NormalMode below the planner angle', () => {
    // A 12-sided prism: neighbouring walls meet at 30 degrees, below the planner's 75 degree
    // hardAngle and the 45 degree chart deviation, so only the NormalMode hardens them.
    const SOFT_20: NormalMode = { mode: 'autoSmooth', angle: 20 };
    const prism = () => {
      const m = model();
      const points: [number, number][] = [];
      for (let i = 0; i < 12; i++) {
        points.push([Math.cos((i * Math.PI) / 6), Math.sin((i * Math.PI) / 6)]);
      }
      m.extrudePolygon({ points, depth: 1 });
      return m;
    };
    const insideIsland = (m: Model) =>
      count(compactKinds(m, SOFT_20), EDGE_KIND.hard, EDGE_KIND.seam);

    it('uv.plan cuts every hard edge of the mode; the flag-only planner leaves them inside', () => {
      const without = prism();
      expect(without.uv.plan({ respectSharp: false }).status).toBe('ok');
      expect(insideIsland(without)).toBeGreaterThan(0);
      const withMode = prism();
      expect(withMode.uv.plan({ respectSharp: SOFT_20 }).status).toBe('ok');
      expect(insideIsland(withMode)).toBe(0);
    });

    it('uv.auto cuts every hard edge of the mode', () => {
      const without = prism();
      expect(without.uv.auto({ resolution: 256, padding: 2, respectSharp: false }).status).toBe(
        'ok',
      );
      expect(insideIsland(without)).toBeGreaterThan(0);
      const withMode = prism();
      const report = withMode.uv.auto({ resolution: 256, padding: 2, respectSharp: SOFT_20 });
      expect(report.status).toBe('ok');
      expect(insideIsland(withMode)).toBe(0);
    });
  });

  it('respectSharp is validated the same way by uv.plan and uv.auto', () => {
    for (const bad of [null, 'yes', {}, 3]) {
      const m = model();
      m.box({ size: [1, 1, 1] });
      const plan = m.uv.plan({ respectSharp: bad as unknown as boolean });
      expect(plan.status).toBe('failed');
      expect(plan.error?.code).toBe('model-invalid-argument');
      const n = model();
      n.box({ size: [1, 1, 1] });
      const auto = n.uv.auto({
        resolution: 256,
        padding: 2,
        respectSharp: bad as unknown as boolean,
      });
      expect(auto.status).toBe('failed');
      expect(auto.error?.code).toBe('model-invalid-argument');
    }
  });
});
