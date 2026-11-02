import type { MeshAsset } from '@forgeax/engine-types';
import { describe, expect, it } from 'vitest';
import type { Tuple3 } from '../geom';
import { model } from '../model';
import { type NurbsSurface, surfaceDerivatives } from '../nurbs';
import { sel } from '../selectors';
import { checkSurfaceQuality } from '../surface-quality';

/** Exact quarter cylinder (rational quadratic arc in xy, linear in z), radius r. */
function cylinder(r: number, z0: number, z1: number): NurbsSurface {
  const w = Math.SQRT1_2;
  return {
    degreeU: 2,
    degreeV: 1,
    points: [
      [
        [r, 0, z0],
        [r, 0, z1],
      ],
      [
        [r, r, z0],
        [r, r, z1],
      ],
      [
        [0, r, z0],
        [0, r, z1],
      ],
    ],
    weights: [
      [1, 1],
      [w, w],
      [1, 1],
    ],
    knotsU: [0, 0, 0, 1, 1, 1],
    knotsV: [0, 0, 1, 1],
  };
}

/** Largest angle (degrees) between exported normals and the cylinder's radial direction. */
function radialError(mesh: MeshAsset): number {
  const p = mesh.attributes.position as Float32Array;
  const n = mesh.attributes.normal as Float32Array;
  let worst = 0;
  for (let i = 0; i < p.length / 3; i++) {
    const rx = p[3 * i] as number;
    const ry = p[3 * i + 1] as number;
    const l = Math.hypot(rx, ry);
    const c = Math.abs((rx * (n[3 * i] as number) + ry * (n[3 * i + 1] as number)) / l);
    worst = Math.max(worst, (Math.acos(Math.min(1, c)) * 180) / Math.PI);
  }
  return worst;
}

function build(patches: { name: string; surface: NurbsSurface }[], chord: number) {
  const m = model();
  m.surface({ patches, chord });
  m.uv.project({ mode: 'box', scale: 1 });
  expect(m.poisoned).toBeUndefined();
  return m;
}

describe("finish normals { mode: 'surface' }", () => {
  it('exports the exact patch normal on a coarse cylinder; weighted is off by more', () => {
    const m = build([{ name: 'barrel', surface: cylinder(0.3, 0, 0.2) }], 0.002);
    const exact = m.toMesh({ normals: { mode: 'surface' } });
    if (!exact.ok) throw exact.error;
    expect(radialError(exact.value.mesh)).toBeLessThan(0.5);
    const [hit, total] = exact.value.report.exactNormals ?? [0, 0];
    expect(hit).toBe(total);
    const weighted = m.toMesh({ normals: { mode: 'weighted' } });
    if (!weighted.ok) throw weighted.error;
    expect(radialError(weighted.value.mesh)).toBeGreaterThan(1);
    expect(weighted.value.report.exactNormals).toBeUndefined();
  });

  it('keeps one normal per vertex across a smooth patch boundary', () => {
    const halves = [cylinder(0.3, 0, 0.1), cylinder(0.3, 0.1, 0.2)];
    const m = build(
      halves.map((surface, k) => ({ name: `half${k}`, surface })),
      0.002,
    );
    const exact = m.toMesh({ normals: { mode: 'surface' } });
    const weighted = m.toMesh({ normals: { mode: 'weighted' } });
    if (!exact.ok) throw exact.error;
    if (!weighted.ok) throw weighted.error;
    expect(exact.value.report.gpuVertices).toBe(weighted.value.report.gpuVertices);
    expect(radialError(exact.value.mesh)).toBeLessThan(0.5);
    // Render vertices split on the seam (uv1 differs) share one normal: no shading seam.
    const p = exact.value.mesh.attributes.position as Float32Array;
    const n = exact.value.mesh.attributes.normal as Float32Array;
    const seam = new Map<string, string>();
    let pairs = 0;
    for (let i = 0; i < p.length / 3; i++) {
      if (Math.abs((p[3 * i + 2] as number) - 0.1) > 1e-6) continue;
      const key = `${p[3 * i]},${p[3 * i + 1]}`;
      const value = `${n[3 * i]},${n[3 * i + 1]},${n[3 * i + 2]}`;
      const seen = seam.get(key);
      if (seen === undefined) seam.set(key, value);
      else {
        expect(value).toBe(seen);
        pairs++;
      }
    }
    expect(pairs).toBeGreaterThan(0);
  });

  it('falls back to the weighted normal where an edit moved corners off their patch', () => {
    const halves = [cylinder(0.3, 0, 0.1), cylinder(0.3, 0.1, 0.2)];
    const m = build(
      halves.map((surface, k) => ({ name: `half${k}`, surface })),
      0.004,
    );
    m.translate(sel.tag('half1'), [0, 0, 0.01]);
    expect(m.poisoned).toBeUndefined();
    const exact = m.toMesh({ normals: { mode: 'surface' } });
    const weighted = m.toMesh({ normals: { mode: 'weighted' } });
    if (!exact.ok) throw exact.error;
    if (!weighted.ok) throw weighted.error;
    const [hit, total] = exact.value.report.exactNormals ?? [0, 0];
    expect(hit).toBeGreaterThan(0);
    expect(hit).toBeLessThan(total);
    // Moved corners keep exactly the weighted normal: the top half matches it bit for bit.
    const pe = exact.value.mesh.attributes.position as Float32Array;
    const ne = exact.value.mesh.attributes.normal as Float32Array;
    const nw = weighted.value.mesh.attributes.normal as Float32Array;
    let same = 0;
    for (let i = 0; i < pe.length / 3; i++)
      if ((pe[3 * i + 2] as number) > 0.15)
        same += [0, 1, 2].every((k) => ne[3 * i + k] === nw[3 * i + k]) ? 1 : 0;
    expect(same).toBeGreaterThan(0);
  });

  it('averages exact normals across a patch seam only when the patches meet G1', () => {
    const plane = (a: number[], b: number[], c: number[], d: number[]): NurbsSurface => ({
      degreeU: 1,
      degreeV: 1,
      points: [
        [a as Tuple3, b as Tuple3],
        [c as Tuple3, d as Tuple3],
      ],
      knotsU: [0, 0, 1, 1],
      knotsV: [0, 0, 1, 1],
    });
    const exactAt = (deg: number) => {
      const t = (deg * Math.PI) / 180;
      const e: Tuple3 = [0.1 * Math.cos(t), 0, 0.1 * Math.sin(t)];
      const m = build(
        [
          { name: 'a', surface: plane([-0.1, 0, 0], [-0.1, 0.1, 0], [0, 0, 0], [0, 0.1, 0]) },
          { name: 'b', surface: plane([0, 0, 0], [0, 0.1, 0], e, [e[0], 0.1, e[2]]) },
        ],
        0.001,
      );
      const x = m.toMesh({ normals: { mode: 'surface' } });
      if (!x.ok) throw x.error;
      return x.value.report.exactNormals;
    };
    expect(exactAt(0)).toEqual([8, 8]);
    // A 90 degree crease left smooth: the seam vertices take the weighted mean, not exact.
    expect(exactAt(90)).toEqual([4, 8]);
  });

  it('reports when a transform leaves every vertex off its recorded patch', () => {
    const m = build([{ name: 'barrel', surface: cylinder(0.3, 0, 0.2) }], 0.002);
    m.translate(sel.all(), [0.1, 0, 0]);
    const x = m.toMesh({ normals: { mode: 'surface' } });
    if (!x.ok) throw x.error;
    expect(x.value.report.exactNormals?.[0]).toBe(0);
    expect(x.value.report.diagnostics?.map((d) => d.severity)).toEqual(['info']);
    const kept = build([{ name: 'barrel', surface: cylinder(0.3, 0, 0.2) }], 0.002);
    const y = kept.toMesh({ normals: { mode: 'surface' } });
    if (!y.ok) throw y.error;
    expect(y.value.report.diagnostics).toBeUndefined();
  });

  it('takes the limit normal at a pole and skips only the corners off the patch', () => {
    // Quarter dome of revolution (quadratic profile): the side t = 1 collapses to a pole.
    const w = Math.SQRT1_2;
    const profile: Tuple3[] = [
      [0.1, 0, 0],
      [0.1, 0, 0.1],
      [0, 0, 0.1],
    ];
    const turn = (p: Tuple3, k: number): Tuple3 =>
      k === 0 ? p : k === 1 ? [p[0], p[0], p[2]] : [0, p[0], p[2]];
    const dome: NurbsSurface = {
      degreeU: 2,
      degreeV: 2,
      points: [0, 1, 2].map((k) => profile.map((p) => turn(p, k))),
      weights: [
        [1, 1, 1],
        [w, w, w],
        [1, 1, 1],
      ],
      knotsU: [0, 0, 0, 1, 1, 1],
      knotsV: [0, 0, 0, 1, 1, 1],
    };
    const m = build([{ name: 'dome', surface: dome }], 0.002);
    const x = m.toMesh({ normals: { mode: 'surface' } });
    if (!x.ok) throw x.error;
    const [hit, total] = x.value.report.exactNormals ?? [0, 0];
    expect(hit).toBe(total);
    const p = x.value.mesh.attributes.position as Float32Array;
    const n = x.value.mesh.attributes.normal as Float32Array;
    let poles = 0;
    for (let i = 0; i < p.length / 3; i++) {
      if (Math.hypot(p[3 * i] as number, p[3 * i + 1] as number) > 1e-6) continue;
      poles++;
      expect((Math.acos(Math.min(1, n[3 * i + 2] as number)) * 180) / Math.PI).toBeLessThan(0.01);
    }
    expect(poles).toBeGreaterThan(0);
  });

  it('keeps exact normals on a mirrored half: the mirror records the reflected patch', () => {
    const half: NurbsSurface = {
      ...cylinder(0.3, 0, 0.2),
      points: cylinder(0.3, 0, 0.2).points.map((row) =>
        row.map(([x, y, z]) => [x + 0.01, y, z] as Tuple3),
      ),
    };
    const m = build([{ name: 'barrel', surface: half }], 0.002);
    expect(m.mirror({ axis: 'x' }).status).toBe('ok');
    const x = m.toMesh({ normals: { mode: 'surface' } });
    if (!x.ok) throw x.error;
    const [hit, total] = x.value.report.exactNormals ?? [0, 0];
    expect(hit).toBe(total);
    expect(x.value.report.diagnostics).toBeUndefined();
    // Both halves: the radial direction about (+-0.01, 0), within 0.5 degree.
    const p = x.value.mesh.attributes.position as Float32Array;
    const n = x.value.mesh.attributes.normal as Float32Array;
    let worst = 0;
    for (let i = 0; i < p.length / 3; i++) {
      const rx = (p[3 * i] as number) - Math.sign(p[3 * i] as number) * 0.01;
      const ry = p[3 * i + 1] as number;
      const c = Math.abs(
        (rx * (n[3 * i] as number) + ry * (n[3 * i + 1] as number)) / Math.hypot(rx, ry),
      );
      worst = Math.max(worst, (Math.acos(Math.min(1, c)) * 180) / Math.PI);
    }
    expect(worst).toBeLessThan(0.5);
  });

  it('names each mirrored patch once and keeps its exact normals outward', () => {
    // A quarter cylinder meeting x = 0 and y = 0, mirrored in x and then in y: a full barrel.
    const m = build([{ name: 'barrel', surface: cylinder(0.3, 0, 0.2) }], 0.002);
    expect(m.mirror({ axis: 'x' }).status).toBe('ok');
    expect(m.mirror({ axis: 'y' }).status).toBe('ok');
    const surfaces = m.diagnostics().surfaces;
    const names = surfaces.map((s) => s.name);
    expect(names).toEqual(['barrel', 'barrel.mirror', 'barrel.mirror.1', 'barrel.mirror.mirror']);
    const x = m.toMesh({ normals: { mode: 'surface' } });
    if (!x.ok) throw x.error;
    const [hit, total] = x.value.report.exactNormals ?? [0, 0];
    expect(hit).toBe(total);
    // The reflections reverse su x sv; exported normals still point outward and to the side
    // of every triangle they shade.
    const p = x.value.mesh.attributes.position as Float32Array;
    const n = x.value.mesh.attributes.normal as Float32Array;
    const index = x.value.mesh.indices as Uint32Array | Uint16Array;
    const at = (i: number, a: Float32Array): Tuple3 => [
      a[3 * i] as number,
      a[3 * i + 1] as number,
      a[3 * i + 2] as number,
    ];
    let outward = 0;
    for (let i = 0; i < p.length / 3; i++) {
      const [px, py] = at(i, p);
      const [nx, ny] = at(i, n);
      if ((px * nx + py * ny) / Math.hypot(px, py) > 0.999) outward++;
    }
    expect(outward).toBe(p.length / 3);
    for (let t = 0; t < index.length; t += 3) {
      const [a, b, c] = [0, 1, 2].map((k) => at(index[t + k] as number, p)) as [
        Tuple3,
        Tuple3,
        Tuple3,
      ];
      const e: Tuple3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const f: Tuple3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      const face: Tuple3 = [
        e[1] * f[2] - e[2] * f[1],
        e[2] * f[0] - e[0] * f[2],
        e[0] * f[1] - e[1] * f[0],
      ];
      for (let k = 0; k < 3; k++) {
        const v = at(index[t + k] as number, n);
        expect(v[0] * face[0] + v[1] * face[1] + v[2] * face[2]).toBeGreaterThan(0);
      }
    }
    // Surface checks name each patch once and measure the centre seams on both planes.
    const quality = checkSurfaceQuality({ surfaces });
    if (!quality.ok) throw quality.error;
    expect(quality.value.surfaces.map((s) => s.name)).toEqual(names);
    const seams = quality.value.edges.filter((e) => e.a !== e.b);
    expect(seams.map((e) => [e.a, e.b].sort().join('|')).sort()).toEqual(
      [
        'barrel.mirror.1|barrel.mirror.mirror',
        'barrel|barrel.mirror',
        'barrel.mirror|barrel.mirror.mirror',
        'barrel|barrel.mirror.1',
      ].sort(),
    );
    for (const e of seams) {
      expect(e.samples).toBeGreaterThan(0);
      expect(e.skipped).toBe(0);
      expect(e.gap.value).toBeLessThan(1e-9);
      expect(e.angle.value).toBeLessThan(1e-6);
    }
  });

  it('claims no exact normal for a fan welded across a normal jump at a zero-speed point', () => {
    // Degree 2 in u, interior knot 0.5; on the side t = 0 the two middle points coincide, so
    // su = 0 at (0.5, 0) and the side's tangent turns by ~40 degrees there (a cone point).
    // Tessellation welds the side vertices beside it; a fan straddling the turn has no
    // exact normal (the auditor's case: 40.1 degrees off at s = 0.53).
    const points = [0, 1, 2, 3].map((i) =>
      [0, 1, 2].map((j): Tuple3 => {
        const x =
          j === 0 ? ([0, 0.05, 0.05, 0.1][i] as number) : ([0, 0.035, 0.065, 0.1][i] as number);
        return [x, j * 0.05, 0.02 * Math.sin(x * 30) + 0.01 * j * j];
      }),
    );
    const surface: NurbsSurface = {
      degreeU: 2,
      degreeV: 2,
      points,
      knotsU: [0, 0, 0, 0.5, 1, 1, 1],
      knotsV: [0, 0, 0, 1, 1, 1],
    };
    const m = build([{ name: 'cusp', surface }], 0.002);
    const exact = m.toMesh({ normals: { mode: 'surface' } });
    const weighted = m.toMesh({ normals: { mode: 'weighted' } });
    if (!exact.ok) throw exact.error;
    if (!weighted.ok) throw weighted.error;
    const [hit, total] = exact.value.report.exactNormals ?? [0, 0];
    expect(hit).toBeLessThan(total);
    // Reference: the patch normal at each render vertex's own uv1, from a regular point
    // 1e-6 beside a degenerate one (the limit). Every exact normal is within 0.5 degree.
    const n = exact.value.mesh.attributes.normal as Float32Array;
    const nw = weighted.value.mesh.attributes.normal as Float32Array;
    const uv = exact.value.mesh.attributes.uv1 as Float32Array;
    const normalAt = (s: number, t: number): Tuple3 => {
      const d = surfaceDerivatives(surface, s, t, 1);
      const [a, b] = [(d[1] as Tuple3[])[0] as Tuple3, (d[0] as Tuple3[])[1] as Tuple3];
      const c: Tuple3 = [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
      ];
      const l = Math.hypot(...c);
      return [c[0] / l, c[1] / l, c[2] / l];
    };
    let checked = 0;
    let worst = 0;
    for (let i = 0; i < n.length / 3; i++) {
      if ([0, 1, 2].every((k) => n[3 * i + k] === nw[3 * i + k])) continue;
      checked++;
      const s = uv[2 * i] as number;
      const t = Math.min(1 - 1e-6, Math.max(1e-6, uv[2 * i + 1] as number));
      const r = normalAt(s === 0.5 ? s + 1e-6 : s, t);
      const c = Math.abs(
        r[0] * (n[3 * i] as number) +
          r[1] * (n[3 * i + 1] as number) +
          r[2] * (n[3 * i + 2] as number),
      );
      worst = Math.max(worst, (Math.acos(Math.min(1, c)) * 180) / Math.PI);
    }
    expect(checked).toBeGreaterThan(30);
    expect(worst).toBeLessThan(0.5);
  });
});
