import { describe, expect, it } from 'vitest';
import { surfaceSamples } from '../compute/mesh-query';
import { encodeSnapshot } from '../fxem';
import { faceNormal, facesVolume } from '../geom';
import { EDGE_SHARP } from '../mesh';
import { type Model, model } from '../model';

import { sel } from '../selectors';

type T3 = [number, number, number];

/**
 * A 1 m hub with six 1.1 x 1.1 x 0.1 m plates flush on its faces, shifted by 5 cm so each
 * plate shares two side planes with the hub and overlaps its neighbours: the exact union
 * meets coplanar contacts it cannot resolve (`model-partial`).
 */
function hubPlates(width = 1.1, shift = 0.05): Model {
  const m = model();
  m.box({ size: [1, 1, 1], tag: 'hub' });
  for (let axis = 0; axis < 3; axis++) {
    for (const side of [-1, 1]) {
      const size: T3 = [width, width, width];
      size[axis] = 0.1;
      const center: T3 = [shift, shift, shift];
      center[axis] = side * 0.55;
      m.box({ size, center, tag: `plate${axis}${side > 0 ? 'p' : 'n'}` });
    }
  }
  return m;
}

const PART_SUM = 1 + 6 * 1.1 * 1.1 * 0.1;
/** Grid-aligned with the plate planes and the hub; the default (two voxels per plate) is finer. */
const VOXEL = { mode: 'voxel', voxelSize: 0.1 } as const;

function lowpolyInfo(m: Model): Record<string, unknown> {
  const last = m.journal[m.journal.length - 1];
  const d = last?.diagnostics?.find((x) => x.message.startsWith('lowpoly'));
  return (d?.detail ?? {}) as Record<string, unknown>;
}

function meshVolume(m: Model): number {
  return facesVolume(m.editMesh, m.editMesh.faces());
}

/** Edges whose dihedral exceeds `degrees` that are not marked sharp. */
function unmarkedHardEdges(m: Model, degrees: number): number {
  const mesh = m.editMesh;
  const limit = Math.cos((degrees * Math.PI) / 180);
  let n = 0;
  for (const e of mesh.edges()) {
    const a = mesh.hFace[e * 2] as number;
    const b = mesh.hFace[e * 2 + 1] as number;
    const na = faceNormal(mesh, a);
    const nb = faceNormal(mesh, b);
    const cosine = na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2];
    if (cosine < limit && ((mesh.eFlags[e] as number) & EDGE_SHARP) === 0) n++;
  }
  return n;
}

describe('lowpoly', () => {
  it('the flush hub unions exactly: the failing plate retries against the finished shell', () => {
    const m = hubPlates();
    expect(m.lowpoly(undefined, { targetFaces: 300, union: { mode: 'exact' } }).status).toBe('ok');
    const info = lowpolyInfo(m);
    expect(info).toMatchObject({ union: 'exact', fallback: false });
    expect(info.parts).toBe(7);
    const components = info.components as { closed: boolean }[];
    expect(components).toHaveLength(1);
    expect(components[0]?.closed).toBe(true);
    expect(meshVolume(m)).toBeCloseTo(1.694, 9);
  });

  it('voxel mode rebuilds the whole set; the hub keeps one closed component', () => {
    const auto = hubPlates();
    expect(
      auto.lowpoly(undefined, { targetFaces: 300, union: VOXEL, tags: { groupPrefix: 'low' } })
        .status,
    ).toBe('ok');
    const info = lowpolyInfo(auto);
    expect(info).toMatchObject({ union: 'voxel', fallback: false });
    const components = info.components as { closed: boolean }[];
    expect(components).toHaveLength(1);
    expect(components[0]?.closed).toBe(true);
    expect(meshVolume(auto)).toBeGreaterThanOrEqual(1);
    expect(meshVolume(auto)).toBeLessThanOrEqual(PART_SUM);
    expect(info.tris).toBeLessThanOrEqual(300);
  });

  it('a part the exact union cannot take is voxel-unioned with only the shells it touches', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 1, 1], center: [1, 1, 0], tag: 'edge' });
    m.box({ size: [1, 1, 1], center: [6, 0, 0], tag: 'far' });
    const mesh = m.editMesh;
    const steel = mesh.nameIndex(mesh.materialNames, 'steel');
    const paint = mesh.nameIndex(mesh.materialNames, 'paint');
    const far = mesh.tagIndex('far', false);
    const edge = mesh.tagIndex('edge', false);
    let edgeFaces = 0;
    for (const f of mesh.faces()) {
      if (mesh.hasTag(f, far)) mesh.fMaterial[f] = steel;
      if (mesh.hasTag(f, edge)) {
        mesh.fMaterial[f] = paint;
        edgeFaces++;
      }
    }
    expect(m.lowpoly(undefined, { targetFaces: 200, union: { voxelSize: 0.1 } }).status).toBe('ok');
    const info = lowpolyInfo(m);
    expect(info).toMatchObject({
      union: 'mixed',
      fallback: true,
      exactError: 'model-partial',
      clusters: 1,
    });
    expect(info.lost).toMatchObject({ materials: { paint: edgeFaces } });
    expect(info.lost).not.toHaveProperty('materials.steel');
    const kept = m.editMesh.faces().filter((f) => m.editMesh.fMaterial[f] === steel);
    expect(kept.length).toBeGreaterThan(0);
    expect(info.components as unknown[]).toHaveLength(2);
    expect(m.lowpoly(undefined, { targetFaces: 200, union: { mode: 'exact' } }).status).toBe(
      'failed',
    );
  });

  it('defaults the voxel size to the thinnest part and tiles QEM fans before pairing', () => {
    // Two voxels across the 0.1 m plates; longest / 64 (19 mm) took about 15 s here.
    const auto = hubPlates();
    expect(auto.lowpoly(undefined, { targetFaces: 300, union: { mode: 'voxel' } }).status).toBe(
      'ok',
    );
    const info = lowpolyInfo(auto);
    expect(info.voxelSize).toBeCloseTo(0.05, 12);
    expect(meshVolume(auto)).toBeCloseTo(1.694, 9);
    // Without the Delaunay tiling pass the QEM fans leave 11 to 13 valence-7+ poles.
    expect(info.highValence).toBeLessThanOrEqual(1);
    const grid = hubPlates();
    expect(grid.lowpoly(undefined, { targetFaces: 300, union: VOXEL }).status).toBe('ok');
    const g = lowpolyInfo(grid);
    expect(g.highValence).toBeLessThanOrEqual(1);
    expect(g.quadAreaRatio).toBeGreaterThan(0.95);
  });

  it('signs the deviation of a simplified sphere as the analytic sphere does', () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 32, heightSegments: 16 });
    expect(m.lowpoly(undefined, { targetFaces: 60 }).status).toBe('ok');
    const signed = lowpolyInfo(m).signed as Record<'inside' | 'outside', { max: number }>;
    // Oracle: |p| - 0.5 at the same samples; the 32 x 16 shell is within 5 mm of the sphere.
    const mesh = m.editMesh;
    const corners: number[] = [];
    for (const f of mesh.faces()) {
      const vs = mesh.faceVertices(f);
      for (let i = 1; i + 1 < vs.length; i++)
        corners.push(vs[0] as number, vs[i] as number, vs[i + 1] as number);
    }
    let inside = 0;
    let outside = 0;
    for (const p of surfaceSamples(mesh.pos, Int32Array.from(corners))) {
      const d = Math.hypot(...p) - 0.5;
      inside = Math.max(inside, -d);
      outside = Math.max(outside, d);
    }
    expect(inside).toBeGreaterThan(0.01);
    expect(outside).toBeGreaterThan(0.01);
    expect(Math.abs(signed.inside.max - inside)).toBeLessThan(0.005);
    expect(Math.abs(signed.outside.max - outside)).toBeLessThan(0.005);
  });

  it('the voxel fallback reports the labels, materials and corners it drops (AS-02-T2)', () => {
    const m = hubPlates();
    const mesh = m.editMesh;
    const rail = mesh.nameIndex(mesh.labelNames, 'rail');
    const steel = mesh.nameIndex(mesh.materialNames, 'steel');
    const hub = mesh.tagIndex('hub', false);
    const plate = mesh.tagIndex('plate0p', false);
    let hubFaces = 0;
    let plateFaces = 0;
    let plateCorners = 0;
    for (const f of mesh.faces()) {
      if (mesh.hasTag(f, hub)) {
        mesh.fLabel[f] = rail;
        hubFaces++;
      }
      if (mesh.hasTag(f, plate)) {
        mesh.fMaterial[f] = steel;
        plateFaces++;
        for (const h of mesh.faceHalves(f)) {
          mesh.setCorner('uv0', h, [0.5, 0.5]);
          plateCorners++;
        }
      }
    }
    expect(m.lowpoly(undefined, { targetFaces: 300, union: VOXEL }).status).toBe('ok');
    const info = lowpolyInfo(m);
    expect(info).toMatchObject({ union: 'voxel', fallback: false });
    expect(info.lost).toEqual({
      labels: { rail: hubFaces },
      materials: { steel: plateFaces },
      corners: { uv0: plateCorners },
      bySource: {
        hub: { labels: hubFaces, materials: 0, corners: 0 },
        plate0p: { labels: 0, materials: plateFaces, corners: plateCorners },
      },
    });
  });

  it('a voxel union of plain parts reports an empty loss; the exact union has none', () => {
    const plain = hubPlates();
    expect(plain.lowpoly(undefined, { targetFaces: 300, union: VOXEL }).status).toBe('ok');
    expect(lowpolyInfo(plain).lost).toEqual({
      labels: {},
      materials: {},
      corners: {},
      bySource: {},
    });
    const exact = model();
    exact.box({ size: [1, 1, 1], tag: 'a' });
    exact.box({ size: [1, 1, 1], center: [0.5, 0.3, 0.2], tag: 'b' });
    expect(exact.lowpoly(undefined, { targetFaces: 100 }).status).toBe('ok');
    const info = lowpolyInfo(exact);
    expect(info.union).toBe('exact');
    expect(info).not.toHaveProperty('lost');
  });

  it('falsifier: an inside-out part is a precondition failure, never a fallback', () => {
    const m = hubPlates();
    m.flip(sel.tag('plate0p'));
    const r = m.lowpoly(undefined, { targetFaces: 300, union: VOXEL });
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('model-precondition');
    expect(r.error?.detail?.volume).toBeLessThan(0);
  });

  it('the result is mostly planar quads and keeps every hard edge sharp', () => {
    const m = hubPlates();
    expect(m.lowpoly(undefined, { targetFaces: 300, union: VOXEL }).status).toBe('ok');
    const info = lowpolyInfo(m);
    expect(info.quadAreaRatio as number).toBeGreaterThanOrEqual(0.85);
    expect(info.planarityP99 as number).toBeLessThanOrEqual(0.02);
    expect(unmarkedHardEdges(m, 45)).toBe(0);
    expect(
      m.editMesh.edges().some((e) => ((m.editMesh.eFlags[e] as number) & EDGE_SHARP) !== 0),
    ).toBe(true);
  });

  it('exact union path: flush full-face plates join into one quad box shell', () => {
    const m = hubPlates(1, 0);
    expect(m.lowpoly(undefined, { targetFaces: 300 }).status).toBe('ok');
    const info = lowpolyInfo(m);
    expect(info).toMatchObject({ union: 'exact', fallback: false, pass: true, issues: [] });
    expect(meshVolume(m)).toBeCloseTo(1.6, 9);
  });

  it('tags one group per output component and maps it to its source parts', () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 1, 1], center: [0.5, 0.5, 0.5], tag: 'b' });
    m.box({ size: [1, 1, 1], center: [4, 0, 0], tag: 'c' });
    expect(m.lowpoly(undefined, { targetFaces: 200, tags: { groupPrefix: 'g' } }).status).toBe(
      'ok',
    );
    const info = lowpolyInfo(m);
    expect(info.parts).toBe(3);
    const components = info.components as { tag: string; sources: string[] }[];
    expect(components.map((c) => c.tag)).toEqual(['g0', 'g1']);
    expect(components.map((c) => c.sources)).toEqual([['a', 'b'], ['c']]);
    const g0 = sel.tag('g0').resolve(m.editMesh);
    const g1 = sel.tag('g1').resolve(m.editMesh);
    expect(g0.ok && g1.ok).toBe(true);
    if (g0.ok && g1.ok) {
      expect(g0.value.length + g1.value.length).toBe(m.editMesh.faceCount);
      expect(g0.value.some((f) => g1.value.includes(f))).toBe(false);
    }
  });

  it('is deterministic', () => {
    const run = () => {
      const m = hubPlates();
      m.lowpoly(undefined, { targetFaces: 300, union: VOXEL, tags: { groupPrefix: 'low' } });
      return encodeSnapshot(m.editMesh);
    };
    expect(Buffer.from(run()).equals(Buffer.from(run()))).toBe(true);
  });

  it('rejects bad arguments', () => {
    for (const options of [
      { targetFaces: 2 },
      { targetFaces: 100, hardAngle: 0 },
      { targetFaces: 100, tags: { groupPrefix: '' } },
    ]) {
      const m = hubPlates(1, 0);
      expect(m.lowpoly(undefined, options).error?.code).toBe('model-invalid-argument');
    }
  });
});

describe('lowpoly slivers (C-410 Phase-2 gap)', () => {
  const W = 0.002;
  /** Two boxes whose tops differ by 1.5 mm: the union keeps a 1.5 mm x 1 m step wall. */
  function stepped(slivers?: number) {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'a' });
    m.box({ size: [1, 3, 1], center: [0.3, 0, 0.0015], tag: 'b' });
    const r = m.lowpoly(sel.all(), {
      targetFaces: 100000,
      quads: false,
      ...(slivers === undefined ? {} : { slivers }),
    });
    expect(r.status).toBe('ok');
    const detail = r.diagnostics?.find((d) => d.message.startsWith('lowpoly'))?.detail as
      | { slivers?: Record<string, number> }
      | undefined;
    return { m, report: detail?.slivers };
  }
  const gate = (m: Model, width = W, part?: string) =>
    m
      .validate({ slivers: { width, ...(part === undefined ? {} : { part }) } })
      .issues.filter((i) => i.code === 'face-degenerate');

  it('the gate is red while a sliver remains and green after the pass, closed, volume change reported', () => {
    const before = stepped();
    expect(before.report).toBeUndefined();
    expect(gate(before.m)).toMatchObject([
      { severity: 'error', detail: { reason: 'sliver', width: W, count: 1 } },
    ]);
    const volume = before.m.validate().volume;

    const after = stepped(W);
    expect(after.report).toMatchObject({ width: W, found: 1, removed: 1, kept: 0 });
    expect(gate(after.m)).toEqual([]);
    const v = after.m.validate();
    expect(v.closed).toBe(true);
    expect(v.issues.filter((i) => i.severity === 'error')).toEqual([]);
    after.m.uv.project({ mode: 'box', scale: 1 });
    expect(after.m.toMesh().ok).toBe(true);
    const change = v.volume / volume - 1;
    expect(after.report?.volumeChange).toBeCloseTo(change, 9);
    expect(Math.abs(change)).toBeGreaterThan(0);
    expect(Math.abs(change)).toBeLessThan(1e-3);
    expect(after.report?.maxMove).toBeLessThanOrEqual(W);
    expect(after.m.editMesh.faceCount).toBeLessThan(before.m.editMesh.faceCount);
    expect(after.m.count(sel.tag('a'))).toBeGreaterThan(0);
    expect(after.m.count(sel.tag('b'))).toBeGreaterThan(0);
  });

  it('a width below the sliver changes nothing and the gate agrees', () => {
    const { m, report } = stepped(0.001);
    expect(report).toMatchObject({ found: 0, removed: 0, kept: 0, volumeChange: 0 });
    expect(gate(m, 0.001)).toEqual([]);
    expect(gate(m)).toHaveLength(1);
  });

  it('limits the gate to a part and rejects a bad width, part or option', () => {
    const { m } = stepped();
    expect(gate(m, W, 'a')).toHaveLength(1);
    expect(gate(m, W, 'b')).toEqual([]);
    expect(gate(m, W, 'nowhere')).toMatchObject([{ detail: { reason: 'unknown-part' } }]);
    for (const width of [0, -1, Number.NaN]) {
      expect(gate(m, width)).toMatchObject([{ detail: { reason: 'invalid-width' } }]);
    }
    for (const slivers of [0, -1, Number.NaN]) {
      const bad = model();
      bad.box({ size: [1, 1, 1] });
      expect(bad.lowpoly(sel.all(), { targetFaces: 100, slivers }).error?.code).toBe(
        'model-invalid-argument',
      );
    }
  });

  it('is deterministic', () => {
    const run = () => encodeSnapshot(stepped(W).m.editMesh);
    expect(Buffer.from(run()).equals(Buffer.from(run()))).toBe(true);
  });
});
