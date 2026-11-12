import type { Point2 } from '../src/primitives';
import { type Model, model } from '../src/model';
import { nurbs } from '../src/nurbs';
import { recipes } from '../src/recipes';
import { sel } from '../src/selectors';
import { SPIKE_CASES } from '../src/__tests__/boolean-cases';

/**
 * Performance tiers (decision 2026-10-22). `runtime`: a lightweight part rebuilt from
 * parameters when they change, in a Worker; one rebuild through finish() stays within
 * RUNTIME_BUDGET_MS at p90. `offline`: Pack build and cook generation; one build stays
 * within half the 15 s Pack build timeout.
 */
export type PerfTier = 'runtime' | 'offline';

export const RUNTIME_BUDGET_MS = 100;
export const OFFLINE_BUDGET_MS = 7500;

export interface PerfCase {
  readonly name: string;
  readonly tier: PerfTier;
  /** Builds the session up to (not including) finish(); UVs are written here. */
  build(): Model;
}

export function budgetOf(tier: PerfTier): number {
  return tier === 'runtime' ? RUNTIME_BUDGET_MS : OFFLINE_BUDGET_MS;
}

function boxUv(m: Model): Model {
  m.uv.project({ mode: 'box', scale: 1 });
  return m;
}

function circle(radius: number, n: number): Point2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n;
    return [radius * Math.cos(a), radius * Math.sin(a)] as Point2;
  });
}

function recipe(build: () => ReturnType<typeof recipes.gear>): Model {
  const part = build();
  if (!part.ok) throw new Error(`recipe failed: ${part.error.message}`);
  return part.value.model;
}

function spike(name: string): Model {
  const found = SPIKE_CASES.find((c) => c.name.startsWith(name));
  if (found === undefined) throw new Error(`no boolean spike case ${name}`);
  return boxUv(found.build(() => undefined).model);
}

export const PERF_CASES: readonly PerfCase[] = [
  {
    name: 'box',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      return boxUv(m);
    },
  },
  {
    name: 'box inset extrude',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      m.inset(sel.facing('+y'), { thickness: 0.1, region: 'perFace', label: 'i' });
      m.extrude(sel.createdBy('i', 'inner'), { distance: 0.2, region: 'merged' });
      return boxUv(m);
    },
  },
  {
    name: 'box 8x8x8 twist',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 2, 1], segments: [8, 8, 8] });
      m.twist(sel.all(), { axis: 'y', angle: 45 });
      return boxUv(m);
    },
  },
  {
    name: 'box 2x16x2 bend',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [0.2, 2, 0.2], segments: [2, 16, 2] });
      m.bend(sel.all(), { axis: 'y', toward: '+x', angle: 90 });
      return boxUv(m);
    },
  },
  {
    name: 'cylinder 32 bevel top',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.cylinder({ radiusTop: 0.5, radiusBottom: 0.5, height: 1, radialSegments: 32 });
      m.bevel(sel.facing('+y').boundary(), { width: 0.05, segments: 2 });
      return boxUv(m);
    },
  },
  {
    name: 'box minus cylinder 24',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 1, 1] });
      const tool = model();
      tool.cylinder({ radiusTop: 0.3, radiusBottom: 0.3, height: 2, radialSegments: 24 });
      m.difference(tool);
      return boxUv(m);
    },
  },
  {
    name: 'box 4x4x4 subdivide 1',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 1, 1], segments: [4, 4, 4] });
      m.subdivide(undefined, { levels: 1 });
      return boxUv(m);
    },
  },
  {
    name: 'sweep circle 12 along path',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sweep({
        profile: circle(0.05, 12),
        path: [
          [0, 0, 0],
          [0.5, 0.2, 0],
          [1, 0, 0.3],
          [1.5, 0.4, 0.3],
          [2, 0.4, 0],
        ],
        segments: 4,
      });
      return boxUv(m);
    },
  },
  {
    name: 'array radial 12',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [0.1, 0.4, 0.05], center: [0.5, 0, 0], label: 'blade' });
      m.inset(sel.createdBy('blade').and(sel.facing('+z')), { thickness: 0.01, region: 'perFace' });
      m.array(sel.all(), { radial: { count: 12, axis: 'y' } });
      return boxUv(m);
    },
  },
  {
    name: 'revolve 48',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.revolve({
        points: [
          [0, 0],
          [0.3, 0],
          [0.32, 0.05],
          [0.25, 0.3],
          [0.15, 0.5],
          [0.18, 0.7],
          [0.2, 0.72],
          [0, 0.72],
        ],
        segments: 48,
      });
      return boxUv(m);
    },
  },
  {
    name: 'recipe hinge',
    tier: 'runtime',
    build: () =>
      recipe(() =>
        recipes.hinge({ length: 0.1, leafWidth: 0.04, thickness: 0.003, pin: 0.006, holes: 3 }),
      ),
  },
  {
    name: 'recipe gear 12',
    tier: 'runtime',
    build: () => recipe(() => recipes.gear({ module: 0.002, teeth: 12, width: 0.01 })),
  },
  {
    name: 'recipe coil spring',
    tier: 'runtime',
    build: () =>
      recipe(() => recipes.coilSpring({ radius: 0.02, wire: 0.004, pitch: 0.008, turns: 5 })),
  },
  {
    name: 'shrinkwrap skirt rim onto body 48x24',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.2, widthSegments: 48, heightSegments: 24, tag: 'body' });
      m.cylinder({
        radiusTop: 0.24,
        radiusBottom: 0.3,
        height: 0.2,
        radialSegments: 48,
        heightSegments: 8,
        openEnded: true,
        center: [0, -0.05, 0],
        tag: 'skirt',
      });
      m.shrinkwrap(sel.tag('skirt').and(sel.inBox([-1, 0.03, -1], [1, 1, 1], { by: 'any' })), {
        onto: sel.tag('body'),
        offset: 0.004,
        falloff: { radius: 0.06, distance: 'connected' },
      });
      return boxUv(m);
    },
  },
  {
    name: 'layer band of body 48x24',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.2, widthSegments: 48, heightSegments: 24, tag: 'body' });
      m.layer(sel.tag('body').and(sel.inBox([-1, -0.08, -1], [1, 0.12, 1], { by: 'all' })), {
        offset: 0.004,
        thickness: 0.003,
        conform: true,
        label: 'dress',
      });
      return boxUv(m);
    },
  },
  {
    name: 'soft translate sphere 48x24 connected symmetric',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.2, widthSegments: 48, heightSegments: 24, tag: 'body' });
      m.translate(sel.near([0.15, 0.1, 0.1], 4), [0.02, 0.01, 0], {
        falloff: { radius: 0.08, distance: 'connected' },
        symmetry: 'x',
      });
      return boxUv(m);
    },
  },
  {
    name: 'knife project aperture on panel 16x16',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [1, 0.6, 0.05], segments: [16, 10, 1], tag: 'panel' });
      const outline = Array.from({ length: 24 }, (_, i) => {
        const a = (2 * Math.PI * i) / 24;
        return [0.3 * Math.cos(a), 0.18 * Math.sin(a), 1] as [number, number, number];
      });
      m.knife({ points: outline, direction: [0, 0, -1], closed: true, sharp: true, label: 'aperture' });
      return boxUv(m);
    },
  },
  {
    name: 'extrude clump along path from sphere region',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.1, widthSegments: 32, heightSegments: 16, tag: 'scalp' });
      m.extrude(sel.tag('scalp').and(sel.inBox([-0.03, 0.09, -0.03], [0.03, 1, 0.03], { by: 'all' })), {
        path: {
          kind: 'catmullRom',
          points: [
            [0, 0.1, 0],
            [0.02, 0.16, 0.03],
            [0.06, 0.18, 0.09],
            [0.08, 0.12, 0.14],
          ],
          segments: 4,
        },
        scale: [1, 0.15],
        twist: 20,
        label: 'clump',
      });
      return boxUv(m);
    },
  },
  {
    name: 'spherize head cage 8x8x8',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.box({ size: [0.2, 0.24, 0.22], segments: [8, 8, 8], tag: 'head' });
      m.spherize(sel.all(), { factor: 1, radii: [0.1, 0.12, 0.11] });
      return boxUv(m);
    },
  },
  {
    // F2 builds hair as its own session: a scalp cap (2.1k faces of a 100x50 head) and
    // its clumps, not the whole head.
    name: 'strands 48 clumps on a 2.1k-face scalp cap (F2 G4 hair part)',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.1, widthSegments: 100, heightSegments: 50, tag: 'head' });
      m.delete(sel.tag('head').and(sel.inBox([-1, -1, -1], [1, 0.02, 1], { by: 'any' })));
      m.strands(sel.tag('head'), {
        count: 48,
        path: [
          [0, 0, 0],
          [0, 0.03, 0.02],
          [0, 0.04, 0.06],
          [0, 0.01, 0.1],
        ],
        comb: [0, 0, -1],
        vary: { length: [0.8, 1.2], turn: 20 },
        label: 'hair',
      });
      return boxUv(m);
    },
  },
  {
    name: 'strands 24 clumps on a scalp 32x16',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.1, widthSegments: 32, heightSegments: 16, tag: 'head' });
      m.strands(sel.tag('head').and(sel.inBox([-1, 0.04, -1], [1, 1, 1], { by: 'all' })), {
        count: 24,
        path: [
          [0, 0, 0],
          [0, 0.03, 0.02],
          [0, 0.04, 0.06],
          [0, 0.01, 0.1],
        ],
        comb: [0, 0, -1],
        vary: { length: [0.8, 1.2], turn: 20 },
        label: 'hair',
      });
      return boxUv(m);
    },
  },
  {
    name: 'layer conform band of body 64x32 (F2 size)',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.2, widthSegments: 64, heightSegments: 32, tag: 'body' });
      m.layer(sel.tag('body').and(sel.inBox([-1, -0.08, -1], [1, 0.12, 1], { by: 'centroid' })), {
        offset: 0.004,
        conform: true,
        label: 'dress',
      });
      return boxUv(m);
    },
  },
  {
    name: 'knife project aperture on hull 64x32 (F1 size)',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 64, heightSegments: 32, tag: 'hull' });
      const outline = Array.from({ length: 24 }, (_, i) => {
        const a = (2 * Math.PI * i) / 24;
        return [0.2 * Math.cos(a), 0.12 * Math.sin(a), 2] as [number, number, number];
      });
      m.knife({ points: outline, direction: [0, 0, -1], closed: true, label: 'aperture' });
      return boxUv(m);
    },
  },
  ...([12, 32] as const).map(
    (n): PerfCase => ({
      name: `shell with a return flange on every edge of a creased ${n}x${n} panel`,
      // The shell's own exact checks dominate (plain 32x32 ~190 ms). 12x12 is the runtime
      // size: 16x16 read ~66 ms and went over 100 ms on a loaded host.
      tier: n === 12 ? 'runtime' : 'offline',
      build: () => {
        const m = model();
        m.plane({ width: 1, height: 1, widthSegments: n, heightSegments: n, tag: 'panel' });
        m.rotate(sel.tag('panel').and(sel.inBox([0, -1, -1], [1, 1, 1], { by: 'all' })), 'y', 30);
        m.shell(sel.tag('panel'), {
          thickness: 0.0015,
          flange: { reach: 0.06, depth: 0.006 },
          label: 'skin',
        });
        return boxUv(m);
      },
    }),
  ),
  { name: 'boolean spike plate-holes', tier: 'offline', build: () => spike('plate-holes') },
  { name: 'boolean spike radial', tier: 'offline', build: () => spike('radial ') },
  { name: 'boolean spike radial-windows', tier: 'offline', build: () => spike('radial-windows') },
  {
    name: 'voxel union sphere box',
    tier: 'offline',
    build: () => {
      const m = model();
      m.box({ size: [0.6, 0.6, 0.6] });
      m.sphere({ radius: 0.4, center: [0.3, 0.3, 0], widthSegments: 24, heightSegments: 16 });
      m.voxel.union(sel.all(), { voxelSize: 0.03, radius: 0.05 });
      return boxUv(m);
    },
  },
  {
    name: 'remesh sphere',
    tier: 'offline',
    build: () => {
      const m = model();
      m.sphere({ radius: 0.5, widthSegments: 32, heightSegments: 16 });
      m.remesh(undefined, { targetEdgeLength: 0.05, iterations: 5 });
      return boxUv(m);
    },
  },
  {
    name: 'uv.auto subdivided box',
    tier: 'offline',
    build: () => {
      const m = model();
      m.box({ size: [1, 0.6, 0.4], segments: [6, 4, 3] });
      m.subdivide(undefined, { levels: 2 });
      m.uv.auto({ resolution: 1024, padding: 4 });
      return m;
    },
  },
  {
    name: 'surface hood and fender with a 4 mm G2 blend, isoparm export',
    tier: 'offline',
    build: () => {
      const patch = (x0: number, x1: number, f: (x: number, y: number) => number) => {
        const rows = [0, 1, 2, 3].map((i) =>
          [0, 1, 2, 3].map((j): [number, number, number] => {
            const x = x0 + ((x1 - x0) * i) / 3;
            const y = -0.5 + j / 3;
            return [x, y, f(x, y)];
          }),
        );
        const s = nurbs.grid(rows, { parametrization: 'uniform' });
        if (!s.ok) throw s.error;
        return s.value;
      };
      const crown = (y: number) => 0.06 * (1 - y * y);
      const m = model();
      m.surface({
        patches: [
          { name: 'hood', surface: patch(-0.4, 0, (x, y) => crown(y) + 0.05 * x) },
          { name: 'fender', surface: patch(0, 0.4, (x, y) => crown(y) - 0.4 * x - 0.3 * x * x) },
        ],
        blends: [{ between: ['hood', 'fender'], radius: 0.004, continuity: 'G2' }],
        chord: 0.0005,
        nonPlanar: 'keep',
        spacing: 'even',
      });
      return m;
    },
  },
  {
    name: 'support loops along a crease of a 16x16 panel, subdivide 1',
    tier: 'runtime',
    build: () => {
      const m = model();
      m.plane({ width: 1, height: 1, widthSegments: 16, heightSegments: 16 });
      m.rotate(sel.inBox([-1, 0.01, -1], [1, 1, 1], { by: 'centroid' }), 'x', 40);
      m.supportLoops(sel.edges.dihedral('>', 20), { offset: [0.005, 0.012] });
      m.subdivide(undefined, { levels: 1 });
      return boxUv(m);
    },
  },
];

export interface OpTiming {
  readonly op: string;
  readonly medianMs: number;
}

/**
 * The gated clock: CPU time of the measuring thread where the runtime reports it
 * (`process.threadCpuUsage`, Node >= 23.9), which a loaded shared host inflates far less
 * than wall time; wall time otherwise. On an idle host the two agree within a few percent.
 * The thread clock advances in scheduler ticks (4 ms on Linux at HZ=250), so cases far
 * below the budget read 0 or one tick.
 */
export type GateClock = 'thread-cpu' | 'wall';

type CpuUsage = { readonly user: number; readonly system: number };
const threadCpuUsage = (process as unknown as { threadCpuUsage?: () => CpuUsage })
  .threadCpuUsage;

function threadCpuMs(): number {
  const usage = threadCpuUsage?.call(process);
  return usage === undefined ? 0 : (usage.user + usage.system) / 1000;
}

export const GATE_CLOCK: GateClock = threadCpuUsage === undefined ? 'wall' : 'thread-cpu';

export interface CaseTiming {
  readonly name: string;
  readonly tier: PerfTier;
  readonly budgetMs: number;
  readonly runs: number;
  /** Wall clock of one rebuild. */
  readonly medianMs: number;
  readonly p90Ms: number;
  /** Thread CPU time of one rebuild (equal to the wall numbers when unavailable). */
  readonly cpuMedianMs: number;
  readonly cpuP90Ms: number;
  /** finish(): compact, export and MeshAsset build (wall, median). */
  readonly finishMedianMs: number;
  readonly faces: number;
  readonly triangles: number;
  /** Journal `durationMs` per operation, median over the runs. */
  readonly ops: readonly OpTiming[];
}

/** The p90 the tier budget applies to. */
export function gatedP90(t: CaseTiming): number {
  return GATE_CLOCK === 'thread-cpu' ? t.cpuP90Ms : t.p90Ms;
}

function quantile(sorted: readonly number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] as number;
}

function round(ms: number): number {
  return Math.round(ms * 100) / 100;
}

/** One rebuild from parameters to MeshAsset: the session ops, then finish(). */
function rebuild(c: PerfCase): {
  totalMs: number;
  cpuMs: number;
  finishMs: number;
  model: Model;
  triangles: number;
} {
  const cpu = threadCpuMs();
  const started = performance.now();
  const m = c.build();
  const before = performance.now();
  const out = m.finish({ key: 'perf' });
  const ended = performance.now();
  const cpuMs = threadCpuMs() - cpu;
  if (!out.ok) throw new Error(`${c.name}: ${out.error.message}`);
  const mesh = out.value['mesh/perf'];
  return {
    totalMs: ended - started,
    cpuMs: GATE_CLOCK === 'thread-cpu' ? cpuMs : ended - started,
    finishMs: ended - before,
    model: m,
    triangles: (mesh?.indices?.length ?? 0) / 3,
  };
}

export function measureCase(c: PerfCase, runs: number, warmup: number): CaseTiming {
  for (let i = 0; i < warmup; i++) rebuild(c);
  const totals: number[] = [];
  const cpus: number[] = [];
  const finishes: number[] = [];
  const perOp: number[][] = [];
  let names: string[] = [];
  let last: ReturnType<typeof rebuild> | undefined;
  for (let i = 0; i < runs; i++) {
    last = rebuild(c);
    totals.push(last.totalMs);
    cpus.push(last.cpuMs);
    finishes.push(last.finishMs);
    const journal = last.model.journal;
    names = journal.map((e) => e.op);
    journal.forEach((e, k) => {
      (perOp[k] ??= []).push(e.durationMs);
    });
  }
  const sorted = (xs: number[]) => [...xs].sort((a, b) => a - b);
  return {
    name: c.name,
    tier: c.tier,
    budgetMs: budgetOf(c.tier),
    runs,
    medianMs: round(quantile(sorted(totals), 0.5)),
    p90Ms: round(quantile(sorted(totals), 0.9)),
    cpuMedianMs: round(quantile(sorted(cpus), 0.5)),
    cpuP90Ms: round(quantile(sorted(cpus), 0.9)),
    finishMedianMs: round(quantile(sorted(finishes), 0.5)),
    faces: last?.model.editMesh.faceCount ?? 0,
    triangles: last?.triangles ?? 0,
    ops: names.map((op, k) => ({ op, medianMs: round(quantile(sorted(perOp[k] ?? []), 0.5)) })),
  };
}
