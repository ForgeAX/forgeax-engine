import { describe, expect, it } from 'vitest';
import { computeCacheKey, runComputeJob, WorkMeter } from '../compute/job';
import { tsProcessBackend } from '../compute/process-backend';
import { decodeSdf, encodeSdf, surfaceNets } from '../compute/voxel-ts';
import { meshVolume, type Tuple3 } from '../geom';
import { debugValidate } from '../invariants';
import { type Model, model } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';
import { SdfGrid } from '../voxel';

const H = 0.05;

function sphere(radius = 0.5, tag = 'ball', center: Tuple3 = [0, 0, 0]): Model {
  const m = model();
  m.sphere({ radius, widthSegments: 48, heightSegments: 24, center, tag });
  return m;
}

function radialError(
  m: Model,
  radius: number,
  center: Tuple3 = [0, 0, 0],
): { max: number; mean: number } {
  let max = 0;
  let sum = 0;
  const vertices = m.editMesh.vertices();
  for (const v of vertices) {
    const p = m.editMesh.position(v);
    const e = Math.abs(Math.hypot(p[0] - center[0], p[1] - center[1], p[2] - center[2]) - radius);
    max = Math.max(max, e);
    sum += e;
  }
  return { max, mean: sum / vertices.length };
}

/** Vertex-connected parts of a session. */
function partCount(m: Model): number {
  const mesh = m.editMesh;
  const parent = new Map<number, number>();
  const find = (v: number): number => {
    let r = v;
    while (parent.get(r) !== r) r = parent.get(r) as number;
    return r;
  };
  for (const v of mesh.vertices()) parent.set(v, v);
  for (const e of mesh.edges()) {
    const [a, b] = mesh.edgeVertices(e);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb));
  }
  return new Set(mesh.vertices().map(find)).size;
}

function metrics(m: Model): Record<string, number> {
  const info = m.journal.at(-1)?.diagnostics?.find((d) => d.severity === 'info');
  return (info?.detail as { metrics: Record<string, number> }).metrics;
}

describe('voxel job: narrow-band SDF and Surface Nets', () => {
  it('a sphere SDF matches the analytic distance and meshes within voxel tolerance', {
    timeout: 120000,
  }, () => {
    const m = sphere();
    const grid = m.voxel.fromMesh(undefined, { voxelSize: H, band: 3 });
    expect(m.poisoned).toBeUndefined();
    expect(grid.isEmpty).toBe(false);
    expect(m.editMesh.faceCount).toBe(1152);
    // Within the band every sample is the distance to the tessellated sphere, whose
    // chord sagitta 0.5 (1 - cos(7.5 deg)) bounds its gap to the analytic one.
    const [nx, ny] = grid.dims;
    let worst = 0;
    let banded = 0;
    for (let s = 0; s < grid.values.length; s++) {
      const v = grid.values[s] as number;
      if (Math.abs(v) >= grid.band * H - 1e-12) continue;
      banded++;
      const i = s % nx;
      const j = ((s - i) / nx) % ny;
      const k = (s - i - nx * j) / (nx * ny);
      const p = [grid.origin[0] + i * H, grid.origin[1] + j * H, grid.origin[2] + k * H];
      worst = Math.max(
        worst,
        Math.abs(v - (Math.hypot(p[0] as number, p[1] as number, p[2] as number) - 0.5)),
      );
    }
    expect(banded).toBeGreaterThan(1000);
    expect(worst).toBeLessThan(0.0045);
    expect(grid.sample([0.52, 0, 0])).toBeCloseTo(0.02, 2);
    expect(grid.sample([0, 0, 0])).toBe(-grid.band * H);

    const out = model();
    const r = out.voxel.toMesh(grid, { label: 'blob' });
    expect(r.status).toBe('ok');
    expect(isClosed(out.editMesh)).toBe(true);
    const error = radialError(out, 0.5);
    expect(error.max).toBeLessThan(0.15 * H);
    expect(error.mean).toBeLessThan(0.05 * H);
    const volume = meshVolume(out.editMesh);
    expect(Math.abs(volume - meshVolume(m.editMesh)) / meshVolume(m.editMesh)).toBeLessThan(0.02);
    // New geometry: this operation's label and role, the source tags by nearest face.
    expect(out.count(sel.createdBy('blob', 'surface'))).toBe(out.editMesh.faceCount);
    expect(out.count(sel.tag('ball'))).toBe(out.editMesh.faceCount);
    expect(r.roles).toEqual({ surface: out.editMesh.faceCount });
    const info = r.diagnostics?.find((d) => d.severity === 'info');
    expect(info?.detail).toMatchObject({ backend: 'ts', quality: 'baseline', unmappedFaces: 0 });

    // Falsifier: a positive iso level grows the extracted sphere by that distance.
    const grown = model();
    grown.voxel.toMesh(grid, { iso: 0.08 });
    expect(radialError(grown, 0.58).max).toBeLessThan(0.15 * H);
    expect(radialError(grown, 0.5).mean).toBeGreaterThan(0.07);
  });

  it('winding and parity signs agree on closed input; an open sheet bounds nothing', {
    timeout: 120000,
  }, () => {
    const winding = sphere().voxel.fromMesh(undefined, { voxelSize: H, band: 3, sign: 'winding' });
    const parity = sphere().voxel.fromMesh(undefined, { voxelSize: H, band: 3, sign: 'parity' });
    let differ = 0;
    for (let s = 0; s < winding.values.length; s++) {
      if (Math.sign(winding.values[s] as number) !== Math.sign(parity.values[s] as number))
        differ++;
    }
    expect(differ).toBe(0);
    // Falsifiers: inverted faces have winding number -1 and an open sheet crosses each
    // grid line once with no exit (its winding number is about 1/2 behind it, which the
    // winding rule cannot decide): no inside; fromMesh warns and fillHoles fails.
    const flipped = sphere();
    flipped.flip(sel.all());
    const sheet = model();
    sheet.plane({ width: 1, height: 1 });
    for (const [m, sign] of [
      [flipped, 'winding'],
      [sheet, 'parity'],
    ] as const) {
      const grid = m.voxel.fromMesh(undefined, { voxelSize: H, band: 2, sign });
      expect(grid.values.every((v) => v >= 0)).toBe(true);
      expect(
        m.journal
          .at(-1)
          ?.diagnostics?.some(
            (d) => d.severity === 'warn' && /no grid sample is inside/.test(d.message),
          ),
      ).toBe(true);
      m.voxel.fillHoles(undefined, { voxelSize: H, sign });
      expect(m.poisoned?.code).toBe('model-op-no-effect');
    }
  });

  it('fillHoles warns, with the openings, when a wide open tube fills to a ring (audit L-B5)', {
    timeout: 120000,
  }, () => {
    const fill = (height: number) => {
      const m = model();
      m.cylinder({
        radiusTop: 0.2,
        radiusBottom: 0.2,
        height,
        radialSegments: 32,
        openEnded: true,
      });
      const r = m.voxel.fillHoles(undefined, { voxelSize: 0.02 });
      expect(r.status).toBe('ok');
      const capped = Math.PI * 0.2 * 0.2 * height;
      return {
        ratio: meshVolume(m.editMesh) / capped,
        warns: (r.diagnostics ?? []).filter((d) => d.severity === 'warn'),
      };
    };
    // h / 2r = 0.5: two openings subtend more than half the sphere at the centre.
    const wide = fill(0.2);
    expect(wide.ratio).toBeLessThan(0.6);
    expect(wide.warns).toHaveLength(1);
    expect(wide.warns[0]?.message).toMatch(/ring or shell/);
    const detail = wide.warns[0]?.detail as {
      cappedVolume: number;
      openings: { center: Tuple3; radius: number; edges: number }[];
    };
    expect(detail.cappedVolume).toBeGreaterThan(0.95 * Math.PI * 0.04 * 0.2);
    expect(
      detail.openings
        .map((o) => [
          Math.round(o.center[1] * 1000) / 1000,
          Math.round(o.radius * 1000) / 1000,
          o.edges,
        ])
        .sort(),
    ).toEqual([
      [-0.1, 0.2, 32],
      [0.1, 0.2, 32],
    ]);
    // Falsifier: at h / 2r = 1 the fill closes the tube and stays silent.
    const tall = fill(0.4);
    expect(tall.ratio).toBeGreaterThan(0.85);
    expect(tall.warns).toEqual([]);
  });

  it('fillHoles closes an open box under both sign rules', { timeout: 120000 }, () => {
    for (const sign of ['winding', 'parity'] as const) {
      const m = model();
      m.box({ size: [1, 1, 1], tag: 'crate' });
      m.delete(sel.facing('+y'));
      expect(isClosed(m.editMesh)).toBe(false);
      const r = m.voxel.fillHoles(undefined, { voxelSize: 0.04, sign, label: 'filled' });
      expect([sign, r.status, r.error?.code]).toEqual([sign, 'ok', undefined]);
      expect(isClosed(m.editMesh)).toBe(true);
      expect(Math.abs(meshVolume(m.editMesh) - 1)).toBeLessThan(0.06);
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
      // The cap over the hole lies beyond the band of every source face: it has no nearest-face tags.
      const detail = r.diagnostics?.find((d) => d.severity === 'info')?.detail as {
        sourceOpenEdges: number;
        unmappedFaces: number;
      };
      expect(detail.sourceOpenEdges).toBe(4);
      expect(detail.unmappedFaces).toBeGreaterThan(0);
      expect(m.count(sel.tag('crate')) + detail.unmappedFaces).toBe(m.editMesh.faceCount);
    }
  });

  it('a hollow solid keeps its cavity: a cavity wall is part of its solid, not a separate part', {
    timeout: 120000,
  }, () => {
    // A 1 m box around an inward-facing 0.5 m box: volume 1 - 0.125. Each shell alone
    // bounds 1 m^3 and nothing, so voxelizing the shells separately filled the cavity.
    const hollow = (extra = false) => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.box({ size: [0.5, 0.5, 0.5] });
      m.flip(sel.inBox([-0.3, -0.3, -0.3], [0.3, 0.3, 0.3], { by: 'all' }));
      if (extra) m.box({ size: [0.4, 0.4, 0.4], center: [0.6, 0, 0] });
      expect(meshVolume(m.editMesh)).toBeCloseTo(extra ? 0.875 + 0.064 : 0.875, 9);
      return m;
    };
    for (const sign of ['winding', 'parity'] as const) {
      const grid = hollow().voxel.fromMesh(undefined, { voxelSize: H, band: 3, sign });
      expect(grid.sample([0, 0, 0])).toBeGreaterThan(0);
      expect(grid.sample([0.375, 0, 0])).toBeLessThan(0);
      const filled = hollow();
      expect(filled.voxel.fillHoles(undefined, { voxelSize: H, sign }).status).toBe('ok');
      expect(meshVolume(filled.editMesh)).toBeCloseTo(0.875, 1);
      const grown = hollow();
      expect(grown.voxel.offset(undefined, { voxelSize: H, distance: 0.05, sign }).status).toBe(
        'ok',
      );
      // Outer box grows, the cavity shrinks: 1.1^3 - 0.4^3.
      expect(meshVolume(grown.editMesh)).toBeCloseTo(1.331 - 0.064, 1);
      const joined = hollow(true);
      expect(joined.voxel.union(undefined, { voxelSize: H, radius: 0, sign }).status).toBe('ok');
      // The 0.4 m box overlaps the outer box by 0.1 m: 0.875 + 0.064 - 0.016.
      expect(meshVolume(joined.editMesh)).toBeCloseTo(0.923, 1);
      expect(partCount(joined)).toBe(2);
    }
  });

  it('smooth union bridges a gap that the hard union leaves open', { timeout: 120000 }, () => {
    const build = (radius: number) => {
      const m = model();
      m.sphere({
        radius: 0.3,
        widthSegments: 32,
        heightSegments: 16,
        center: [-0.35, 0, 0],
        tag: 'a',
      });
      m.sphere({
        radius: 0.3,
        widthSegments: 32,
        heightSegments: 16,
        center: [0.35, 0, 0],
        tag: 'b',
      });
      const r = m.voxel.union(sel.all(), { voxelSize: 0.03, radius, label: 'blend' });
      expect(r.status).toBe('ok');
      return m;
    };
    const hard = build(0);
    const smooth = build(0.25);
    // The 0.1 m gap: at its middle both distances are 0.05; smin < 0 needs radius > 0.2.
    expect(partCount(hard)).toBe(2);
    expect(partCount(smooth)).toBe(1);
    expect(meshVolume(smooth.editMesh)).toBeGreaterThan(meshVolume(hard.editMesh) * 1.01);
    for (const m of [hard, smooth]) {
      expect(isClosed(m.editMesh)).toBe(true);
      expect(m.count(sel.tag('a'))).toBeGreaterThan(0);
      expect(m.count(sel.tag('b'))).toBeGreaterThan(0);
      const bounds = m.bounds(sel.tag('a'));
      if (!bounds.ok) throw bounds.error;
      expect(bounds.value.min[0]).toBeLessThan(-0.6);
      expect(bounds.value.max[0]).toBeLessThan(0.05);
    }
    expect(metrics(smooth).parts).toBe(2);
  });

  it('offset grows and shrinks a box by the distance; unselected faces stay', {
    timeout: 120000,
  }, () => {
    const m = model();
    m.box({ size: [1, 1, 1], tag: 'core' });
    m.box({ size: [0.2, 0.2, 0.2], center: [3, 0, 0], tag: 'spare' });
    m.voxel.offset(sel.tag('core'), { voxelSize: 0.025, distance: 0.1, label: 'grown' });
    expect(m.poisoned).toBeUndefined();
    const grown = m.bounds(sel.createdBy('grown'));
    if (!grown.ok) throw grown.error;
    for (let k = 0; k < 3; k++) {
      expect(Math.abs((grown.value.max[k] as number) - 0.6)).toBeLessThan(0.0125);
      expect(Math.abs((grown.value.min[k] as number) + 0.6)).toBeLessThan(0.0125);
    }
    expect(m.count(sel.tag('spare'))).toBe(6);
    const shrunk = model();
    shrunk.box({ size: [1, 1, 1] });
    shrunk.voxel.offset(undefined, { voxelSize: 0.025, distance: -0.1 });
    expect(Math.abs(meshVolume(shrunk.editMesh) - 0.512)).toBeLessThan(0.02);
    // Falsifier: an offset below the voxel resolution warns that the volume moved the wrong way or not at all.
    const tiny = sphere();
    tiny.voxel.offset(undefined, { voxelSize: 0.1, distance: 0.002 });
    expect(
      tiny.journal
        .at(-1)
        ?.diagnostics?.some(
          (d) => d.severity === 'warn' && /below the voxel resolution/.test(d.message),
        ),
    ).toBe(true);
  });

  it('sharp placement (dual contouring) keeps box corners that the mean placement rounds', {
    timeout: 120000,
  }, () => {
    const cornerError = (sharp: boolean) => {
      const m = model();
      m.box({ size: [1, 1, 1], center: [0.013, 0.021, 0.008] });
      const grid = m.voxel.fromMesh(undefined, { voxelSize: 0.07, band: 3 });
      const out = model();
      const r = out.voxel.toMesh(grid, { sharp });
      expect(r.status).toBe('ok');
      let worst = 0;
      for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
          for (const sz of [-1, 1]) {
            const c = [0.013 + sx * 0.5, 0.021 + sy * 0.5, 0.008 + sz * 0.5];
            let best = Infinity;
            for (const v of out.editMesh.vertices()) {
              const p = out.editMesh.position(v);
              best = Math.min(
                best,
                Math.hypot(
                  p[0] - (c[0] as number),
                  p[1] - (c[1] as number),
                  p[2] - (c[2] as number),
                ),
              );
            }
            worst = Math.max(worst, best);
          }
        }
      }
      return {
        worst,
        features: (
          r.diagnostics?.find((d) => d.severity === 'info')?.detail as {
            metrics: { features: number };
          }
        ).metrics.features,
      };
    };
    const sharp = cornerError(true);
    const mean = cornerError(false);
    expect(sharp.worst).toBeLessThan(1e-9);
    expect(mean.worst).toBeGreaterThan(0.4 * 0.07);
    expect(sharp.features).toBeGreaterThan(0);
    expect(mean.features).toBe(0);
  });

  it('smoothing sweeps relax the vertices and keep them on the iso level', {
    timeout: 120000,
  }, () => {
    const grid = sphere().voxel.fromMesh(undefined, { voxelSize: H, band: 3 });
    const plain = model();
    plain.voxel.toMesh(grid, {});
    const relaxed = model();
    relaxed.voxel.toMesh(grid, { smooth: 4 });
    expect(radialError(relaxed, 0.5).max).toBeLessThan(0.15 * H);
    expect(relaxed.snapshot()).not.toEqual(plain.snapshot());
    expect(relaxed.editMesh.faceCount).toBe(plain.editMesh.faceCount);
  });

  it('rejects invalid options and empty grids; a poisoned session returns the empty grid', {
    timeout: 120000,
  }, () => {
    const cases: [(m: Model) => unknown, string][] = [
      [(m) => m.voxel.fromMesh(undefined, { voxelSize: 0, band: 3 }), 'model-invalid-argument'],
      [(m) => m.voxel.fromMesh(undefined, { voxelSize: H, band: 0 }), 'model-invalid-argument'],
      [
        (m) => m.voxel.fromMesh(undefined, { voxelSize: H, band: 2, sign: 'odd' as never }),
        'model-invalid-argument',
      ],
      [(m) => m.voxel.union(undefined, { voxelSize: H, radius: -1 }), 'model-invalid-argument'],
      [
        (m) => m.voxel.union(undefined, { voxelSize: H, radius: 0.2, band: 2 }),
        'model-invalid-argument',
      ],
      [(m) => m.voxel.offset(undefined, { voxelSize: H, distance: 0 }), 'model-invalid-argument'],
      [(m) => m.voxel.fillHoles(undefined, { voxelSize: H, smooth: -1 }), 'model-invalid-argument'],
      [
        (m) => m.voxel.fillHoles(undefined, { voxelSize: H, smooth: 100 }),
        'model-invalid-argument',
      ],
      [(m) => m.voxel.toMesh(SdfGrid.empty), 'model-invalid-argument'],
      [
        (m) => m.voxel.toMesh(m.voxel.fromMesh(undefined, { voxelSize: H, band: 2 }), { iso: 0.2 }),
        'model-invalid-argument',
      ],
      [
        (m) => m.voxel.fromMesh(sel.tag('missing'), { voxelSize: H, band: 2 }),
        'model-selection-empty',
      ],
    ];
    for (const [call, code] of cases) {
      const m = sphere();
      const before = m.snapshot();
      call(m);
      expect(m.poisoned?.code).toBe(code);
      expect(m.snapshot()).toEqual(before);
    }
    const poisoned = sphere();
    poisoned.voxel.offset(undefined, { voxelSize: H, distance: 0 });
    expect(poisoned.voxel.fromMesh(undefined, { voxelSize: H, band: 2 })).toBe(SdfGrid.empty);
    expect(poisoned.journal.at(-1)?.status).toBe('skipped');
    expect(SdfGrid.empty.sample([0, 0, 0])).toBeNaN();
  });

  it('budgets, cancellation and the native policy follow the job contract', {
    timeout: 120000,
  }, () => {
    const fine = sphere();
    fine.voxel.fromMesh(undefined, { voxelSize: 0.002, band: 2 });
    expect(fine.poisoned?.code).toBe('model-work-budget');
    expect(fine.poisoned?.detail).toMatchObject({ dims: [510, 510, 510] });
    const small = model({ budget: { work: 1000 } });
    small.sphere({ radius: 0.5, widthSegments: 16, heightSegments: 8 });
    small.voxel.union(undefined, { voxelSize: H, radius: 0 });
    expect(small.poisoned?.code).toBe('model-work-budget');
    const native = sphere();
    native.voxel.offset(undefined, { voxelSize: H, distance: 0.1, compute: 'native' });
    expect(native.poisoned?.code).toBe('model-capability-unavailable');
    const request = {
      kind: 'voxel' as const,
      inputs: [sphere().snapshot()],
      params: {
        operation: 'sdf' as const,
        faces: 'all' as const,
        voxelSize: H,
        band: 2,
        sign: 'winding' as const,
      },
    };
    const cancelled = runComputeJob(request, tsProcessBackend, { signal: { aborted: true } });
    expect(cancelled.ok ? undefined : cancelled.error.code).toBe('model-cancelled');
    const done = runComputeJob(request, tsProcessBackend);
    if (!done.ok) throw done.error;
    expect(done.value.report).toMatchObject({ backend: 'ts', quality: 'baseline' });
    expect(done.value.report.cacheKey).toBe(
      computeCacheKey(request, done.value.report.backendIdentity),
    );
    const again = runComputeJob(request, tsProcessBackend);
    if (!again.ok) throw again.error;
    expect(again.value.outputs[0]).toEqual(done.value.outputs[0]);
    const grid = decodeSdf(done.value.outputs[0] as Uint8Array);
    if (!grid.ok) throw grid.error;
    expect(encodeSdf(grid.value)).toEqual(done.value.outputs[0]);
    expect(decodeSdf(new Uint8Array(8)).ok).toBe(false);
  });

  it('is deterministic: the same build gives the same bytes', { timeout: 120000 }, () => {
    const build = () => {
      const m = model();
      m.torus({ radius: 0.4, tube: 0.12, radialSegments: 12, tubularSegments: 32, tag: 'ring' });
      m.cylinder({ radiusTop: 0.1, radiusBottom: 0.1, height: 1, radialSegments: 16, tag: 'post' });
      m.voxel.union(undefined, { voxelSize: 0.04, radius: 0.08, smooth: 2, label: 'knot' });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });

  it('one-voxel tunnels through an ambiguous face stay manifold (B11 D1)', () => {
    // Fields whose ambiguous faces join one sheet on both sides used to give two cell
    // vertices four quads; the seeded fields below cover every such configuration seen.
    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const n = 6;
    let faces = 0;
    for (let trial = 0; trial < 400; trial++) {
      const values = new Float64Array(n * n * n);
      for (let k = 0; k < n; k++) {
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            const border =
              i === 0 || j === 0 || k === 0 || i === n - 1 || j === n - 1 || k === n - 1;
            values[i + n * (j + n * k)] = border ? 1 : random() * 2 - 1;
          }
        }
      }
      const grid = {
        origin: [0, 0, 0] as Tuple3,
        voxelSize: 1,
        dims: [n, n, n] as const,
        band: 4,
        values,
        nearest: new Int32Array(n * n * n).fill(-1),
      };
      for (const sharp of [false, true]) {
        const surface = surfaceNets(grid, { iso: 0, smooth: 0, sharp }, new WorkMeter(1e9));
        if (!surface.ok) throw new Error(`trial ${trial}: ${surface.error.expected}`);
        expect(isClosed(surface.value.mesh)).toBe(true);
        expect(debugValidate(surface.value.mesh)).toEqual([]);
        faces += surface.value.mesh.faceCount;
      }
    }
    expect(faces).toBeGreaterThan(0);
  });

  it('a thin strand bundle unions at every grid phase (B11 D1, maid-whale hair repro)', {
    timeout: 120000,
  }, () => {
    // Strands thinner than two voxels at several grid phases: the F2 hair failed at
    // voxelSize 0.01 for radius 0 and 0.003.
    for (const shift of [0, 0.0025, 0.005, 0.0075]) {
      const m = model();
      for (let i = 0; i < 6; i++) {
        const r = 0.006 + 0.001 * (i % 3);
        m.sweep({
          profile: Array.from({ length: 8 }, (_, a) => [
            r * Math.cos((a * Math.PI) / 4),
            r * Math.sin((a * Math.PI) / 4),
          ]) as [number, number][],
          path: [
            [shift + i * 0.011, 0, 0],
            [shift + i * 0.009 + 0.02, 0.08, 0.01 * (i % 2)],
            [shift + i * 0.012, 0.16, 0.02],
          ],
          tag: `strand-${i}`,
        });
      }
      for (const radius of [0, 0.003]) {
        const r = m.try((s) => s.voxel.union(sel.all(), { voxelSize: 0.01, radius }));
        expect(r.ok, `shift ${shift} radius ${radius}`).toBe(true);
      }
      expect(m.validate().issues.filter((i) => i.severity === 'error')).toEqual([]);
    }
  });
});
