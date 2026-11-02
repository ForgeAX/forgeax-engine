import { describe, expect, it } from 'vitest';
import { runComputeJob } from '../compute/job';
import { PrimitiveGrid } from '../compute/mesh-query';
import { tsProcessBackend } from '../compute/process-backend';
import { faceNormal, meshVolume, type Tuple3 } from '../geom';
import { EDGE_SHARP, type EditMesh } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { isClosed } from '../ops';
import { sel } from '../selectors';

function metrics(report: OpReport): Record<string, number> {
  const info = report.diagnostics?.find((d) => d.severity === 'info');
  return (info?.detail as { metrics: Record<string, number> }).metrics;
}

function sharpBox(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], label: 'crate' });
  m.markSharp(sel.edges.dihedral('>', 40));
  return m;
}

function sharpLength(mesh: EditMesh): number {
  let total = 0;
  for (const e of mesh.edges()) {
    if (((mesh.eFlags[e] as number) & EDGE_SHARP) === 0) continue;
    const [a, b] = mesh.edgeVertices(e).map((v) => mesh.position(v)) as [Tuple3, Tuple3];
    total += Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }
  return total;
}

/** Segments of the edges between faces of different label or role. */
function labelBorder(mesh: EditMesh): {
  points: Float64Array;
  corners: Int32Array;
  vertices: number[];
} {
  const corners: number[] = [];
  const vertices = new Set<number>();
  for (const e of mesh.edges()) {
    const f = mesh.hFace[e * 2] as number;
    const g = mesh.hFace[e * 2 + 1] as number;
    if (f < 0 || g < 0) continue;
    if (mesh.fLabel[f] === mesh.fLabel[g] && mesh.fRole[f] === mesh.fRole[g]) continue;
    const [a, b] = mesh.edgeVertices(e);
    corners.push(a, b, b);
    vertices.add(a);
    vertices.add(b);
  }
  return { points: mesh.pos, corners: Int32Array.from(corners), vertices: [...vertices] };
}

/** A capped sphere: shell faces and a `cap` inset (roles inner and rim) on top. */
function cappedSphere(): Model {
  const m = model();
  m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24, label: 'shell' });
  m.inset(sel.facing('+y', 40), { thickness: 0.03, region: 'merged', label: 'cap' });
  return m;
}

function borderDeviation(before: Model, after: Model): number {
  const original = labelBorder(before.editMesh);
  const grid = new PrimitiveGrid(original.points, original.corners);
  let worst = 0;
  for (const v of labelBorder(after.editMesh).vertices) {
    const hit = grid.closest(after.editMesh.position(v));
    worst = Math.max(worst, Math.sqrt(hit?.distance2 ?? Infinity));
  }
  return worst;
}

function identities(m: Model): string[] {
  const mesh = m.editMesh;
  return [
    ...new Set(
      mesh
        .faces()
        .map(
          (f) =>
            `${mesh.labelNames[mesh.fLabel[f] as number]}/${mesh.roleNames[mesh.fRole[f] as number]}`,
        ),
    ),
  ].sort();
}

describe('remesh job: isotropic remeshing', () => {
  it('a box remesh keeps its sharp edges and corners exactly', { timeout: 120000 }, () => {
    const m = sharpBox();
    const r = m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 5 });
    expect(r.status).toBe('ok');
    const x = metrics(r);
    expect(x.hausdorff).toBeLessThan(1e-9);
    expect(Math.abs(x.volumeChange as number)).toBeLessThan(1e-9);
    expect(Math.abs((x.edgeLengthMean as number) - 0.1)).toBeLessThan(0.015);
    expect(x.edgesInRange).toBeGreaterThan(0.85);
    expect(isClosed(m.editMesh)).toBe(true);
    expect(m.editMesh.faces().every((f) => m.editMesh.fLen[f] === 3)).toBe(true);
    expect(sharpLength(m.editMesh)).toBeCloseTo(12, 9);
    for (const sx of [-0.5, 0.5]) {
      for (const sy of [-0.5, 0.5]) {
        for (const sz of [-0.5, 0.5]) {
          expect(
            m.editMesh
              .vertices()
              .some((v) => m.editMesh.position(v).every((c, k) => c === [sx, sy, sz][k])),
          ).toBe(true);
        }
      }
    }
    // Labels and roles carry over by source face.
    expect(m.count(sel.createdBy('crate'))).toBe(m.editMesh.faceCount);
    // Falsifier: with sharp edges free the remesh cuts across the box edges and corners.
    const free = sharpBox();
    const cut = free.remesh(undefined, {
      targetEdgeLength: 0.1,
      iterations: 5,
      preserve: { sharp: false },
    });
    expect(metrics(cut).hausdorff).toBeGreaterThan(0.01);
    expect(sharpLength(free.editMesh)).toBeLessThan(12);
  });

  it('a sphere remesh evens edge lengths, stays on the surface and converges', {
    timeout: 120000,
  }, () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 64, heightSegments: 32 });
    const before = meshVolume(m.editMesh);
    const r = m.remesh(undefined, { targetEdgeLength: 0.08, iterations: 8 });
    const x = metrics(r);
    expect(Math.abs((x.edgeLengthMean as number) - 0.08)).toBeLessThan(0.01);
    expect(x.edgesInRange).toBeGreaterThan(0.8);
    expect(x.hausdorff).toBeLessThan(0.01);
    expect(Math.abs(meshVolume(m.editMesh) - before) / before).toBeLessThan(0.02);
    expect(x.splits).toBeGreaterThan(0);
    expect(x.collapses).toBeGreaterThan(0);
    expect(x.flips).toBeGreaterThan(0);
    // A second pass at the same length settles: under half the topology work, little movement.
    const again = metrics(m.remesh(undefined, { targetEdgeLength: 0.08, iterations: 8 }));
    expect((again.splits as number) + (again.collapses as number)).toBeLessThan(
      ((x.splits as number) + (x.collapses as number)) / 2,
    );
    expect(again.hausdorff).toBeLessThan(0.01);
  });

  it('a partial remesh leaves the other faces untouched and stitched', { timeout: 120000 }, () => {
    const m = model();
    m.box({ size: [1, 1, 1], segments: [4, 4, 4], tag: 'body' });
    m.markSharp(sel.edges.dihedral('>', 40));
    const others = m.snapshot();
    const top = sel.facing('+y');
    const untouched = model();
    untouched.append(others);
    untouched.delete(top);
    const r = m.remesh(top, { targetEdgeLength: 0.05, iterations: 4 });
    expect(r.status).toBe('ok');
    expect(isClosed(m.editMesh)).toBe(true);
    const kept = model();
    kept.append(m.snapshot());
    kept.delete(sel.facing('+y'));
    expect(kept.snapshot()).toEqual(untouched.snapshot());
    expect(m.count(top)).toBeGreaterThan(16 * 2);
  });
});

describe('remesh job: QEM simplification', () => {
  it('simplify keeps label borders as constrained curves', { timeout: 120000 }, () => {
    const source = cappedSphere();
    const m = cappedSphere();
    const r = m.simplify(undefined, { targetFaces: 400 });
    expect(r.status).toBe('ok');
    const x = metrics(r);
    expect(x.trianglesAfter).toBe(400);
    expect(identities(m)).toEqual(identities(source));
    expect(isClosed(m.editMesh)).toBe(true);
    const preserved = borderDeviation(source, m);
    expect(preserved).toBeLessThan(0.002);
    // Falsifier: with labels free the border vertices wander off the original border.
    const free = cappedSphere();
    free.simplify(undefined, { targetFaces: 400, preserve: { labels: false } });
    expect(borderDeviation(source, free)).toBeGreaterThan(5 * preserved);
  });

  it('the volume quadric preserves the enclosed volume', { timeout: 120000 }, () => {
    const run = (quadric: 'plane' | 'volume' | 'attribute') => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24 });
      const r = m.simplify(undefined, { targetFaces: 300, quadric });
      expect(r.status).toBe('ok');
      expect(isClosed(m.editMesh)).toBe(true);
      return metrics(r);
    };
    const volume = run('volume');
    const plane = run('plane');
    const attribute = run('attribute');
    expect(Math.abs(volume.volumeChange as number)).toBeLessThan(1e-9);
    // Falsifier: the plain plane quadric loses volume measurably.
    expect(Math.abs(plane.volumeChange as number)).toBeGreaterThan(1e-4);
    expect(attribute.hausdorff).toBeLessThan(0.03);
    for (const x of [volume, plane, attribute]) expect(x.trianglesAfter).toBe(300);
  });

  it('maxError stops the collapses; Hausdorff and volume are reported', { timeout: 120000 }, () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24 });
    const r = m.simplify(undefined, { maxError: 0.001 });
    const x = metrics(r);
    expect(x.trianglesAfter).toBeLessThan(x.trianglesBefore as number);
    expect(x.trianglesAfter).toBeGreaterThan(300);
    expect(x.lastCollapseError).toBeLessThanOrEqual(0.001);
    expect(x.hausdorff).toBeLessThan(0.005);
    expect(x.volumeBefore).toBeGreaterThan(0);
    expect(r.diagnostics?.filter((d) => d.severity === 'warn')).toEqual([]);
  });

  it('names the real blocker when simplify stops above targetFaces', { timeout: 120000 }, () => {
    const warning = (r: ReturnType<ReturnType<typeof model>['simplify']>) =>
      r.diagnostics?.find((d) => d.severity === 'warn' && /above targetFaces/.test(d.message))
        ?.message;
    // A loose maxError never stops anything: the sharp-edge constraints do.
    const constrained = model();
    constrained.box({ size: [1, 1, 1], segments: [2, 2, 2] });
    constrained.markSharp(sel.edges.dihedral('>', 45), true);
    const loose = warning(constrained.simplify(undefined, { targetFaces: 4, maxError: 100 }));
    expect(loose).toBeDefined();
    expect(loose).not.toContain('maxError');
    // A tight maxError does stop it, and says so.
    const sphere = model();
    sphere.sphere({ radius: 0.5, widthSegments: 16, heightSegments: 12 });
    const tight = warning(sphere.simplify(undefined, { targetFaces: 4, maxError: 1e-2 }));
    expect(tight).toContain('maxError');
  });

  it('UV seams stay curves and corner values transfer within their island', {
    timeout: 120000,
  }, () => {
    const m = model();
    m.sphere({ radius: 0.5, widthSegments: 32, heightSegments: 16 });
    m.uv.project({ mode: 'box', scale: 1 });
    const r = m.simplify(undefined, { targetFaces: 500 });
    expect(r.status).toBe('ok');
    const mesh = m.editMesh;
    let checked = 0;
    for (const f of mesh.faces()) {
      const n = faceNormal(mesh, f);
      const len = Math.hypot(...n);
      const k = [0, 1, 2].reduce(
        (best, i) => (Math.abs(n[i] as number) > Math.abs(n[best] as number) ? i : best),
        0,
      );
      for (const h of mesh.faceHalves(f)) expect(mesh.corner('uv0', h)).toBeDefined();
      if (Math.abs(n[k] as number) < 0.95 * len) continue;
      // Well inside a box-projection island the transferred UV is the projection of the position.
      const sign = (n[k] as number) < 0 ? -1 : 1;
      for (const h of mesh.faceHalves(f)) {
        const p = mesh.position(mesh.hVert[h] as number);
        const expected =
          k === 0 ? [-sign * p[2], p[1]] : k === 1 ? [p[0], -sign * p[2]] : [sign * p[0], p[1]];
        const uv = mesh.corner('uv0', h) as Float32Array;
        expect(Math.abs((uv[0] as number) - (expected[0] as number))).toBeLessThan(0.02);
        expect(Math.abs((uv[1] as number) - (expected[1] as number))).toBeLessThan(0.02);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('simplifies a face subset and stitches it to the pinned rest', { timeout: 120000 }, () => {
    const m = cappedSphere();
    const shell = sel.createdBy('shell');
    const capFaces = m.count(sel.createdBy('cap'));
    const r = m.simplify(shell, { targetFaces: 300 });
    expect(r.status).toBe('ok');
    expect(m.count(sel.createdBy('cap'))).toBe(capFaces);
    expect(isClosed(m.editMesh)).toBe(true);
    expect(m.count(shell)).toBe(300);
  });

  it('clearance keeps a simplified shell off the surface just inside it (layered parts)', {
    timeout: 120000,
  }, () => {
    const run = (clearance?: number) => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24, label: 'outer' });
      m.sphere({ radius: 0.497, widthSegments: 64, heightSegments: 32, label: 'inner' });
      const r = m.simplify(sel.createdBy('outer'), {
        targetFaces: 200,
        ...(clearance === undefined ? {} : { clearance }),
      });
      expect(r.status).toBe('ok');
      const crossing = m
        .validate()
        .issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn');
      return { m, x: metrics(r), crossing };
    };
    // Falsifier: the coarse chords of the outer shell dip 3 mm through the inner one.
    expect(run().crossing.length).toBeGreaterThan(0);
    const guarded = run(0.0005);
    expect(guarded.crossing).toEqual([]);
    expect(guarded.x.clearanceBlocked).toBeGreaterThan(0);
    expect(guarded.x.trianglesAfter).toBeLessThan(guarded.x.trianglesBefore as number);
    expect(isClosed(guarded.m.editMesh)).toBe(true);
  });

  it('clearance holds for remesh too: splits, collapses, flips and smoothing keep off the inner surface', {
    timeout: 120000,
  }, () => {
    const run = (clearance?: number) => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24, label: 'outer' });
      m.sphere({ radius: 0.497, widthSegments: 64, heightSegments: 32, label: 'inner' });
      const r = m.remesh(sel.createdBy('outer'), {
        targetEdgeLength: 0.2,
        iterations: 5,
        ...(clearance === undefined ? {} : { clearance }),
      });
      expect(r.status).toBe('ok');
      const crossing = m
        .validate()
        .issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn');
      return { m, x: metrics(r), crossing };
    };
    // Falsifier: 20 cm triangles dip about 1 cm through the shell 3 mm inside.
    expect(run().crossing.length).toBeGreaterThan(0);
    const guarded = run(0.0005);
    expect(guarded.crossing).toEqual([]);
    expect(guarded.x.clearanceBlocked).toBeGreaterThan(0);
    expect(isClosed(guarded.m.editMesh)).toBe(true);
  });

  it('adaptive sizing refines bends and keeps flat regions coarse (a flattened ellipsoid)', {
    timeout: 120000,
  }, () => {
    const run = (adaptive?: { error: number; minEdge: number }) => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 96, heightSegments: 48 });
      m.scale(sel.all(), [1, 0.15, 1]);
      m.triangulate(sel.all());
      const r = m.remesh(undefined, {
        targetEdgeLength: 0.12,
        iterations: 8,
        ...(adaptive === undefined ? {} : { adaptive }),
      });
      expect(r.status).toBe('ok');
      const quality = (faces?: ReturnType<typeof sel.all>) => {
        const q = m.meshQuality(faces);
        if (!q.ok) throw new Error(q.error.expected);
        return q.value;
      };
      return {
        m,
        x: metrics(r),
        all: quality(),
        rim: quality(sel.inBox([-1, -0.02, -1], [1, 0.02, 1], { by: 'centroid' })),
        pole: quality(sel.inBox([-0.25, -1, -0.25], [0.25, 1, 0.25], { by: 'centroid' })),
      };
    };
    const uniform = run();
    const adaptive = run({ error: 0.002, minEdge: 0.01 });
    // Falsifier: uniform 12 cm triangles cut the 7.5 cm-radius rim by about 3 cm.
    expect(uniform.x.hausdorff).toBeGreaterThan(0.02);
    expect(adaptive.x.hausdorff).toBeLessThan(0.005);
    expect(adaptive.rim.density).toBeGreaterThan(5 * uniform.rim.density);
    expect(adaptive.pole.density).toBeLessThan(1.25 * uniform.pole.density);
    // Graded: the finer rim still meets the R5 tiling limits.
    expect(adaptive.all.aspect.p90).toBeLessThanOrEqual(4);
    expect(adaptive.all.sizeRatio.p95).toBeLessThanOrEqual(2);
    expect(isClosed(adaptive.m.editMesh)).toBe(true);
    // A field that cannot go below the target is the uniform remesh, byte for byte.
    const flat = model();
    flat.sphere({ radius: 0.5, widthSegments: 96, heightSegments: 48 });
    flat.scale(sel.all(), [1, 0.15, 1]);
    flat.triangulate(sel.all());
    flat.remesh(undefined, {
      targetEdgeLength: 0.12,
      iterations: 8,
      adaptive: { error: 0.002, minEdge: 0.12 },
    });
    expect(flat.snapshot()).toEqual(uniform.m.snapshot());
  });

  it('rejects bad options; budgets, cancellation and the native policy follow the job contract', {
    timeout: 120000,
  }, () => {
    const cases: [(m: Model) => unknown, string][] = [
      [(m) => m.simplify(undefined, {}), 'model-invalid-argument'],
      [(m) => m.simplify(undefined, { targetFaces: 0 }), 'model-invalid-argument'],
      [(m) => m.simplify(undefined, { maxError: -1 }), 'model-invalid-argument'],
      [(m) => m.simplify(undefined, { targetFaces: 10, clearance: 0 }), 'model-invalid-argument'],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 1, clearance: -1 }),
        'model-invalid-argument',
      ],
      [
        (m) =>
          m.remesh(undefined, {
            targetEdgeLength: 0.1,
            iterations: 1,
            adaptive: { error: 0, minEdge: 0.01 },
          }),
        'model-invalid-argument',
      ],
      [
        (m) =>
          m.remesh(undefined, {
            targetEdgeLength: 0.1,
            iterations: 1,
            adaptive: { error: 0.001, minEdge: 0.2 },
          }),
        'model-invalid-argument',
      ],
      [
        (m) => m.simplify(undefined, { targetFaces: 10, quadric: 'cubic' as never }),
        'model-invalid-argument',
      ],
      [
        (m) => m.simplify(undefined, { targetFaces: 10, preserve: { sharp: 'maybe' as never } }),
        'model-invalid-argument',
      ],
      [(m) => m.simplify(undefined, { targetFaces: 100000 }), 'model-op-no-effect'],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0, iterations: 2 }),
        'model-invalid-argument',
      ],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 0 }),
        'model-invalid-argument',
      ],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 101 }),
        'model-invalid-argument',
      ],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 2, smoothing: 2 }),
        'model-invalid-argument',
      ],
      [
        (m) => m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 2, compute: 'native' }),
        'model-capability-unavailable',
      ],
      [(m) => m.simplify(undefined, { targetFaces: 10, budget: 100 }), 'model-work-budget'],
    ];
    for (const [call, code] of cases) {
      const m = sharpBox();
      const before = m.snapshot();
      call(m);
      expect(m.poisoned?.code).toBe(code);
      expect(m.snapshot()).toEqual(before);
    }
    const capped = model({ budget: { faces: 1000 } });
    capped.sphere({ radius: 0.5, widthSegments: 16, heightSegments: 8 });
    capped.remesh(undefined, { targetEdgeLength: 0.01, iterations: 2 });
    expect(capped.poisoned?.code).toBe('model-work-budget');
    const request = {
      kind: 'remesh' as const,
      inputs: [sharpBox().snapshot()],
      params: {
        operation: 'isotropic' as const,
        faces: 'all' as const,
        targetEdgeLength: 0.1,
        iterations: 2,
        constraints: {
          boundary: 'slide',
          sharp: 'slide',
          seam: 'slide',
          material: 'slide',
          label: 'slide',
        } as const,
      },
    };
    const cancelled = runComputeJob(request, tsProcessBackend, { signal: { aborted: true } });
    expect(cancelled.ok ? undefined : cancelled.error.code).toBe('model-cancelled');
    const done = runComputeJob(request, tsProcessBackend);
    if (!done.ok) throw done.error;
    expect(done.value.report).toMatchObject({ backend: 'ts', quality: 'baseline' });
    expect(done.value.provenance[0]?.face.every((f) => f >= 0 && f < 6)).toBe(true);
  });

  it('is deterministic: the same build gives the same bytes', { timeout: 120000 }, () => {
    const build = () => {
      const m = cappedSphere();
      m.remesh(undefined, { targetEdgeLength: 0.06, iterations: 3 });
      m.simplify(undefined, { targetFaces: 500 });
      return m.snapshot();
    };
    expect(build()).toEqual(build());
  });
});

describe('simplify deviation without maxError (audit L-B4)', () => {
  it('warns relative to the bounding diagonal when preserved auto seams leave the rims to coarsen', {
    timeout: 120000,
  }, () => {
    const run = (uvSeams: boolean) => {
      const m = model();
      m.cylinder({
        radiusTop: 0.2,
        radiusBottom: 0.2,
        height: 0.4,
        radialSegments: 48,
        heightSegments: 16,
      });
      m.triangulate(sel.all());
      expect(m.uv.auto({ resolution: 512, padding: 4 }).status).toBe('ok');
      const before = m.editMesh.faceCount;
      const r = m.simplify(undefined, {
        targetFaces: Math.round(before * 0.12),
        preserve: { uvSeams },
      });
      expect(r.status).toBe('ok');
      return { x: metrics(r), warns: (r.diagnostics ?? []).filter((d) => d.severity === 'warn') };
    };
    const seams = run(true);
    expect(seams.x.hausdorffRelative).toBeGreaterThan(0.02);
    const relative = seams.warns.find((w) => /of the bounding diagonal/.test(w.message));
    expect(relative?.message).toMatch(/before uv\.auto/);
    expect(relative?.detail).toMatchObject({ limit: 0.02, hausdorff: seams.x.hausdorff });
    // Falsifier: the same target without the seams keeps the surface and stays silent.
    const free = run(false);
    expect(free.x.hausdorffRelative).toBeLessThan(1e-6);
    expect(free.warns).toEqual([]);
  });
});

describe('remesh direction', () => {
  const around = { around: { axis: [0, 1, 0] as Tuple3, center: [0, 0, 0] as Tuple3 } };

  it('builds the field without changing the remesh, and reports it', () => {
    const plain = sharpBox();
    plain.remesh(undefined, { targetEdgeLength: 0.2, iterations: 3 });
    const guided = sharpBox();
    const r = guided.remesh(undefined, {
      targetEdgeLength: 0.2,
      iterations: 3,
      direction: { guides: [{ flow: around }], anisotropy: 1 },
    });
    // At anisotropy 1 the field is built and reported, and the remesh is byte-identical.
    expect(guided.snapshot()).toEqual(plain.snapshot());
    const info = r.diagnostics?.find((d) => d.severity === 'info');
    const detail = info?.detail as {
      direction: Record<string, unknown>;
      metrics: Record<string, number>;
    };
    expect(detail.direction).toMatchObject({ guides: 1, anisotropy: 1 });
    // The cube's sharp edges are preserved feature curves: hard field constraints.
    expect(detail.direction.constrained).toBeGreaterThan(0);
    expect(detail.metrics.fieldRoughness).toBeGreaterThanOrEqual(0);
  });

  it('accepts principal directions and refuses bad guides', () => {
    const ok = sharpBox().remesh(undefined, {
      targetEdgeLength: 0.2,
      iterations: 1,
      direction: { guides: 'principal', anisotropy: 1 },
    });
    expect(ok.status).not.toBe('error');
    const bad = (direction: unknown) => {
      const m = sharpBox();
      m.remesh(undefined, { targetEdgeLength: 0.2, iterations: 1, direction: direction as never });
      return m.poisoned?.code;
    };
    expect(bad({ guides: [] })).toBe('model-invalid-argument');
    expect(bad({ guides: [{ flow: { along: [0, 0, 0] } }] })).toBe('model-invalid-argument');
    expect(bad({ guides: [{ flow: { curve: [[0, 0, 0]] } }] })).toBe('model-invalid-argument');
    expect(bad({ guides: 'principal', anisotropy: 7 })).toBe('model-invalid-argument');
    expect(bad({ guides: 'principal', anisotropy: 0.5 })).toBe('model-invalid-argument');
  });
});

describe('remesh direction', () => {
  const around = { around: { axis: [0, 1, 0] as Tuple3, center: [0, 0, 0] as Tuple3 } };
  const flow = [{ flow: around }];
  function tube(radius = 0.5, label = 'tube'): Model {
    const m = model();
    m.cylinder({
      radiusTop: radius,
      radiusBottom: radius,
      height: 1.5,
      radialSegments: 48,
      heightSegments: 6,
      label,
    });
    m.delete(sel.createdBy(label, 'top').or(sel.createdBy(label, 'bottom')));
    return m;
  }
  const quality = (
    m: Model,
    faces = sel.all(),
    guides: readonly { faces?: never; flow: typeof around }[] = flow,
  ) => {
    const q = m.meshQuality(faces, {}, { flow: guides });
    if (!q.ok) throw q.error;
    return q.value;
  };
  const remesh = { targetEdgeLength: 0.1, iterations: 20 } as const;

  it('lays long edges along the flow within every R5 limit', () => {
    const plain = tube();
    plain.remesh(undefined, remesh);
    // Falsifier: without the field the long edges point anywhere.
    expect(quality(plain).flow?.p75).toBeGreaterThan(30);
    const guided = tube();
    guided.remesh(undefined, { ...remesh, direction: { guides: flow } });
    const q = quality(guided);
    expect(q.flow?.p75).toBeLessThanOrEqual(20);
    expect(q.failed).toEqual([]);
    // Falsifier: stretched to 2 the tiling fails the aspect median.
    const stretched = tube();
    stretched.remesh(undefined, { ...remesh, direction: { guides: flow, anisotropy: 2 } });
    expect(quality(stretched).failed).toContain('aspectP50');
  });

  it('is the isotropic remesh exactly at anisotropy 1', () => {
    const plain = tube();
    plain.remesh(undefined, { targetEdgeLength: 0.1, iterations: 4 });
    const flat = tube();
    flat.remesh(undefined, {
      targetEdgeLength: 0.1,
      iterations: 4,
      direction: { guides: flow, anisotropy: 1 },
    });
    expect(flat.snapshot()).toEqual(plain.snapshot());
  });

  it("takes a guide's own anisotropy on its faces", () => {
    const m = tube();
    const lower = sel.inBox([-1, -1, -1], [1, 0, 1]);
    m.remesh(undefined, {
      ...remesh,
      direction: {
        guides: [
          { faces: lower, flow: around, anisotropy: 1.5 },
          { flow: around, anisotropy: 1 },
        ],
      },
    });
    const low = quality(m, sel.inBox([-1, -1, -1], [1, -0.15, 1]));
    const high = quality(m, sel.inBox([-1, 0.15, -1], [1, 1, 1]));
    expect(low.flow?.p75).toBeLessThanOrEqual(20);
    expect(high.flow?.p75).toBeGreaterThan(30);
  });

  it('follows meridians on a dome', () => {
    const dome = () => {
      const d = model();
      d.sphere({ radius: 0.5, widthSegments: 48, heightSegments: 24, label: 'dome' });
      d.delete(sel.inBox([-1, -1, -1], [1, -0.01, 1], { by: 'all' }));
      return d;
    };
    const meridians = [{ flow: { from: [0, 0.5, 0] as Tuple3 } }];
    const m = dome();
    const plain = dome();
    plain.remesh(undefined, remesh);
    m.remesh(undefined, { ...remesh, direction: { guides: meridians } });
    // Away from the pole, where the meridians have not yet converged.
    const lower = sel.inBox([-1, 0.03, -1], [1, 0.25, 1]);
    const q = m.meshQuality(lower, {}, { flow: meridians });
    const p = plain.meshQuality(lower, {}, { flow: meridians });
    if (!q.ok || !p.ok) throw new Error('quality');
    expect(p.value.flow?.p75).toBeGreaterThan(30);
    expect(q.value.flow?.p75).toBeLessThanOrEqual(20);
  });

  it('keeps the alignment through a directed tiling cleanup', () => {
    // A 2-row band (the G6 hem's dimensions and place) remeshed along its flow.
    const hem = [
      { flow: { around: { axis: [0, 1, 0] as Tuple3, center: [0, 0.2, -0.012] as Tuple3 } } },
    ];
    const band = () => {
      const m = model();
      m.cylinder({
        radiusTop: 0.3,
        radiusBottom: 0.33,
        height: 2 * 0.035 * (Math.sqrt(3) / 2),
        radialSegments: 160,
        heightSegments: 8,
        openEnded: true,
        center: [0, 0.2, -0.012],
      });
      m.triangulate(sel.all());
      m.remesh(undefined, { targetEdgeLength: 0.02, iterations: 10 });
      m.remesh(undefined, {
        targetEdgeLength: 0.045,
        iterations: 20,
        adaptive: { error: 0.004, minEdge: 0.036 },
        direction: { guides: hem },
      });
      return m;
    };
    const tidy = { maxError: 0.003, maxAspect: 3.5, iterations: 20 } as const;
    const untidy = quality(band(), sel.all(), hem).flow?.p75 as number;
    const plain = band();
    const p = plain.try((t) => t.cleanup.tiling(undefined, tidy));
    if (!p.ok) throw p.error;
    const directed = band();
    // An aligned tiling may leave the directed cleanup nothing to do.
    const r = directed.try((t) =>
      t.cleanup.tiling(undefined, { ...tidy, direction: { guides: hem } }),
    );
    if (!r.ok) expect(r.error.code).toBe('model-op-no-effect');
    // Falsifier: the Delaunay cleanup undoes the alignment.
    expect(quality(plain, sel.all(), hem).flow?.p75).toBeGreaterThan(untidy + 10);
    expect(quality(directed, sel.all(), hem).flow?.p75).toBeLessThanOrEqual(untidy + 2);
    expect(quality(directed, sel.all(), hem).failed).toEqual([]);
  });

  it('is the Delaunay tiling cleanup exactly without a direction', () => {
    const run = (direction?: { guides: typeof flow; anisotropy: number }) => {
      const m = tube();
      m.triangulate(sel.all());
      m.remesh(undefined, { targetEdgeLength: 0.1, iterations: 3 });
      m.try((t) =>
        t.cleanup.tiling(undefined, {
          maxError: 0.01,
          ...(direction === undefined ? {} : { direction }),
        }),
      );
      return m.snapshot();
    };
    // Anisotropy 1 has no metric: the Delaunay cleanup too.
    expect(run({ guides: flow, anisotropy: 1 })).toEqual(run());
  });

  it('keeps a clearance-locked layer pair aligned and apart', { timeout: 120000 }, () => {
    // Two concentric tubes 2 cm apart, remeshed in one call with clearance under one guide.
    const m = tube(0.5, 'inner');
    m.append(tube(0.52, 'outer').snapshot());
    const r = m.remesh(undefined, { ...remesh, clearance: 0.005, direction: { guides: flow } });
    expect(r.status).not.toBe('error');
    for (const label of ['inner', 'outer'])
      expect(quality(m, sel.createdBy(label)).flow?.p75).toBeLessThanOrEqual(20);
    const v = m.validate();
    expect(v.issues.filter((i) => i.code === 'self-intersection' && i.severity === 'warn')).toEqual(
      [],
    );
  });
});
