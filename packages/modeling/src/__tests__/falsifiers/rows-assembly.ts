import { PackageId } from '@forgeax/engine-pack/guid';
import { type AssetStats, assetStats, checkAssetBudget } from '../../asset-budget';
import type { Tuple3 } from '../../geom';
import { checkLayout, type PatchLayoutSpec, resolveLayout } from '../../layout';
import { model } from '../../model';
import { sweepOverlap } from '../../motion-space';
import { nurbs } from '../../nurbs';
import { type PosePath, rig } from '../../rig';
import { measureSeamVisibility } from '../../seam-visibility';
import { sel } from '../../selectors';
import { measureShutLines } from '../../shut-lines';
import type { FalsifierRow, PendingCheck, Verdict } from './registry';

const must = <T>(
  r: { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown },
): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

/** A verdict from a structured result: refusals carry their error code. */
const refusal = (
  r: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } },
): Verdict => (r.ok ? { pass: true, codes: [] } : { pass: false, codes: [r.error.code] });

/** An asset-budget verdict: the mobile-prop profile passes or lists every violated limit. */
const budget = (stats: AssetStats): Verdict => {
  const r = checkAssetBudget(stats, 'mobile-prop');
  return { pass: r.ok, codes: r.issues.map((issue) => issue.code) };
};

/** Measured stats of one unit box cut into `segments` cells per axis, UV-unwrapped and exported. */
const boxStats = (segments: number): AssetStats => {
  const m = model();
  m.box({ size: [1, 1, 1], segments: [segments, segments, segments] });
  m.uv.auto({ resolution: 256, padding: 2 });
  const built = m.toMesh({ normals: { mode: 'smooth' } });
  if (!built.ok) throw new Error(built.error.message);
  return must(assetStats([{ id: 'box', mesh: built.value.mesh }]));
};

// ---- layouts: two quintic patches, a roof and a side, joined by a G1 or G2 edge ----

function patch(
  x0: number,
  x1: number,
  y0: number,
  y1: number,
  f: (x: number, y: number) => number,
) {
  const rows = Array.from({ length: 12 }, (_, i) =>
    Array.from({ length: 12 }, (_, j): Tuple3 => {
      const x = x0 + ((x1 - x0) * i) / 11;
      const y = y0 + ((y1 - y0) * j) / 11;
      return [x, y, f(x, y)];
    }),
  );
  return must(nurbs.fitSurface(rows, { degree: [5, 5], net: [6, 6] })).surface;
}

const roof = (x: number, y: number) => 0.1 * Math.sin(1.2 * x) + 0.05 * y * y;
const side = (x: number, y: number) => 0.13 + 0.06 * Math.cos(1.5 * x) - 0.02 * y;

const layoutSpec = (continuity: 'G1' | 'G2'): PatchLayoutSpec => ({
  patches: [
    { id: 'P', role: 'primary', surface: patch(0, 1, 0, 1, roof) },
    {
      id: 'S',
      role: 'secondary',
      surface: patch(1.02, 2, 0, 1, side),
      sides: { u0: { to: 'P:u1', continuity } },
    },
  ],
});

/** The G1 layout built by the model, keyed by patch id. */
function builtG1() {
  const m = model();
  m.patchLayout(layoutSpec('G1'));
  m.surface({ layout: 'layout', chord: 0.002 });
  return new Map(m.diagnostics().surfaces.map((s) => [s.name, s.surface]));
}

// ---- rig fixtures: a block figure, a hinged bar with stops, an arm, a hinged limb ----

function figure(o: { arms?: boolean; stilts?: boolean } = {}) {
  const m = model();
  const box = (label: string, size: [number, number, number], center: [number, number, number]) =>
    m.box({ size, center, label });
  box('pelvis', o.stilts ? [0.9, 0.1, 0.3] : [0.4, 0.2, 0.2], [0, 1.0, 0]);
  box('chest', o.stilts ? [1.0, 0.9, 0.35] : [0.5, 0.5, 0.25], [0, o.stilts ? 1.5 : 1.4, 0]);
  for (const [side, x] of [
    ['l', 0.15],
    ['r', -0.15],
  ] as const) {
    box(`leg-${side}`, o.stilts ? [0.03, 0.85, 0.03] : [0.12, 0.85, 0.12], [x, 0.475, 0]);
    box(`foot-${side}`, o.stilts ? [0.14, 0.02, 0.4] : [0.12, 0.05, 0.25], [
      x,
      o.stilts ? 0.01 : 0.025,
      o.stilts ? 0 : 0.05,
    ]);
    if (o.arms) box(`arm-${side}`, [0.08, 0.5, 0.1], [Math.sign(x) * 0.36, 1.35, 0]);
  }
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'pelvis', parent: 'root', position: [0, 1.0, 0], kind: 'revolute', axis: 'z' },
      { name: 'chest', parent: 'pelvis', position: [0, 1.15, 0], kind: 'revolute', axis: 'z' },
      { name: 'hip-l', parent: 'root', position: [0.15, 0.9, 0] },
      { name: 'hip-r', parent: 'root', position: [-0.15, 0.9, 0] },
      { name: 'step-l', parent: 'hip-l', position: [0.15, 0.9, 0], kind: 'prismatic', axis: 'y' },
      { name: 'shoulder-l', parent: 'chest', position: [0.25, 1.6, 0] },
      { name: 'shoulder-r', parent: 'chest', position: [-0.25, 1.6, 0] },
      { name: 'pelvis-l', parent: 'pelvis', position: [0.15, 1.0, 0] },
      { name: 'pelvis-r', parent: 'pelvis', position: [-0.15, 1.0, 0] },
    ],
  });
  r.bindRigid(sel.createdBy('pelvis'), 'pelvis', { part: 'pelvis' });
  r.bindRigid(sel.createdBy('chest'), 'chest', { part: 'chest' });
  if (o.arms)
    r.bindRigid(sel.createdBy('arm-l').or(sel.createdBy('arm-r')), 'chest', { part: 'arms' });
  r.bindRigid(sel.createdBy('leg-l').or(sel.createdBy('foot-l')), 'step-l', { part: 'leg-l' });
  r.bindRigid(sel.createdBy('leg-r').or(sel.createdBy('foot-r')), 'hip-r', { part: 'leg-r' });
  return r;
}

const POSE_OPTIONS = {
  hips: ['pelvis-l', 'pelvis-r'],
  shoulders: ['shoulder-l', 'shoulder-r'],
  feet: ['leg-l', 'leg-r'],
} as const;

/** A bar on a hinge about y, limits [0, 90], stopped at both ends; `maxStop` sets the 90 degree stop. */
function stopBar(maxStop: Tuple3) {
  const m = model();
  m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'bar' });
  m.box({ size: [0.06, 0.06, 0.06], center: maxStop, label: 'stop' });
  // Spans z in [0.02, 0.08]: its -z face meets the bar's +z face at rest, so the min end lands.
  m.box({ size: [0.06, 0.06, 0.06], center: [0.2, 0, 0.05], label: 'stop-min' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      {
        name: 'hinge',
        parent: 'root',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'y',
        limits: [0, 90],
        stops: {
          min: { stop: 'stop-min', against: 'bar' },
          max: { stop: 'stop', against: 'bar' },
        },
      },
    ],
  });
  r.bindRigid(sel.createdBy('bar'), 'hinge', { part: 'bar' });
  r.bindRigid(sel.createdBy('stop'), 'root', { part: 'stop' });
  r.bindRigid(sel.createdBy('stop-min'), 'root', { part: 'stop-min' });
  return r;
}

/** An arm: a shoulder about z and an elbow about z, 0.5 m out. */
function arm() {
  const m = model();
  m.box({ size: [0.5, 0.04, 0.04], center: [0.25, 0, 0], label: 'upper' });
  m.box({ size: [0.4, 0.04, 0.04], center: [0.7, 0, 0], label: 'fore' });
  const r = rig(m, {
    joints: [
      { name: 'ground', parent: null, position: [0, 0, 0] },
      {
        name: 'shoulder',
        parent: 'ground',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: [-30, 120],
      },
      {
        name: 'elbow',
        parent: 'shoulder',
        position: [0.5, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: [0, 90],
      },
    ],
  });
  r.bindRigid(sel.createdBy('upper'), 'shoulder', { part: 'upper' });
  r.bindRigid(sel.createdBy('fore'), 'elbow', { part: 'fore' });
  return r;
}

const raise = (span: readonly [number, number]) => ({
  id: 'raise',
  from: { shoulder: 0 },
  to: { shoulder: 90 },
  beat: { span, anticipate: 0.1 },
});
const bend = (span: readonly [number, number]) => ({
  id: 'bend',
  from: { elbow: 0 },
  to: { elbow: 60 },
  beat: { span, overshoot: 0.05 },
});

/** A hinged arm beside a wall, with a UV projection so it can export a clip. */
function hinged() {
  const m = model();
  m.box({ size: [1, 0.25, 0.25], center: [0.5, 0, 0], label: 'arm' });
  m.box({ size: [0.25, 0.5, 1], center: [0.75, -0.625, 0], label: 'wall' });
  m.uv.project({ mode: 'box', scale: 0.5 });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      {
        name: 'hinge',
        parent: 'root',
        position: [0, 0, 0],
        kind: 'revolute',
        axis: 'z',
        limits: [-90, 90],
      },
    ],
  });
  r.bindRigid(sel.all(), 'root', { part: 'wall' });
  r.bindRigid(sel.createdBy('arm'), 'hinge', { part: 'arm' });
  return r;
}

const packageId = must(PackageId.parse('01900000-0000-7000-8000-0000000c0107'));
const clipPath: PosePath = {
  keys: [
    { u: 0, pose: { hinge: 0 } },
    { u: 1, pose: { hinge: 60 } },
  ],
};
const clip = (name: string) => ({ name, path: clipPath, duration: 1 });

/** Two bars on hinges about y at the origin, each sweeping a full turn. */
function bars() {
  const m = model();
  for (const k of [0, 1]) m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: `bar${k}` });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'hinge0', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
      { name: 'hinge1', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  r.bindRigid(sel.createdBy('bar0'), 'hinge0', { part: 'bar0' });
  r.bindRigid(sel.createdBy('bar1'), 'hinge1', { part: 'bar1' });
  const path: PosePath = {
    keys: [
      { u: 0, pose: { hinge0: 0, hinge1: 0 } },
      { u: 1, pose: { hinge0: 360, hinge1: 360 } },
    ],
  };
  return { r, path };
}

// ---- phase claims: a driver, a follower keyed outside the declared joints, and a plate it swings through ----

function swingRig(plateZ: number) {
  const m = model();
  m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0, 0], label: 'driver' });
  m.box({ size: [0.2, 0.04, 0.04], center: [0.2, 0.2, 0], label: 'follower' });
  m.box({ size: [0.1, 0.1, 0.02], center: [0, 0.2, plateZ], label: 'plate' });
  const r = rig(m, {
    joints: [
      { name: 'root', parent: null, position: [0, 0, 0] },
      { name: 'drive', parent: 'root', position: [0, 0, 0], kind: 'revolute', axis: 'y' },
      { name: 'follow', parent: 'root', position: [0, 0.2, 0], kind: 'revolute', axis: 'y' },
    ],
  });
  r.bindRigid(sel.createdBy('driver'), 'drive', { part: 'driver' });
  r.bindRigid(sel.createdBy('follower'), 'follow', { part: 'follower' });
  r.bindRigid(sel.createdBy('plate'), 'root', { part: 'plate' });
  return r;
}

const SWING_PATH: PosePath = {
  keys: [
    { u: 0, pose: { drive: 0, follow: 0 } },
    { u: 1, pose: { drive: 30, follow: 120 } },
  ],
};

function claimVerdict(joints: readonly string[], plateZ: number): Verdict {
  const out = must(
    swingRig(plateZ).phaseClaims(SWING_PATH, {
      voxel: 0.01,
      phases: [{ id: 'p', u: [0, 1], joints: [...joints] }],
    }),
  );
  const unclaimed = out.claims.flatMap((c) => c.unclaimed);
  const conflicts = out.conflicts.map((c) => `${c.kind}:${c.parts.join('+')}`);
  return {
    pass: unclaimed.length === 0 && conflicts.length === 0,
    codes: [...unclaimed.map((u) => `unclaimed:${u}`), ...conflicts],
  };
}

// ---- shut lines: two panels in z = 0 meeting on a seam; a 1 mm step on b fails flush ----

function seam(step = 0, gapAt: (y: number) => number = () => 0.0035): ReturnType<typeof model> {
  const m = model();
  const ys = Array.from({ length: 9 }, (_, k) => -0.2 + (0.4 * k) / 8);
  for (const [side, name, z] of [
    [-1, 'a', 0],
    [1, 'b', step],
  ] as const) {
    const near = ys.map((y): Tuple3 => [(side * gapAt(y)) / 2, y, z]);
    const bottom: Tuple3 = [side * 0.3, -0.2, z];
    const top: Tuple3 = [side * 0.3, 0.2, z];
    const ring = side === -1 ? [bottom, ...near, top] : [bottom, top, ...[...near].reverse()];
    m.polygon({ points: ring, tag: name, label: name });
    m.shell(sel.tag(name), { thickness: 0.003, label: `${name}-wall` });
  }
  return m;
}
const seamRow = { id: 'D', parts: ['a', 'b'] as [string, string], zone: 'A' as const };

export const ASSEMBLY_ROWS: readonly FalsifierRow[] = [
  {
    check: 'Rig.phaseClaims',
    // The pass input moves the plate out of the swing; the fail input keeps it in and leaves the follower undeclared.
    pass: () => claimVerdict(['drive', 'follow'], -0.5),
    fail: () => claimVerdict(['drive'], -0.2),
    expect: 'unclaimed:follower',
  },
  {
    // A 13 mm slot over the last 30% of the seam leaves tail stations out of reach. The chain
    // extent must surface as an uncovered stretch (`unmeasured`), not vanish from the measurement.
    // Flush is proven by the `Model.shutLines` row below, which shares this measurement path.
    check: 'measureShutLines',
    expect: 'shut-line-unmeasured',
    pass: () => {
      const r = must(measureShutLines(seam().editMesh, { table: [seamRow] }));
      return {
        pass: r.pass,
        codes: r.rows.filter((x) => x.status !== 'pass').map((x) => x.status),
      };
    },
    fail: () => {
      const r = must(
        measureShutLines(seam(0, (y) => (y > 0.05 ? 0.013 : 0.0035)).editMesh, {
          table: [seamRow],
        }),
      );
      return {
        pass: r.pass,
        codes: r.rows.flatMap((x) => x.failures.map((f) => `shut-line-${f}`)),
      };
    },
  },
  {
    check: 'Model.shutLines',
    expect: 'shut-line-flush',
    pass: () => {
      const r = must(seam().shutLines({ table: [seamRow] }));
      return { pass: r.pass, codes: [] };
    },
    fail: () => {
      const r = must(seam(0.001).shutLines({ table: [seamRow] }));
      return {
        pass: r.pass,
        codes: r.rows.flatMap((x) => x.failures.map((f) => `shut-line-${f}`)),
      };
    },
  },
  {
    check: 'Model.validateShutLines',
    expect: 'shut-line',
    pass: () => {
      const v = seam().validate({ shutLines: { table: [seamRow] } });
      return { pass: v.pass, codes: v.issues.map((i) => i.code) };
    },
    fail: () => {
      const v = seam(0.001).validate({ shutLines: { table: [seamRow] } });
      return { pass: v.pass, codes: v.issues.map((i) => i.code) };
    },
  },
  {
    check: 'checkLayout',
    pass: () => {
      const issues = checkLayout(
        must(resolveLayout(layoutSpec('G1'))),
        [],
        {},
        { built: builtG1() },
      );
      return { pass: issues.length === 0, codes: issues.map((i) => i.code) };
    },
    fail: () => {
      const issues = checkLayout(
        must(resolveLayout(layoutSpec('G2'))),
        [],
        {},
        { built: builtG1() },
      );
      return { pass: issues.length === 0, codes: issues.map((i) => i.code) };
    },
    expect: 'layout-continuity',
  },
  {
    check: 'Model.validateLayouts',
    pass: () => {
      const m = model();
      m.patchLayout(layoutSpec('G1'));
      m.surface({ layout: 'layout', chord: 0.002 });
      const found = m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout');
      return { pass: found.length === 0, codes: found.map((i) => String(i.detail.check)) };
    },
    fail: () => {
      const m = model();
      m.patchLayout(layoutSpec('G1'));
      const found = m.validate({ layout: true }).issues.filter((i) => i.code === 'patch-layout');
      return { pass: found.length === 0, codes: found.map((i) => String(i.detail.check)) };
    },
    expect: 'layout-unbuilt',
  },
  {
    // Refusal row: sweepOverlap has no judgment code, so its failing input is a voxel mismatch.
    check: 'sweepOverlap',
    pass: () => {
      const { r, path } = bars();
      const a = must(r.sweep(path, { voxel: 0.01, parts: ['bar0'] }));
      const b = must(r.sweep(path, { voxel: 0.01, parts: ['bar1'] }));
      return refusal(sweepOverlap(a, b));
    },
    fail: () => {
      const { r, path } = bars();
      const a = must(r.sweep(path, { voxel: 0.01, parts: ['bar0'] }));
      const b = must(r.sweep(path, { voxel: 0.02, parts: ['bar1'] }));
      return refusal(sweepOverlap(a, b));
    },
    expect: 'model-invalid-argument',
  },
  {
    check: 'Rig.poseReport',
    pass: () => {
      const report = must(
        figure({ arms: true }).poseReport({ pelvis: 6, chest: -12 }, POSE_OPTIONS),
      );
      return { pass: report.pass, codes: report.issues.map((i) => i.code) };
    },
    fail: () => {
      const report = must(
        figure({ stilts: true }).poseReport({ pelvis: 6, chest: -12 }, POSE_OPTIONS),
      );
      return { pass: report.pass, codes: report.issues.map((i) => i.code) };
    },
    expect: 'no-negative-space',
  },
  {
    check: 'Rig.stopReport',
    pass: () => {
      const report = must(stopBar([-0.05, 0, -0.2]).stopReport());
      return { pass: report.pass, codes: report.checks.map((c) => c.finding) };
    },
    fail: () => {
      const report = must(stopBar([0, 0, -0.2]).stopReport());
      return { pass: report.pass, codes: report.checks.map((c) => c.finding) };
    },
    expect: 'through',
  },
  {
    check: 'Rig.motionReport',
    pass: () => {
      const r = arm();
      const c = must(r.choreograph({ phases: [raise([0, 1]), bend([1.5, 2.5])], duration: 3 }));
      const m = must(
        r.motionReport(c.path, {
          groups: { arm: ['shoulder'], hand: ['elbow'] },
          duration: 3,
          readPoints: c.readPoints,
        }),
      );
      return { pass: m.issues.length === 0, codes: m.issues.map((i) => i.code) };
    },
    fail: () => {
      const r = arm();
      const c = must(r.choreograph({ phases: [raise([0, 1]), bend([0.5, 2])], duration: 3 }));
      const m = must(
        r.motionReport(c.path, { groups: { arm: ['shoulder'], hand: ['elbow'] }, duration: 3 }),
      );
      return { pass: m.issues.length === 0, codes: m.issues.map((i) => i.code) };
    },
    expect: 'concurrent',
  },
  {
    // checkClips is private and runs through finish(); its failing input is a duplicate clip name.
    check: 'Rig.checkClips',
    pass: () => {
      const result = hinged().finish({
        key: 'limb',
        packageId,
        clips: [clip('open'), clip('close')],
      });
      return refusal(result);
    },
    fail: () => {
      const result = hinged().finish({ key: 'limb', packageId, clips: [clip('a'), clip('a')] });
      return refusal(result);
    },
    expect: 'model-invalid-argument',
  },
  {
    // Refusal row: measureSeamVisibility returns a measurement, so its failing input is an invalid view count.
    check: 'measureSeamVisibility',
    pass: () => {
      const m = model();
      m.box({ size: [2, 1, 1], center: [0, 0.5, 0], label: 'block' });
      m.markSharp(sel.edges.dihedral('>', 30));
      m.uv.unwrap({ seams: 'sharp' });
      m.uv.pack({ resolution: 256, padding: 2, method: 'raster' });
      return refusal(measureSeamVisibility(m.editMesh, {}));
    },
    fail: () => {
      const m = model();
      m.box({ size: [2, 1, 1], center: [0, 0.5, 0], label: 'block' });
      m.markSharp(sel.edges.dihedral('>', 30));
      m.uv.unwrap({ seams: 'sharp' });
      m.uv.pack({ resolution: 256, padding: 2, method: 'raster' });
      return refusal(measureSeamVisibility(m.editMesh, { views: 3 }));
    },
    expect: 'model-invalid-argument',
  },
  {
    // Refusal row: Model.seamVisibility returns a measurement, so its failing input is an out-of-range minHidden.
    check: 'Model.seamVisibility',
    pass: () => {
      const m = model();
      m.box({ size: [2, 1, 1], center: [0, 0.5, 0], label: 'block' });
      m.markSharp(sel.edges.dihedral('>', 30));
      m.uv.unwrap({ seams: 'sharp' });
      m.uv.pack({ resolution: 256, padding: 2, method: 'raster' });
      return refusal(m.seamVisibility({}));
    },
    fail: () => {
      const m = model();
      m.box({ size: [2, 1, 1], center: [0, 0.5, 0], label: 'block' });
      m.markSharp(sel.edges.dihedral('>', 30));
      m.uv.unwrap({ seams: 'sharp' });
      m.uv.pack({ resolution: 256, padding: 2, method: 'raster' });
      return refusal(m.seamVisibility({ minHidden: 2 }));
    },
    expect: 'model-invalid-argument',
  },
  {
    // Budget row: a coarse box passes mobile-prop; a 40-cell box exceeds its triangle limit.
    check: 'checkAssetBudget',
    pass: () => budget(boxStats(2)),
    fail: () => budget(boxStats(40)),
    expect: 'budget-triangles',
  },
];

export const ASSEMBLY_PENDING: readonly PendingCheck[] = [];
