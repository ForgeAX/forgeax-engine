import { describe, expect, it } from 'vitest';
import { runComputeJob } from '../compute/job';
import { tsUvBackend } from '../compute/uv-backend';
import { measureUv } from '../compute/uv-ts';
import { encodeSnapshot } from '../fxem';
import { EDGE_SEAM, EDGE_SHARP } from '../mesh';
import { type Model, model, type OpReport } from '../model';
import { sel } from '../selectors';
import { crossedEdges } from '../uv';

type Metrics = Record<string, number>;

function auto(report: OpReport): { metrics: Metrics; unwrap: Metrics; pack: Metrics } {
  const info = report.diagnostics?.filter((d) => d.severity === 'info').at(-1);
  if (report.status !== 'ok' || info === undefined) {
    throw new Error(`${report.op}: ${report.error?.message}`);
  }
  return info.detail as { metrics: Metrics; unwrap: Metrics; pack: Metrics };
}

const ATLAS = { resolution: 1024, padding: 4 } as const;

function sharpBox(): Model {
  const m = model();
  m.box({ size: [1, 1, 1], segments: [3, 3, 3] });
  m.markSharp(sel.edges.dihedral('>', 40));
  return m;
}

function sphere(): Model {
  const m = model();
  m.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
  return m;
}

/** UV islands of the session's uv0 and their overlap / range facts. */
function layout(m: Model) {
  const measured = measureUv(m.editMesh);
  if (!measured.ok) throw measured.error;
  const issues = m.validate({ uniqueUv: true }).issues.map((i) => i.code);
  let inside = true;
  for (const f of m.editMesh.faces()) {
    for (const h of m.editMesh.faceHalves(f)) {
      const uv = m.editMesh.corner('uv0', h) as Float32Array;
      if (
        !(
          (uv[0] as number) >= 0 &&
          (uv[0] as number) <= 1 &&
          (uv[1] as number) >= 0 &&
          (uv[1] as number) <= 1
        )
      )
        inside = false;
    }
  }
  return { islands: measured.value.islands.length, measured: measured.value, issues, inside };
}

describe('uv.auto', () => {
  it('sharp edges are hard boundaries: a box makes one chart per side, packed without overlap', () => {
    const m = sharpBox();
    const r = m.uv.auto(ATLAS);
    const { metrics, unwrap, pack } = auto(r);
    expect(r.roles).toEqual({ charted: 54 });
    expect(metrics.initialPatches).toBe(54);
    expect(metrics.charts).toBe(6);
    expect(metrics.hardEdges).toBe(36);
    expect(unwrap.islands).toBe(6);
    expect(unwrap.stretchL2).toBeCloseTo(1, 9);
    expect(pack.islands).toBe(6);
    const l = layout(m);
    expect(l.islands).toBe(6);
    expect(l.inside).toBe(true);
    expect(l.issues.filter((c) => c.startsWith('uv-'))).toEqual([]);
    expect(crossedEdges(m.editMesh, m.editMesh.faces(), 'uv0', EDGE_SHARP)).toBe(0);
  });

  it('a smooth closed sphere is cut into low-distortion charts within maxCharts', () => {
    const m = sphere();
    const { metrics, unwrap } = auto(m.uv.auto(ATLAS));
    expect(metrics.initialPatches).toBe(100);
    expect(metrics.charts).toBeGreaterThan(1);
    expect(metrics.charts).toBeLessThanOrEqual(100);
    expect(metrics.meanDistortion).toBeLessThanOrEqual(1.5);
    expect(unwrap.flipped).toBe(0);
    expect(unwrap.areaDistortion).toBeLessThan(2);
    expect(unwrap.stretchL2).toBeLessThan(1.01);
    const l = layout(m);
    expect(l.islands).toBe(metrics.charts);
    expect(l.issues.filter((c) => c.startsWith('uv-'))).toEqual([]);
    const few = sphere();
    const capped = auto(few.uv.auto({ ...ATLAS, maxCharts: 8 })).metrics;
    expect(capped.initialPatches).toBe(8);
    expect(capped.charts).toBeLessThanOrEqual(8);
  });

  it('merging stops at the distortion limit: a tight limit keeps more charts on a curved part (falsifier)', () => {
    const loose = auto(sphere().uv.auto(ATLAS)).metrics;
    const tight = auto(sphere().uv.auto({ ...ATLAS, maxDistortion: 1.005 })).metrics;
    expect(tight.charts).toBeGreaterThan(loose.charts as number);
    // A flat sheet merges into one chart under any limit.
    const plane = model();
    plane.plane({ width: 2, height: 1, widthSegments: 8, heightSegments: 4 });
    expect(auto(plane.uv.auto({ ...ATLAS, maxDistortion: 1 })).metrics.charts).toBe(1);
  });

  it('the normal limit keeps a 90 degree turn apart; a 180 degree limit lets a smooth L merge (falsifier)', () => {
    const bent = () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 4, heightSegments: 4 });
      m.extrude(sel.facing('+z'), { distance: 0.25, region: 'merged' });
      return m;
    };
    const strict = auto(
      bent().uv.auto({ ...ATLAS, respectSharp: false, maxNormalDeviation: 45 }),
    ).metrics;
    const open = auto(
      bent().uv.auto({
        ...ATLAS,
        respectSharp: false,
        maxNormalDeviation: 180,
        maxDistortion: 100,
      }),
    ).metrics;
    expect(open.charts).toBeLessThan(strict.charts as number);
  });

  it('respectSharp: false lets charts cross sharp edges, which the assertion detects (falsifier)', () => {
    const m = model();
    m.plane({ width: 2, height: 1, widthSegments: 8, heightSegments: 4 });
    const line = sel
      .inBox([-9, -9, -9], [0, 9, 9], { by: 'centroid' })
      .boundary()
      .and(sel.inBox([0, -9, -9], [9, 9, 9], { by: 'centroid' }).boundary());
    expect(m.markSharp(line).roles).toEqual({ edges: 4 });
    const kept = auto(m.uv.auto(ATLAS)).metrics;
    expect(kept.charts).toBe(2);
    expect(crossedEdges(m.editMesh, m.editMesh.faces(), 'uv0', EDGE_SHARP)).toBe(0);
    const free = model();
    free.plane({ width: 2, height: 1, widthSegments: 8, heightSegments: 4 });
    free.markSharp(line);
    expect(auto(free.uv.auto({ ...ATLAS, respectSharp: false })).metrics.charts).toBe(1);
    expect(crossedEdges(free.editMesh, free.editMesh.faces(), 'uv0', EDGE_SHARP)).toBe(4);
    expect(crossedEdges(free.editMesh, free.editMesh.faces(), 'uv0', EDGE_SEAM)).toBe(0);
  });

  it('a band between two loops is cut into disk charts, so LSCM never folds it', () => {
    // A small open band beside a large sphere gets a single farthest-point seed: one
    // annulus patch. Charted as one island, LSCM folded it (flips, uv-overlap).
    for (const segments of [12, 24, 48]) {
      const m = sphere();
      m.revolve({
        points: [
          [0.05, 1.5],
          [0.06, 1.52],
          [0.05, 1.54],
        ],
        segments,
        label: 'band',
      });
      auto(m.uv.auto({ resolution: 256, padding: 2 }));
      const { measured, issues } = layout(m);
      expect(measured.flipped).toBe(0);
      expect(measured.stretchLinf).toBeLessThan(1.5);
      expect(issues.filter((code) => code.startsWith('uv-'))).toEqual([]);
      const bandIslands = new Set(
        sel
          .createdBy('band')
          .evaluate(m.editMesh)
          .map((f) => measured.faceIsland[f]),
      );
      expect(bandIslands.size).toBeGreaterThanOrEqual(2);
    }
  });

  it('works on a face selection and leaves other faces alone', () => {
    const m = sharpBox();
    m.uv.project({ mode: 'box', scale: 1 });
    const top = sel.facing('+y');
    const mesh = m.editMesh;
    const chosen = new Set(top.evaluate(mesh));
    const others = mesh.faces().filter((f) => !chosen.has(f));
    const before = others.flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? [])),
    );
    const r = m.uv.auto({ ...ATLAS, faces: top });
    expect(r.roles).toEqual({ charted: 9 });
    expect(auto(r).metrics.charts).toBe(1);
    const after = others.flatMap((f) =>
      mesh.faceHalves(f).map((h) => Array.from(mesh.corner('uv0', h) ?? [])),
    );
    expect(after).toEqual(before);
  });

  it('is byte deterministic and reports invalid options, native policy, budget and cancellation', () => {
    const a = sphere();
    a.uv.auto(ATLAS);
    const b = sphere();
    b.uv.auto(ATLAS);
    expect(a.snapshot()).toEqual(b.snapshot());
    for (const bad of [
      { maxCharts: 0 },
      { maxCharts: 1.5 },
      { maxDistortion: 0.5 },
      { maxNormalDeviation: 0 },
      { respectSharp: 'yes' },
      { resolution: Number.NaN },
    ]) {
      const m = sphere();
      expect(m.uv.auto({ ...ATLAS, ...(bad as object) }).error?.code).toBe(
        'model-invalid-argument',
      );
    }
    expect(sphere().uv.auto({ ...ATLAS, compute: 'native' }).error?.code).toBe(
      'model-capability-unavailable',
    );
    expect(sphere().uv.auto({ ...ATLAS, budget: 2000 }).error?.code).toBe('model-work-budget');
    const signal = { aborted: false };
    const cancelled = model({ signal });
    cancelled.sphere({ radius: 1, widthSegments: 32, heightSegments: 16 });
    signal.aborted = true;
    expect(cancelled.uv.auto(ATLAS).error?.code).toBe('model-cancelled');
  });

  it('many disconnected parts: every part keeps its own charts, each a valid disc, beyond maxCharts (F1 S6)', () => {
    // 40 hub caps: 120 hard-bounded components exceed the default cap of 100. Every side
    // tube must still be cut into developable charts, never unwrapped as an annulus.
    const m = model();
    for (let k = 0; k < 40; k++) {
      m.cylinder({
        radiusTop: 0.045,
        radiusBottom: 0.045,
        height: 0.012,
        radialSegments: 24,
        center: [k * 0.2, 0, 0],
      });
    }
    const r = m.uv.auto({ resolution: 2048, padding: 4 });
    const { metrics, unwrap } = auto(r);
    expect(metrics.components).toBe(120);
    expect(metrics.charts).toBeGreaterThan(100);
    expect(metrics.meanDistortion).toBeLessThanOrEqual(1.5);
    expect(unwrap.flipped).toBe(0);
    expect(unwrap.stretchL2).toBeLessThan(1.01);
    expect(
      r.diagnostics?.some((d) => d.severity === 'warn' && d.message.includes('maxCharts')),
    ).toBe(true);
    const l = layout(m);
    expect(l.issues.filter((c) => c.startsWith('uv-'))).toEqual([]);
  });

  it('isolated sharp edges never stay inside a chart, so no chart crosses them (F1 S6)', () => {
    // Sharp edges whose endpoints touch no other hard edge: slits that cannot open alone.
    // A patch holding one is no disk; it splits until every slit lies between two charts.
    const m = model();
    m.plane({ width: 2, height: 2, widthSegments: 20, heightSegments: 20 });
    let slits = 0;
    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < 5; j++) {
        const x = -0.8 + 0.4 * i;
        const y = -0.75 + 0.4 * j;
        const one = sel
          .inBox([x - 0.1, y - 0.05, -9], [x, y + 0.05, 9], { by: 'centroid' })
          .boundary()
          .and(sel.inBox([x, y - 0.05, -9], [x + 0.1, y + 0.05, 9], { by: 'centroid' }).boundary());
        slits += m.markSharp(one).roles?.edges ?? 0;
      }
    }
    expect(slits).toBe(25);
    for (const maxCharts of [1, 100]) {
      const copy = model();
      copy.append(m.snapshot());
      const { metrics } = auto(copy.uv.auto({ ...ATLAS, maxCharts }));
      expect(metrics.charts).toBeGreaterThanOrEqual(2);
      expect(crossedEdges(copy.editMesh, copy.editMesh.faces(), 'uv0', EDGE_SHARP)).toBe(0);
      expect(layout(copy).issues.filter((c) => c.startsWith('uv-'))).toEqual([]);
    }
  });

  it('a 14k-face part with a high maxCharts stays well inside the default budget (F1 S6)', {
    timeout: 120000,
  }, () => {
    // Before: seeding grew a full Dijkstra per seed, every chart candidate paid for the
    // whole mesh's half-edges, and CGLS needed about n iterations per island: the chart
    // job and the unwrap each ran out of the 200M-unit default budget.
    const m = model();
    m.sphere({ radius: 1, widthSegments: 128, heightSegments: 112 });
    const { metrics, unwrap } = auto(m.uv.auto({ resolution: 2048, padding: 4, maxCharts: 2000 }));
    expect(metrics.faces).toBeGreaterThan(14000);
    expect(metrics.work).toBeLessThan(20_000_000);
    expect(unwrap.work).toBeLessThan(120_000_000);
    expect(unwrap.iterations).toBe(0);
    expect(unwrap.flipped).toBe(0);
  });

  it('the chart job reports per-face charts and cut edges as a compute job', () => {
    const m = sphere();
    const r = runComputeJob(
      {
        kind: 'uv.chart',
        inputs: [encodeSnapshot(m.editMesh.compact().mesh)],
        params: { maxCharts: 20, maxDistortion: 1.5, maxNormalDeviation: 45 },
      },
      tsUvBackend,
    );
    if (!r.ok) throw r.error;
    const { faceChart, charts } = r.value.provenance;
    expect(charts.length).toBe(r.value.report.metrics.charts);
    expect(charts.reduce((n, c) => n + c.faces, 0)).toBe(m.editMesh.faceCount);
    expect(Math.max(...faceChart)).toBe(charts.length - 1);
    expect((r.value.outputs[0] as Uint8Array).reduce((n, c) => n + c, 0)).toBe(
      r.value.report.metrics.cuts,
    );
    expect(r.value.report.quality).toBe('baseline');
  });
});
